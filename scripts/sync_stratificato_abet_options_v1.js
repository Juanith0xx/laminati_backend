import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import pool from "../src/config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPLY = process.argv.includes("--apply");
const REPLACE = process.argv.includes("--replace");
const HEADLESS = !process.argv.includes("--headed");

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const ONLY_SKU = String(argValue("--sku") || "").trim().toUpperCase();
const LIMIT = Number(argValue("--limit") || 0) || 0;
const CONCURRENCY = Math.max(1, Math.min(6, Number(argValue("--concurrency") || 3) || 3));
const TIMEOUT_MS = Math.max(10000, Number(process.env.ABET_SYNC_TIMEOUT_MS || 35000));
const BASE_URL = String(process.env.ABET_BASE_URL || "https://es.abetlaminati.com").replace(/\/$/, "");

const DECORATIVE_TYPES = new Set(["COLOR_EFFECT", "DESIGN_EDITION"]);

const SITE_MARKERS = [
  "productos y colecciones",
  "products and collections",
  "prodotti e collezioni",
];

const FINISH_HEADING_MARKERS = [
  "finish",
  "finitura",
  "finiture",
  "acabado",
  "acabados",
];

const FINISH_ALIASES = new Map([
  ["sei 2", ["sei 2", "sei due"]],
  ["polaris co", ["polaris co", "polaris contemporary"]],
  ["papier", ["papier", "paper"]],
  ["66", ["66", "\"66\"", "“66”"]],
  ["lucida", ["lucida"]],
  ["millerighe", ["millerighe"]],
  ["sei", ["sei"]],
  ["morbida", ["morbida"]],
  ["grana 2", ["grana 2"]],
  ["grainwood", ["grainwood"]],
  ["climb", ["climb"]],
  ["zodia 3", ["zodia 3"]],
  ["root", ["root"]],
  ["polaris", ["polaris"]],
  ["dharma", ["dharma"]],
  ["aquarama", ["aquarama"]],
  ["ostuni", ["ostuni"]],
  ["geo", ["geo"]],
  ["bark", ["bark"]],
  ["nutshell", ["nutshell"]],
  ["mandarin", ["mandarin"]],
  ["millerighe 2", ["millerighe 2"]],
  ["zodia", ["zodia"]],
  ["cross", ["cross"]],
  ["velwood", ["velwood"]],
  ["microline", ["microline"]],
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[×]/g, "x")
    .replace(/[“”‘’]/g, '"')
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
  const escaped = normalizeText(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return regex.test(text);
}

function phraseIndex(text, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return -1;
  return text.indexOf(normalizedPhrase);
}

function extractProductsSection(bodyText) {
  const normalized = normalizeText(bodyText);
  const indexes = SITE_MARKERS
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0);

  if (!indexes.length) {
    return null;
  }

  const start = Math.min(...indexes);
  return normalized.slice(start);
}

function getAliasesForFinish(finishName) {
  const normalizedName = normalizeText(finishName).trim();
  return FINISH_ALIASES.get(normalizedName) || [finishName];
}

