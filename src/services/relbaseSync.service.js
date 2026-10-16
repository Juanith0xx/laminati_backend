import pool from "../config/database.js";

import {
  relbaseRequest,
} from "./relbase.service.js";

/* =========================================
   EXTRAER URL DE IMAGEN PRINCIPAL
========================================= */
const getRelbaseImageUrl = (product) => {
  return (
    product?.image?.url ||
    product?.image?.large_thumb?.url ||
    product?.image?.small_thumb?.url ||
    null
  );
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
   EXTRAER PRODUCTOS DE RESPUESTA RELBASE

   Soporta:

   {
     data: [...]
   }

   y:

   {
     data: {
       resources: [...]
     }
   }
========================================= */
const extractRelbaseProducts = (
  responsePayload
) => {
  const responseData =
    responsePayload?.data;

  /*
   * FORMATO REAL RELBASE V2
   */
  if (
    Array.isArray(
      responseData?.products
    )
  ) {
    return responseData.products;
  }

  /*
   * FALLBACK:
   * data directamente como array
   */
  if (
    Array.isArray(responseData)
  ) {
    return responseData;
  }

  /*
   * FALLBACK:
   * data.resources
   */
  if (
    Array.isArray(
      responseData?.resources
    )
  ) {
    return responseData.resources;
  }

  /*
   * FALLBACK:
   * products directamente
   */
  if (
    Array.isArray(
      responsePayload?.products
    )
  ) {
    return responsePayload.products;
  }

  /*
   * FALLBACK:
   * resources directamente
   */
  if (
    Array.isArray(
      responsePayload?.resources
    )
  ) {
    return responsePayload.resources;
  }

  return null;
};

/* =========================================
   EXTRAER META RELBASE
========================================= */
const extractRelbaseMeta = (
  responsePayload
) => {
  return (
    responsePayload?.meta ||
    responsePayload?.data?.meta ||
    {}
  );
};

/* =========================================
   CALCULAR SIGUIENTE PÁGINA
========================================= */
const getNextPage = ({
  meta,
  requestedPage,
  resourcesLength,
  perPage,
}) => {
  const currentPage =
    Number(
      meta?.current_page ??
      meta?.page ??
      requestedPage
    );

  const totalPages =
    Number(
      meta?.total_pages ??
      meta?.total_page ??
      meta?.pages ??
      0
    );

  /*
   * Opción 1:
   * Relbase informa total_pages.
   */
  if (
    Number.isFinite(totalPages) &&
    totalPages > 0
  ) {
    if (
      Number.isFinite(currentPage) &&
      currentPage >= totalPages
    ) {
      return null;
    }

    if (
      Number.isFinite(currentPage)
    ) {
      return currentPage + 1;
    }
  }

  /*
   * Opción 2:
   * Relbase informa next_page.
   */
  const rawNextPage =
    meta?.next_page;

  if (
    rawNextPage !== undefined &&
    rawNextPage !== null &&
    rawNextPage !== false &&
    rawNextPage !== ""
  ) {
    const parsedNextPage =
      Number(rawNextPage);

    if (
      Number.isFinite(
        parsedNextPage
      ) &&
      parsedNextPage >
        requestedPage
    ) {
      return parsedNextPage;
    }
  }

  /*
   * Opción 3:
   * fallback por cantidad recibida.
   *
   * Si llegaron menos registros
   * que los solicitados, asumimos
   * última página.
   */
  if (
    resourcesLength < perPage
  ) {
    return null;
  }

  return requestedPage + 1;
};

/* =========================================
   UPSERT PRODUCTO EN STAGING
========================================= */
export const upsertStagingProduct = async (
  client,
  product
) => {
  const relbaseProductId =
    product?.id !== undefined &&
    product?.id !== null
      ? String(product.id)
      : null;

  if (!relbaseProductId) {
    throw new Error(
      "Producto Relbase sin id"
    );
  }

  const name =
    String(
      product?.name || ""
    ).trim();

  if (!name) {
    throw new Error(
      `Producto Relbase ${relbaseProductId} sin nombre`
    );
  }

  const result =
    await client.query(
      `
        INSERT INTO relbase_product_staging (
          relbase_product_id,

          code,
          name,
          description,

          price,
          price_sale,

          company_id,
          business_id,

          barcode,
          product_type,
          is_tax_affected,

          image_url,

          raw_payload,

          sync_status,

          last_seen_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,

          $5,
          $6,

          $7,
          $8,

          $9,
          $10,
          $11,

          $12,

          $13::jsonb,

          'PENDING',

          NOW()
        )

        ON CONFLICT (
          relbase_product_id
        )

        DO UPDATE SET

          code =
            EXCLUDED.code,

          name =
            EXCLUDED.name,

          description =
            EXCLUDED.description,

          price =
            EXCLUDED.price,

          price_sale =
            EXCLUDED.price_sale,

          company_id =
            EXCLUDED.company_id,

          business_id =
            EXCLUDED.business_id,

          barcode =
            EXCLUDED.barcode,

          product_type =
            EXCLUDED.product_type,

          is_tax_affected =
            EXCLUDED.is_tax_affected,

          image_url =
            EXCLUDED.image_url,

          raw_payload =
            EXCLUDED.raw_payload,

          last_seen_at =
            NOW()

        RETURNING
          id,
          relbase_product_id,
          code,
          name,
          sync_status,
          linked_product_id,
          last_seen_at
      `,
      [
        relbaseProductId,

        product?.code || null,
        name,
        product?.description ||
          null,

        normalizeNumber(
          product?.price
        ),

        normalizeNumber(
          product?.price_sale
        ),

        normalizeNumber(
          product?.company_id
        ),

        normalizeNumber(
          product?.business_id
        ),

        product?.barcode || null,

        product?.product_type ||
          null,

        typeof product
          ?.is_tax_affected ===
        "boolean"
          ? product
              .is_tax_affected
          : null,

        getRelbaseImageUrl(
          product
        ),

        JSON.stringify(product),
      ]
    );

  return result.rows[0];
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
          'PRODUCT',
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
   FINALIZAR LOG CORRECTAMENTE
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

        response_payload =
          $1::jsonb,

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
   MARCAR LOG COMO ERROR
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
   SINCRONIZAR PRODUCTOS
   RELBASE → STAGING
========================================= */
export const syncRelbaseProductsToStaging =
  async () => {
    let syncLogId = null;

    const perPage = 100;

    let page = 1;

    let pagesProcessed = 0;

    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    const errors = [];

    const seenRelbaseIds =
    new Set();

    const duplicatedRelbaseIds =
    new Set();

    try {
      /* =====================================
         CREAR LOG
      ===================================== */
      syncLogId =
        await createSyncLog();

      /* =====================================
         PAGINACIÓN RELBASE
      ===================================== */
      while (true) {
        const params =
          new URLSearchParams({
            page: String(page),

            per_page:
              String(perPage),
          });

        const result =
          await relbaseRequest(
            `/api/v2/productos?${params.toString()}`
          );

        /*
         * relbaseRequest devuelve:
         *
         * {
         *   data: <respuesta real Relbase>,
         *   rateLimit: {...}
         * }
         */
        const responsePayload =
          result?.data || null;

        const resources =
          extractRelbaseProducts(
            responsePayload
          );

        const meta =
          extractRelbaseMeta(
            responsePayload
          );

        /* =====================================
           VALIDAR FORMATO
        ===================================== */
        if (
          !Array.isArray(
            resources
          )
        ) {
          const responseData =
            responsePayload?.data;

          console.error(
            "Formato inesperado de productos Relbase:",
            {
              payload_type:
                typeof responsePayload,

              payload_keys:
                responsePayload &&
                typeof responsePayload ===
                  "object"
                  ? Object.keys(
                      responsePayload
                    )
                  : [],

              data_is_array:
                Array.isArray(
                  responseData
                ),

              data_keys:
                responseData &&
                typeof responseData ===
                  "object" &&
                !Array.isArray(
                  responseData
                )
                  ? Object.keys(
                      responseData
                    )
                  : [],

              meta,
            }
          );

          throw new Error(
            "Relbase respondió con un formato de productos inesperado"
          );
        }

        pagesProcessed += 1;

        console.log(
          "Relbase productos:",
          {
            page,

            received:
              resources.length,

            meta,

            rate_limit:
              result?.rateLimit ||
              null,
          }
        );

        /*
         * Sin productos:
         * fin de paginación.
         */
        if (
          resources.length === 0
        ) {
          break;
        }

        /* =====================================
           TRANSACCIÓN POR PÁGINA
        ===================================== */
        const client =
          await pool.connect();

        try {
          await client.query(
            "BEGIN"
          );

          for (
            const product of
            resources
          ) {
            const currentRelbaseId =
            product?.id !== undefined &&
            product?.id !== null
                ? String(product.id)
                : null;

            if (currentRelbaseId) {
            if (
                seenRelbaseIds.has(
                currentRelbaseId
                )
            ) {
                duplicatedRelbaseIds.add(
                currentRelbaseId
                );
            } else {
                seenRelbaseIds.add(
                currentRelbaseId
                );
            }
            }
            totalProcessed += 1;

            /*
             * SAVEPOINT individual:
             *
             * Si un producto produce
             * un error SQL, PostgreSQL
             * no invalida toda la
             * transacción de la página.
             */
            await client.query(
              "SAVEPOINT relbase_product_sync"
            );

            try {
              await upsertStagingProduct(
                client,
                product
              );

              await client.query(
                "RELEASE SAVEPOINT relbase_product_sync"
              );

              totalSuccess += 1;
            } catch (
              productError
            ) {
              try {
                await client.query(
                  "ROLLBACK TO SAVEPOINT relbase_product_sync"
                );

                await client.query(
                  "RELEASE SAVEPOINT relbase_product_sync"
                );
              } catch (
                rollbackError
              ) {
                console.error(
                  "Error haciendo rollback de producto Relbase:",
                  rollbackError
                );

                throw rollbackError;
              }

              totalFailed += 1;

              errors.push({
                relbase_product_id:
                  product?.id ||
                  null,

                code:
                  product?.code ||
                  null,

                message:
                  productError
                    ?.message ||
                  "Error desconocido",
              });

              console.error(
                "Error sincronizando producto Relbase:",
                {
                  id:
                    product?.id ||
                    null,

                  code:
                    product?.code ||
                    null,

                  message:
                    productError
                      ?.message ||
                    null,
                }
              );
            }
          }

          await client.query(
            "COMMIT"
          );
        } catch (
          pageError
        ) {
          try {
            await client.query(
              "ROLLBACK"
            );
          } catch (
            rollbackError
          ) {
            console.error(
              "Error haciendo rollback de página Relbase:",
              rollbackError
            );
          }

          throw pageError;
        } finally {
          client.release();
        }

        /* =====================================
           CALCULAR SIGUIENTE PÁGINA
        ===================================== */
        const nextPage =
          getNextPage({
            meta,

            requestedPage:
              page,

            resourcesLength:
              resources.length,

            perPage,
          });

        /*
         * No existe siguiente página.
         */
        if (
          nextPage === null
        ) {
          break;
        }

        /*
         * Protección contra
         * paginación circular.
         */
        if (
          nextPage <= page
        ) {
          throw new Error(
            `Relbase devolvió una paginación inválida. Página actual: ${page}, siguiente página: ${nextPage}`
          );
        }

        page = nextPage;

        /*
         * Límite de seguridad.
         */
        if (
          pagesProcessed >=
          10000
        ) {
          throw new Error(
            "La paginación Relbase superó el límite de seguridad"
          );
        }
      }

      /* =====================================
         RESUMEN
      ===================================== */
      const summary = {
  pages_processed:
    pagesProcessed,

  total_processed:
    totalProcessed,

  total_unique:
    seenRelbaseIds.size,

  total_duplicates:
    duplicatedRelbaseIds.size,

  duplicated_relbase_ids:
    Array.from(
      duplicatedRelbaseIds
    ),

  total_success:
    totalSuccess,

  total_failed:
    totalFailed,

  errors:
    errors.slice(
      0,
      100
    ),
};

      /* =====================================
         CERRAR LOG
      ===================================== */
      await completeSyncLog(
        syncLogId,
        summary
      );

      return {
        sync_log_id:
          syncLogId,

        ...summary,
      };
    } catch (error) {
      /* =====================================
         MARCAR ERROR EN LOG
      ===================================== */
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
            "No fue posible actualizar el log de sincronización Relbase:",
            logError
          );
        }
      }

      throw error;
    }
  };