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
const RETRIES = Math.max(1, Math.min(5, Number(argValue("--retries") || process.env.ABET_SYNC_RETRIES || 5) || 5));
const TIMEOUT_MS = Math.max(10000, Number(process.env.ABET_SYNC_TIMEOUT_MS || 90000));
const SECTION_WAIT_MS = Math.max(3000, Math.min(TIMEOUT_MS, Number(process.env.ABET_SYNC_SECTION_WAIT_MS || 20000)));
const SETTLE_MS = Math.max(500, Number(process.env.ABET_SYNC_SETTLE_MS || 2000));
const BASE_URL = String(process.env.ABET_BASE_URL || "https://abetlaminati.com").replace(/\/$/, "");
const PROGRESS_HEARTBEAT_MS = Math.max(3000, Number(process.env.ABET_SYNC_HEARTBEAT_MS || 5000));

const FAMILY_CODES = ["LABGRADE", "LABGRADE_PLUS"];
const SOURCE_VERSION = "LABGRADE-06-2026";

const EXPECTED_CATALOG = {
  LABGRADE: [
    ["410", "Bianco Ghiaccio"],
    ["406", "Bianco Primavera"],
    ["810", "Mini Bianco"],
    ["478", "Grigio Chiaro"],
    ["475", "Grigio Perla"],
    ["421", "Nero"],
  ],
  LABGRADE_PLUS: [
    ["763", "White"],
    ["765", "Grey"],
    ["764", "Black"],
    ["766", "766"],
  ],
};

const SITE_MARKERS = [
  "productos y colecciones",
  "products and collections",
  "prodotti e collezioni",
];

const NEXT_PRODUCT_MARKERS = new Set([
  "colours",
  "colors",
  "full-colour",
  "full colour",
  "hr-laq",
  "hr laq",
  "stratificato hpl",
  "polaris foldline",
  "polaris contemporary",
  "polaris",
  "metalli",
  "magnetico",
  "meg",
  "meg-h",
  "walkprint",
  "diafos",
  "naval deck",
  "foldline",
  "lamishield",
  "postforming",
  "print hpl",
]);

const FINISH_ALIASES = new Map([
  ["sei", ["sei"]],
  ["zodia", ["zodia"]],
  ["skin", ["skin"]],
]);

// Se mencionan en fichas web pero NO forman parte del maestro técnico que estamos aplicando.
// Se guardan solo como diagnóstico para poder auditarlas sin incorporarlas automáticamente.
const EXTERNAL_FINISH_TERMS = ["morbida"];

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function progressLine({ index, total, sku, stage, startedAt, extra = "" }) {
  const elapsed = formatDuration(Date.now() - startedAt);
  const suffix = extra ? ` | ${extra}` : "";
  console.log(`[${index + 1}/${total}] ${sku} -> ${stage} | transcurrido=${elapsed}${suffix}`);
}

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

function decorNameForSlug(product) {
  let value = String(product.name || "").trim();
  if (product.family_code === "LABGRADE") {
    value = value.replace(/\s+labgrade\s*$/i, "").trim();
  } else if (product.family_code === "LABGRADE_PLUS") {
    value = value.replace(/\s+labgrade\s+plus\s*$/i, "").trim();
  }
  return value || String(product.internal_code || "").trim();
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

function isBlockBoundary(line, familyCode) {
  if (familyCode === "LABGRADE" && line === "labgrade plus") return true;
  if (familyCode === "LABGRADE_PLUS" && line === "labgrade") return true;
  return NEXT_PRODUCT_MARKERS.has(line);
}

function extractFamilyBlock(section, familyCode) {
  if (!section) return null;
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const target = familyCode === "LABGRADE_PLUS" ? "labgrade plus" : "labgrade";
  const start = lines.findIndex((line) => line === target);
  if (start < 0) return null;

  const selected = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && isBlockBoundary(line, familyCode)) break;
    selected.push(line);
    if (selected.length >= 60) break;
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
      if (idx >= 0 && hasPhrase(segment, alias)) bestIndex = Math.min(bestIndex, idx);
    }
    if (Number.isFinite(bestIndex)) {
      found.push({ ...finish, occurrenceIndex: bestIndex });
    }
  }
  return found.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex || a.sort_order - b.sort_order);
}

