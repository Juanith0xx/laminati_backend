import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import pool from "../src/config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPLY = process.argv.includes("--apply");
const HEADLESS = !process.argv.includes("--headed");

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const ONLY_SKU = String(argValue("--sku") || "").trim().toUpperCase();
const LIMIT = Number(argValue("--limit") || 0) || 0;
const CONCURRENCY = Math.max(1, Math.min(4, Number(argValue("--concurrency") || 2) || 2));
const RETRIES = Math.max(1, Math.min(5, Number(argValue("--retries") || process.env.ABET_SYNC_RETRIES || 4) || 4));
const TIMEOUT_MS = Math.max(10000, Number(process.env.ABET_SYNC_TIMEOUT_MS || 60000));
const SECTION_WAIT_MS = Math.max(3000, Math.min(TIMEOUT_MS, Number(process.env.ABET_SYNC_SECTION_WAIT_MS || 18000)));
const SETTLE_MS = Math.max(500, Number(process.env.ABET_SYNC_SETTLE_MS || 1800));
const BASE_URL = String(process.env.ABET_BASE_URL || "https://abetlaminati.com").replace(/\/$/, "");

const SITE_MARKERS = [
  "productos y colecciones",
  "products and collections",
  "prodotti e collezioni",
];

const NEXT_PRODUCT_MARKERS = new Set([
  "meg-h",
  "easy meg",
  "easy-meg",
  "colours",
  "colors",
  "full-colour",
  "full colour",
  "hr-laq",
  "hr laq",
  "stratificato hpl",
  "polaris foldline",
  "polaris",
  "metalli",
  "labgrade",
  "labgrade plus",
  "walkprint",
  "diafos",
  "naval deck",
  "exterior",
]);

const FINISH_ALIASES = new Map([
  ["sei", ["sei"]],
  ["sei due", ["sei due", "sei 2"]],
  ["climb", ["climb"]],
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[×]/g, "x")
    .replace(/[“”‘’]/g, "'")
    .replace(/\r/g, "")
    .toLowerCase();
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function hasPhrase(text, phrase) {
  const escaped = normalizeText(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return regex.test(text);
}

function phraseIndex(text, phrase) {
  return normalizeText(text).indexOf(normalizeText(phrase));
}

function extractProductsSection(bodyText) {
  const normalized = normalizeText(bodyText);
  const indexes = SITE_MARKERS
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0);

  if (!indexes.length) return null;
  return normalized.slice(Math.min(...indexes));
}

function extractMegBlock(section) {
  if (!section) return null;

  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const start = lines.findIndex((line) => line === "meg");
  if (start < 0) return null;

  const selected = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && NEXT_PRODUCT_MARKERS.has(line)) {
      break;
    }
    selected.push(line);
    if (selected.length >= 50) break;
  }

  return selected.join("\n");
}

function getFinishAliases(name) {
  return FINISH_ALIASES.get(normalizeText(name).trim()) || [name];
}

function findFinishOccurrences(segment, masterFinishes) {
  const found = [];
  for (const finish of masterFinishes) {
    let bestIndex = Number.POSITIVE_INFINITY;
    for (const alias of getFinishAliases(finish.name)) {
      const idx = phraseIndex(segment, alias);
      if (idx >= 0 && hasPhrase(segment, alias)) {
        bestIndex = Math.min(bestIndex, idx);
      }
    }
    if (Number.isFinite(bestIndex)) {
      found.push({ ...finish, occurrenceIndex: bestIndex });
    }
  }
  return found.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex || a.sort_order - b.sort_order);
}

