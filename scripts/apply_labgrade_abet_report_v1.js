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
const PROGRESS_EVERY = Math.max(1, Number(PROGRESS_EVERY_RAW || 2));

const FAMILY_CODES = ["LABGRADE", "LABGRADE_PLUS"];
const EXPECTED_FAMILY_COUNTS = {
  LABGRADE: 6,
  LABGRADE_PLUS: 4,
};
const EXPECTED_SOURCE_VERSION = "LABGRADE-06-2026";
const APPLY_SOURCE_VERSION = "LABGRADE-06-2026-WEB-REPORT-V1";
const REQUIRED_CONFIRM = "LABGRADE_REPORT";

const FAMILY_RULES = {
  LABGRADE: {
    skuPrefix: "LAB-",
    finishes: ["Sei", "Zodia"],
    formatsPerFinish: 4,
    thicknesses: [8, 10, 12, 13, 16, 18, 20],
  },
  LABGRADE_PLUS: {
    skuPrefix: "LABP-",
    finishes: ["Skin"],
    formatsPerFinish: 1,
    thicknesses: [8, 13, 16, 18, 20],
  },
};

let activeClient = null;
let transactionOpen = false;
let shutdownRequested = false;

const startedAt = Date.now();
const logDir = path.resolve(process.cwd(), "tmp");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(
  logDir,
  `apply_labgrade_report_${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
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

function sameNumberSet(actual, expected) {
  const a = [...new Set((actual || []).map(Number))].sort((x, y) => x - y);
  const e = [...new Set(expected.map(Number))].sort((x, y) => x - y);
  return a.length === e.length && a.every((value, index) => value === e[index]);
}

function sameStringSet(actual, expected) {
  const a = [...new Set((actual || []).map(String))].sort();
  const e = [...new Set(expected.map(String))].sort();
  return a.length === e.length && a.every((value, index) => value === e[index]);
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

function finishKey(familyCode, finishName) {
  return `${familyCode}::${finishName}`;
}

async function loadProductsBySku(approved) {
  const skus = approved.map((item) => String(item.sku).trim().toUpperCase());
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.is_active,
      p.is_published,
      p.allow_sale,
      fam.code AS family_code
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    WHERE fam.code = ANY($1::text[])
      AND p.sku = ANY($2::text[])
  `, [FAMILY_CODES, skus]);

  return new Map(rows.map((row) => [String(row.sku).toUpperCase(), row]));
}

async function loadFinishes(approved) {
  const requested = [];
  for (const item of approved) {
    for (const name of item.finishes) {
      requested.push({ familyCode: item.family_code, name });
    }
  }

  const { rows } = await pool.query(`
    SELECT
      fam.code AS family_code,
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
    WHERE fam.code = ANY($1::text[])
      AND f.is_active = TRUE
  `, [FAMILY_CODES]);

  const map = new Map(rows.map((row) => [finishKey(row.family_code, row.name), row]));
  return { map, requested };
}

