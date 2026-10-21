import express from "express";

import cors from "cors";

import helmet from "helmet";

import morgan from "morgan";

import rateLimit from "express-rate-limit";

import {
  testDatabaseConnection,
} from "./config/database.js";

import {
  corsOptions,
} from "./config/cors.js";

import authRoutes from "./routes/auth.routes.js";

import adminRoutes from "./routes/admin.routes.js";

import adminSalesAccessRoutes from "./routes/adminSalesAccess.routes.js";

import productRoutes from "./routes/products.routes.js";

import catalogRoutes from "./routes/catalog.routes.js";

import relbaseRoutes from "./routes/relbase.routes.js";

import paymentRoutes from "./routes/payment.routes.js";

import orderRoutes from "./routes/order.routes.js";

import pickupRoutes from "./routes/pickup.routes.js";

import {
  startRelbaseSyncJob,
} from "./jobs/relbaseSync.job.js";

import posRoutes from "./routes/pos.routes.js";

import dashboardRoutes from "./routes/dashboard.routes.js";

import orderManagementRoutes from "./routes/orderManagement.routes.js";

import checkoutRoutes from "./routes/checkout.routes.js";

import accountRoutes from "./routes/account.routes.js";

import contactRoutes from "./routes/contact.routes.js";

import quotationTrackingRoutes from "./routes/quotationTracking.routes.js";

import publicProjectsRoutes from "./routes/publicProjects.routes.js";

import gerenciaRoutes from "./routes/gerencia.routes.js";

const app = express();

app.disable("x-powered-by");


/* =========================================
   SEGURIDAD
========================================= */

app.use(
  helmet()
);

app.use(
  cors(corsOptions)
);


/* =========================================
   PARSEO DE BODY

   IMPORTANTE:
   DEBE ESTAR ANTES DE LAS RUTAS
========================================= */

app.use(
  express.json({
    limit: "20mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);


/* =========================================
   LOGS
========================================= */

app.use(
  morgan("dev")
);


/* =========================================
   RATE LIMIT GENERAL
========================================= */

const apiLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    limit:
      500,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,
  });

app.use(
  "/api",
  apiLimiter
);


/* =========================================
   HEALTH CHECK
========================================= */

app.get(
  "/api/health",
  async (req, res) => {
    try {
      const database =
        await testDatabaseConnection();

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Laminatiword Backend funcionando correctamente",

          server:
            "online",

          database: {
            status:
              "connected",

            name:
              database.database_name,

            time:
              database.database_time,
          },
        });
    } catch (error) {
      console.error(
        "Error Health Check:",
        error
      );

      return res
        .status(503)
        .json({
          success: false,

          message:
            "PostgreSQL no está disponible",

          server:
            "online",

          database: {
            status:
              "disconnected",
          },
        });
    }
  }
);


/* =========================================
   RUTAS API
========================================= */

app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api/products",
  productRoutes
);

app.use(
  "/api/catalog",
  catalogRoutes
);

app.use(
  "/api/payments",
  paymentRoutes
);

app.use(
  "/api/orders",
  orderRoutes
);

app.use(
  "/api/pickups",
  pickupRoutes
);

app.use(
  "/api/integrations/relbase",
  relbaseRoutes
);

app.use("/api/checkout", checkoutRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/public/quotation-tracking", quotationTrackingRoutes);
app.use("/api/public/projects", publicProjectsRoutes);

// Gerencia Italia: endpoints exclusivos de sólo lectura.
app.use("/api/gerencia", gerenciaRoutes);

app.use("/api/admin/pos", posRoutes);

// Dashboard comercial: GET de sólo lectura, protegido para ADMIN.
app.use("/api/admin/dashboard", dashboardRoutes);

// Listado y detalle administrativo de órdenes WEB/STORE (sólo GET).
app.use("/api/admin/order-management", orderManagementRoutes);

/*
 * Rutas operativas compartidas por ADMIN y VENDEDOR.
 * Deben ir antes del router administrativo genérico.
 */
app.use(
  "/api/admin",
  adminSalesAccessRoutes
);

/*
 * Administración completa: continúa exclusiva para ADMIN.
 */
app.use(
  "/api/admin",
  adminRoutes
);

/* =========================================
   JOBS AUTOMÁTICOS
========================================= */

/**
 * El job se inicia cuando el backend
 * carga la aplicación.
 *
 * NODE_ENV=test evita que una prueba
 * automatizada levante el cron.
 *
 * RELBASE_AUTO_SYNC_ENABLED controla
 * si realmente debe programarse.
 */

if (
  process.env.NODE_ENV !==
  "test"
) {
  startRelbaseSyncJob();
}


/* =========================================
   RUTA NO ENCONTRADA
========================================= */

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        success: false,
        message:
          "Ruta no encontrada",
      });
  }
);


/* =========================================
   MANEJO GLOBAL DE ERRORES
========================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Error global:",
      error
    );

    return res
      .status(
        error.status ||
        500
      )
      .json({
        success: false,

        message:
          error.status &&
          error.status < 500
            ? error.message
            : "Error interno del servidor",
      });
  }
);



export default app;