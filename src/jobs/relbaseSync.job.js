import cron from "node-cron";

import {
  syncAllImportedRelbaseProducts,
} from "../services/relbaseBulkSync.service.js";

/* =========================================
   CONVERTIR VARIABLE BOOLEAN
========================================= */
const parseBoolean = (
  value,
  defaultValue = false
) => {
  if (
    value === undefined ||
    value === null
  ) {
    return defaultValue;
  }

  return String(value)
    .trim()
    .toLowerCase() === "true";
};

/* =========================================
   EJECUTAR SINCRONIZACION
========================================= */
const executeRelbaseSync = async () => {
  const startedAt =
    new Date();

  console.log(
    "========================================="
  );

  console.log(
    "🔄 Iniciando sincronización automática Relbase..."
  );

  console.log(
    "Fecha:",
    startedAt.toISOString()
  );

  try {
    const result =
      await syncAllImportedRelbaseProducts();

    console.log(
      "✅ Sincronización automática Relbase completada"
    );

    console.log(
      "Resultado:",
      {
        duration_ms:
          result.duration_ms,

        staging:
          result.staging,

        imported_products:
          result.imported_products,

        synchronization:
          result.synchronization,

        errors:
          result.errors?.length || 0,
      }
    );
  } catch (error) {
    /*
     * Si otro proceso ya está
     * sincronizando, no lo tratamos
     * como error crítico.
     *
     * El advisory lock del Paso 74
     * protege la sincronización.
     */
    if (
      error?.code ===
      "RELBASE_SYNC_ALREADY_RUNNING"
    ) {
      console.log(
        "ℹ️ Sincronización Relbase omitida: ya existe otra ejecución en proceso"
      );

      return;
    }

    console.error(
      "❌ Error en sincronización automática Relbase:",
      {
        message:
          error?.message ||
          "Error desconocido",

        code:
          error?.code || null,

        status:
          error?.status || null,
      }
    );
  } finally {
    console.log(
      "========================================="
    );
  }
};

/* =========================================
   INICIAR JOB RELBASE
========================================= */
export const startRelbaseSyncJob = () => {
  const enabled =
    parseBoolean(
      process.env
        .RELBASE_AUTO_SYNC_ENABLED,
      false
    );

  if (!enabled) {
    console.log(
      "ℹ️ Sincronización automática Relbase desactivada"
    );

    return null;
  }

  const cronExpression =
    process.env.RELBASE_SYNC_CRON ||
    "*/30 * * * *";

  const timezone =
    process.env
      .RELBASE_SYNC_TIMEZONE ||
    "America/Santiago";

  /* =====================================
     VALIDAR EXPRESIÓN CRON
  ===================================== */
  if (
    !cron.validate(
      cronExpression
    )
  ) {
    console.error(
      "❌ RELBASE_SYNC_CRON no es una expresión cron válida:",
      cronExpression
    );

    return null;
  }

  console.log(
    "✅ Sincronización automática Relbase programada"
  );

  console.log(
    "Cron:",
    cronExpression
  );

  console.log(
    "Timezone:",
    timezone
  );

  /* =====================================
     PROGRAMAR
  ===================================== */
  const task =
    cron.schedule(
      cronExpression,

      async () => {
        await executeRelbaseSync();
      },

      {
        timezone,
      }
    );

  return task;
};