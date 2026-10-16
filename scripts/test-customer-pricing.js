import "dotenv/config";

import pool from "../src/config/database.js";

import {
  resolveCustomerProductPriceBySku,
} from "../src/services/customerPricing.service.js";

const [
  ,
  ,
  userId,
  sku,
] = process.argv;

if (!userId || !sku) {
  console.error(
    "Uso: node scripts/test-customer-pricing.js <USER_UUID> <SKU>"
  );
  process.exit(1);
}

try {
  const result =
    await resolveCustomerProductPriceBySku({
      userId,
      sku,
    });

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        success: false,
        message:
          error?.message ||
          "Error resolviendo precio",
        code:
          error?.code ||
          null,
      },
      null,
      2
    )
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