function parseMegPage({ bodyText, masterFinishes }) {
  const section = extractProductsSection(bodyText);
  if (!section) {
    return {
      ok: false,
      reason: "PRODUCTS_SECTION_NOT_FOUND",
      finishes: [],
      defaultFinish: null,
      diagnostics: {
        body_length: String(bodyText || "").length,
        section_length: 0,
        meg_block_found: false,
        raw_finish_hits: [],
      },
    };
  }

  const megBlock = extractMegBlock(section);
  if (!megBlock) {
    return {
      ok: false,
      reason: "MEG_BLOCK_NOT_FOUND",
      finishes: [],
      defaultFinish: null,
      diagnostics: {
        body_length: String(bodyText || "").length,
        section_length: section.length,
        meg_block_found: false,
        raw_finish_hits: [],
        section_preview: section.slice(0, 1800),
      },
    };
  }

  const matched = findFinishOccurrences(megBlock, masterFinishes);
  const valid = matched.filter((finish) => finish.has_formats);
  const rejectedNoFormats = matched.filter((finish) => !finish.has_formats).map((finish) => finish.name);

  if (!valid.length) {
    return {
      ok: false,
      reason: matched.length ? "MEG_FINISHES_WITHOUT_ACTIVE_FORMATS" : "MEG_FINISHES_NOT_RECOGNIZED",
      finishes: [],
      defaultFinish: null,
      diagnostics: {
        body_length: String(bodyText || "").length,
        section_length: section.length,
        meg_block_found: true,
        raw_finish_hits: matched.map((finish) => finish.name),
        rejected_no_active_formats: rejectedNoFormats,
        meg_block_preview: megBlock.slice(0, 1800),
      },
    };
  }

  // Abet presenta primero el acabado estándar y luego los alternativos.
  const defaultFinish = valid[0] || null;

  return {
    ok: true,
    reason: null,
    finishes: valid,
    defaultFinish,
    diagnostics: {
      body_length: String(bodyText || "").length,
      section_length: section.length,
      meg_block_found: true,
      raw_finish_hits: matched.map((finish) => finish.name),
      rejected_no_active_formats: rejectedNoFormats,
      meg_block_preview: megBlock.slice(0, 1800),
    },
  };
}

async function loadMasterFinishes() {
  const { rows } = await pool.query(`
    SELECT
      f.id,
      f.name,
      f.sort_order,
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
    WHERE fam.code = 'MEG'
      AND f.is_active = TRUE
    ORDER BY f.sort_order, f.name
  `);
  return rows;
}

async function loadActiveThicknesses() {
  const { rows } = await pool.query(`
    SELECT t.thickness_mm
    FROM project_family_thicknesses t
    JOIN project_product_families fam
      ON fam.id = t.family_id
    WHERE fam.code = 'MEG'
      AND t.is_active = TRUE
    ORDER BY t.thickness_mm
  `);
  return rows.map((row) => Number(row.thickness_mm));
}

async function loadProducts() {
  const params = [];
  let skuFilter = "";
  let limitSql = "";

  if (ONLY_SKU) {
    params.push(ONLY_SKU);
    skuFilter = `AND UPPER(p.sku) = $${params.length}`;
  }

  if (LIMIT > 0) {
    params.push(LIMIT);
    limitSql = `LIMIT $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.internal_code,
      p.name,
      p.is_published,
      p.allow_sale
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    WHERE fam.code = 'MEG'
      ${skuFilter}
    ORDER BY p.sku
    ${limitSql}
  `, params);

  return rows;
}