function findExternalFinishHits(segment) {
  return EXTERNAL_FINISH_TERMS.filter((name) => hasPhrase(segment, name));
}

function parseLabgradePage({ bodyText, familyCode, masterFinishes }) {
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
        family_block_found: false,
        raw_finish_hits: [],
        external_finish_hits: [],
      },
    };
  }

  const familyBlock = extractFamilyBlock(section, familyCode);
  if (!familyBlock) {
    return {
      ok: false,
      reason: familyCode === "LABGRADE_PLUS" ? "LABGRADE_PLUS_BLOCK_NOT_FOUND" : "LABGRADE_BLOCK_NOT_FOUND",
      finishes: [],
      defaultFinish: null,
      diagnostics: {
        body_length: String(bodyText || "").length,
        section_length: section.length,
        family_block_found: false,
        raw_finish_hits: [],
        external_finish_hits: [],
        section_preview: section.slice(0, 2200),
      },
    };
  }

  const matched = findFinishOccurrences(familyBlock, masterFinishes);
  const valid = matched.filter((finish) => finish.has_formats);
  const rejectedNoFormats = matched.filter((finish) => !finish.has_formats).map((finish) => finish.name);
  const externalFinishHits = findExternalFinishHits(familyBlock);

  if (!valid.length) {
    return {
      ok: false,
      reason: matched.length ? "LABGRADE_FINISHES_WITHOUT_ACTIVE_FORMATS" : "LABGRADE_FINISHES_NOT_RECOGNIZED",
      finishes: [],
      defaultFinish: null,
      diagnostics: {
        body_length: String(bodyText || "").length,
        section_length: section.length,
        family_block_found: true,
        raw_finish_hits: matched.map((finish) => finish.name),
        external_finish_hits: externalFinishHits,
        rejected_no_active_formats: rejectedNoFormats,
        family_block_preview: familyBlock.slice(0, 2200),
        parser_version: "LABGRADE_V1_MASTER_INTERSECTION",
      },
    };
  }

  const defaultFinish = valid[0] || null;

  return {
    ok: true,
    reason: null,
    finishes: valid,
    defaultFinish,
    diagnostics: {
      body_length: String(bodyText || "").length,
      section_length: section.length,
      family_block_found: true,
      raw_finish_hits: matched.map((finish) => finish.name),
      external_finish_hits: externalFinishHits,
      rejected_no_active_formats: rejectedNoFormats,
      family_block_preview: familyBlock.slice(0, 2200),
      parser_version: "LABGRADE_V1_MASTER_INTERSECTION",
    },
  };
}

async function loadMasterFinishes() {
  const { rows } = await pool.query(`
    SELECT
      fam.code AS family_code,
      f.id,
      f.name,
      f.sort_order,
      EXISTS (
        SELECT 1
        FROM project_family_finish_formats pfff
        JOIN project_family_formats fmt ON fmt.id = pfff.format_id
        WHERE pfff.finish_id = f.id
          AND pfff.is_active = TRUE
          AND fmt.is_active = TRUE
      ) AS has_formats
    FROM project_family_finishes f
    JOIN project_product_families fam ON fam.id = f.family_id
    WHERE fam.code = ANY($1::text[])
      AND f.is_active = TRUE
    ORDER BY fam.code, f.sort_order, f.name
  `, [FAMILY_CODES]);

  return rows.reduce((acc, row) => {
    acc[row.family_code] ||= [];
    acc[row.family_code].push(row);
    return acc;
  }, {});
}

