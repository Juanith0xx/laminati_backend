import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { chromium } from "playwright";

import pool from "../../src/config/database.js";
import {
  uploadProductImage,
  deleteProductImageVariants,
} from "../../src/services/productImageStorage.service.js";

const COLLECTION_SLUG = "venezia";

const VENEZIA = [
  { code: "6501", sku: "STRAT-6501", name: "Grande Venezia" },
  { code: "6502", sku: "STRAT-6502", name: "Venezia" },
  { code: "6503", sku: "STRAT-6503", name: "Piccola Venezia" },
  { code: "6504", sku: "STRAT-6504", name: "Grande Venezia" },
  { code: "6505", sku: "STRAT-6505", name: "Venezia" },
  { code: "6506", sku: "STRAT-6506", name: "Piccola Venezia" },
  { code: "6507", sku: "STRAT-6507", name: "Grande Venezia" },
  { code: "6508", sku: "STRAT-6508", name: "Venezia" },
  { code: "6509", sku: "STRAT-6509", name: "Piccola Venezia" },
  { code: "6510", sku: "STRAT-6510", name: "Grande Venezia" },
  { code: "6511", sku: "STRAT-6511", name: "Venezia" },
  { code: "6512", sku: "STRAT-6512", name: "Piccola Venezia" },
  { code: "6513", sku: "STRAT-6513", name: "Grande Venezia" },
  { code: "6514", sku: "STRAT-6514", name: "Venezia" },
  { code: "6515", sku: "STRAT-6515", name: "Piccola Venezia" },
  { code: "6516", sku: "STRAT-6516", name: "Grande Venezia" },
  { code: "6517", sku: "STRAT-6517", name: "Venezia" },
  { code: "6518", sku: "STRAT-6518", name: "Piccola Venezia" },
  { code: "6519", sku: "STRAT-6519", name: "Grande Venezia" },
  { code: "6520", sku: "STRAT-6520", name: "Venezia" },
  { code: "6521", sku: "STRAT-6521", name: "Piccola Venezia" },
  { code: "6522", sku: "STRAT-6522", name: "Grande Venezia" },
  { code: "6523", sku: "STRAT-6523", name: "Venezia" },
  { code: "6524", sku: "STRAT-6524", name: "Piccola Venezia" },
  { code: "6525", sku: "STRAT-6525", name: "Grande Venezia" },
  { code: "6526", sku: "STRAT-6526", name: "Venezia" },
  { code: "6527", sku: "STRAT-6527", name: "Piccola Venezia" },
];

const ALLOWED_SKUS = new Set(VENEZIA.map((item) => item.sku));
const META_BY_SKU = new Map(VENEZIA.map((item) => [item.sku, item]));

const ABET_HOSTS = [
  "https://na.abetlaminati.com",
  "https://abetlaminati.com",
  "https://es.abetlaminati.com",
];

function normalizeSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    onlySku: null,
    onlyCollection: null,
    concurrency: 1,
    confirm: null,
    confirmDb: null,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }

    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");

    if (key === "--only-sku") {
      options.onlySku = String(value || "").trim().toUpperCase();
    } else if (key === "--only-collection") {
      options.onlyCollection = normalizeSlug(value);
    } else if (key === "--concurrency") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 8) {
        options.concurrency = parsed;
      }
    } else if (key === "--confirm") {
      options.confirm = String(value || "").trim();
    } else if (key === "--confirm-db") {
      options.confirmDb = String(value || "").trim().toLowerCase();
    }
  }

  return options;
}

function assertOptions(options, config) {
  if (
    options.onlyCollection &&
    options.onlyCollection !== COLLECTION_SLUG
  ) {
    throw new Error(
      `Colección inválida: ${options.onlyCollection}. Este script sólo permite ${COLLECTION_SLUG}.`
    );
  }

  if (options.onlySku && !ALLOWED_SKUS.has(options.onlySku)) {
    throw new Error(
      `${options.onlySku} no pertenece a la allowlist oficial Venezia 6501–6527.`
    );
  }

  if (options.apply) {
    if (options.confirm !== config.confirmToken) {
      throw new Error(
        `Para aplicar cambios debes usar --confirm=${config.confirmToken}`
      );
    }

    if (options.confirmDb !== "railway") {
      throw new Error(
        "Para aplicar cambios en producción debes usar --confirm-db=railway"
      );
    }
  }
}