async function loadCatalogAudit() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE internal_code = '405')::int AS has_405,
      COUNT(*) FILTER (WHERE internal_code IN ('1450','715','754','756'))::int AS discontinued_present
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    WHERE fam.code = 'MEG'
  `);
  return rows[0] || { total: 0, has_405: 0, discontinued_present: 0 };
}

async function loadFinishFormats(finishIds) {
  if (!finishIds.length) return {};

  const { rows } = await pool.query(`
    SELECT
      f.id AS finish_id,
      f.name AS finish,
      fmt.id AS format_id,
      fmt.label,
      fmt.width_cm,
      fmt.length_cm,
      fmt.sort_order
    FROM project_family_finish_formats pfff
    JOIN project_family_finishes f
      ON f.id = pfff.finish_id
    JOIN project_family_formats fmt
      ON fmt.id = pfff.format_id
    WHERE pfff.is_active = TRUE
      AND fmt.is_active = TRUE
      AND f.id = ANY($1::uuid[])
    ORDER BY f.sort_order, fmt.sort_order
  `, [finishIds]);

  return rows.reduce((acc, row) => {
    acc[row.finish_id] ||= [];
    acc[row.finish_id].push({
      id: row.format_id,
      label: row.label,
      width_cm: Number(row.width_cm),
      length_cm: Number(row.length_cm),
    });
    return acc;
  }, {});
}

async function waitForProductsSection(page) {
  try {
    await page.waitForFunction(
      (markers) => {
        const text = (document.body?.innerText || "").toLowerCase();
        return markers.some((marker) => text.includes(marker));
      },
      SITE_MARKERS,
      { timeout: SECTION_WAIT_MS }
    );
    return true;
  } catch {
    return false;
  }
}

async function readSettledBody(page) {
  const markerFound = await waitForProductsSection(page);

  try {
    await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0));
  } catch {
    // noop
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(5000, SECTION_WAIT_MS) });
  } catch {
    // Abet mantiene recursos activos; no es fatal.
  }

  await page.waitForTimeout(SETTLE_MS);
  const bodyText = await page.locator("body").innerText({ timeout: 10000 });
  return { bodyText, markerFound };
}

function buildCandidateUrls(product) {
  const code = String(product.internal_code || product.sku?.replace(/^MEG-/i, "") || "").trim();
  const slug = slugify(product.name);
  const candidates = [
    `${BASE_URL}/decori/meg-sei-${slug}-${encodeURIComponent(code)}/`,
    `${BASE_URL}/decori/${slug}-${encodeURIComponent(code)}/`,
    `${BASE_URL}/decori/meg-sei-due-${slug}-${encodeURIComponent(code)}/`,
    `${BASE_URL}/decori/meg-climb-${slug}-${encodeURIComponent(code)}/`,
  ];
  return [...new Set(candidates)];
}

async function tryCandidateUrl(page, url) {
  const attempts = [];
  let finalParsed = null;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = attempt === 1
        ? await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS })
        : await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

      const status = response?.status() || null;
      if (!response || status >= 400) {
        attempts.push({ attempt, http_status: status, ok: false, reason: `HTTP_${status || "NO_RESPONSE"}` });
        break;
      }

      const { bodyText, markerFound } = await readSettledBody(page);
      attempts.push({ attempt, http_status: status, marker_found_during_wait: markerFound, bodyText });
      return { ok: true, responseStatus: status, bodyText, attempts };
    } catch (error) {
      attempts.push({ attempt, ok: false, reason: error?.message || String(error) });
      if (attempt < RETRIES) {
        await page.waitForTimeout(1200 * attempt);
      }
    }
  }

  return { ok: false, responseStatus: null, bodyText: null, attempts, finalParsed };
}

async function applyProductFinishes({ product, parsed, sourceUrl }) {
  if (!parsed.finishes.length) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (parsed.defaultFinish) {
      await client.query(`
        UPDATE product_project_finishes
        SET is_default = FALSE, updated_at = NOW()
        WHERE product_id = $1
      `, [product.id]);
    }

    for (const finish of parsed.finishes) {
      const isDefault = parsed.defaultFinish?.id === finish.id;
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
        VALUES ($1, $2, $3, TRUE, 'Abet Laminati', $4, 'MEG-07-2026')
        ON CONFLICT (product_id, finish_id)
        DO UPDATE SET
          is_default = EXCLUDED.is_default,
          is_active = TRUE,
          source_name = EXCLUDED.source_name,
          source_url = EXCLUDED.source_url,
          source_version = EXCLUDED.source_version,
          updated_at = NOW()
      `, [product.id, finish.id, isDefault, sourceUrl]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function inspectProduct({ browser, product, masterFinishes, thicknesses }) {
  const code = String(product.internal_code || product.sku?.replace(/^MEG-/i, "") || "").trim();
  const candidateUrls = buildCandidateUrls(product);
  const page = await browser.newPage({
    locale: "es-ES",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  });

  const urlAttempts = [];

  try {
    let chosenUrl = null;
    let parsed = null;

    for (const url of candidateUrls) {
      const loaded = await tryCandidateUrl(page, url);
      const cleanAttempts = loaded.attempts.map(({ bodyText, ...rest }) => rest);
      urlAttempts.push({ url, attempts: cleanAttempts });

      if (!loaded.ok || !loaded.bodyText) continue;

      const candidateParsed = parseMegPage({ bodyText: loaded.bodyText, masterFinishes });
      urlAttempts[urlAttempts.length - 1].parse_reason = candidateParsed.reason;
      urlAttempts[urlAttempts.length - 1].meg_block_found = candidateParsed.diagnostics?.meg_block_found || false;

      if (candidateParsed.ok || candidateParsed.reason !== "PRODUCTS_SECTION_NOT_FOUND") {
        chosenUrl = url;
        parsed = candidateParsed;
        if (candidateParsed.ok) break;
      }
    }

    if (!parsed || !chosenUrl) {
      return {
        sku: product.sku,
        code,
        name: product.name,
        status: "ERROR",
        reason: "NO_USABLE_ABET_PAGE",
        url: candidateUrls[0],
        candidate_urls: candidateUrls,
        url_attempts: urlAttempts,
        default_finish: null,
        finishes: [],
        formats: {},
        thicknesses,
      };
    }

    const formats = await loadFinishFormats(parsed.finishes.map((finish) => finish.id));

    if (APPLY && parsed.ok) {
      await applyProductFinishes({ product, parsed, sourceUrl: chosenUrl });
    }

    return {
      sku: product.sku,
      code,
      name: product.name,
      is_published: product.is_published,
      allow_sale: product.allow_sale,
      url: chosenUrl,
      status: parsed.ok ? (APPLY ? "APPLIED" : "DRY_RUN_OK") : "REVIEW",
      reason: parsed.reason,
      default_finish: parsed.defaultFinish?.name || null,
      finishes: parsed.finishes.map((finish) => finish.name),
      formats: Object.fromEntries(
        parsed.finishes.map((finish) => [
          finish.name,
          (formats[finish.id] || []).map((format) => format.label),
        ])
      ),
      thicknesses,
      diagnostics: parsed.diagnostics,
      candidate_urls: candidateUrls,
      url_attempts: urlAttempts,
    };
  } catch (error) {
    return {
      sku: product.sku,
      code,
      name: product.name,
      status: "ERROR",
      reason: error?.message || String(error),
      url: candidateUrls[0],
      candidate_urls: candidateUrls,
      url_attempts: urlAttempts,
      default_finish: null,
      finishes: [],
      formats: {},
      thicknesses,
    };
  } finally {
    await page.close();
  }
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  return results;
}