async function loadExistingActiveRelations(approved) {
  const skus = approved.map((item) => String(item.sku).trim().toUpperCase());
  const { rows } = await pool.query(`
    SELECT
      p.sku,
      fam.code AS family_code,
      fin.name AS finish_name,
      ppf.is_default
    FROM product_project_finishes ppf
    JOIN products p ON p.id = ppf.product_id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    JOIN project_family_finishes fin ON fin.id = ppf.finish_id
    WHERE p.sku = ANY($1::text[])
      AND fam.code = ANY($2::text[])
      AND ppf.is_active = TRUE
    ORDER BY fam.code, p.sku, fin.name
  `, [skus, FAMILY_CODES]);
  return rows;
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

  if (!approved.length) fail("El reporte no contiene productos DRY_RUN_OK.");
  if (reviewCount !== 0) fail(`El reporte contiene ${reviewCount} REVIEW. Se exige REVIEW: 0.`);
  if (errorCount !== 0) fail(`El reporte contiene ${errorCount} ERROR. Se exige ERROR: 0.`);
  if (missingCatalog.length !== 0) {
    fail(`El reporte contiene ${missingCatalog.length} faltante(s) de catálogo esperado. Debe ser 0.`);
  }

  if (EXPECTED_COUNT !== null && approved.length !== EXPECTED_COUNT) {
    fail(`Cantidad DRY_RUN_OK inesperada: reporte=${approved.length}, confirm-count=${EXPECTED_COUNT}`);
  }

  if (report.total !== undefined && Number(report.total) !== approved.length) {
    fail(`El reporte no está 100% aprobado: total=${report.total}, DRY_RUN_OK=${approved.length}`);
  }

  const familyCounts = Object.fromEntries(FAMILY_CODES.map((code) => [code, 0]));
  const seen = new Set();

  for (const item of approved) {
    const sku = String(item.sku || "").trim().toUpperCase();
    const familyCode = String(item.family_code || "").trim().toUpperCase();
    if (!sku) fail("Hay un DRY_RUN_OK sin SKU.");
    if (!FAMILY_CODES.includes(familyCode)) fail(`${sku}: familia inesperada ${familyCode || "vacía"}.`);
    if (seen.has(sku)) fail(`SKU duplicado en el reporte: ${sku}`);
    seen.add(sku);
    familyCounts[familyCode] += 1;

    const rule = FAMILY_RULES[familyCode];
    if (!sku.startsWith(rule.skuPrefix)) {
      fail(`${sku}: prefijo SKU incompatible con familia ${familyCode}.`);
    }

    if (!Array.isArray(item.finishes) || !item.finishes.length) {
      fail(`${sku}: DRY_RUN_OK sin acabados.`);
    }
    if (!sameStringSet(item.finishes, rule.finishes)) {
      fail(`${sku}: acabados inesperados para ${familyCode}. Reporte=${item.finishes.join(", ")} Esperado=${rule.finishes.join(", ")}`);
    }
    if (!item.default_finish || !item.finishes.includes(item.default_finish)) {
      fail(`${sku}: default_finish inválido o ausente.`);
    }

    if (!item.url || !String(item.url).startsWith("https://abetlaminati.com/")) {
      fail(`${sku}: URL fuente Abet inválida.`);
    }

    if (!item.formats || typeof item.formats !== "object") {
      fail(`${sku}: reporte sin formats.`);
    }
    for (const finishName of item.finishes) {
      const formats = item.formats[finishName];
      if (!Array.isArray(formats) || formats.length !== rule.formatsPerFinish) {
        fail(`${sku}: ${finishName} debe tener ${rule.formatsPerFinish} formato(s) activo(s); reporte=${formats?.length ?? 0}.`);
      }
    }

    if (!sameNumberSet(item.thicknesses, rule.thicknesses)) {
      fail(`${sku}: espesores inesperados para ${familyCode}. Reporte=${(item.thicknesses || []).join(", ")} Esperado=${rule.thicknesses.join(", ")}`);
    }
  }

  for (const familyCode of FAMILY_CODES) {
    if (familyCounts[familyCode] !== EXPECTED_FAMILY_COUNTS[familyCode]) {
      fail(`${familyCode}: cantidad aprobada=${familyCounts[familyCode]}, esperada=${EXPECTED_FAMILY_COUNTS[familyCode]}.`);
    }

    const summary = report.family_summary?.[familyCode];
    if (summary) {
      if (Number(summary.ok) !== EXPECTED_FAMILY_COUNTS[familyCode] || Number(summary.review) !== 0 || Number(summary.errors) !== 0) {
        fail(`${familyCode}: family_summary inconsistente con el estado esperado.`);
      }
    }
  }

  return { approved, reviewCount, errorCount, familyCounts };
}

