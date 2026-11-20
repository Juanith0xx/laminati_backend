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
const PROGRESS_EVERY_RAW = argValue("--progress-every");
const PROGRESS_EVERY = Math.max(1, Number(PROGRESS_EVERY_RAW || 5));

const EXPECTED_FAMILY = "MEG";
const EXPECTED_SOURCE_VERSION = "MEG-07-2026";
const APPLY_SOURCE_VERSION = "MEG-07-2026-WEB-REPORT-V3";
const REQUIRED_CONFIRM = "MEG_REPORT";

let activeClient = null;
let transactionOpen = false;
let shutdownRequested = false;

const startedAt = Date.now();
const logDir = path.resolve(process.cwd(), "tmp");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(
  logDir,
  `apply_meg_report_${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":");
}

function writeLog(level, message = "") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

const info = (message = "") => writeLog("INFO", message);
const warn = (message = "") => writeLog("WARN", message);
const errorLog = (message = "") => writeLog("ERROR", message);

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
    SELECT p.id, p.sku, p.name, p.is_active, p.is_published, p.allow_sale
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    WHERE fam.code = $1
      AND p.sku = ANY($2::text[])
  `, [EXPECTED_FAMILY, skus]);

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
      ) AS has_formats,
      (
        SELECT COUNT(*)::int
        FROM project_family_finish_formats pfff
        JOIN project_family_formats fmt
          ON fmt.id = pfff.format_id
        WHERE pfff.finish_id = f.id
          AND pfff.is_active = TRUE
          AND fmt.is_active = TRUE
      ) AS active_format_count
    FROM project_family_finishes f
    JOIN project_product_families fam
      ON fam.id = f.family_id
    WHERE fam.code = $1
      AND f.is_active = TRUE
      AND f.name = ANY($2::text[])
  `, [EXPECTED_FAMILY, names]);

  return new Map(rows.map((row) => [row.name, row]));
}

function validateReport(report) {
  const approved = report.results.filter((item) => item?.status === "DRY_RUN_OK");
  const reviewCount = report.review ?? report.results.filter((item) => item?.status === "REVIEW").length;
  const errorCount = report.errors ?? report.results.filter((item) => item?.status === "ERROR").length;
  const missingCatalog = Array.isArray(report.catalog_missing_expected)
    ? report.catalog_missing_expected
    : [];

  if (report.mode && report.mode !== "DRY_RUN") {
    fail(`El reporte debe provenir de DRY_RUN. mode=${report.mode}`);
  }

  if (report.source_version && report.source_version !== EXPECTED_SOURCE_VERSION) {
    fail(`source_version inesperada: ${report.source_version}. Esperada: ${EXPECTED_SOURCE_VERSION}`);
  }

  if (!approved.length) {
    fail("El reporte no contiene productos DRY_RUN_OK.");
  }

  if (reviewCount !== 0) {
    fail(`El reporte contiene ${reviewCount} REVIEW. Para MEG se exige REVIEW: 0.`);
  }

  if (errorCount !== 0) {
    fail(`El reporte contiene ${errorCount} ERROR. Para MEG se exige ERROR: 0.`);
  }

  if (missingCatalog.length !== 0) {
    fail(`El reporte contiene ${missingCatalog.length} faltante(s) de catálogo esperado. Debe ser 0.`);
  }

  if (EXPECTED_COUNT !== null && approved.length !== EXPECTED_COUNT) {
    fail(`Cantidad DRY_RUN_OK inesperada: reporte=${approved.length}, confirm-count=${EXPECTED_COUNT}`);
  }

  if (report.total !== undefined && Number(report.total) !== approved.length) {
    fail(`El reporte no está 100% aprobado: total=${report.total}, DRY_RUN_OK=${approved.length}`);
  }

  const seen = new Set();
  for (const item of approved) {
    const sku = String(item.sku || "").trim().toUpperCase();
    if (!sku) fail("Hay un DRY_RUN_OK sin SKU.");
    if (!sku.startsWith("MEG-")) fail(`SKU fuera de familia MEG en el reporte: ${sku}`);
    if (seen.has(sku)) fail(`SKU duplicado en el reporte: ${sku}`);
    seen.add(sku);

    if (!Array.isArray(item.finishes) || !item.finishes.length) {
      fail(`${sku}: DRY_RUN_OK sin acabados.`);
    }

    if (item.finishes.length !== 3) {
      fail(`${sku}: se esperaban 3 acabados MEG y el reporte contiene ${item.finishes.length}.`);
    }

    const uniqueFinishes = new Set(item.finishes);
    if (uniqueFinishes.size !== item.finishes.length) {
      fail(`${sku}: acabados duplicados en el reporte.`);
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

    if (!item.formats || typeof item.formats !== "object") {
      fail(`${sku}: reporte sin formats.`);
    }

    for (const finishName of item.finishes) {
      const formats = item.formats[finishName];
      if (!Array.isArray(formats) || formats.length !== 3) {
        fail(`${sku}: acabado ${finishName} debe tener 3 formatos activos en el reporte.`);
      }
    }

    if (!Array.isArray(item.thicknesses) || item.thicknesses.length !== 10) {
      fail(`${sku}: se esperaban 10 espesores MEG en el reporte.`);
    }
  }

  return { approved, reviewCount, errorCount };
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
    fail(`Productos MEG no encontrados en BD: ${missingProducts.join(", ")}`);
  }

  const missingFinishes = finishNames.filter((name) => !finishes.has(name));
  if (missingFinishes.length) {
    fail(`Acabados maestros MEG no encontrados: ${missingFinishes.join(", ")}`);
  }

  const noFormats = finishNames.filter((name) => !finishes.get(name)?.has_formats);
  if (noFormats.length) {
    fail(`Acabados MEG sin formatos activos: ${noFormats.join(", ")}`);
  }

  const wrongFormatCount = finishNames.filter((name) => Number(finishes.get(name)?.active_format_count) !== 3);
  if (wrongFormatCount.length) {
    fail(`Acabados MEG con cantidad de formatos activa distinta de 3: ${wrongFormatCount.join(", ")}`);
  }

  const relationCount = approved.reduce((sum, item) => sum + item.finishes.length, 0);

  if (relationCount !== approved.length * 3) {
    fail(`Cantidad de relaciones inconsistente: ${relationCount}; esperada=${approved.length * 3}`);
  }

  return { products, finishes, relationCount, finishNames };
}

async function rollbackIfNeeded(reason) {
  if (!activeClient || !transactionOpen) return;
  try {
    warn(`ROLLBACK solicitado: ${reason}`);
    await activeClient.query("ROLLBACK");
    transactionOpen = false;
    warn("ROLLBACK OK. No se confirmó la transacción en PostgreSQL.");
  } catch (rollbackError) {
    errorLog(`FALLO AL HACER ROLLBACK: ${rollbackError?.message || rollbackError}`);
  }
}

async function applyApproved({ approved, products, finishes, relationCount }) {
  activeClient = await pool.connect();
  let processedProducts = 0;
  let processedRelations = 0;
  let currentSku = null;
  let currentFinish = null;

  try {
    await activeClient.query("BEGIN");
    transactionOpen = true;
    info("BEGIN OK. Transacción abierta.");

    for (const item of approved) {
      if (shutdownRequested) {
        throw new Error("Ejecución interrumpida por señal del sistema/usuario.");
      }

      currentSku = String(item.sku).trim().toUpperCase();
      currentFinish = null;
      const product = products.get(currentSku);

      await activeClient.query(`
        UPDATE product_project_finishes
        SET is_default = FALSE, updated_at = NOW()
        WHERE product_id = $1
      `, [product.id]);

      for (const finishName of item.finishes) {
        currentFinish = finishName;
        const finish = finishes.get(finishName);
        const isDefault = finishName === item.default_finish;

        await activeClient.query(`
          INSERT INTO product_project_finishes (
            product_id,
            finish_id,
            is_default,
            is_active,
            source_name,
            source_url,
            source_version
          )
          VALUES ($1, $2, $3, TRUE, 'Abet Laminati', $4, $5)
          ON CONFLICT (product_id, finish_id)
          DO UPDATE SET
            is_default = EXCLUDED.is_default,
            is_active = TRUE,
            source_name = EXCLUDED.source_name,
            source_url = EXCLUDED.source_url,
            source_version = EXCLUDED.source_version,
            updated_at = NOW()
        `, [product.id, finish.id, isDefault, item.url, APPLY_SOURCE_VERSION]);

        processedRelations += 1;
      }

      processedProducts += 1;

      const shouldPrint =
        processedProducts === 1 ||
        processedProducts % PROGRESS_EVERY === 0 ||
        processedProducts === approved.length;

      if (shouldPrint) {
        const productPct = ((processedProducts / approved.length) * 100).toFixed(1);
        const relationPct = ((processedRelations / relationCount) * 100).toFixed(1);
        info(
          `PROGRESO ${processedProducts}/${approved.length} productos (${productPct}%) | ` +
          `${processedRelations}/${relationCount} relaciones (${relationPct}%) | ` +
          `último=${currentSku} | default=${item.default_finish} | ` +
          `transcurrido=${formatDuration(Date.now() - startedAt)}`,
        );
      }
    }

    info(`Escritura terminada: ${processedProducts} productos / ${processedRelations} relaciones.`);
    info("Ejecutando COMMIT...");
    await activeClient.query("COMMIT");
    transactionOpen = false;
    info("COMMIT OK. Cambios confirmados en PostgreSQL.");

    return { processedProducts, processedRelations };
  } catch (error) {
    errorLog(
      `FALLO durante APPLY | SKU=${currentSku || "—"} | acabado=${currentFinish || "—"} | ` +
      `productos=${processedProducts}/${approved.length} | relaciones=${processedRelations}/${relationCount}`,
    );
    errorLog(error?.stack || error?.message || String(error));
    await rollbackIfNeeded("error durante APPLY");
    throw error;
  } finally {
    activeClient.release();
    activeClient = null;
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
    WHERE fam.code = $1
      AND ppf.is_active = TRUE
  `, [EXPECTED_FAMILY]);
  return rows[0];
}

