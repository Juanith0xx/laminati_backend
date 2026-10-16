import pool from "../config/database.js";

import {
  relbaseRequest,
} from "./relbase.service.js";

/* =========================================
   ERROR CONTROLADO
========================================= */
const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error = new Error(message);

  error.status = status;
  error.code = code;

  return error;
};

/* =========================================
   NORMALIZAR STOCK

   Si Relbase llegara a entregar stock
   negativo, Laminatiword lo considera 0
   para evitar disponibilidad web negativa.
========================================= */
const normalizeStock = (value) => {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(number, 0);
};

/* =========================================
   NORMALIZAR NÚMERO OPCIONAL
========================================= */
const normalizeNullableNumber = (
  value
) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
};

/* =========================================
   CREAR LOG DE SINCRONIZACIÓN
========================================= */
const createSyncLog = async () => {
  const result =
    await pool.query(
      `
        INSERT INTO relbase_sync_logs (
          entity_type,
          operation,
          direction,
          status,
          attempts,
          started_at
        )
        VALUES (
          'INVENTORY',
          'SYNC',
          'RELBASE_TO_WEB',
          'PENDING',
          1,
          NOW()
        )

        RETURNING id
      `
    );

  return result.rows[0].id;
};

/* =========================================
   FINALIZAR LOG
========================================= */
const completeSyncLog = async (
  logId,
  summary
) => {
  await pool.query(
    `
      UPDATE relbase_sync_logs

      SET
        status = 'SUCCESS',
        response_payload = $1::jsonb,
        error_message = NULL,
        completed_at = NOW()

      WHERE id = $2
    `,
    [
      JSON.stringify(summary),
      logId,
    ]
  );
};

/* =========================================
   MARCAR LOG ERROR
========================================= */
const failSyncLog = async (
  logId,
  error
) => {
  await pool.query(
    `
      UPDATE relbase_sync_logs

      SET
        status = 'FAILED',
        error_message = $1,
        completed_at = NOW()

      WHERE id = $2
    `,
    [
      error?.message ||
        "Error desconocido",

      logId,
    ]
  );
};