async function preflight(approved) {
  const products = await loadProductsBySku(approved);
  const { map: finishes, requested } = await loadFinishes(approved);

  for (const item of approved) {
    const sku = String(item.sku).trim().toUpperCase();
    const product = products.get(sku);
    if (!product) fail(`Producto no encontrado en BD: ${sku}`);
    if (product.family_code !== item.family_code) {
      fail(`${sku}: familia BD=${product.family_code}, reporte=${item.family_code}.`);
    }
  }

  for (const req of requested) {
    const key = finishKey(req.familyCode, req.name);
    const finish = finishes.get(key);
    if (!finish) fail(`Acabado maestro no encontrado: ${req.familyCode} / ${req.name}`);
    if (!finish.has_formats) fail(`Acabado sin formatos activos: ${req.familyCode} / ${req.name}`);
    const expectedFormats = FAMILY_RULES[req.familyCode].formatsPerFinish;
    if (Number(finish.active_format_count) !== expectedFormats) {
      fail(`${req.familyCode} / ${req.name}: formatos activos=${finish.active_format_count}, esperados=${expectedFormats}.`);
    }
  }

  const relationCount = approved.reduce((sum, item) => sum + item.finishes.length, 0);
  const expectedRelationCount =
    EXPECTED_FAMILY_COUNTS.LABGRADE * FAMILY_RULES.LABGRADE.finishes.length +
    EXPECTED_FAMILY_COUNTS.LABGRADE_PLUS * FAMILY_RULES.LABGRADE_PLUS.finishes.length;

  if (relationCount !== expectedRelationCount) {
    fail(`Cantidad de relaciones inconsistente: ${relationCount}; esperada=${expectedRelationCount}`);
  }

  const existing = await loadExistingActiveRelations(approved);
  const desired = new Map(
    approved.map((item) => [
      String(item.sku).trim().toUpperCase(),
      new Set(item.finishes),
    ]),
  );
  const stale = existing.filter((row) => !desired.get(String(row.sku).toUpperCase())?.has(row.finish_name));
  if (stale.length) {
    const preview = stale.slice(0, 20).map((row) => `${row.sku}:${row.finish_name}`).join(", ");
    fail(`Hay relaciones activas fuera del reporte (${stale.length}). No se aplicará para evitar sobrescribir datos inesperados: ${preview}`);
  }

  return { products, finishes, relationCount, expectedRelationCount, existingActiveRelations: existing.length };
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
      if (shutdownRequested) throw new Error("Ejecución interrumpida por señal del sistema/usuario.");

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
        const finish = finishes.get(finishKey(item.family_code, finishName));
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
      const shouldPrint = processedProducts === 1 || processedProducts % PROGRESS_EVERY === 0 || processedProducts === approved.length;
      if (shouldPrint) {
        const productPct = ((processedProducts / approved.length) * 100).toFixed(1);
        const relationPct = ((processedRelations / relationCount) * 100).toFixed(1);
        info(
          `PROGRESO ${processedProducts}/${approved.length} productos (${productPct}%) | ` +
          `${processedRelations}/${relationCount} relaciones (${relationPct}%) | ` +
          `último=${currentSku} | familia=${item.family_code} | default=${item.default_finish} | ` +
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
      fam.code AS family_code,
      COUNT(DISTINCT ppf.product_id)::int AS productos_con_acabados,
      COUNT(*)::int AS relaciones_acabado,
      COUNT(DISTINCT ppf.product_id) FILTER (WHERE ppf.is_default = TRUE)::int AS productos_con_default
    FROM product_project_finishes ppf
    JOIN products p ON p.id = ppf.product_id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    WHERE fam.code = ANY($1::text[])
      AND ppf.is_active = TRUE
    GROUP BY fam.code
    ORDER BY fam.code
  `, [FAMILY_CODES]);
  return new Map(rows.map((row) => [row.family_code, row]));
}

async function verificationDefaultProblems() {
  const { rows } = await pool.query(`
    SELECT
      fam.code AS family_code,
      p.sku,
      p.name,
      COUNT(*) FILTER (WHERE ppf.is_default = TRUE AND ppf.is_active = TRUE)::int AS defaults
    FROM products p
    JOIN product_project_families fam ON fam.id = p.project_family_id
    LEFT JOIN product_project_finishes ppf ON ppf.product_id = p.id
    WHERE fam.code = ANY($1::text[])
    GROUP BY fam.code, p.id, p.sku, p.name
    HAVING COUNT(*) FILTER (WHERE ppf.is_default = TRUE AND ppf.is_active = TRUE) <> 1
    ORDER BY fam.code, p.sku
  `, [FAMILY_CODES]);
  return rows;
}

async function verificationRelationCountProblems() {
  const { rows } = await pool.query(`
    SELECT
      fam.code AS family_code,
      p.sku,
      p.name,
      COUNT(*) FILTER (WHERE ppf.is_active = TRUE)::int AS acabados_activos
    FROM products p
    JOIN project_product_families fam ON fam.id = p.project_family_id
    LEFT JOIN product_project_finishes ppf ON ppf.product_id = p.id
    WHERE fam.code = ANY($1::text[])
    GROUP BY fam.code, p.id, p.sku, p.name
    HAVING COUNT(*) FILTER (WHERE ppf.is_active = TRUE) <>
      CASE WHEN fam.code = 'LABGRADE' THEN 2 ELSE 1 END
    ORDER BY fam.code, p.sku
  `, [FAMILY_CODES]);
  return rows;
}

async function verificationNoFormatRelations() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS relaciones_sin_formato
    FROM product_project_finishes ppf
    JOIN products p ON p.id = ppf.product_id
    JOIN project_product_families fam ON fam.id = p.project_family_id
    JOIN project_family_finishes fin ON fin.id = ppf.finish_id
    WHERE fam.code = ANY($1::text[])
      AND ppf.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM project_family_finish_formats pfff
        JOIN project_family_formats fmt ON fmt.id = pfff.format_id
        WHERE pfff.finish_id = fin.id
          AND pfff.is_active = TRUE
          AND fmt.is_active = TRUE
      )
  `, [FAMILY_CODES]);
  return rows[0];
}

async function main() {
  info("=== Apply Labgrade / Abet from validated report V1 ===");
  info(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  info(`Log: ${logFile}`);
  info(`Progreso: cada ${PROGRESS_EVERY} producto(s)`);

  if (!REPORT_ARG) fail("Falta --report <ruta-json>.");

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
  info(`LABGRADE aprobados: ${validated.familyCounts.LABGRADE}`);
  info(`LABGRADE_PLUS aprobados: ${validated.familyCounts.LABGRADE_PLUS}`);
  info(`REVIEW: ${validated.reviewCount}`);
  info(`ERROR: ${validated.errorCount}`);
  info(`Faltantes catálogo: ${report.catalog_missing_expected?.length || 0}`);
  info(`Relaciones a insertar/actualizar: ${pre.relationCount}`);
  info(`Relaciones activas existentes compatibles: ${pre.existingActiveRelations}`);

  if (!APPLY) {
    info("PREFLIGHT OK. No se modificó PostgreSQL.");
    info(`Para aplicar exige: --apply --confirm=${REQUIRED_CONFIRM} --confirm-db=railway --confirm-count=<cantidad>`);
    info(`PROCESO TERMINADO CORRECTAMENTE. Duración=${formatDuration(Date.now() - startedAt)}`);
    info(`Log guardado en: ${logFile}`);
    return;
  }

  if (CONFIRM !== REQUIRED_CONFIRM) fail(`Confirmación inválida. Usa --confirm=${REQUIRED_CONFIRM}`);
  if (CONFIRM_DB !== "railway") fail("Confirmación de BD inválida. Usa --confirm-db=railway");
  if (EXPECTED_COUNT === null) fail("En APPLY es obligatorio --confirm-count=<cantidad DRY_RUN_OK>.");

  const applied = await applyApproved({ approved, ...pre });

  info("Ejecutando verificación post-COMMIT...");
  const verify = await verification();
  const defaultProblems = await verificationDefaultProblems();
  const relationCountProblems = await verificationRelationCountProblems();
  const noFormat = await verificationNoFormatRelations();

  info("=== VERIFICACIÓN FINAL ===");
  let verificationFailed = false;

  for (const familyCode of FAMILY_CODES) {
    const row = verify.get(familyCode) || {
      productos_con_acabados: 0,
      relaciones_acabado: 0,
      productos_con_default: 0,
    };
    const expectedProducts = EXPECTED_FAMILY_COUNTS[familyCode];
    const expectedRelations = expectedProducts * FAMILY_RULES[familyCode].finishes.length;

    info(`${familyCode} - Productos con acabados activos: ${row.productos_con_acabados}`);
    info(`${familyCode} - Relaciones de acabado activas: ${row.relaciones_acabado}`);
    info(`${familyCode} - Productos con default activo: ${row.productos_con_default}`);

    if (Number(row.productos_con_acabados) !== expectedProducts) {
      verificationFailed = true;
      warn(`${familyCode} COUNT_CHECK productos=${row.productos_con_acabados}, esperado=${expectedProducts}`);
    }
    if (Number(row.relaciones_acabado) !== expectedRelations) {
      verificationFailed = true;
      warn(`${familyCode} COUNT_CHECK relaciones=${row.relaciones_acabado}, esperado=${expectedRelations}`);
    }
    if (Number(row.productos_con_default) !== expectedProducts) {
      verificationFailed = true;
      warn(`${familyCode} COUNT_CHECK defaults=${row.productos_con_default}, esperado=${expectedProducts}`);
    }
  }

  info(`Productos procesados en esta ejecución: ${applied.processedProducts}`);
  info(`Relaciones procesadas en esta ejecución: ${applied.processedRelations}`);
  info(`Relaciones sin formato activo: ${noFormat.relaciones_sin_formato}`);

  if (defaultProblems.length) {
    verificationFailed = true;
    warn(`ATENCIÓN: ${defaultProblems.length} producto(s) con cantidad de default distinta de 1.`);
    for (const row of defaultProblems.slice(0, 50)) {
      warn(`DEFAULT_CHECK | ${row.family_code} | ${row.sku} | ${row.name} | defaults=${row.defaults}`);
    }
  } else {
    info("DEFAULT_CHECK OK: todos los productos Labgrade tienen exactamente 1 default.");
  }

  if (relationCountProblems.length) {
    verificationFailed = true;
    warn(`ATENCIÓN: ${relationCountProblems.length} producto(s) con cantidad de acabados activa incorrecta.`);
    for (const row of relationCountProblems.slice(0, 50)) {
      warn(`RELATION_CHECK | ${row.family_code} | ${row.sku} | ${row.name} | acabados=${row.acabados_activos}`);
    }
  } else {
    info("RELATION_CHECK OK: LABGRADE tiene 2 acabados y LABGRADE_PLUS 1 acabado por producto.");
  }

  if (Number(noFormat.relaciones_sin_formato) !== 0) {
    verificationFailed = true;
    warn(`FORMAT_CHECK: existen ${noFormat.relaciones_sin_formato} relación(es) sin formato activo.`);
  } else {
    info("FORMAT_CHECK OK: todas las relaciones Labgrade tienen formatos activos.");
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
