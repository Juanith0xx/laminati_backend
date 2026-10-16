import pool from "../config/database.js";

import {
  syncRelbaseProductsToStaging,
} from "./relbaseSync.service.js";

import {
  syncRelbaseProductInventory,
} from "./relbaseInventory.service.js";

/* =========================================
   ESPERA
========================================= */
const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

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
   NORMALIZAR NÚMERO
========================================= */
const normalizeNumber = (value) => {
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
   PRECIO BASE WEB

   Relbase:
   price      = neto
   price_sale = precio venta

   Laminatiword:
   base_price = precio comercial Relbase
========================================= */
const getRelbaseBasePrice = (
  stagingProduct
) => {
  const priceSale =
    normalizeNumber(
      stagingProduct.price_sale
    );

  if (
    priceSale !== null &&
    priceSale >= 0
  ) {
    return priceSale;
  }

  const price =
    normalizeNumber(
      stagingProduct.price
    );

  if (
    price !== null &&
    price >= 0
  ) {
    return price;
  }

  return null;
};

/* =========================================
   ACTUALIZAR PRECIO DE UN PRODUCTO
========================================= */
const updateProductPrice = async (
  product
) => {
  const basePrice =
    getRelbaseBasePrice(product);

  if (basePrice === null) {
    throw createServiceError(
      `El producto Relbase ${product.relbase_product_id} no posee un precio válido`,
      400,
      "RELBASE_PRICE_INVALID"
    );
  }

  const taxRate =
    product.is_tax_affected === false
      ? 0
      : 19;

  const result =
    await pool.query(
      `
        UPDATE products

        SET
          base_price = $1,
          tax_rate = $2

        WHERE id = $3

        RETURNING
          id,
          sku,
          relbase_product_id,
          name,
          base_price,
          tax_rate,
          is_active,
          is_published,
          allow_sale,
          updated_at
      `,
      [
        basePrice,
        taxRate,
        product.product_id,
      ]
    );

  if (result.rowCount === 0) {
    throw createServiceError(
      `No se encontró el producto Laminatiword ${product.product_id}`,
      404,
      "PRODUCT_NOT_FOUND"
    );
  }

  return result.rows[0];
};

/* =========================================
   OBTENER PRODUCTOS IMPORTADOS

   IMPORTANTE:
   Sólo sincronizamos productos que ya
   fueron aprobados/importados por ADMIN.
========================================= */
const getImportedProducts = async () => {
  const result =
    await pool.query(
      `
        SELECT
          rps.id
            AS staging_id,

          rps.relbase_product_id,
          rps.code,
          rps.name,
          rps.price,
          rps.price_sale,
          rps.is_tax_affected,
          rps.product_type,
          rps.sync_status,
          rps.linked_product_id,

          p.id
            AS product_id,

          p.sku,
          p.base_price
            AS current_base_price,

          p.tax_rate
            AS current_tax_rate,

          p.is_active,
          p.is_published,
          p.allow_sale

        FROM relbase_product_staging rps

        INNER JOIN products p
          ON p.id =
             rps.linked_product_id

        WHERE
          rps.sync_status =
            'IMPORTED'

          AND
          rps.linked_product_id
            IS NOT NULL

          AND
          rps.product_type =
            'product'

        ORDER BY
          rps.name ASC
      `
    );

  return result.rows;
};

/* =========================================
   SINCRONIZACIÓN GENERAL RELBASE
========================================= */
export const syncAllImportedRelbaseProducts =
  async () => {
    /*
     * Usamos PostgreSQL advisory lock
     * para evitar dos sincronizaciones
     * generales simultáneas.
     *
     * Esto también funcionará cuando el
     * backend esté desplegado en Railway.
     */
    const lockClient =
      await pool.connect();

    let lockAcquired = false;

    try {
      /* =====================================
         BLOQUEO
      ===================================== */
      const lockResult =
        await lockClient.query(
          `
            SELECT
              pg_try_advisory_lock(
                hashtext(
                  'LAMINATIWORD_RELBASE_BULK_SYNC'
                )
              ) AS locked
          `
        );

      lockAcquired =
        lockResult.rows[0]?.locked ===
        true;

      if (!lockAcquired) {
        throw createServiceError(
          "Ya existe una sincronización general de Relbase en proceso",
          409,
          "RELBASE_SYNC_ALREADY_RUNNING"
        );
      }

      const startedAt =
        new Date();

      /* =====================================
         PASO 1
         ACTUALIZAR STAGING
      ===================================== */
      console.log(
        "Relbase Sync General: actualizando staging..."
      );

      const stagingSync =
        await syncRelbaseProductsToStaging();

      /* =====================================
         PASO 2
         PRODUCTOS YA IMPORTADOS
      ===================================== */
      const importedProducts =
        await getImportedProducts();

      console.log(
        "Relbase Sync General:",
        {
          imported_products:
            importedProducts.length,
        }
      );

      let totalProcessed = 0;
      let totalSuccess = 0;
      let totalFailed = 0;

      let pricesUpdated = 0;
      let inventoriesUpdated = 0;

      const results = [];
      const errors = [];

      /* =====================================
         PASO 3
         PRECIO + INVENTARIO
      ===================================== */
      for (
        const product of
        importedProducts
      ) {
        totalProcessed += 1;

        const productResult = {
          product_id:
            product.product_id,

          relbase_product_id:
            product.relbase_product_id,

          sku:
            product.sku,

          name:
            product.name,

          price:
            null,

          inventory:
            null,

          success:
            false,
        };

        try {
          /* =================================
             PRECIO
          ================================= */
          const oldBasePrice =
            normalizeNumber(
              product.current_base_price
            );

          const updatedProduct =
            await updateProductPrice(
              product
            );

          const newBasePrice =
            normalizeNumber(
              updatedProduct.base_price
            );

          productResult.price = {
            previous:
              oldBasePrice,

            current:
              newBasePrice,

            changed:
              oldBasePrice !==
              newBasePrice,
          };

          pricesUpdated += 1;

          /* =================================
             INVENTARIO
          ================================= */
          const inventoryResult =
            await syncRelbaseProductInventory(
              product.product_id
            );

          productResult.inventory = {
            warehouses:
              inventoryResult
                ?.inventory
                ?.length || 0,

            synchronized:
              true,
          };

          inventoriesUpdated += 1;

          productResult.success =
            true;

          totalSuccess += 1;
        } catch (
          productError
        ) {
          totalFailed += 1;

          productResult.success =
            false;

          productResult.error =
            productError.message;

          errors.push({
            product_id:
              product.product_id,

            relbase_product_id:
              product.relbase_product_id,

            sku:
              product.sku,

            message:
              productError.message,

            code:
              productError.code ||
              null,

            status:
              productError.status ||
              null,
          });

          console.error(
            "Error sincronizando producto Relbase:",
            {
              product_id:
                product.product_id,

              relbase_product_id:
                product.relbase_product_id,

              sku:
                product.sku,

              message:
                productError.message,
            }
          );
        }

        results.push(
          productResult
        );

        /*
         * Pequeña separación entre productos.
         *
         * relbaseRequest ya controla
         * respuestas 429, pero esto reduce
         * solicitudes agresivas al sincronizar
         * muchos productos.
         */
        await sleep(250);
      }

      const completedAt =
        new Date();

      const durationMs =
        completedAt.getTime() -
        startedAt.getTime();

      return {
        started_at:
          startedAt.toISOString(),

        completed_at:
          completedAt.toISOString(),

        duration_ms:
          durationMs,

        staging: {
          pages_processed:
            stagingSync
              .pages_processed,

          total_processed:
            stagingSync
              .total_processed,

          total_unique:
            stagingSync
              .total_unique,

          total_duplicates:
            stagingSync
              .total_duplicates,

          total_failed:
            stagingSync
              .total_failed,
        },

        imported_products: {
          total:
            importedProducts.length,

          processed:
            totalProcessed,

          success:
            totalSuccess,

          failed:
            totalFailed,
        },

        synchronization: {
          prices_updated:
            pricesUpdated,

          inventories_updated:
            inventoriesUpdated,
        },

        errors:
          errors.slice(0, 100),

        results,
      };
    } finally {
      /* =====================================
         LIBERAR BLOQUEO
      ===================================== */
      if (lockAcquired) {
        try {
          await lockClient.query(
            `
              SELECT
                pg_advisory_unlock(
                  hashtext(
                    'LAMINATIWORD_RELBASE_BULK_SYNC'
                  )
                )
            `
          );
        } catch (
          unlockError
        ) {
          console.error(
            "Error liberando lock Relbase:",
            unlockError
          );
        }
      }

      lockClient.release();
    }
  };