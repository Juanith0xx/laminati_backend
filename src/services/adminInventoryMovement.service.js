import crypto from "node:crypto";
import pool from "../config/database.js";
import { relbaseRequest } from "./relbase.service.js";
import { syncRelbaseProductInventory } from "./relbaseInventory.service.js";

const fail = (message, status = 400, code = "INVALID_MOVEMENT") => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const WRITE_ENABLED = () => process.env.RELBASE_INVENTORY_WRITE_ENABLED === "true";
const integerId = (value, label) => {
  const raw = String(value ?? "");
  if (!/^[1-9]\d{0,14}$/.test(raw)) throw fail(`${label} inválido`);
  return Number(raw);
};

const uuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));

const getProduct = async (productId, db = pool) => {
  if (!uuid(productId)) throw fail("ID de producto inválido");
  const result = await db.query(
    `SELECT id, sku, name, relbase_product_id FROM products WHERE id = $1 LIMIT 1`,
    [productId]
  );
  if (!result.rowCount) throw fail("Producto no encontrado", 404, "PRODUCT_NOT_FOUND");
  const product = result.rows[0];
  if (!product.relbase_product_id) throw fail("Este producto no está vinculado a Relbase", 409, "UNLINKED_PRODUCT");
  integerId(product.relbase_product_id, "ID del producto Relbase");
  return product;
};

const getConnection = async (db = pool) => {
  const result = await db.query(
    `SELECT is_active, scope FROM relbase_oauth_connections WHERE provider = 'RELBASE' LIMIT 1`
  );
  const connection = result.rows[0];
  const granted = new Set(String(connection?.scope ?? "").split(/\s+/).filter(Boolean));
  return {
    connected: Boolean(connection?.is_active),
    read_authorized: granted.has("products:read") && granted.has("inventory:read"),
    write_authorized: granted.has("inventory:write"),
  };
};

const getWarehouse = async (productId, warehouseId, db = pool) => {
  const result = await db.query(
    `SELECT i.id, i.warehouse_name, i.warehouse_code, i.stock_quantity, i.safety_stock,
            COALESCE(SUM(CASE WHEN ir.status = 'CONFIRMED' OR
                         (ir.status = 'ACTIVE' AND (ir.expires_at IS NULL OR ir.expires_at > NOW()))
                         THEN ir.quantity ELSE 0 END), 0) AS reserved_quantity
       FROM inventory i
       LEFT JOIN inventory_reservations ir ON ir.inventory_id = i.id
      WHERE i.product_id = $1 AND i.relbase_warehouse_id = $2
      GROUP BY i.id, i.warehouse_name, i.warehouse_code, i.stock_quantity, i.safety_stock
      LIMIT 1`,
    [productId, warehouseId]
  );
  if (!result.rowCount) throw fail("La bodega no está sincronizada para este producto. Sincroniza desde Relbase primero.", 409, "WAREHOUSE_NOT_SYNCED");
  return result.rows[0];
};

const liveStock = async (relbaseProductId, warehouseId) => {
  const result = await relbaseRequest(`/api/v2/productos/${relbaseProductId}/stock_por_bodegas`, { method: "GET" });
  const warehouses = result?.data?.data?.stocks;
  if (!Array.isArray(warehouses)) throw fail("Relbase no devolvió un inventario válido", 502, "RELBASE_UNEXPECTED_STOCK");
  const match = warehouses.find((row) => Number(row?.ware_house_id) === warehouseId);
  if (!match) throw fail("Relbase no devolvió la bodega seleccionada; no se puede modificar el stock", 409, "WAREHOUSE_NOT_RETURNED");
  const amount = Number(match.current_stock);

  /*
   * Relbase puede devolver existencias negativas reales
   * (por ejemplo -5). Ese valor NO es inválido:
   * representa el estado operativo que debemos poder
   * regularizar mediante una TOMA FÍSICA.
   *
   * Sólo rechazamos valores no numéricos.
   */
  if (!Number.isFinite(amount)) {
    throw fail(
      "Relbase devolvió una existencia no numérica; operación bloqueada",
      502,
      "RELBASE_INVALID_STOCK"
    );
  }

  return amount;
};