/* =========================================
   SINCRONIZAR INVENTARIO DE UN PRODUCTO
========================================= */
export const syncRelbaseProductInventory =
  async (productId) => {
    let syncLogId = null;

    try {
      /* =====================================
         BUSCAR PRODUCTO LOCAL
      ===================================== */
      const productResult =
        await pool.query(
          `
            SELECT
              id,
              sku,
              name,
              relbase_product_id

            FROM products

            WHERE id::text = $1

            LIMIT 1
          `,
          [String(productId)]
        );

      if (
        productResult.rowCount === 0
      ) {
        throw createServiceError(
          "El producto Laminatiword no existe",
          404,
          "PRODUCT_NOT_FOUND"
        );
      }

      const product =
        productResult.rows[0];

      if (
        !product.relbase_product_id
      ) {
        throw createServiceError(
          "El producto no se encuentra asociado a Relbase",
          400,
          "RELBASE_PRODUCT_ID_MISSING"
        );
      }

      /* =====================================
         CREAR LOG
      ===================================== */
      syncLogId =
        await createSyncLog();

      /* =====================================
         CONSULTAR STOCK REAL RELBASE
      ===================================== */
      const relbaseResult =
        await relbaseRequest(
          `/api/v2/productos/${product.relbase_product_id}/stock_por_bodegas`
        );

      const payload =
        relbaseResult?.data || null;

      const stocks =
        payload?.data?.stocks;

      if (
        !Array.isArray(stocks)
      ) {
        throw new Error(
          "Relbase respondió con un formato de inventario inesperado"
        );
      }

      /* =====================================
         TRANSACCIÓN LOCAL
      ===================================== */
      const client =
        await pool.connect();

      const syncedInventory = [];

      try {
        await client.query(
          "BEGIN"
        );

        const returnedWarehouseIds =
          [];

        /* ===================================
           UPSERT BODEGAS
        =================================== */
        for (
          const stock of stocks
        ) {
          const warehouseId =
            Number(
              stock?.ware_house_id
            );

          if (
            !Number.isFinite(
              warehouseId
            )
          ) {
            throw new Error(
              `Relbase devolvió una bodega inválida para el producto ${product.relbase_product_id}`
            );
          }

          returnedWarehouseIds.push(
            warehouseId
          );

          const warehouseCode =
            `RELBASE-${warehouseId}`;

          const warehouseName =
            String(
              stock?.name ||
                `Bodega ${warehouseId}`
            ).trim();

          const stockQuantity =
            normalizeStock(
              stock?.current_stock
            );

          const averageCost =
            normalizeNullableNumber(
              stock?.average_cost
            );

          const location =
            stock?.location !==
              undefined &&
            stock?.location !== null
              ? String(
                  stock.location
                ).trim()
              : null;

          const inventoryResult =
            await client.query(
              `
                INSERT INTO inventory (
                  product_id,

                  warehouse_code,
                  warehouse_name,
                  relbase_warehouse_id,

                  stock_quantity,

                  average_cost,
                  location,

                  last_sync_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6,
                  $7,
                  NOW()
                )

                ON CONFLICT (
                  product_id,
                  relbase_warehouse_id
                )
                WHERE
                  relbase_warehouse_id
                  IS NOT NULL

                DO UPDATE SET

                  warehouse_code =
                    EXCLUDED.warehouse_code,

                  warehouse_name =
                    EXCLUDED.warehouse_name,

                  stock_quantity =
                    EXCLUDED.stock_quantity,

                  average_cost =
                    EXCLUDED.average_cost,

                  location =
                    EXCLUDED.location,

                  last_sync_at =
                    NOW()

                RETURNING
                  id,
                  product_id,

                  warehouse_code,
                  warehouse_name,
                  relbase_warehouse_id,

                  stock_quantity,
                  reserved_quantity,
                  safety_stock,

                  average_cost,
                  location,

                  last_sync_at
              `,
              [
                product.id,

                warehouseCode,
                warehouseName,
                warehouseId,

                stockQuantity,

                averageCost,
                location,
              ]
            );

          syncedInventory.push(
            inventoryResult.rows[0]
          );
        }

        /* ===================================
           BODEGAS QUE YA NO VIENEN DE RELBASE

           Para evitar stock antiguo/fantasma,
           cualquier bodega Relbase previamente
           asociada al producto que ya no venga
           en la respuesta queda con stock 0.

           NO modifica safety_stock.
           NO modifica reserved_quantity.
        =================================== */
        if (
          returnedWarehouseIds.length >
          0
        ) {
          await client.query(
            `
              UPDATE inventory

              SET
                stock_quantity = 0,
                last_sync_at = NOW()

              WHERE
                product_id = $1

                AND
                relbase_warehouse_id
                  IS NOT NULL

                AND NOT (
                  relbase_warehouse_id =
                  ANY($2::BIGINT[])
                )
            `,
            [
              product.id,
              returnedWarehouseIds,
            ]
          );
        } else {
          /*
           * Relbase respondió sin bodegas:
           * todo stock proveniente de Relbase
           * para este producto queda en 0.
           */
          await client.query(
            `
              UPDATE inventory

              SET
                stock_quantity = 0,
                last_sync_at = NOW()

              WHERE
                product_id = $1

                AND
                relbase_warehouse_id
                  IS NOT NULL
            `,
            [product.id]
          );
        }

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {
          // Transacción finalizada.
        }

        throw error;
      } finally {
        client.release();
      }

      /* =====================================
         RESUMEN
      ===================================== */
      const summary = {
        product_id:
          product.id,

        relbase_product_id:
          product.relbase_product_id,

        sku:
          product.sku,

        warehouses_received:
          stocks.length,

        inventories_updated:
          syncedInventory.length,
      };

      await completeSyncLog(
        syncLogId,
        summary
      );

      return {
        product: {
          id:
            product.id,

          sku:
            product.sku,

          name:
            product.name,

          relbase_product_id:
            product.relbase_product_id,
        },

        inventory:
          syncedInventory,

        relbase_meta:
          payload?.meta || null,

        sync: {
          sync_log_id:
            syncLogId,

          ...summary,
        },
      };
    } catch (error) {
      if (syncLogId) {
        try {
          await failSyncLog(
            syncLogId,
            error
          );
        } catch (
          logError
        ) {
          console.error(
            "Error actualizando log de inventario Relbase:",
            logError
          );
        }
      }

      throw error;
    }
  };