import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false,
        }
      : false,
});

pool.on("error", (error) => {
  console.error("Error inesperado en PostgreSQL:", error);
});

export const query = (text, params) => {
  return pool.query(text, params);
};

export const testDatabaseConnection = async () => {
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT
        NOW() AS database_time,
        current_database() AS database_name,
        version() AS postgres_version
    `);

    return result.rows[0];
  } finally {
    client.release();
  }
};

export default pool;