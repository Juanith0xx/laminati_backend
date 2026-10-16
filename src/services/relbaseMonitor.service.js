import pool from "../config/database.js";

/* =========================================
   CONFIGURACIÓN
========================================= */

const getStaleMinutes = () => {
  const value =
    Number(
      process.env
        .RELBASE_MONITOR_STALE_MINUTES
    );

  if (
    Number.isFinite(value) &&
    value > 0
  ) {
    return value;
  }

  /*
   * Cron actual: cada 30 minutos.
   *
   * Consideramos advertencia si pasan
   * 90 minutos sin sincronización correcta.
   */
  return 90;
};

/* =========================================
   CALCULAR MINUTOS TRANSCURRIDOS
========================================= */

const getMinutesAgo = (date) => {
  if (!date) {
    return null;
  }

  const timestamp =
    new Date(date).getTime();

  if (
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  return Math.max(
    Math.floor(
      (Date.now() - timestamp) /
        60000
    ),
    0
  );
};

/* =========================================
   ESTADO GENERAL RELBASE
========================================= */

export const getRelbaseMonitorStatus =
  async () => {
    const staleMinutes =
      getStaleMinutes();

    /* =====================================
       1. CONEXIÓN OAUTH
    ===================================== */

    const connectionResult =
      await pool.query(
        `
          SELECT
            id,
            provider,
            token_type,
            scope,

            access_expires_at,

            connected_at,
            last_refreshed_at,

            is_active,

            created_at,
            updated_at

          FROM relbase_oauth_connections

          WHERE provider = 'RELBASE'

          LIMIT 1
        `
      );

    const connection =
      connectionResult.rows[0] ||
      null;

    /* =====================================
       2. ESTADÍSTICAS STAGING
    ===================================== */

    const stagingResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::INTEGER
              AS total,

            COUNT(*) FILTER (
              WHERE
                sync_status =
                'PENDING'
            )::INTEGER
              AS pending,

            COUNT(*) FILTER (
              WHERE
                sync_status =
                'IMPORTED'
            )::INTEGER
              AS imported,

            COUNT(*) FILTER (
              WHERE
                sync_status =
                'IGNORED'
            )::INTEGER
              AS ignored,

            COUNT(*) FILTER (
              WHERE
                sync_status =
                'ERROR'
            )::INTEGER
              AS errors,

            COUNT(*) FILTER (
              WHERE
                product_type =
                'product'
            )::INTEGER
              AS products,

            COUNT(*) FILTER (
              WHERE
                product_type =
                'service'
            )::INTEGER
              AS services,

            MAX(last_seen_at)
              AS last_seen_at,

            MAX(imported_at)
              AS last_imported_at

          FROM relbase_product_staging
        `
      );

    const staging =
      stagingResult.rows[0];

    /* =====================================
       3. ÚLTIMA SYNC PRODUCTOS
    ===================================== */

    const productSyncResult =
      await pool.query(
        `
          SELECT
            id,
            entity_type,
            operation,
            direction,
            status,
            attempts,

            started_at,
            completed_at,

            error_message,
            response_payload

          FROM relbase_sync_logs

          WHERE
            entity_type =
            'PRODUCT'

            AND
            operation =
            'SYNC'

            AND
            direction =
            'RELBASE_TO_WEB'

          ORDER BY
            started_at DESC

          LIMIT 1
        `
      );

    const lastProductSync =
      productSyncResult.rows[0] ||
      null;

    /* =====================================
       4. ÚLTIMA SYNC INVENTARIO
    ===================================== */

    const inventorySyncResult =
      await pool.query(
        `
          SELECT
            id,
            entity_type,
            operation,
            direction,
            status,
            attempts,

            started_at,
            completed_at,

            error_message,
            response_payload

          FROM relbase_sync_logs

          WHERE
            entity_type =
            'INVENTORY'

            AND
            operation =
            'SYNC'

            AND
            direction =
            'RELBASE_TO_WEB'

          ORDER BY
            started_at DESC

          LIMIT 1
        `
      );

    const lastInventorySync =
      inventorySyncResult.rows[0] ||
      null;

    /* =====================================
       5. ERRORES ÚLTIMAS 24 HORAS
    ===================================== */

    /*
     * Todos los errores ocurridos durante
     * las últimas 24 horas.
     *
     * Esto es histórico y NO necesariamente
     * representa un problema vigente.
     */
    const errors24hResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::INTEGER
              AS total

          FROM relbase_sync_logs

          WHERE
            status =
            'FAILED'

            AND
            started_at >=
              NOW()
              - INTERVAL '24 hours'
        `
      );

    const errors24h =
      errors24hResult
        .rows[0]
        ?.total || 0;

    /* =====================================
       ERRORES ACTIVOS / NO RECUPERADOS
    ===================================== */

    /*
     * Un error se considera recuperado cuando
     * existe posteriormente una sincronización
     * SUCCESS para la misma:
     *
     * - entity_type
     * - operation
     * - direction
     *
     * De esta manera un error antiguo no deja
     * el monitor permanentemente en WARNING.
     */
    const unresolvedErrorsResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::INTEGER
              AS total

          FROM relbase_sync_logs failed

          WHERE
            failed.status =
              'FAILED'

            AND
            failed.started_at >=
              NOW()
              - INTERVAL '24 hours'

            AND NOT EXISTS (
              SELECT 1

              FROM relbase_sync_logs success

              WHERE
                success.entity_type =
                  failed.entity_type

                AND
                success.operation =
                  failed.operation

                AND
                success.direction =
                  failed.direction

                AND
                success.status =
                  'SUCCESS'

                AND
                success.started_at >
                  failed.started_at
            )
        `
      );

    const unresolvedErrors =
      unresolvedErrorsResult
        .rows[0]
        ?.total || 0;

    /* =====================================
       ERRORES RECUPERADOS
    ===================================== */

    const recoveredErrors =
      Math.max(
        errors24h -
          unresolvedErrors,
        0
      );

    /* =====================================
       6. ÚLTIMOS ERRORES
    ===================================== */

    const recentErrorsResult =
      await pool.query(
        `
          SELECT
            id,
            entity_type,
            operation,
            direction,
            status,

            attempts,

            error_message,

            started_at,
            completed_at

          FROM relbase_sync_logs

          WHERE
            status =
            'FAILED'

          ORDER BY
            started_at DESC

          LIMIT 10
        `
      );

    /* =====================================
       7. PRODUCTOS IMPORTADOS
          SIN INVENTARIO
    ===================================== */

    const missingInventoryResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::INTEGER
              AS total

          FROM products p

          INNER JOIN
            relbase_product_staging rps

            ON
              rps.linked_product_id =
              p.id

          WHERE
            rps.sync_status =
              'IMPORTED'

            AND
            rps.product_type =
              'product'

            AND NOT EXISTS (
              SELECT 1

              FROM inventory i

              WHERE
                i.product_id =
                p.id

                AND
                i.relbase_warehouse_id
                  IS NOT NULL
            )
        `
      );

    const productsWithoutInventory =
      missingInventoryResult
        .rows[0]
        ?.total || 0;

    /* =====================================
       8. INVENTARIO DESACTUALIZADO
    ===================================== */

    const staleInventoryResult =
      await pool.query(
        `
          SELECT
            COUNT(DISTINCT p.id)::INTEGER
              AS total

          FROM products p

          INNER JOIN
            relbase_product_staging rps

            ON
              rps.linked_product_id =
              p.id

          INNER JOIN
            inventory i

            ON
              i.product_id =
              p.id

          WHERE
            rps.sync_status =
              'IMPORTED'

            AND
            rps.product_type =
              'product'

            AND
            i.relbase_warehouse_id
              IS NOT NULL

            AND (
              i.last_sync_at
                IS NULL

              OR

              i.last_sync_at <
                NOW()
                - (
                    $1 *
                    INTERVAL '1 minute'
                  )
            )
        `,
        [
          staleMinutes,
        ]
      );

    const staleInventoryProducts =
      staleInventoryResult
        .rows[0]
        ?.total || 0;

    /* =====================================
       9. CALCULAR ESTADO CONEXIÓN
    ===================================== */

    let connectionStatus =
      "DISCONNECTED";

    let tokenStatus =
      "UNKNOWN";

    if (
      connection &&
      connection.is_active
    ) {
      connectionStatus =
        "CONNECTED";

      const expiresAt =
        connection.access_expires_at
          ? new Date(
              connection
                .access_expires_at
            ).getTime()
          : null;

      if (
        Number.isFinite(expiresAt)
      ) {
        const remainingMs =
          expiresAt -
          Date.now();

        if (remainingMs <= 0) {
          /*
           * No necesariamente es error:
           * nuestro servicio lo refresca
           * automáticamente.
           */
          tokenStatus =
            "EXPIRED_REFRESHABLE";
        } else if (
          remainingMs <=
          2 * 60 * 1000
        ) {
          tokenStatus =
            "EXPIRING";
        } else {
          tokenStatus =
            "VALID";
        }
      }
    }

    /* =====================================
       10. TIEMPOS
    ===================================== */

    const productSyncMinutesAgo =
      getMinutesAgo(
        lastProductSync
          ?.completed_at ||
        lastProductSync
          ?.started_at
      );

    const inventorySyncMinutesAgo =
      getMinutesAgo(
        lastInventorySync
          ?.completed_at ||
        lastInventorySync
          ?.started_at
      );

    /* =====================================
       11. DETECTAR PROBLEMAS
    ===================================== */

    const issues = [];

    /* -------------------------------------
       CONEXIÓN
    ------------------------------------- */

    if (!connection) {
      issues.push({
        severity: "ERROR",
        code:
          "RELBASE_NOT_CONNECTED",
        message:
          "No existe una conexión configurada con Relbase",
      });
    } else if (
      !connection.is_active
    ) {
      issues.push({
        severity: "ERROR",
        code:
          "RELBASE_CONNECTION_INACTIVE",
        message:
          "La conexión con Relbase se encuentra desactivada",
      });
    }

    /* -------------------------------------
       ÚLTIMA SYNC PRODUCTOS
    ------------------------------------- */

    if (!lastProductSync) {
      issues.push({
        severity: "WARNING",
        code:
          "PRODUCT_SYNC_NOT_FOUND",
        message:
          "No existen registros de sincronización de productos",
      });
    } else if (
      lastProductSync.status ===
      "FAILED"
    ) {
      issues.push({
        severity: "ERROR",
        code:
          "LAST_PRODUCT_SYNC_FAILED",
        message:
          lastProductSync
            .error_message ||
          "La última sincronización de productos falló",
      });
    }

    if (
      productSyncMinutesAgo !==
        null &&
      productSyncMinutesAgo >
        staleMinutes
    ) {
      issues.push({
        severity: "WARNING",
        code:
          "PRODUCT_SYNC_STALE",
        message:
          `La última sincronización de productos fue hace ${productSyncMinutesAgo} minutos`,
      });
    }

    /* -------------------------------------
       ERRORES RECIENTES
    ------------------------------------- */

    if (unresolvedErrors > 0) {
      issues.push({
        severity: "WARNING",
        code:
          "UNRESOLVED_SYNC_ERRORS",
        message:
          `Se detectaron ${unresolvedErrors} errores de sincronización que todavía no registran una recuperación exitosa`,
      });
    }

    /* -------------------------------------
       INVENTARIO FALTANTE
    ------------------------------------- */

    if (
      productsWithoutInventory > 0
    ) {
      issues.push({
        severity: "WARNING",
        code:
          "IMPORTED_PRODUCTS_WITHOUT_INVENTORY",
        message:
          `${productsWithoutInventory} productos importados no poseen inventario sincronizado`,
      });
    }

    /* -------------------------------------
       INVENTARIO ANTIGUO
    ------------------------------------- */

    if (
      staleInventoryProducts > 0
    ) {
      issues.push({
        severity: "WARNING",
        code:
          "STALE_INVENTORY",
        message:
          `${staleInventoryProducts} productos poseen inventario desactualizado`,
      });
    }

    /* -------------------------------------
       ERRORES STAGING
    ------------------------------------- */

    if (
      Number(staging.errors) > 0
    ) {
      issues.push({
        severity: "WARNING",
        code:
          "STAGING_PRODUCTS_WITH_ERROR",
        message:
          `${staging.errors} productos de staging se encuentran en estado ERROR`,
      });
    }

    /* =====================================
       12. ESTADO GENERAL
    ===================================== */

    let overallStatus =
      "HEALTHY";

    if (
      issues.some(
        (issue) =>
          issue.severity ===
          "ERROR"
      )
    ) {
      overallStatus =
        "ERROR";
    } else if (
      issues.length > 0
    ) {
      overallStatus =
        "WARNING";
    }

    /* =====================================
       RESPUESTA
    ===================================== */

    return {
      status:
        overallStatus,

      checked_at:
        new Date()
          .toISOString(),

      configuration: {
        auto_sync_enabled:
          String(
            process.env
              .RELBASE_AUTO_SYNC_ENABLED ||
              "false"
          ).toLowerCase() ===
          "true",

        cron:
          process.env
            .RELBASE_SYNC_CRON ||
          null,

        timezone:
          process.env
            .RELBASE_SYNC_TIMEZONE ||
          "America/Santiago",

        stale_after_minutes:
          staleMinutes,
      },

      connection: {
        status:
          connectionStatus,

        token_status:
          tokenStatus,

        is_active:
          connection
            ?.is_active ||
          false,

        scope:
          connection?.scope ||
          null,

        connected_at:
          connection
            ?.connected_at ||
          null,

        last_refreshed_at:
          connection
            ?.last_refreshed_at ||
          null,

        access_expires_at:
          connection
            ?.access_expires_at ||
          null,
      },

      catalog: {
        total:
          Number(
            staging.total || 0
          ),

        pending:
          Number(
            staging.pending || 0
          ),

        imported:
          Number(
            staging.imported || 0
          ),

        ignored:
          Number(
            staging.ignored || 0
          ),

        errors:
          Number(
            staging.errors || 0
          ),

        products:
          Number(
            staging.products || 0
          ),

        services:
          Number(
            staging.services || 0
          ),

        last_seen_at:
          staging.last_seen_at,

        last_imported_at:
          staging.last_imported_at,
      },

      synchronization: {
        products: {
          status:
            lastProductSync
              ?.status ||
            "NEVER",

          started_at:
            lastProductSync
              ?.started_at ||
            null,

          completed_at:
            lastProductSync
              ?.completed_at ||
            null,

          minutes_ago:
            productSyncMinutesAgo,

          error:
            lastProductSync
              ?.error_message ||
            null,

          summary:
            lastProductSync
              ?.response_payload ||
            null,
        },

        inventory: {
          status:
            lastInventorySync
              ?.status ||
            "NEVER",

          started_at:
            lastInventorySync
              ?.started_at ||
            null,

          completed_at:
            lastInventorySync
              ?.completed_at ||
            null,

          minutes_ago:
            inventorySyncMinutesAgo,

          error:
            lastInventorySync
              ?.error_message ||
            null,
        },
      },

      inventory: {
        products_without_inventory:
          productsWithoutInventory,

        stale_products:
          staleInventoryProducts,
      },

      errors: {
        last_24_hours:
          errors24h,

        unresolved:
          unresolvedErrors,

        recovered:
          recoveredErrors,

        recent:
          recentErrorsResult.rows,
      },

      issues,
    };
  };