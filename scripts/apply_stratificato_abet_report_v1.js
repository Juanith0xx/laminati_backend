import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import pool from "../src/config/database.js";

const argValue = (name) => {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const REPORT_ARG = argValue("--report");
const APPLY = process.argv.includes("--apply");
const CONFIRM = argValue("--confirm");
const CONFIRM_DB = argValue("--confirm-db");
const EXPECTED_COUNT_RAW = argValue("--confirm-count");
const EXPECTED_COUNT = EXPECTED_COUNT_RAW ? Number(EXPECTED_COUNT_RAW) : null;

function fail(message) {
  throw new Error(message);
}

function readReport(reportPath) {
  const absolute = path.resolve(process.cwd(), reportPath);
  if (!fs.existsSync(absolute)) {
    fail(`No existe el reporte: ${absolute}`);
  }

  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (!Array.isArray(parsed.results)) {
    fail("El reporte no contiene un array results válido.");
  }

  return { absolute, report: parsed };
}

async function loadProductsBySku(skus) {
  const { rows } = await pool.query(`
    SELECT p.id, p.sku, p.name
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    WHERE fam.code = 'STRATIFICATO'
      AND p.sku = ANY($1::text[])
  `, [skus]);

  return new Map(rows.map((row) => [String(row.sku).toUpperCase(), row]));
}

async function loadFinishesByName(names) {
  const { rows } = await pool.query(`
    SELECT
      f.id,
      f.name,
      EXISTS (
        SELECT 1
        FROM project_family_finish_formats pfff
        JOIN project_family_formats fmt
          ON fmt.id = pfff.format_id
        WHERE pfff.finish_id = f.id
          AND pfff.is_active = TRUE
          AND fmt.is_active = TRUE
      ) AS has_formats
    FROM project_family_finishes f
    JOIN project_product_families fam
      ON fam.id = f.family_id
    WHERE fam.code = 'STRATIFICATO'
      AND f.is_active = TRUE
      AND f.name = ANY($1::text[])
  `, [names]);

  return new Map(rows.map((row) => [row.name, row]));
}

function validateReport(report) {
  const approved = report.results.filter((item) => item?.status === "DRY_RUN_OK");

  if (!approved.length) {
    fail("El reporte no contiene productos DRY_RUN_OK.");
  }

  if (report.errors !== 0) {
    fail(`El reporte contiene ${report.errors} ERROR. Usa un reporte con ERROR: 0.`);
  }

  if (EXPECTED_COUNT !== null && approved.length !== EXPECTED_COUNT) {
    fail(`Cantidad DRY_RUN_OK inesperada: reporte=${approved.length}, confirm-count=${EXPECTED_COUNT}`);
  }

  const seen = new Set();
  for (const item of approved) {
    const sku = String(item.sku || "").trim().toUpperCase();
    if (!sku) fail("Hay un DRY_RUN_OK sin SKU.");
    if (seen.has(sku)) fail(`SKU duplicado en el reporte: ${sku}`);
    seen.add(sku);

    if (!Array.isArray(item.finishes) || !item.finishes.length) {
      fail(`${sku}: DRY_RUN_OK sin acabados.`);
    }

    if (!item.default_finish) {
      fail(`${sku}: DRY_RUN_OK sin default_finish.`);
    }

    if (!item.finishes.includes(item.default_finish)) {
      fail(`${sku}: default_finish ${item.default_finish} no está en finishes.`);
    }

    if (!item.url || !String(item.url).startsWith("https://abetlaminati.com/")) {
      fail(`${sku}: URL fuente Abet inválida.`);
    }
  }

  return approved;
}

async function preflight(approved) {
  const skus = approved.map((item) => String(item.sku).trim().toUpperCase());
  const finishNames = [...new Set(approved.flatMap((item) => item.finishes))];

  const [products, finishes] = await Promise.all([
    loadProductsBySku(skus),
    loadFinishesByName(finishNames),
  ]);

  const missingProducts = skus.filter((sku) => !products.has(sku));
  if (missingProducts.length) {
    fail(`Productos Stratificato no encontrados en BD: ${missingProducts.join(", ")}`);
  }

  const missingFinishes = finishNames.filter((name) => !finishes.has(name));
  if (missingFinishes.length) {
    fail(`Acabados maestros no encontrados: ${missingFinishes.join(", ")}`);
  }

  const noFormats = finishNames.filter((name) => !finishes.get(name)?.has_formats);
  if (noFormats.length) {
    fail(`Acabados sin formatos activos: ${noFormats.join(", ")}`);
  }

  let relationCount = 0;
  for (const item of approved) relationCount += item.finishes.length;

  return { products, finishes, relationCount, finishNames };
}

async function applyApproved({ approved, products, finishes }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const item of approved) {
      const sku = String(item.sku).trim().toUpperCase();
      const product = products.get(sku);

      await client.query(`
        UPDATE product_project_finishes
        SET is_default = FALSE, updated_at = NOW()
        WHERE product_id = $1
      `, [product.id]);

      for (const finishName of item.finishes) {
        const finish = finishes.get(finishName);
        const isDefault = finishName === item.default_finish;

        await client.query(`
          INSERT INTO product_project_finishes (
            product_id,
            finish_id,
            is_default,
            is_active,
            source_name,
            source_url,
            source_version
          )
          VALUES ($1, $2, $3, TRUE, 'Abet Laminati', $4, 'WEB-2026-REPORT-V2')
          ON CONFLICT (product_id, finish_id)
          DO UPDATE SET
            is_default = EXCLUDED.is_default,
            is_active = TRUE,
            source_name = EXCLUDED.source_name,
            source_url = EXCLUDED.source_url,
            source_version = EXCLUDED.source_version,
            updated_at = NOW()
        `, [product.id, finish.id, isDefault, item.url]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verification() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(DISTINCT ppf.product_id)::int AS productos_con_acabados,
      COUNT(*)::int AS relaciones_acabado,
      COUNT(DISTINCT ppf.product_id) FILTER (WHERE ppf.is_default = TRUE)::int AS productos_con_default
    FROM product_project_finishes ppf
    JOIN products p ON p.id = ppf.product_id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    WHERE fam.code = 'STRATIFICATO'
      AND ppf.is_active = TRUE
  `);
  return rows[0];
}

async function main() {
  console.log("=== Apply Stratificato / Abet from validated report V1 ===");
  console.log(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}`);

  if (!REPORT_ARG) {
    fail("Falta --report <ruta-json>.");
  }

  const { absolute, report } = readReport(REPORT_ARG);
  const approved = validateReport(report);
  const pre = await preflight(approved);

  console.log(`Reporte: ${absolute}`);
  console.log(`Reporte versión: ${report.version || "—"}`);
  console.log(`Total auditado: ${report.total ?? report.results.length}`);
  console.log(`Aprobados DRY_RUN_OK: ${approved.length}`);
  console.log(`REVIEW ignorados: ${report.review ?? report.results.filter((x) => x.status === "REVIEW").length}`);
  console.log(`ERROR en reporte: ${report.errors ?? report.results.filter((x) => x.status === "ERROR").length}`);
  console.log(`Acabados maestros utilizados: ${pre.finishNames.length}`);
  console.log(`Relaciones a insertar/actualizar: ${pre.relationCount}`);
  console.log("");

  if (!APPLY) {
    console.log("PREFLIGHT OK. No se modificó PostgreSQL.");
    console.log("Para aplicar exige: --apply --confirm=STRATIFICATO_REPORT --confirm-db=railway --confirm-count=<cantidad>");
    return;
  }

  if (CONFIRM !== "STRATIFICATO_REPORT") {
    fail("Confirmación inválida. Usa --confirm=STRATIFICATO_REPORT");
  }
  if (CONFIRM_DB !== "railway") {
    fail("Confirmación de BD inválida. Usa --confirm-db=railway");
  }
  if (EXPECTED_COUNT === null) {
    fail("En APPLY es obligatorio --confirm-count=<cantidad DRY_RUN_OK>.");
  }

  await applyApproved({ approved, ...pre });
  const verify = await verification();

  console.log("APPLY COMPLETADO EN UNA TRANSACCIÓN.");
  console.log(`Productos Stratificato con acabados activos: ${verify.productos_con_acabados}`);
  console.log(`Relaciones de acabado activas: ${verify.relaciones_acabado}`);
  console.log(`Productos con default activo: ${verify.productos_con_default}`);
  console.log("Los REVIEW/ERROR del reporte no fueron procesados.");
}

main()
  .catch((error) => {
    console.error("ERROR FATAL:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
