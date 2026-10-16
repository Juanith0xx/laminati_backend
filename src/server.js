import { createServer } from "node:http";

import dotenv from "dotenv";

/* =========================================
   CARGAR VARIABLES DE ENTORNO PRIMERO
========================================= */

dotenv.config();

/**
 * IMPORTANTE:
 * Los imports internos se realizan después
 * de cargar .env para garantizar que todos
 * los servicios reciban las variables
 * correctas desde process.env.
 */

const { default: app } = await import(
  "./app.js"
);

const {
  testDatabaseConnection,
} = await import(
  "./config/database.js"
);

const {
  initializeRealtimeServer,
} = await import(
  "./services/realtime.service.js"
);

/* =========================================
   HELPERS
========================================= */

const isTrue = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );

/* =========================================
   CONFIGURACIÓN SERVIDOR
========================================= */

const PORT = Number(
  process.env.PORT || 5000
);

/* =========================================
   INICIAR SERVIDOR
========================================= */

const startServer = async () => {
  try {
    const database =
      await testDatabaseConnection();

    console.log(
      "PostgreSQL conectado correctamente"
    );

    console.log(
      `Base de datos: ${database.database_name}`
    );

    console.log(
      "RELBASE_DTE_EMISSION_ENABLED:",
      process.env
        .RELBASE_DTE_EMISSION_ENABLED
    );

    const httpServer =
      createServer(app);

    initializeRealtimeServer(
      httpServer
    );

    httpServer.listen(
      PORT,
      () => {
        console.log(
          `Laminatiword Backend ejecutándose en http://localhost:${PORT}`
        );

        console.log(
          "Notificaciones realtime ADMIN: activas"
        );
      }
    );

    /* =====================================
       EMAIL OUTBOX WORKER
    ===================================== */

    if (
      isTrue(
        process.env
          .EMAIL_OUTBOX_ENABLED
      )
    ) {
      try {
        const {
          startEmailOutboxWorker,
        } = await import(
          "./services/emailOutboxWorker.service.js"
        );

        startEmailOutboxWorker();
      } catch (workerError) {
        console.error(
          "El backend inició, pero no fue posible iniciar el worker de email_outbox:",
          workerError?.message ||
            "Error desconocido"
        );
      }
    } else {
      console.log(
        "EMAIL_OUTBOX_ENABLED: false"
      );
    }

    /* =====================================
       RELBASE DTE STATUS WORKER

       Sólo sincronización GET de DTE ISSUED.
       Nunca emite ni ejecuta POST DTE.
    ===================================== */

    if (
      isTrue(
        process.env
          .RELBASE_DTE_STATUS_SYNC_ENABLED
      )
    ) {
      try {
        const {
          startRelbaseDteStatusWorker,
        } = await import(
          "./services/relbaseDteStatusWorker.service.js"
        );

        startRelbaseDteStatusWorker();
      } catch (workerError) {
        console.error(
          "El backend inició, pero no fue posible iniciar el worker de estado DTE Relbase:",
          workerError?.message ||
            "Error desconocido"
        );
      }
    } else {
      console.log(
        "RELBASE_DTE_STATUS_SYNC_ENABLED: false"
      );
    }
  } catch (error) {
    console.error(
      "No fue posible conectar con PostgreSQL:",
      error.message
    );

    process.exit(1);
  }
};

startServer();