async function loadActiveThicknesses() {
  const { rows } = await pool.query(`
    SELECT fam.code AS family_code, t.thickness_mm
    FROM project_family_thicknesses t
    JOIN project_product_families fam ON fam.id = t.family_id
    WHERE fam.code = ANY($1::text[])
      AND t.is_active = TRUE
    ORDER BY fam.code, t.thickness_mm
  `, [FAMILY_CODES]);

  return rows.reduce((acc, row) => {
    acc[row.family_code] ||= [];
    acc[row.family_code].push(Number(row.thickness_mm));
    return acc;
  }, {});
}

async function loadProducts() {
  const params = [FAMILY_CODES];
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
      p.allow_sale,
      fam.code AS family_code,
      fam.name AS family_name
    FROM products p
    JOIN project_product_families fam ON fam.id = p.project_family_id
    WHERE fam.code = ANY($1::text[])
      ${skuFilter}
    ORDER BY fam.code, p.sku
    ${limitSql}
  `, params);
  return rows;
}

async function loadCatalogAudit() {
  const { rows } = await pool.query(`
    SELECT fam.code AS family_code, p.internal_code, p.sku, p.name
    FROM products p
    JOIN project_product_families fam ON fam.id = p.project_family_id
    WHERE fam.code = ANY($1::text[])
    ORDER BY fam.code, p.sku
  `, [FAMILY_CODES]);

  const byFamily = Object.fromEntries(FAMILY_CODES.map((code) => [code, []]));
  for (const row of rows) byFamily[row.family_code].push(row);

  const missing = [];
  for (const familyCode of FAMILY_CODES) {
    const present = new Set(byFamily[familyCode].map((row) => String(row.internal_code || "").trim()));
    for (const [code, name] of EXPECTED_CATALOG[familyCode]) {
      if (!present.has(code)) {
        missing.push({ family_code: familyCode, code, name, sku: familyCode === "LABGRADE" ? `LAB-${code}` : `LABP-${code}` });
      }
    }
  }

  return {
    byFamily,
    totals: Object.fromEntries(FAMILY_CODES.map((code) => [code, byFamily[code].length])),
    missing,
  };
}

async function loadFinishFormats(finishIds) {
  if (!finishIds.length) return {};
  const { rows } = await pool.query(`
    SELECT
      f.id AS finish_id,
      fmt.id AS format_id,
      fmt.label,
      fmt.width_cm,
      fmt.length_cm,
      fmt.sort_order
    FROM project_family_finish_formats pfff
    JOIN project_family_finishes f ON f.id = pfff.finish_id
    JOIN project_family_formats fmt ON fmt.id = pfff.format_id
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
  try { await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0)); } catch {}
  try { await page.waitForLoadState("networkidle", { timeout: Math.min(5000, SECTION_WAIT_MS) }); } catch {}
  await page.waitForTimeout(SETTLE_MS);
  const bodyText = await page.locator("body").innerText({ timeout: 10000 });
  return { bodyText, markerFound };
}

function buildCandidateUrls(product) {
  const code = String(product.internal_code || "").trim();
  const baseName = decorNameForSlug(product);
  const slug = slugify(baseName);

  if (product.family_code === "LABGRADE_PLUS") {
    const specialized = code === "766"
      ? `${BASE_URL}/decori/labgrade-plus-skin-${encodeURIComponent(code)}/`
      : `${BASE_URL}/decori/labgrade-plus-skin-${slug}-${encodeURIComponent(code)}/`;
    const generic = code === "766"
      ? `${BASE_URL}/decori/${encodeURIComponent(code)}/`
      : `${BASE_URL}/decori/${slug}-${encodeURIComponent(code)}/`;
    return [...new Set([generic, specialized])];
  }

  return [...new Set([
    `${BASE_URL}/decori/${slug}-${encodeURIComponent(code)}/`,
    `${BASE_URL}/decori/labgrade-sei-${slug}-${encodeURIComponent(code)}/`,
    `${BASE_URL}/decori/labgrade-zodia-${slug}-${encodeURIComponent(code)}/`,
  ])];
}