async function verificationDefaultProblems() {
  const { rows } = await pool.query(`
    SELECT
      p.sku,
      p.name,
      COUNT(*) FILTER (
        WHERE ppf.is_default = TRUE
          AND ppf.is_active = TRUE
      )::int AS defaults
    FROM products p
    JOIN product_project_finishes ppf ON ppf.product_id = p.id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    WHERE fam.code = $1
      AND ppf.is_active = TRUE
    GROUP BY p.id, p.sku, p.name
    HAVING COUNT(*) FILTER (
      WHERE ppf.is_default = TRUE
        AND ppf.is_active = TRUE
    ) <> 1
    ORDER BY p.sku
  `, [EXPECTED_FAMILY]);
  return rows;
}

async function verificationRelationCountProblems() {
  const { rows } = await pool.query(`
    SELECT
      p.sku,
      p.name,
      COUNT(*) FILTER (WHERE ppf.is_active = TRUE)::int AS acabados_activos
    FROM products p
    JOIN project_product_families fam ON fam.id = p.project_family_id
    LEFT JOIN product_project_finishes ppf ON ppf.product_id = p.id
    WHERE fam.code = $1
    GROUP BY p.id, p.sku, p.name
    HAVING COUNT(*) FILTER (WHERE ppf.is_active = TRUE) <> 3
    ORDER BY p.sku
  `, [EXPECTED_FAMILY]);
  return rows;
}