// Sólo lectura, sin modificar inventario ni reservar unidades.
export const previewInventoryMovement = async ({ productId, warehouseId }) => {
  const product = await getProduct(productId);
  const relbaseWarehouseId = integerId(warehouseId, "Bodega");
  const [connection, warehouse] = await Promise.all([
    getConnection(),
    getWarehouse(product.id, relbaseWarehouseId),
  ]);
  if (!connection.connected) throw fail("La cuenta de Relbase está desconectada", 409, "RELBASE_DISCONNECTED");
  if (!connection.read_authorized) throw fail("Faltan permisos de lectura en el OAuth de Relbase", 409, "RELBASE_READ_SCOPE");
  const current = await liveStock(integerId(product.relbase_product_id, "Producto Relbase"), relbaseWarehouseId);
  return {
    product: { id: product.id, sku: product.sku, name: product.name, relbase_product_id: product.relbase_product_id },
    warehouse: {
      id: relbaseWarehouseId, name: warehouse.warehouse_name,
      local_stock: Number(warehouse.stock_quantity),
      relbase_stock: current,
      reserved: Number(warehouse.reserved_quantity),
      safety_stock: Number(warehouse.safety_stock),
      maximum_safe_consumption: Math.max(current - Number(warehouse.reserved_quantity) - Number(warehouse.safety_stock), 0),

      /*
       * Si Relbase está negativo, la única operación segura
       * es fijar la existencia real mediante COUNT.
       */
      requires_physical_count: current < 0,
    },
    permissions: { ...connection, write_enabled: WRITE_ENABLED(), can_write: connection.write_authorized && WRITE_ENABLED() },
  };
};

const validateMovement = (body) => {
  if (!uuid(body?.request_id)) throw fail("Se requiere un identificador UUID del movimiento");
  if (!['RECEIPT', 'CONSUMPTION', 'COUNT'].includes(body?.operation)) throw fail("Tipo de movimiento inválido");
  const quantity = Number(body?.quantity);
  if (!Number.isSafeInteger(quantity) || (body.operation !== 'COUNT' && quantity <= 0) || quantity < 0 || quantity > 100000) {
    throw fail("La cantidad debe ser un entero válido entre 0 y 100.000 (ingresos y salidas mayores que 0)");
  }
  const warehouseId = integerId(body?.warehouse_id, "Bodega");
  const document = String(body?.document_reference ?? "").trim();
  if (document.length < 4 || document.length > 120) throw fail("Indica un motivo o documento de 4 a 120 caracteres");
  const unitCost = body.operation === 'RECEIPT' ? Number(body?.unit_cost) : null;
  if (body.operation === 'RECEIPT' && (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1000000000)) {
    throw fail("Indica el costo unitario de recepción (CLP, mayor o igual a cero)");
  }
  return { requestId: body.request_id, warehouseId, operation: body.operation, quantity, document, unitCost };
};