function findFinishOccurrences(segment, masterFinishes) {
  const found = [];

  for (const finish of masterFinishes) {
    const aliases = getAliasesForFinish(finish.name);
    let bestIndex = Number.POSITIVE_INFINITY;

    for (const alias of aliases) {
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

function detectDefaultFinish(segment, matchedFinishes) {
  if (!matchedFinishes.length) return null;

  let headingIndex = -1;
  for (const marker of FINISH_HEADING_MARKERS) {
    const idx = segment.indexOf(marker);
    if (idx >= 0 && (headingIndex < 0 || idx < headingIndex)) {
      headingIndex = idx;
    }
  }

  const area = headingIndex >= 0
    ? segment.slice(headingIndex, headingIndex + 450)
    : segment.slice(0, 650);

  const occurrences = [];
  for (const finish of matchedFinishes) {
    for (const alias of getAliasesForFinish(finish.name)) {
      const idx = phraseIndex(area, alias);
      if (idx >= 0 && hasPhrase(area, alias)) {
        occurrences.push({ finish, idx });
      }
    }
  }

  occurrences.sort((a, b) => a.idx - b.idx || a.finish.sort_order - b.finish.sort_order);
  return occurrences[0]?.finish || matchedFinishes[0] || null;
}

function parseProductPage({ bodyText, associations, masterFinishes }) {
  const section = extractProductsSection(bodyText);
  if (!section) {
    return {
      ok: false,
      reason: "PRODUCTS_SECTION_NOT_FOUND",
      finishes: [],
      defaultFinish: null,
      collectionAudit: [],
    };
  }

  const occurrences = associations
    .map((association) => ({
      ...association,
      position: phraseIndex(section, association.name),
    }))
    .filter((item) => item.position >= 0)
    .sort((a, b) => a.position - b.position);

  const collectionAudit = [];
  const finishMap = new Map();
  const defaultCandidates = [];

  for (let index = 0; index < occurrences.length; index += 1) {
    const association = occurrences[index];
    const next = occurrences[index + 1];
    const end = next ? next.position : Math.min(section.length, association.position + 2400);
    const segment = section.slice(association.position, end);

    const decorative = DECORATIVE_TYPES.has(association.collection_type);
    const matched = decorative
      ? findFinishOccurrences(segment, masterFinishes)
      : [];

    const defaultFinish = decorative
      ? detectDefaultFinish(segment, matched)
      : null;

    collectionAudit.push({
      name: association.name,
      slug: association.slug,
      type: association.collection_type,
      found_on_page: true,
      decorative,
      finishes: matched.map((item) => item.name),
      default_finish: defaultFinish?.name || null,
    });

    if (!decorative) continue;

    for (const finish of matched) {
      finishMap.set(finish.id, finish);
    }

    if (defaultFinish) {
      defaultCandidates.push({
        finish: defaultFinish,
        association,
      });
    }
  }

  for (const association of associations) {
    if (!occurrences.some((item) => item.id === association.id)) {
      collectionAudit.push({
        name: association.name,
        slug: association.slug,
        type: association.collection_type,
        found_on_page: false,
        decorative: DECORATIVE_TYPES.has(association.collection_type),
        finishes: [],
        default_finish: null,
      });
    }
  }

  const finishes = [...finishMap.values()]
    .filter((finish) => finish.has_formats)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const finishIds = new Set(finishes.map((finish) => finish.id));
  const defaultFinish = defaultCandidates
    .map((candidate) => candidate.finish)
    .find((finish) => finishIds.has(finish.id)) || null;

  return {
    ok: finishes.length > 0,
    reason: finishes.length ? null : "NO_VALID_STRATIFICATO_FINISHES",
    finishes,
    defaultFinish,
    collectionAudit,
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
    WHERE fam.code = 'STRATIFICATO'
      AND f.is_active = TRUE
    ORDER BY f.sort_order, f.name
  `);

  return rows;
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
      COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'id', ac.id,
            'name', ac.name,
            'slug', ac.slug,
            'collection_type', ac.collection_type
          )
        ) FILTER (WHERE ac.id IS NOT NULL),
        '[]'::jsonb
      ) AS associations
    FROM products p
    JOIN project_product_families fam
      ON fam.id = p.project_family_id
    LEFT JOIN product_abet_collections pac
      ON pac.product_id = p.id
    LEFT JOIN abet_collections ac
      ON ac.id = pac.abet_collection_id
    WHERE fam.code = 'STRATIFICATO'
      ${skuFilter}
    GROUP BY p.id, p.sku, p.internal_code, p.name
    ORDER BY p.sku
    ${limitSql}
  `, params);

  return rows;
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

async function applyProductFinishes({ product, parsed, sourceUrl }) {
  if (!parsed.finishes.length) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (REPLACE) {
      await client.query(`
        UPDATE product_project_finishes
        SET
          is_active = FALSE,
          is_default = FALSE,
          updated_at = NOW()
        WHERE product_id = $1
          AND source_name = 'Abet Laminati'
      `, [product.id]);
    } else if (parsed.defaultFinish) {
      await client.query(`
        UPDATE product_project_finishes
        SET
          is_default = FALSE,
          updated_at = NOW()
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
        VALUES ($1, $2, $3, TRUE, 'Abet Laminati', $4, 'WEB-2026')
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

async function inspectProduct({ browser, product, masterFinishes }) {
  const code = String(product.internal_code || product.sku?.replace(/^STRAT-/i, "") || "").trim();
  const slug = slugify(product.name);
  const sourceUrl = `${BASE_URL}/decori/${slug}-${encodeURIComponent(code)}/`;

  const page = await browser.newPage({
    locale: "es-ES",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  });

  try {
    const response = await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });

    if (!response || response.status() >= 400) {
      return {
        sku: product.sku,
        code,
        name: product.name,
        url: sourceUrl,
        status: "ERROR",
        reason: `HTTP_${response?.status() || "NO_RESPONSE"}`,
        finishes: [],
        formats: {},
        collections: product.associations,
      };
    }

    await page.waitForTimeout(900);
    const bodyText = await page.locator("body").innerText({ timeout: 10000 });

    const parsed = parseProductPage({
      bodyText,
      associations: product.associations,
      masterFinishes,
    });

    const formats = await loadFinishFormats(parsed.finishes.map((finish) => finish.id));

    if (APPLY && parsed.ok) {
      await applyProductFinishes({ product, parsed, sourceUrl });
    }

    return {
      sku: product.sku,
      code,
      name: product.name,
      url: sourceUrl,
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
      collection_audit: parsed.collectionAudit,
    };
  } catch (error) {
    return {
      sku: product.sku,
      code,
      name: product.name,
      url: sourceUrl,
      status: "ERROR",
      reason: error?.message || String(error),
      finishes: [],
      formats: {},
      collections: product.associations,
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
  const prefix = `[${index + 1}/${total}] ${result.sku}`;
  const finishes = result.finishes?.length ? result.finishes.join(", ") : "—";
  console.log(`${prefix} -> ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  console.log(`    ${result.url}`);
  console.log(`    default=${result.default_finish || "—"}`);
  console.log(`    acabados=${finishes}`);

  for (const [finish, formats] of Object.entries(result.formats || {})) {
    console.log(`      ${finish}: ${formats.join(" | ") || "sin formato activo"}`);
  }
}

async function main() {
  console.log("=== Sync Stratificato / Abet options V1 ===");
  console.log(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"}${REPLACE ? " + REPLACE" : ""}`);
  console.log(`Abet: ${BASE_URL}`);
  console.log(`SKU: ${ONLY_SKU || "todos"}`);
  console.log(`Limit: ${LIMIT || "sin límite"}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  const [masterFinishes, products] = await Promise.all([
    loadMasterFinishes(),
    loadProducts(),
  ]);

  console.log(`Acabados maestros Stratificato: ${masterFinishes.length}`);
  console.log(`Productos a revisar: ${products.length}`);
  console.log("");

  if (!products.length) {
    console.log("No hay productos para procesar.");
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    let completed = 0;
    const results = await mapConcurrent(products, CONCURRENCY, async (product) => {
      const result = await inspectProduct({ browser, product, masterFinishes });
      printProductResult(result, completed, products.length);
      completed += 1;
      return result;
    });

    const summary = {
      generated_at: new Date().toISOString(),
      mode: APPLY ? "APPLY" : "DRY_RUN",
      replace: REPLACE,
      total: results.length,
      ok: results.filter((item) => ["DRY_RUN_OK", "APPLIED"].includes(item.status)).length,
      review: results.filter((item) => item.status === "REVIEW").length,
      errors: results.filter((item) => item.status === "ERROR").length,
      results,
    };

    const reportDir = path.resolve(__dirname, "../tmp");
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportDir, `stratificato_abet_sync_${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");

    console.log("");
    console.log("=== RESUMEN ===");
    console.log(`OK: ${summary.ok}`);
    console.log(`REVIEW: ${summary.review}`);
    console.log(`ERROR: ${summary.errors}`);
    console.log(`Reporte: ${reportPath}`);

    if (!APPLY) {
      console.log("");
      console.log("DRY-RUN: no se modificó PostgreSQL.");
      console.log("Cuando el resultado sea correcto, vuelve a ejecutar con --apply.");
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
