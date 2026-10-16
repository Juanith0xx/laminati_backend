import pool from "../src/config/database.js";

import {
  ensureStorePickupForPaidOrder,
} from "../src/services/pickup.service.js";

const run = async () => {
  try {
    const result =
      await pool.query(`
        SELECT
          o.id,
          o.order_number
        FROM orders o
        LEFT JOIN store_pickups sp
          ON sp.order_id = o.id
        WHERE o.payment_status = 'PAID'
          AND o.fulfillment_status = 'PENDING'
          AND o.status <> 'CANCELLED'
          AND sp.id IS NULL
        ORDER BY o.created_at ASC
      `);

    console.log(
      `Pedidos a procesar: ${result.rowCount}`
    );

    for (const order of result.rows) {
      const pickup =
        await ensureStorePickupForPaidOrder(
          null,
          order.id
        );

      console.log(
        order.order_number,
        "→",
        pickup?.pickup?.status,
        pickup?.pickup?.id
      );
    }

    console.log(
      "Backfill finalizado correctamente."
    );
  } catch (error) {
    console.error(
      "Error realizando backfill:",
      error
    );

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();