async function tryCandidateUrl(page, url, { onProgress } = {}) {
  const attempts = [];
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      onProgress?.(`INTENTO ${attempt}/${RETRIES} - navegando`, `url=${url}`);
      const response = attempt === 1
        ? await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS })
        : await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

      const status = response?.status() || null;
      onProgress?.(`INTENTO ${attempt}/${RETRIES} - HTTP ${status || "sin respuesta"}`);
      if (!response || status >= 400) {
        attempts.push({ attempt, http_status: status, ok: false, reason: `HTTP_${status || "NO_RESPONSE"}` });
        break;
      }

      onProgress?.(`INTENTO ${attempt}/${RETRIES} - esperando sección Products & Collections`);
      const { bodyText, markerFound } = await readSettledBody(page);
      onProgress?.(`INTENTO ${attempt}/${RETRIES} - página leída`, `marker=${markerFound ? "sí" : "no"}`);
      attempts.push({ attempt, http_status: status, marker_found_during_wait: markerFound, bodyText });
      return { ok: true, responseStatus: status, bodyText, attempts };
    } catch (error) {
      onProgress?.(`INTENTO ${attempt}/${RETRIES} - ERROR`, String(error?.message || error).split("\n")[0]);
      attempts.push({ attempt, ok: false, reason: error?.message || String(error) });
      if (attempt < RETRIES) {
        onProgress?.("REINTENTO PROGRAMADO", `espera=${1200 * attempt}ms`);
        await page.waitForTimeout(1200 * attempt);
      }
    }
  }
  return { ok: false, responseStatus: null, bodyText: null, attempts };
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
        VALUES ($1, $2, $3, TRUE, 'Abet Laminati', $4, $5)
        ON CONFLICT (product_id, finish_id)
        DO UPDATE SET
          is_default = EXCLUDED.is_default,
          is_active = TRUE,
          source_name = EXCLUDED.source_name,
          source_url = EXCLUDED.source_url,
          source_version = EXCLUDED.source_version,
          updated_at = NOW()
      `, [product.id, finish.id, isDefault, sourceUrl, SOURCE_VERSION]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function inspectProduct({ browser, product, masterFinishesByFamily, thicknessesByFamily, index, total }) {
  const code = String(product.internal_code || "").trim();
  const candidateUrls = buildCandidateUrls(product);
  const page = await browser.newPage({
    locale: "es-ES",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  });

  const urlAttempts = [];
  const startedAt = Date.now();
  let currentStage = "INICIANDO";
  let currentExtra = `familia=${product.family_code} candidatas=${candidateUrls.length}`;
  const onProgress = (stage, extra = "") => {
    currentStage = stage;
    currentExtra = extra;
    progressLine({ index, total, sku: product.sku, stage, startedAt, extra });
  };

  onProgress("INICIANDO", currentExtra);
  const heartbeat = setInterval(() => {
    progressLine({ index, total, sku: product.sku, stage: `TRABAJANDO (${currentStage})`, startedAt, extra: currentExtra });
  }, PROGRESS_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    let chosenUrl = null;
    let parsed = null;
    const masterFinishes = masterFinishesByFamily[product.family_code] || [];
    const thicknesses = thicknessesByFamily[product.family_code] || [];

    for (let urlIndex = 0; urlIndex < candidateUrls.length; urlIndex += 1) {
      const url = candidateUrls[urlIndex];
      onProgress(`URL ${urlIndex + 1}/${candidateUrls.length}`, url);
      const loaded = await tryCandidateUrl(page, url, { onProgress });
      const cleanAttempts = loaded.attempts.map(({ bodyText, ...rest }) => rest);
      urlAttempts.push({ url, attempts: cleanAttempts });
      if (!loaded.ok || !loaded.bodyText) continue;

      onProgress(`ANALIZANDO BLOQUE ${product.family_code}`, url);
      const candidateParsed = parseLabgradePage({
        bodyText: loaded.bodyText,
        familyCode: product.family_code,
        masterFinishes,
      });

      onProgress(
        candidateParsed.ok ? "PARSE OK" : `PARSE ${candidateParsed.reason}`,
        `acabados=${candidateParsed.finishes?.map((f) => f.name).join(",") || "—"}`
      );

      urlAttempts[urlAttempts.length - 1].parse_reason = candidateParsed.reason;
      urlAttempts[urlAttempts.length - 1].family_block_found = candidateParsed.diagnostics?.family_block_found || false;

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
        family_code: product.family_code,
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

    onProgress("CARGANDO FORMATOS", `acabados=${parsed.finishes.length}`);
    const formats = await loadFinishFormats(parsed.finishes.map((finish) => finish.id));

    if (APPLY && parsed.ok) {
      onProgress("APLICANDO EN POSTGRESQL");
      await applyProductFinishes({ product, parsed, sourceUrl: chosenUrl });
      onProgress("APPLY OK");
    }

    return {
      sku: product.sku,
      code,
      name: product.name,
      family_code: product.family_code,
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
      family_code: product.family_code,
      status: "ERROR",
      reason: error?.message || String(error),
      url: candidateUrls[0],
      candidate_urls: candidateUrls,
      url_attempts: urlAttempts,
      default_finish: null,
      finishes: [],
      formats: {},
      thicknesses: thicknessesByFamily[product.family_code] || [],
    };
  } finally {
    clearInterval(heartbeat);
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
  console.log(`[${index + 1}/${total}] ${result.sku} [${result.family_code}] -> ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  console.log(`    ${result.url}`);
  console.log(`    default=${result.default_finish || "—"}`);
  console.log(`    acabados=${result.finishes?.length ? result.finishes.join(", ") : "—"}`);
  console.log(`    espesores=${result.thicknesses?.length ? result.thicknesses.join(", ") : "—"}`);
  for (const [finish, formats] of Object.entries(result.formats || {})) {
    console.log(`      ${finish}: ${formats.join(" | ") || "sin formato activo"}`);
  }
  const extra = result.diagnostics?.external_finish_hits || [];
  if (extra.length) console.log(`    nota_web_fuera_maestro=${extra.join(", ")}`);
  if (!["DRY_RUN_OK", "APPLIED"].includes(result.status) && result.diagnostics) {
    console.log(`    family_block=${result.diagnostics.family_block_found ? "sí" : "no"}`);
    console.log(`    acabados_crudos=${result.diagnostics.raw_finish_hits?.join(", ") || "—"}`);
  }
}