async function getDbIdentity() {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port
  `);

  return result.rows[0];
}

async function loadProducts(options) {
  const params = [COLLECTION_SLUG, [...ALLOWED_SKUS]];
  let skuCondition = "";

  if (options.onlySku) {
    params.push(options.onlySku);
    skuCondition = `AND UPPER(p.sku) = $3`;
  }

  const result = await pool.query(
    `
      SELECT DISTINCT
        p.id,
        UPPER(p.sku) AS sku,
        p.name,
        p.slug,
        p.internal_code
      FROM products p
      INNER JOIN product_abet_collections pac
        ON pac.product_id = p.id
      INNER JOIN abet_collections ac
        ON ac.id = pac.abet_collection_id
      WHERE ac.slug = $1
        AND UPPER(p.sku) = ANY($2::text[])
        ${skuCondition}
      ORDER BY UPPER(p.sku)
    `,
    params
  );

  return result.rows.map((row) => ({
    ...row,
    meta: META_BY_SKU.get(row.sku),
  }));
}

async function getImageState(productId) {
  const result = await pool.query(
    `
      SELECT
        id,
        image_type,
        is_primary,
        sort_order,
        storage_provider,
        thumbnail_key,
        card_key,
        detail_key,
        original_filename
      FROM product_images
      WHERE product_id = $1
      ORDER BY sort_order ASC, created_at ASC
    `,
    [productId]
  );

  return result.rows;
}

function hasHealthyImage(rows, imageType) {
  return rows.some(
    (row) =>
      String(row.image_type || "").toLowerCase() === imageType &&
      row.storage_provider === "RAILWAY" &&
      row.thumbnail_key &&
      row.card_key &&
      row.detail_key
  );
}

function makeDetailCandidates(meta) {
  const nameSlug = normalizeSlug(meta.name);
  const code = meta.code;
  const suffixes = [
    `${nameSlug}-${code}`,
    `venezia-${nameSlug}-${code}`,
    `${code}-${nameSlug}`,
  ];

  const urls = [];

  for (const host of ABET_HOSTS) {
    for (const suffix of suffixes) {
      urls.push(`${host}/decori/${suffix}/`);
      urls.push(`${host}/es/decori/${suffix}/`);
    }
  }

  return [...new Set(urls)];
}

async function discoverDetailUrl(page, meta) {
  const candidates = makeDetailCandidates(meta);

  // 1) URLs predecibles del sitio Abet.
  for (const url of candidates) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      if (!response || response.status() >= 400) {
        continue;
      }

      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (bodyText.includes(meta.code)) {
        return page.url();
      }
    } catch {
      // probamos el siguiente candidato
    }
  }

  // 2) Fallback: buscar el decor dentro de la colección oficial.
  for (const host of ABET_HOSTS) {
    const collectionUrls = [
      `${host}/collections/venezia/`,
      `${host}/collections/venezia-giulio-cappellini/`,
      `${host}/es/collections/venezia/`,
      `${host}/es/collections/venezia-giulio-cappellini/`,
    ];

    for (const collectionUrl of collectionUrls) {
      try {
        const response = await page.goto(collectionUrl, {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        });

        if (!response || response.status() >= 400) {
          continue;
        }

        await page.waitForTimeout(800);

        const href = await page.evaluate((code) => {
          const anchors = [...document.querySelectorAll("a[href]")];
          const direct = anchors.find((anchor) => {
            const text = String(anchor.textContent || "").replace(/\s+/g, " ").trim();
            const hrefValue = String(anchor.getAttribute("href") || "");
            return text.includes(code) || hrefValue.includes(code);
          });
          return direct?.href || null;
        }, meta.code);

        if (href) {
          return href;
        }
      } catch {
        // siguiente host
      }
    }
  }

  throw new Error(`No se encontró ficha Abet para ${meta.code} ${meta.name}`);
}

function downloadLabel(imageType) {
  return imageType === "sample"
    ? ["download card format", "card format", "formato card", "formato scheda"]
    : ["download panel format", "panel format", "formato panel", "formato pannello"];
}

async function getDirectDownloadUrl(page, imageType) {
  const labels = downloadLabel(imageType);

  return page.evaluate((wantedLabels) => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const elements = [
      ...document.querySelectorAll("a[href], button, [role='button']"),
    ];

    for (const element of elements) {
      const text = normalize(element.textContent);
      if (!wantedLabels.some((label) => text.includes(label))) {
        continue;
      }

      const candidates = [
        element.getAttribute?.("href"),
        element.getAttribute?.("data-href"),
        element.getAttribute?.("data-url"),
        element.getAttribute?.("data-download"),
      ].filter(Boolean);

      if (candidates.length > 0) {
        try {
          return new URL(candidates[0], window.location.href).href;
        } catch {
          // seguir
        }
      }
    }

    // Fallback por atributos/hrefs que nombren card o panel.
    const keyword = wantedLabels[0].includes("card") ? "card" : "panel";
    const anchors = [...document.querySelectorAll("a[href]")];
    const anchor = anchors.find((item) => {
      const href = normalize(item.getAttribute("href"));
      const text = normalize(item.textContent);
      return href.includes(keyword) || text.includes(`${keyword} format`);
    });

    return anchor?.href || null;
  }, labels);
}

async function fetchBuffer(url, referer) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} descargando ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";

  return {
    buffer,
    contentType,
    finalUrl: response.url || url,
  };
}

async function clickAndDownload(page, imageType) {
  const labels = downloadLabel(imageType);
  const locator = page
    .locator("a, button, [role='button']")
    .filter({
      hasText: imageType === "sample" ? /card format/i : /panel format/i,
    })
    .first();

  if ((await locator.count()) === 0) {
    throw new Error(`No aparece el botón ${labels[0]} en ${page.url()}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "laminati-abet-"));

  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
    await locator.click({ timeout: 15000 });
    const download = await downloadPromise;
    const suggestedFilename = download.suggestedFilename();
    const target = path.join(tempDir, suggestedFilename || `${imageType}.img`);
    await download.saveAs(target);
    const buffer = await fs.readFile(target);

    return {
      buffer,
      contentType: "",
      finalUrl: page.url(),
      filename: suggestedFilename || `${imageType}.img`,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function inferFilename(url, imageType, code, contentType = "") {
  try {
    const parsed = new URL(url);
    const basename = decodeURIComponent(path.basename(parsed.pathname));
    if (basename && basename.includes(".")) {
      return basename;
    }
  } catch {
    // fallback abajo
  }

  let extension = ".jpg";
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes("png")) extension = ".png";
  if (normalized.includes("webp")) extension = ".webp";
  if (normalized.includes("avif")) extension = ".avif";

  return `${code}-${imageType}${extension}`;
}