function printProductResult(result, index, total) {
  console.log(`[${index + 1}/${total}] ${result.sku} -> ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  console.log(`    ${result.url}`);
  console.log(`    default=${result.default_finish || "—"}`);
  console.log(`    acabados=${result.finishes?.length ? result.finishes.join(", ") : "—"}`);
  console.log(`    espesores=${result.thicknesses?.length ? result.thicknesses.join(", ") : "—"}`);
  for (const [finish, formats] of Object.entries(result.formats || {})) {
    console.log(`      ${finish}: ${formats.join(" | ") || "sin formato activo"}`);
  }
  if (result.status !== "DRY_RUN_OK" && result.status !== "APPLIED" && result.diagnostics) {
    console.log(`    meg_block=${result.diagnostics.meg_block_found ? "sí" : "no"}`);
    console.log(`    acabados_crudos=${result.diagnostics.raw_finish_hits?.join(", ") || "—"}`);
  }
}

async function main() {
  console.log("=== Sync MEG / Abet options V1 ===");
  console.log(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Abet: ${BASE_URL}`);
  console.log(`SKU: ${ONLY_SKU || "todos"}`);
  console.log(`Limit: ${LIMIT || "sin límite"}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Retries: ${RETRIES}`);
  console.log(`Section wait: ${SECTION_WAIT_MS} ms`);
  console.log(`Settle: ${SETTLE_MS} ms`);
  console.log("");

  const [masterFinishes, thicknesses, products, catalogAudit] = await Promise.all([
    loadMasterFinishes(),
    loadActiveThicknesses(),
    loadProducts(),
    loadCatalogAudit(),
  ]);

  console.log(`Acabados maestros MEG: ${masterFinishes.length}`);
  console.log(`Espesores activos MEG: ${thicknesses.length} (${thicknesses.join(", ")})`);
  console.log(`Productos MEG en BD: ${catalogAudit.total}`);
  console.log(`Productos a revisar: ${products.length}`);
  console.log(`MEG-405 presente: ${catalogAudit.has_405 ? "sí" : "NO"}`);
  if (!catalogAudit.has_405) {
    console.log("ADVERTENCIA CATÁLOGO: falta MEG-405 Bianco Porcellana, presente en la ficha MEG 07/2026.");
  }
  console.log("");

  if (!products.length) {
    console.log("No hay productos para procesar.");
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    let completed = 0;
    const results = await mapConcurrent(products, CONCURRENCY, async (product) => {
      const result = await inspectProduct({ browser, product, masterFinishes, thicknesses });
      printProductResult(result, completed, products.length);
      completed += 1;
      return result;
    });

    const reviewByReason = results
      .filter((item) => item.status === "REVIEW")
      .reduce((acc, item) => {
        const key = item.reason || "UNKNOWN_REVIEW";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

    const errorByReason = results
      .filter((item) => item.status === "ERROR")
      .reduce((acc, item) => {
        const key = item.reason || "UNKNOWN_ERROR";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

    const summary = {
      generated_at: new Date().toISOString(),
      version: "MEG_V1",
      source_version: "MEG-07-2026",
      mode: APPLY ? "APPLY" : "DRY_RUN",
      base_url: BASE_URL,
      total_catalog_db: catalogAudit.total,
      catalog_missing_expected: catalogAudit.has_405 ? [] : [
        { sku: "MEG-405", code: "405", name: "Bianco Porcellana", source: "MEG 07/2026" },
      ],
      active_thicknesses_mm: thicknesses,
      master_finishes: masterFinishes.map((finish) => finish.name),
      total: results.length,
      ok: results.filter((item) => ["DRY_RUN_OK", "APPLIED"].includes(item.status)).length,
      review: results.filter((item) => item.status === "REVIEW").length,
      review_by_reason: reviewByReason,
      errors: results.filter((item) => item.status === "ERROR").length,
      error_by_reason: errorByReason,
      results,
    };

    const reportDir = path.resolve(__dirname, "../tmp");
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportDir, `meg_abet_sync_v1_${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");

    console.log("");
    console.log("=== RESUMEN ===");
    console.log(`OK: ${summary.ok}`);
    console.log(`REVIEW: ${summary.review}`);
    for (const [reason, count] of Object.entries(summary.review_by_reason)) {
      console.log(`  - ${reason}: ${count}`);
    }
    console.log(`ERROR: ${summary.errors}`);
    for (const [reason, count] of Object.entries(summary.error_by_reason)) {
      console.log(`  - ${reason}: ${count}`);
    }
    console.log(`Faltantes de catálogo esperados: ${summary.catalog_missing_expected.length}`);
    for (const missing of summary.catalog_missing_expected) {
      console.log(`  - ${missing.sku} ${missing.name}`);
    }
    console.log(`Reporte: ${reportPath}`);

    if (!APPLY) {
      console.log("");
      console.log("DRY-RUN: no se modificó PostgreSQL.");
      console.log("No uses --apply hasta validar el reporte completo.");
    }
  } finally {
    await browser.close();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error("ERROR FATAL:", error);
  try {
    await pool.end();
  } catch {
    // noop
  }
  process.exitCode = 1;
});