async function main() {
  console.log("=== Sync Labgrade / Abet options V1 + progreso ===");
  console.log(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Abet: ${BASE_URL}`);
  console.log(`SKU: ${ONLY_SKU || "todos"}`);
  console.log(`Limit: ${LIMIT || "sin límite"}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Retries: ${RETRIES}`);
  console.log(`Section wait: ${SECTION_WAIT_MS} ms`);
  console.log(`Settle: ${SETTLE_MS} ms`);
  console.log(`Heartbeat: ${PROGRESS_HEARTBEAT_MS} ms`);
  console.log("");

  const [masterFinishesByFamily, thicknessesByFamily, products, catalogAudit] = await Promise.all([
    loadMasterFinishes(),
    loadActiveThicknesses(),
    loadProducts(),
    loadCatalogAudit(),
  ]);

  for (const familyCode of FAMILY_CODES) {
    const finishes = masterFinishesByFamily[familyCode] || [];
    const thicknesses = thicknessesByFamily[familyCode] || [];
    console.log(`${familyCode}: productos BD=${catalogAudit.totals[familyCode] || 0} | acabados maestros=${finishes.length} (${finishes.map((f) => f.name).join(", ") || "—"}) | espesores=${thicknesses.length} (${thicknesses.join(", ") || "—"})`);
  }
  console.log(`Productos a revisar: ${products.length}`);
  console.log(`Faltantes esperados de catálogo: ${catalogAudit.missing.length}`);
  for (const item of catalogAudit.missing) console.log(`  - ${item.sku} ${item.name}`);
  console.log("");

  if (!products.length) {
    console.log("No hay productos para procesar.");
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    let completed = 0;
    const batchStartedAt = Date.now();
    const results = await mapConcurrent(products, CONCURRENCY, async (product, index) => {
      const result = await inspectProduct({
        browser,
        product,
        masterFinishesByFamily,
        thicknessesByFamily,
        index,
        total: products.length,
      });
      completed += 1;
      printProductResult(result, index, products.length);
      const percent = ((completed / products.length) * 100).toFixed(1);
      console.log(`PROGRESO GLOBAL: ${completed}/${products.length} (${percent}%) | transcurrido=${formatDuration(Date.now() - batchStartedAt)}`);
      console.log("");
      return result;
    });

    const reviewByReason = results.filter((r) => r.status === "REVIEW").reduce((acc, r) => {
      const key = r.reason || "UNKNOWN_REVIEW";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const errorByReason = results.filter((r) => r.status === "ERROR").reduce((acc, r) => {
      const key = r.reason || "UNKNOWN_ERROR";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const familySummary = {};
    for (const familyCode of FAMILY_CODES) {
      const familyResults = results.filter((r) => r.family_code === familyCode);
      familySummary[familyCode] = {
        total: familyResults.length,
        ok: familyResults.filter((r) => ["DRY_RUN_OK", "APPLIED"].includes(r.status)).length,
        review: familyResults.filter((r) => r.status === "REVIEW").length,
        errors: familyResults.filter((r) => r.status === "ERROR").length,
      };
    }

    const summary = {
      generated_at: new Date().toISOString(),
      version: "LABGRADE_V1",
      source_version: SOURCE_VERSION,
      mode: APPLY ? "APPLY" : "DRY_RUN",
      base_url: BASE_URL,
      catalog_totals_db: catalogAudit.totals,
      catalog_missing_expected: catalogAudit.missing,
      active_thicknesses_mm: thicknessesByFamily,
      master_finishes: Object.fromEntries(
        FAMILY_CODES.map((code) => [code, (masterFinishesByFamily[code] || []).map((f) => f.name)])
      ),
      family_summary: familySummary,
      total: results.length,
      ok: results.filter((r) => ["DRY_RUN_OK", "APPLIED"].includes(r.status)).length,
      review: results.filter((r) => r.status === "REVIEW").length,
      review_by_reason: reviewByReason,
      errors: results.filter((r) => r.status === "ERROR").length,
      error_by_reason: errorByReason,
      results,
    };

    const reportDir = path.resolve(__dirname, "../tmp");
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportDir, `labgrade_abet_sync_v1_${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");

    console.log("");
    console.log("=== RESUMEN ===");
    for (const familyCode of FAMILY_CODES) {
      const s = familySummary[familyCode];
      console.log(`${familyCode}: OK=${s.ok} REVIEW=${s.review} ERROR=${s.errors} TOTAL=${s.total}`);
    }
    console.log(`OK: ${summary.ok}`);
    console.log(`REVIEW: ${summary.review}`);
    for (const [reason, count] of Object.entries(summary.review_by_reason)) console.log(`  - ${reason}: ${count}`);
    console.log(`ERROR: ${summary.errors}`);
    for (const [reason, count] of Object.entries(summary.error_by_reason)) console.log(`  - ${reason}: ${count}`);
    console.log(`Faltantes de catálogo esperados: ${catalogAudit.missing.length}`);
    for (const item of catalogAudit.missing) console.log(`  - ${item.sku} ${item.name}`);
    console.log(`Reporte: ${reportPath}`);
    console.log("");
    if (!APPLY) {
      console.log("DRY-RUN: no se modificó PostgreSQL.");
      console.log("No uses --apply hasta validar el reporte completo.");
    } else {
      console.log("APPLY ejecutado. Verifica product_project_finishes antes de continuar.");
    }
  } finally {
    await browser.close();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error("ERROR FATAL:", error);
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