const publicMovement = (row) => ({
  request_id: row.request_id,
  product_id: row.product_id,
  operation: row.operation,
  status: row.status,
  quantity: Number(row.quantity),
  relbase_warehouse_id: Number(row.relbase_warehouse_id),
  before_stock: row.before_stock === null ? null : Number(row.before_stock),
  after_stock: row.after_stock === null ? null : Number(row.after_stock),
  relbase_adjustment_id: row.relbase_adjustment_id,
  error_message: row.error_message,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const getInventoryMovement = async ({ productId, requestId }) => {
  if (!uuid(productId) || !uuid(requestId)) throw fail("Identificador inválido");
  const result = await pool.query(
    `SELECT * FROM relbase_inventory_movements WHERE product_id = $1 AND request_id = $2 LIMIT 1`,
    [productId, requestId]
  );
  if (!result.rowCount) throw fail("Movimiento no encontrado", 404, "MOVEMENT_NOT_FOUND");
  return publicMovement(result.rows[0]);
};

export const registerInventoryMovement = async ({ productId, actorId, body }) => {
  if (!WRITE_ENABLED()) throw fail("La escritura de inventario está deshabilitada por configuración", 409, "INVENTORY_WRITE_DISABLED");
  if (!actorId) throw fail("No se pudo identificar al administrador", 401, "ACTOR_MISSING");
  const validated = validateMovement(body);
  const client = await pool.connect();
  let lockAcquired = false;
  let persisted = false;
  let externalApplied = false;
  let postAttempted = false;
  let before = null;
  const lockKey = `${productId}:${validated.warehouseId}`;
  const safeErrorMessage = (error) => {
    const raw = String(error?.relbaseData?.meta?.message || error?.message || "Error al registrar el movimiento");
    return raw.slice(0, 500);
  };

  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey]);
    lockAcquired = Boolean(lock.rows[0]?.locked);
    if (!lockAcquired) throw fail("Hay otro movimiento para este producto y bodega. Espera y vuelve a consultar.", 409, "MOVEMENT_BUSY");

    const product = await getProduct(productId, client);
    const connection = await getConnection(client);
    if (!connection.connected || !connection.write_authorized || !connection.read_authorized) {
      throw fail("Relbase no está conectado con permisos products:read, inventory:read e inventory:write. Reautoriza OAuth.", 409, "RELBASE_SCOPE_REQUIRED");
    }
    const warehouse = await getWarehouse(product.id, validated.warehouseId, client);
    const canonicalPayload = JSON.stringify({ productId: product.id, warehouseId: validated.warehouseId, operation: validated.operation, quantity: validated.quantity, document: validated.document, unitCost: validated.unitCost });
    const requestHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');
    const insert = await client.query(
      `INSERT INTO relbase_inventory_movements
       (request_id, product_id, product_sku, relbase_product_id, relbase_warehouse_id, actor_user_id,
        operation, quantity, unit_cost, document_reference, request_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROCESSING')
       ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
      [validated.requestId, product.id, product.sku, product.relbase_product_id, validated.warehouseId,
       String(actorId), validated.operation, validated.quantity, validated.unitCost, validated.document, requestHash]
    );
    if (!insert.rowCount) {
      const existing = await client.query(`SELECT * FROM relbase_inventory_movements WHERE request_id = $1`, [validated.requestId]);
      const row = existing.rows[0];
      if (row?.request_hash !== requestHash) throw fail("Este identificador ya pertenece a otro movimiento", 409, "IDEMPOTENCY_CONFLICT");
      if (row.status === 'SUCCEEDED' || row.status === 'SYNC_PENDING' || row.status === 'RELBASE_APPLIED') {
        return { ...publicMovement(row), already_registered: true };
      }
      throw fail(`Movimiento existente: ${row.status}. Revisa su estado; no se reenviará a Relbase automáticamente.`, 409, "MOVEMENT_ALREADY_EXISTS");
    }
    persisted = true;

    // Validar contra el stock real justo antes del POST, y no sólo contra el espejo de PostgreSQL.
    before = await liveStock(integerId(product.relbase_product_id, "Producto Relbase"), validated.warehouseId);
    const committed = Number(warehouse.reserved_quantity);
    const safety = Number(warehouse.safety_stock);

    /*
     * Un stock negativo en Relbase es un descuadre real,
     * no un error de lectura.
     *
     * Mientras permanezca negativo, no permitimos sumar
     * ni descontar unidades porque eso ocultaría el problema.
     * La regularización debe hacerse fijando el conteo físico.
     */
    if (
      before < 0 &&
      validated.operation !== "COUNT"
    ) {
      throw fail(
        `Relbase registra ${before} unidades. Regulariza primero con una toma física.`,
        409,
        "NEGATIVE_STOCK_REQUIRES_COUNT"
      );
    }
    if (validated.operation === 'CONSUMPTION' && (validated.quantity > before || before - validated.quantity < committed + safety)) {
      throw fail("La salida dejaría menos stock que el reservado y el stock de seguridad", 409, "RESERVATIONS_PROTECTED");
    }
    if (validated.operation === 'COUNT' && validated.quantity < committed + safety) {
      throw fail("La toma de inventario no puede quedar por debajo de reservas y stock de seguridad", 409, "RESERVATIONS_PROTECTED");
    }

    const relbaseProductId = integerId(product.relbase_product_id, 'Producto Relbase');
    const endpoints = {
      RECEIPT: '/api/v2/inventario/recepcion',
      CONSUMPTION: '/api/v2/inventario/consumo',
      COUNT: '/api/v2/inventario/toma-inventario',
    };
    const payload = {
      ware_house_id: validated.warehouseId,
      ...(validated.operation !== 'COUNT' ? { document: validated.document } : {}),
      items: [{ product_id: relbaseProductId, quantity: validated.quantity,
        ...(validated.operation === 'RECEIPT' ? { unit_cost: validated.unitCost } : {}) }],
    };
    // IMPORTANTÍSIMO: toda repetición interna (429) utiliza esta misma clave.
    postAttempted = true;
    const response = await relbaseRequest(endpoints[validated.operation], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': validated.requestId },
      body: JSON.stringify(payload),
    });
    const adjustmentId = response?.data?.data?.ajuste?.id;
    if (!adjustmentId || ![200, 201].includes(Number(response?.data?.meta?.code))) {
      throw fail("Relbase respondió sin confirmación completa del ajuste. Requiere conciliación manual.", 502, "RELBASE_AMBIGUOUS_CONFIRMATION");
    }
    externalApplied = true;
    await client.query(
      `UPDATE relbase_inventory_movements
          SET status = 'RELBASE_APPLIED', relbase_adjustment_id = $2,
              before_stock = $3, relbase_response = $4::jsonb, updated_at = NOW()
        WHERE request_id = $1`,
      [validated.requestId, String(adjustmentId), before, JSON.stringify({ adjustment_id: adjustmentId, meta: response.data.meta })]
    );

    try {
      const sync = await syncRelbaseProductInventory(product.id);
      const afterRow = sync?.inventory?.find((item) => Number(item.relbase_warehouse_id) === validated.warehouseId);
      const after = afterRow ? Number(afterRow.stock_quantity) : null;
      const expectedAfter = validated.operation === 'RECEIPT'
        ? before + validated.quantity
        : validated.operation === 'CONSUMPTION'
          ? before - validated.quantity
          : validated.quantity;
      if (after === null || !Number.isFinite(after) || Math.abs(after - expectedAfter) > 0.00001) {
        throw fail('El stock sincronizado no coincide con el movimiento previsto; revisar movimientos concurrentes en Relbase.', 409, 'STOCK_RECONCILIATION_REQUIRED');
      }
      const saved = await client.query(
        `UPDATE relbase_inventory_movements
            SET status = 'SUCCEEDED', after_stock = $2, sync_response = $3::jsonb, updated_at = NOW()
          WHERE request_id = $1 RETURNING *`,
        [validated.requestId, after, JSON.stringify({ sync_log_id: sync?.sync?.sync_log_id ?? null })]
      );
      return publicMovement(saved.rows[0]);
    } catch (syncError) {
      const saved = await client.query(
        `UPDATE relbase_inventory_movements
            SET status = 'SYNC_PENDING', error_message = $2, updated_at = NOW()
          WHERE request_id = $1 RETURNING *`,
        [validated.requestId, `Relbase confirmó; falló la sincronización local: ${safeErrorMessage(syncError)}`]
      );
      return publicMovement(saved.rows[0]);
    }
  } catch (error) {
    if (persisted) {
      // Después de intentar el POST, incluso una excepción de red deja el resultado ambiguo.
      // Si el POST todavía no se intentó, sabemos que no se modificó Relbase.
      // Tras intentar el POST, tratar cualquier timeout/error como resultado incierto.
      const definitive = !postAttempted;
      const status = definitive ? 'REJECTED' : 'REVIEW_REQUIRED';
      try {
        await client.query(
          `UPDATE relbase_inventory_movements
              SET status = $2, before_stock = $3, error_message = $4, updated_at = NOW()
            WHERE request_id = $1`,
          [validated.requestId, status, before, safeErrorMessage(error)]
        );
      } catch (dbError) {
        console.error('No se pudo registrar la incidencia de movimiento de inventario:', dbError);
      }
      if (!definitive) {
        throw fail(`Resultado de Relbase incierto. No repitas el movimiento; consulta el historial y concilia en Relbase. ID: ${validated.requestId}`, 409, 'REVIEW_REQUIRED');
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); }
      catch (unlockError) { console.error('No se pudo liberar bloqueo de inventario:', unlockError); }
    }
    client.release();
  }
};
