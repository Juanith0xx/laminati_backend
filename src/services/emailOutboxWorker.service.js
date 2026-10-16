import cron from "node-cron";

import {
  verifyEmailTransport,
} from "./emailTransport.service.js";

import {
  listRunnableEmailOutboxIds,
  processEmailOutboxEvent,
} from "./emailOutboxProcessor.service.js";

const cleanText = (value) => String(value ?? "").trim();

const isTrue = (value) =>
  ["1", "true", "yes", "on"].includes(cleanText(value).toLowerCase());

const resolveBatchSize = () => {
  const parsed = Number(process.env.EMAIL_OUTBOX_BATCH_SIZE || 5);
  if (!Number.isInteger(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 25);
};

const resolveCronExpression = () =>
  cleanText(process.env.EMAIL_OUTBOX_CRON || "* * * * *");

let running = false;
let task = null;

export const runEmailOutboxCycle = async () => {
  if (running) {
    return {
      skipped: true,
      reason: "CYCLE_ALREADY_RUNNING",
    };
  }

  running = true;

  try {
    await verifyEmailTransport();

    const ids = await listRunnableEmailOutboxIds(resolveBatchSize());
    const results = [];

    for (const id of ids) {
      const result = await processEmailOutboxEvent(id);
      results.push({ id, ...result });
    }

    if (ids.length > 0) {
      console.log("Email outbox ciclo completado:", {
        selected: ids.length,
        sent: results.filter((item) => item.sent).length,
        failed: results.filter(
          (item) => item.processed && !item.sent && !item.quarantined
        ).length,
        quarantined: results.filter((item) => item.quarantined).length,
      });
    }

    return {
      skipped: false,
      selected: ids.length,
      results,
    };
  } catch (error) {
    console.error("Email outbox worker no pudo ejecutar el ciclo:", {
      message: error?.message || "Error desconocido",
      code: error?.code || null,
    });

    return {
      skipped: false,
      selected: 0,
      transport_error: true,
      error: {
        message: error?.message || "Error desconocido",
        code: error?.code || null,
      },
    };
  } finally {
    running = false;
  }
};

export const startEmailOutboxWorker = () => {
  if (!isTrue(process.env.EMAIL_OUTBOX_ENABLED)) {
    return {
      enabled: false,
      started: false,
    };
  }

  const expression = resolveCronExpression();

  if (!cron.validate(expression)) {
    const error = new Error(`EMAIL_OUTBOX_CRON no es válido: ${expression}`);
    error.code = "EMAIL_OUTBOX_CRON_INVALID";
    throw error;
  }

  if (task) {
    return {
      enabled: true,
      started: false,
      already_started: true,
      cron: expression,
    };
  }

  task = cron.schedule(expression, () => {
    void runEmailOutboxCycle();
  });

  console.log("Email outbox worker automático iniciado:", {
    cron: expression,
    batch_size: resolveBatchSize(),
    test_mode: isTrue(process.env.EMAIL_OUTBOX_TEST_MODE),
  });

  if (isTrue(process.env.EMAIL_OUTBOX_RUN_ON_START || "true")) {
    void runEmailOutboxCycle();
  }

  return {
    enabled: true,
    started: true,
    cron: expression,
    batch_size: resolveBatchSize(),
  };
};

export const stopEmailOutboxWorker = () => {
  if (!task) return false;
  task.stop();
  task.destroy();
  task = null;
  return true;
};