async function validateImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 256) {
    throw new Error("La descarga no contiene una imagen válida (buffer vacío o demasiado pequeño)");
  }

  const signature = buffer.subarray(0, 20).toString("hex");

  try {
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Sharp no pudo determinar dimensiones");
    }

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      signature,
    };
  } catch (error) {
    const preview = buffer.subarray(0, 60).toString("utf8").replace(/\s+/g, " ");
    throw new Error(
      `Imagen no compatible. signature=${signature}. preview=${preview}. sharp=${error.message}`
    );
  }
}

async function downloadOfficialImage(page, detailUrl, imageType, meta) {
  await page.goto(detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(800);

  const directUrl = await getDirectDownloadUrl(page, imageType);

  if (directUrl) {
    const downloaded = await fetchBuffer(directUrl, detailUrl);
    const filename = inferFilename(
      downloaded.finalUrl,
      imageType,
      meta.code,
      downloaded.contentType
    );

    await validateImageBuffer(downloaded.buffer);

    return {
      ...downloaded,
      filename,
    };
  }

  const clicked = await clickAndDownload(page, imageType);
  await validateImageBuffer(clicked.buffer);
  return clicked;
}

async function uploadAndPersist({ product, imageType, downloaded }) {
  const imageId = randomUUID();
  const sortOrder = imageType === "sample" ? 0 : 1;
  const isPrimary = imageType === "sample";
  const altText = `Stratificato ${product.name} ${product.sku} - Abet Laminati`;

  const storageResult = await uploadProductImage({
    buffer: downloaded.buffer,
    sku: product.sku,
    imageType,
    imageId,
  });

  const uploadedKeys = [
    storageResult?.variants?.thumbnail?.key,
    storageResult?.variants?.card?.key,
    storageResult?.variants?.detail?.key,
  ].filter(Boolean);

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id FROM products WHERE id = $1 FOR UPDATE`,
      [product.id]
    );

    if (locked.rowCount === 0) {
      throw new Error(`Producto desapareció durante importación: ${product.sku}`);
    }

    const existing = await client.query(
      `
        SELECT id
        FROM product_images
        WHERE product_id = $1
          AND LOWER(COALESCE(image_type, '')) = $2
        LIMIT 1
      `,
      [product.id, imageType]
    );

    if (existing.rowCount > 0) {
      throw Object.assign(new Error(`${imageType} ya existe para ${product.sku}`), {
        code: "IMAGE_ALREADY_EXISTS",
      });
    }

    if (isPrimary) {
      await client.query(
        `UPDATE product_images SET is_primary = FALSE WHERE product_id = $1 AND is_primary = TRUE`,
        [product.id]
      );
    }

    await client.query(
      `
        INSERT INTO product_images (
          id,
          product_id,
          image_url,
          alt_text,
          is_primary,
          sort_order,
          storage_provider,
          image_type,
          thumbnail_key,
          card_key,
          detail_key,
          original_filename,
          source_width,
          source_height,
          source_bytes
        )
        VALUES (
          $1, $2, NULL, $3, $4, $5, 'RAILWAY', $6,
          $7, $8, $9, $10, $11, $12, $13
        )
      `,
      [
        imageId,
        product.id,
        altText,
        isPrimary,
        sortOrder,
        imageType,
        storageResult.variants.thumbnail.key,
        storageResult.variants.card.key,
        storageResult.variants.detail.key,
        downloaded.filename,
        storageResult.source.width,
        storageResult.source.height,
        storageResult.source.bytes,
      ]
    );

    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (!committed && uploadedKeys.length > 0) {
      await deleteProductImageVariants(uploadedKeys).catch(() => {});
    }

    throw error;
  } finally {
    client.release();
  }
}

async function cleanupGalleryIfOfficialPairExists(product) {
  const client = await pool.connect();
  let galleryRows = [];

  try {
    await client.query("BEGIN");

    const state = await client.query(
      `
        SELECT
          id,
          image_type,
          storage_provider,
          thumbnail_key,
          card_key,
          detail_key
        FROM product_images
        WHERE product_id = $1
        FOR UPDATE
      `,
      [product.id]
    );

    const sampleExists = hasHealthyImage(state.rows, "sample");
    const panelExists = hasHealthyImage(state.rows, "panel");

    if (!sampleExists || !panelExists) {
      await client.query("ROLLBACK");
      return { deleted: 0, reason: "official-pair-incomplete" };
    }

    galleryRows = state.rows.filter(
      (row) => String(row.image_type || "").toLowerCase() === "gallery"
    );

    if (galleryRows.length === 0) {
      await client.query("COMMIT");
      return { deleted: 0, reason: "no-gallery" };
    }

    await client.query(
      `DELETE FROM product_images WHERE product_id = $1 AND LOWER(COALESCE(image_type, '')) = 'gallery'`,
      [product.id]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const keys = galleryRows
    .filter((row) => row.storage_provider === "RAILWAY")
    .flatMap((row) => [row.thumbnail_key, row.card_key, row.detail_key])
    .filter(Boolean);

  if (keys.length > 0) {
    await deleteProductImageVariants(keys).catch((error) => {
      console.warn(
        `${product.sku} -> gallery eliminado de DB; limpieza Storage pendiente: ${error.message}`
      );
    });
  }

  return { deleted: galleryRows.length, reason: "deleted" };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }
  );

  await Promise.all(workers);
}

export async function runVeneziaImport(config) {
  const options = parseArgs(process.argv.slice(2));
  assertOptions(options, config);

  const dbIdentity = await getDbIdentity();
  const products = await loadProducts(options);

  console.log("============================================================");
  console.log(`Stratificato · Venezia · ${config.imageType.toUpperCase()}`);
  console.log("============================================================");
  console.log(`Modo:        ${options.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Colección:   ${COLLECTION_SLUG}`);
  console.log(`SKU:         ${options.onlySku || "todos"}`);
  console.log(`Concurrencia:${options.concurrency}`);
  console.log(`DB:          ${dbIdentity.database_name}`);
  console.log(`DB user:     ${dbIdentity.database_user}`);
  console.log(`DB server:   ${dbIdentity.server_address || process.env.DB_HOST || "n/a"}:${dbIdentity.server_port || process.env.DB_PORT || "n/a"}`);
  console.log(`Encontrados: ${products.length}/27`);
  console.log("============================================================");

  if (products.length === 0) {
    throw new Error(
      "No se encontraron productos Venezia asociados en la base de datos."
    );
  }

  if (!options.onlySku && products.length !== 27) {
    console.warn(
      `ADVERTENCIA: se esperaban 27 productos Venezia y se encontraron ${products.length}.`
    );
  }

  if (!options.apply) {
    products.forEach((product, index) => {
      console.log(`[${index + 1}/${products.length}] ${product.sku} · ${product.name}`);
    });
    console.log("\nDry-run finalizado. No se modificó Storage ni PostgreSQL.");
    await pool.end();
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const summary = {
    imported: 0,
    skipped: 0,
    errors: 0,
    galleryDeleted: 0,
  };

  try {
    await runPool(products, options.concurrency, async (product, index) => {
      const prefix = `[${index + 1}/${products.length}] ${product.sku}`;
      const page = await browser.newPage({
        acceptDownloads: true,
        viewport: { width: 1440, height: 1100 },
      });

      try {
        const before = await getImageState(product.id);
        if (hasHealthyImage(before, config.imageType)) {
          console.log(`${prefix} -> SKIP: ${config.imageType} ya existe`);
          summary.skipped += 1;

          if (config.cleanupGallery) {
            const cleanup = await cleanupGalleryIfOfficialPairExists(product);
            summary.galleryDeleted += cleanup.deleted;
          }
          return;
        }

        console.log(`${prefix} -> buscando ficha Abet`);
        const detailUrl = await discoverDetailUrl(page, product.meta);
        console.log(`${prefix} -> ${detailUrl}`);

        const downloaded = await downloadOfficialImage(
          page,
          detailUrl,
          config.imageType,
          product.meta
        );

        const metadata = await validateImageBuffer(downloaded.buffer);
        console.log(
          `${prefix} -> descarga OK ${metadata.width}x${metadata.height} ${metadata.format || "image"} (${downloaded.buffer.length} bytes)`
        );

        await uploadAndPersist({
          product,
          imageType: config.imageType,
          downloaded,
        });

        summary.imported += 1;
        console.log(`${prefix} -> OK ${config.imageType} guardado en Railway Storage + PostgreSQL`);

        if (config.cleanupGallery) {
          const cleanup = await cleanupGalleryIfOfficialPairExists(product);
          summary.galleryDeleted += cleanup.deleted;
          if (cleanup.deleted > 0) {
            console.log(`${prefix} -> gallery eliminado: ${cleanup.deleted}`);
          }
        }
      } catch (error) {
        summary.errors += 1;
        console.error(`${prefix} -> ERROR: ${error.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    });
  } finally {
    await browser.close().catch(() => {});
    await pool.end();
  }

  console.log("\n============================================================");
  console.log("RESUMEN VENEZIA");
  console.log("============================================================");
  console.log(`Productos:        ${products.length}`);
  console.log(`Importados:       ${summary.imported}`);
  console.log(`Omitidos:         ${summary.skipped}`);
  console.log(`Errores:          ${summary.errors}`);
  console.log(`Gallery eliminados:${summary.galleryDeleted}`);
  console.log("============================================================");

  if (summary.errors > 0) {
    process.exitCode = 1;
  }
}