async function verificationNoFormatRelations() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS relaciones_sin_formato
    FROM product_project_finishes ppf
    JOIN products p ON p.id = ppf.product_id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    JOIN project_family_finishes fin ON fin.id = ppf.finish_id
    WHERE fam.code = $1
      AND ppf.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM project_family_finish_formats pfff
        JOIN project_family_formats fmt ON fmt.id = pfff.format_id
        WHERE pfff.finish_id = fin.id
          AND pfff.is_active = TRUE
          AND fmt.is_active = TRUE
      )
  `, [EXPECTED_FAMILY]);
  return rows[0];
}

async function main() {
  info("=== Apply MEG / Abet from validated report V1 ===");
  info(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  info(`Log: ${logFile}`);
  info(`Progreso: cada ${PROGRESS_EVERY} producto(s)`);

  if (!REPORT_ARG) {
    fail("Falta --report <ruta-json>.");
  }

  const { absolute, report } = readReport(REPORT_ARG);
  const validated = validateReport(report);
  const approved = validated.approved;
  const pre = await preflight(approved);

  info(`Reporte: ${absolute}`);
  info(`Reporte versión: ${report.version || "—"}`);
  info(`Fuente técnica: ${report.source_version || "—"}`);
  info(`Generado: ${report.generated_at || "—"}`);
  info(`Total auditado: ${report.total ?? report.results.length}`);
  info(`Aprobados DRY_RUN_OK: ${approved.length}`);
  info(`REVIEW: ${validated.reviewCount}`);
  info(`ERROR: ${validated.errorCount}`);
  info(`Faltantes catálogo: ${report.catalog_missing_expected?.length || 0}`);
  info(`Acabados maestros utilizados: ${pre.finishNames.length} (${pre.finishNames.join(", ")})`);
  info(`Relaciones a insertar/actualizar: ${pre.relationCount}`);

  if (!APPLY) {
    info("PREFLIGHT OK. No se modificó PostgreSQL.");
    info(`Para aplicar exige: --apply --confirm=${REQUIRED_CONFIRM} --confirm-db=railway --confirm-count=<cantidad>`);
    info(`PROCESO TERMINADO CORRECTAMENTE. Duración=${formatDuration(Date.now() - startedAt)}`);
    info(`Log guardado en: ${logFile}`);
    return;
  }

  if (CONFIRM !== REQUIRED_CONFIRM) {
    fail(`Confirmación inválida. Usa --confirm=${REQUIRED_CONFIRM}`);
  }
  if (CONFIRM_DB !== "railway") {
    fail("Confirmación de BD inválida. Usa --confirm-db=railway");
  }
  if (EXPECTED_COUNT === null) {
    fail("En APPLY es obligatorio --confirm-count=<cantidad DRY_RUN_OK>.");
  }

  const applied = await applyApproved({ approved, ...pre });

  info("Ejecutando verificación post-COMMIT...");
  const verify = await verification();
  const defaultProblems = await verificationDefaultProblems();
  const relationCountProblems = await verificationRelationCountProblems();
  const noFormat = await verificationNoFormatRelations();

  info("=== VERIFICACIÓN FINAL ===");
  info(`Productos MEG con acabados activos: ${verify.productos_con_acabados}`);
  info(`Relaciones de acabado activas: ${verify.relaciones_acabado}`);
  info(`Productos con default activo: ${verify.productos_con_default}`);
  info(`Productos procesados en esta ejecución: ${applied.processedProducts}`);
  info(`Relaciones procesadas en esta ejecución: ${applied.processedRelations}`);
  info(`Relaciones sin formato activo: ${noFormat.relaciones_sin_formato}`);

  let verificationFailed = false;

  if (Number(verify.productos_con_acabados) !== approved.length) {
    verificationFailed = true;
    warn(`COUNT_CHECK: productos_con_acabados=${verify.productos_con_acabados}, esperado=${approved.length}`);
  }

  if (Number(verify.relaciones_acabado) !== pre.relationCount) {
    verificationFailed = true;
    warn(`COUNT_CHECK: relaciones_acabado=${verify.relaciones_acabado}, esperado=${pre.relationCount}`);
  }

  if (Number(verify.productos_con_default) !== approved.length) {
    verificationFailed = true;
    warn(`COUNT_CHECK: productos_con_default=${verify.productos_con_default}, esperado=${approved.length}`);
  }

  if (defaultProblems.length) {
    verificationFailed = true;
    warn(`ATENCIÓN: ${defaultProblems.length} producto(s) con cantidad de default distinta de 1.`);
    for (const row of defaultProblems.slice(0, 50)) {
      warn(`DEFAULT_CHECK | ${row.sku} | ${row.name} | defaults=${row.defaults}`);
    }
  } else {
    info("DEFAULT_CHECK OK: todos los productos MEG tienen exactamente 1 default.");
  }

  if (relationCountProblems.length) {
    verificationFailed = true;
    warn(`ATENCIÓN: ${relationCountProblems.length} producto(s) no tienen exactamente 3 acabados activos.`);
    for (const row of relationCountProblems.slice(0, 50)) {
      warn(`RELATION_CHECK | ${row.sku} | ${row.name} | acabados=${row.acabados_activos}`);
    }
  } else {
    info("RELATION_CHECK OK: todos los productos MEG tienen exactamente 3 acabados activos.");
  }

  if (Number(noFormat.relaciones_sin_formato) !== 0) {
    verificationFailed = true;
    warn(`FORMAT_CHECK: existen ${noFormat.relaciones_sin_formato} relación(es) de acabado sin formato activo.`);
  } else {
    info("FORMAT_CHECK OK: todas las relaciones MEG tienen formatos activos.");
  }

  info("COMMIT CONFIRMADO: SÍ");

  if (verificationFailed) {
    warn("PROCESO TERMINÓ CON COMMIT, PERO LA VERIFICACIÓN POST-COMMIT DETECTÓ INCONSISTENCIAS.");
    warn("Revisar el log antes de continuar con frontend/cotizador.");
    process.exitCode = 2;
  } else {
    info(`PROCESO TERMINADO CORRECTAMENTE. Duración=${formatDuration(Date.now() - startedAt)}`);
  }

  info(`Log guardado en: ${logFile}`);
}

async function handleSignal(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  warn(`Se recibió ${signal}. Intentando cerrar de forma segura...`);
  await rollbackIfNeeded(signal);
  try { await pool.end(); } catch {}
  process.exit(130);
}

process.once("SIGINT", () => { void handleSignal("SIGINT"); });
process.once("SIGTERM", () => { void handleSignal("SIGTERM"); });

main()
  .catch(async (error) => {
    errorLog(`ERROR FATAL: ${error?.stack || error?.message || error}`);
    await rollbackIfNeeded("ERROR FATAL");
    errorLog(`PROCESO TERMINADO CON ERROR. COMMIT CONFIRMADO: NO. Duración=${formatDuration(Date.now() - startedAt)}`);
    errorLog(`Log guardado en: ${logFile}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
