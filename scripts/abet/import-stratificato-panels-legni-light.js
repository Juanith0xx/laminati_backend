import "dotenv/config";

import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

import pool from "../../src/config/database.js";

import {
  uploadProductImage,
  deleteProductImageVariants,
} from "../../src/services/productImageStorage.service.js";

const ABET_COLLECTION_URL =
  "https://abetlaminati.com/en/abet-collection/";

const ABET_DECOR_BASES = [
  "https://na.abetlaminati.com/decori/",
  "https://abetlaminati.com/es/decori/",
  "https://abetlaminati.com/en/decori/",
];

const ABET_COLLECTION_BASES = [
  "https://na.abetlaminati.com/collections/",
  "https://abetlaminati.com/en/collections/",
  "https://abetlaminati.com/es/collections/",
  "https://es.abetlaminati.com/collections/",
];

const CONFIRM_TOKEN =
  "STRATIFICATO_PANELS";

const CONFIRM_DB =
  "railway";

/*
 * LEGNI LIGHT - colección controlada.
 *
 * Laminati trabaja 62 decorados activos de Legni Light.
 * STRAT-680 (Pino Susa) está marcado "discontinued soon"; se omite.
 */
const LEGNI_LIGHT_TARGET_SKUS = new Set([
  "STRAT-1385",
  "STRAT-1960",
  "STRAT-1957",
  "STRAT-1678",
  "STRAT-388",
  "STRAT-619",
  "STRAT-670",
  "STRAT-1958",
  "STRAT-659",
  "STRAT-1955",
  "STRAT-1969",
  "STRAT-1949",
  "STRAT-1394",
  "STRAT-672",
  "STRAT-1956",
  "STRAT-607",
  "STRAT-1381",
  "STRAT-1954",
  "STRAT-671",
  "STRAT-1383",
  "STRAT-1961",
  "STRAT-631",
  "STRAT-649",
  "STRAT-1386",
  "STRAT-1677",
  "STRAT-385",
  "STRAT-1619",
  "STRAT-650",
  "STRAT-620",
  "STRAT-639",
  "STRAT-381",
  "STRAT-1611",
  "STRAT-384",
  "STRAT-1384",
  "STRAT-660",
  "STRAT-1396",
  "STRAT-602",
  "STRAT-1952",
  "STRAT-1977",
  "STRAT-1968",
  "STRAT-661",
  "STRAT-1666",
  "STRAT-321",
  "STRAT-1367",
  "STRAT-1379",
  "STRAT-1661",
  "STRAT-1621",
  "STRAT-370",
  "STRAT-662",
  "STRAT-633",
  "STRAT-1972",
  "STRAT-1970",
  "STRAT-668",
  "STRAT-1971",
  "STRAT-673",
  "STRAT-386",
  "STRAT-1948",
  "STRAT-387",
  "STRAT-1324",
  "STRAT-1978",
  "STRAT-9796",
  "STRAT-1679",
]);

const LEGNI_LIGHT_COLLECTION_SLUG =
  "legni-light";


/*
 * LEGNI LIGHT V1
 *
 * MODO SAFE MASS:
 * 1) Solo entran automáticamente productos que pertenezcan a una
 *    colección visual/decorativa conocida y ya validada en producción.
 * 2) Las colecciones de aplicación (MEG, MEG-H, Labgrade, Foldline,
 *    Walkprint, Magnetico, etc.) NO convierten por sí mismas a un
 *    producto en decorativo.
 * 3) Todo lo ambiguo queda REVIEW y NO entra al masivo.
 *
 * Objetivo: importar primero el subconjunto seguro. Ante duda, no
 * subimos un panel. Los REVIEW se resolverán en una segunda fase.
 */
const DECORATIVE_COLLECTION_SLUGS = new Set([
  "decori-minimi",
  "fabriek",
  "legni-light",
  "legni-light",
  "metal-effect",
  "metalli",
  "rocks",
  "velwood",

  // Design editions / decorativos gráficos.
  "digital-circus",
  "digital-nature",
  "design-edition",
  "febo",
  "hachure",
  "mare-nostrum",
  "parade",
  "venezia",
  "whimsy",
  "work-in-progress",
]);

const PLAIN_ONLY_COLLECTION_SLUGS = new Set([
  "colours",
  "hr-laq",
  "interni",
  "fluo",
  "full-colour",
  "polaris",
]);

/*
 * V17 COLLECTION MODE
 *
 * Exclusiones conocidas por colección para el modo seguro.
 * Se pueden incluir manualmente con --include-discontinued.
 *
 * Decori Minimi:
 * - 563 Spot Grigio -> "discontinued soon" en Abet.
 */
const COLLECTION_SAFE_EXCLUSIONS = new Map([
  [
    "decori-minimi",
    new Set([
      "STRAT-563",
    ]),
  ],
]);

/*
 * URLs canónicas verificadas directamente en Abet.
 *
 * IMPORTANTE:
 * algunas URLs cortas (/es/decori/ghisa-567/) responden HTTP 200
 * pero no hidratan correctamente el decorado ni el botón de panel.
 * En COLLECTION MODE se priorizan estas URLs canónicas.
 */
const COLLECTION_CANONICAL_URL_OVERRIDES = new Map([
  [
    "decori-minimi",
    new Map([
      [
        "280",
        "https://na.abetlaminati.com/decori/decori-minimi-mandarin-decori-minimi-280-280/",
      ],
      [
        "567",
        "https://na.abetlaminati.com/decori/decori-minimi-mandarin-ghisa-567/",
      ],
      [
        "568",
        "https://na.abetlaminati.com/decori/decori-minimi-mandarin-fusione-568/",
      ],
    ]),
  ],
  [
    "fabriek",
    new Map([
      ["271", "https://na.abetlaminati.com/decori/na-271/"],
      ["560", "https://na.abetlaminati.com/decori/twist-light-560/"],
      ["571", "https://na.abetlaminati.com/decori/black-carbon-571/"],
      ["1901", "https://na.abetlaminati.com/decori/cerro-sal-1901/"],
      ["1902", "https://na.abetlaminati.com/decori/cerro-pimienta-1902/"],
      ["1903", "https://na.abetlaminati.com/decori/cerro-miel-1903/"],
      ["1904", "https://na.abetlaminati.com/decori/cerro-nuez-1904/"],
      ["1905", "https://na.abetlaminati.com/decori/cerro-cafe-1905/"],
      ["1906", "https://na.abetlaminati.com/decori/pike-sal-1906/"],
      ["1907", "https://na.abetlaminati.com/decori/pike-pimienta-1907/"],
      ["1908", "https://na.abetlaminati.com/decori/pike-miel-1908/"],
      ["1909", "https://na.abetlaminati.com/decori/pike-nuez-1909/"],
      ["1910", "https://na.abetlaminati.com/decori/pike-cafe-1910/"],
      ["1950", "https://na.abetlaminati.com/decori/boucle-prussia-1950/"],
      ["1966", "https://na.abetlaminati.com/decori/boucle-persia-1966/"],
      ["1967", "https://na.abetlaminati.com/decori/corallo-malindi-1967/"],
    ]),
  ],
]);

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

function parseArgs(argv) {
  const args = {
    apply: false,
    dbInfo: false,
    storageInfo: false,
    classificationReport: false,
    headful: false,
    limit: null,
    onlySku: null,
    onlyCollection: null,
    includeDiscontinued: false,
    confirm: "",
    confirmDb: "",
  };

  for (const raw of argv) {
    if (raw === "--apply") {
      args.apply = true;
      continue;
    }

    if (raw === "--db-info") {
      args.dbInfo = true;
      continue;
    }

    if (raw === "--storage-info") {
      args.storageInfo = true;
      continue;
    }

    if (raw === "--classification-report") {
      args.classificationReport = true;
      continue;
    }

    if (raw === "--headful") {
      args.headful = true;
      continue;
    }

    if (raw.startsWith("--limit=")) {
      const value =
        Number.parseInt(
          raw.slice("--limit=".length),
          10
        );

      if (
        Number.isFinite(value) &&
        value > 0
      ) {
        args.limit = value;
      }

      continue;
    }

    if (raw.startsWith("--only-sku=")) {
      args.onlySku =
        raw
          .slice("--only-sku=".length)
          .trim()
          .toUpperCase() || null;
      continue;
    }

    if (raw.startsWith("--only-collection=")) {
      args.onlyCollection =
        raw
          .slice("--only-collection=".length)
          .trim()
          .toLowerCase() || null;
      continue;
    }

    if (raw === "--include-discontinued") {
      args.includeDiscontinued = true;
      continue;
    }

    if (raw.startsWith("--confirm=")) {
      args.confirm =
        raw.slice("--confirm=".length);
      continue;
    }

    if (raw.startsWith("--confirm-db=")) {
      args.confirmDb =
        raw.slice("--confirm-db=".length);
    }
  }

  return args;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getCodeFromSku(sku) {
  return String(sku || "")
    .trim()
    .replace(/^STRAT-/i, "");
}

async function getDbInfo() {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port
  `);

  return result.rows[0] || {};
}

async function getAbetMappingInfo() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM abet_collections)::int AS collections,
      (SELECT COUNT(*) FROM abet_collection_decor_codes)::int AS decor_codes,
      (SELECT COUNT(*) FROM product_abet_collections)::int AS product_links
  `);

  return result.rows[0] || {
    collections: 0,
    decor_codes: 0,
    product_links: 0,
  };
}

async function printDbInfo() {
  const info = await getDbInfo();

  console.log("");
  console.log("DATABASE");
  console.log("--------");
  console.log(`database: ${info.database_name || "-"}`);
  console.log(`user:     ${info.database_user || "-"}`);
  console.log(`server:   ${info.server_address || "local/socket"}`);
  console.log(`port:     ${info.server_port || "-"}`);
  console.log("");
}

function printStorageInfo() {
  console.log("");
  console.log("RAILWAY STORAGE");
  console.log("---------------");
  console.log(
    `endpoint: ${
      process.env.RAILWAY_STORAGE_ENDPOINT
        ? "CONFIGURADO"
        : "FALTA"
    }`
  );
  console.log(
    `access:   ${
      process.env.RAILWAY_STORAGE_ACCESS_KEY_ID
        ? "CONFIGURADO"
        : "FALTA"
    }`
  );
  console.log(
    `secret:   ${
      process.env.RAILWAY_STORAGE_SECRET_ACCESS_KEY
        ? "CONFIGURADO"
        : "FALTA"
    }`
  );
  console.log(
    `bucket:   ${
      process.env.RAILWAY_STORAGE_BUCKET ||
      "FALTA"
    }`
  );
  console.log("");
}

async function loadTargets({
  onlySku = null,
  onlyCollection = null,
}) {
  const result = await pool.query(
    `
      SELECT
        p.id,
        p.sku,
        p.name,

        COALESCE(
          ARRAY(
            SELECT DISTINCT ac2.slug
            FROM product_abet_collections pac2
            JOIN abet_collections ac2
              ON ac2.id = pac2.abet_collection_id
            WHERE pac2.product_id = p.id
            ORDER BY ac2.slug
          ),
          ARRAY[]::text[]
        ) AS abet_collection_slugs,

        EXISTS (
          SELECT 1
          FROM product_images pi
          WHERE pi.product_id = p.id
            AND LOWER(COALESCE(pi.image_type, '')) = 'panel'
        ) AS has_panel

      FROM products p

      WHERE p.sku ILIKE 'STRAT-%'
        AND (
          $1::text IS NULL
          OR UPPER(p.sku) = UPPER($1)
        )
        AND (
          $2::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM product_abet_collections pac_filter
            JOIN abet_collections ac_filter
              ON ac_filter.id = pac_filter.abet_collection_id
            WHERE pac_filter.product_id = p.id
              AND LOWER(ac_filter.slug) = LOWER($2)
          )
        )

      ORDER BY
        CASE
          WHEN REPLACE(UPPER(p.sku), 'STRAT-', '') ~ '^[0-9]+$'
          THEN REPLACE(UPPER(p.sku), 'STRAT-', '')::integer
          ELSE 999999999
        END,
        p.sku
    `,
    [
      onlySku,
      onlyCollection,
    ]
  );

  return result.rows.map((row) => ({
    ...row,
    code: getCodeFromSku(row.sku),
  }));
}

function classifyProduct(product) {
  const slugs = [
    ...new Set(
      (product.abet_collection_slugs || [])
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    ),
  ];

  const decorativeMatches =
    slugs.filter((slug) =>
      DECORATIVE_COLLECTION_SLUGS.has(slug)
    );

  if (decorativeMatches.length > 0) {
    return {
      type: "DECORATIVE",
      reason:
        `colección decorativa: ${decorativeMatches.join(", ")}`,
    };
  }

  if (slugs.length === 0) {
    return {
      type: "REVIEW",
      reason:
        "sin colección Abet asociada",
    };
  }

  if (
    slugs.every((slug) =>
      PLAIN_ONLY_COLLECTION_SLUGS.has(slug)
    )
  ) {
    return {
      type: "PLAIN",
      reason:
        `solo colecciones lisas: ${slugs.join(", ")}`,
    };
  }

  return {
    type: "REVIEW",
    reason:
      `colecciones no clasificadas: ${slugs.join(", ")}`,
  };
}

function printClassificationReport(products) {
  const classified =
    products.map((product) => ({
      ...product,
      classification:
        classifyProduct(product),
    }));

  const decorative =
    classified.filter(
      (item) =>
        item.classification.type ===
        "DECORATIVE"
    );

  const plain =
    classified.filter(
      (item) =>
        item.classification.type ===
        "PLAIN"
    );

  const review =
    classified.filter(
      (item) =>
        item.classification.type ===
        "REVIEW"
    );

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " CLASIFICACIÓN STRATIFICATO LEGNI LIGHT V1 ACTIVE 62"
  );
  console.log(
    "========================================"
  );
  console.log(
    "Fuente clasificación:  colecciones visuales Abet validadas"
  );
  console.log(
    `Total STRAT:           ${classified.length}`
  );
  console.log(
    `Decorativos:           ${decorative.length}`
  );
  console.log(
    `Lisos:                 ${plain.length}`
  );
  console.log(
    `Revisión manual:       ${review.length}`
  );
  console.log("");

  if (review.length > 0) {
    console.log(
      "PRODUCTOS EN REVISIÓN (NO SE IMPORTAN EN MASIVO)"
    );
    console.log(
      "-----------------------------------------------"
    );

    for (const item of review) {
      console.log(
        `${item.sku} | ${item.name} | ${item.classification.reason}`
      );
    }

    console.log("");
  }

  const collectionCounts =
    new Map();

  for (const item of classified) {
    for (
      const slug
      of item.abet_collection_slugs || []
    ) {
      const key =
        String(slug || "")
          .trim()
          .toLowerCase();

      if (!key) {
        continue;
      }

      collectionCounts.set(
        key,
        (collectionCounts.get(key) || 0) + 1
      );
    }
  }

  console.log(
    "COLECCIONES PRESENTES"
  );
  console.log(
    "---------------------"
  );

  for (
    const [slug, count]
    of [...collectionCounts.entries()]
      .sort((a, b) =>
        a[0].localeCompare(b[0])
      )
  ) {
    let type = "REVIEW";

    if (
      DECORATIVE_COLLECTION_SLUGS.has(
        slug
      )
    ) {
      type = "DECORATIVE";
    } else if (
      PLAIN_ONLY_COLLECTION_SLUGS.has(
        slug
      )
    ) {
      type = "PLAIN";
    }

    console.log(
      `${type.padEnd(10)} | ${String(count).padStart(3)} | ${slug}`
    );
  }

  console.log("");

  return {
    classified,
    decorative,
    plain,
    review,
  };
}
async function dismissCookies(page) {
  const patterns = [
    /accept/i,
    /aceptar/i,
    /accetta/i,
    /consent/i,
  ];

  for (const pattern of patterns) {
    const candidates = [
      page.getByRole("button", { name: pattern }).first(),
      page.getByRole("link", { name: pattern }).first(),
    ];

    for (const candidate of candidates) {
      try {
        if (
          await candidate.isVisible({
            timeout: 400,
          })
        ) {
          await candidate.click();
          await sleep(250);
          return;
        }
      } catch {
        // Sin banner visible.
      }
    }
  }
}

async function dismissCountryLanguageModal(page) {
  /*
   * Abet puede mostrar un modal global de País / Idioma.
   * En modo headless también puede aparecer y bloquear el
   * click sobre "Descargar formato del panel".
   */
  const modalTitlePattern =
    /País\s*\/\s*Idioma|Country\s*\/\s*Language|Paese\s*\/\s*Lingua/i;

  let modalVisible = false;

  try {
    const title =
      page.getByText(
        modalTitlePattern,
        { exact: false }
      ).first();

    modalVisible =
      await title.isVisible({
        timeout: 1200,
      });
  } catch {
    modalVisible = false;
  }

  if (!modalVisible) {
    return false;
  }

  /*
   * Normalmente España / Español ya vienen seleccionados,
   * por lo que basta confirmar. Probamos varios idiomas.
   */
  const confirmPatterns = [
    /^Confirmar$/i,
    /^Confirm$/i,
    /^Conferma$/i,
  ];

  for (const pattern of confirmPatterns) {
    const button =
      page.getByRole(
        "button",
        { name: pattern }
      ).first();

    try {
      if (
        await button.isVisible({
          timeout: 500,
        })
      ) {
        await button.click();
        await sleep(700);
        return true;
      }
    } catch {
      // Probar siguiente opción.
    }
  }

  /*
   * Fallback: cerrar el modal por su botón X si la acción
   * de confirmar no está disponible.
   */
  const closeCandidates = [
    page.getByRole("button", { name: /close|cerrar|chiudi/i }).first(),
    page.locator('[aria-label*="close" i], [aria-label*="cerrar" i], button:has(svg)').last(),
  ];

  for (const candidate of closeCandidates) {
    try {
      if (
        await candidate.isVisible({
          timeout: 400,
        })
      ) {
        await candidate.click({
          force: true,
        });
        await sleep(500);
        return true;
      }
    } catch {
      // Sin cierre utilizable.
    }
  }

  return false;
}

async function findDecorSearchInput(page) {
  const selectors = [
    'input[type="search"]',
    'input[placeholder*="decor" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="cerca" i]',
    'input[name*="search" i]',
    'input[id*="search" i]',
  ];

  for (const selector of selectors) {
    const locator =
      page.locator(selector);

    const count =
      await locator.count();

    for (
      let index = 0;
      index < count;
      index += 1
    ) {
      const candidate =
        locator.nth(index);

      try {
        if (
          await candidate.isVisible({
            timeout: 250,
          })
        ) {
          return candidate;
        }
      } catch {
        // Probar siguiente.
      }
    }
  }

  const inputs =
    page.locator(
      'input:not([type]), input[type="text"]'
    );

  const count =
    await inputs.count();

  let best = null;
  let bestScore = -1;

  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const candidate =
      inputs.nth(index);

    try {
      if (
        !(await candidate.isVisible({
          timeout: 200,
        }))
      ) {
        continue;
      }

      const score =
        await candidate.evaluate(
          (element) => {
            const attrs = [
              element.getAttribute("placeholder"),
              element.getAttribute("name"),
              element.getAttribute("id"),
              element.getAttribute("aria-label"),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();

            const parentText =
              String(
                element.parentElement
                  ?.innerText || ""
              )
                .toLowerCase()
                .slice(0, 300);

            const haystack =
              `${attrs} ${parentText}`;

            let value = 0;

            if (
              /search|decor|code|cerca|código|codice/.test(
                haystack
              )
            ) {
              value += 10;
            }

            if (
              /hex|color|colour/.test(
                haystack
              )
            ) {
              value -= 10;
            }

            return value;
          }
        );

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    } catch {
      // Continuar.
    }
  }

  return bestScore > 0
    ? best
    : null;
}

function isExactDecorUrlForCode(
  rawUrl,
  code
) {
  try {
    const parsed = new URL(
      rawUrl,
      ABET_COLLECTION_URL
    );

    const pathname =
      parsed.pathname
        .replace(/\/+$/, "")
        .toLowerCase();

    const normalizedCode =
      String(code || "")
        .trim()
        .toLowerCase();

    return (
      pathname.includes("/decori/") &&
      pathname.endsWith(
        `-${normalizedCode}`
      )
    );
  } catch {
    return false;
  }
}

async function findExactDecorHref(
  page,
  code
) {
  const normalizedCode =
    String(code || "").trim();

  if (!normalizedCode) {
    return null;
  }

  /*
   * Regla crítica V4:
   * nunca hacemos click sobre una tarjeta por texto.
   * Solo aceptamos una URL /decori/ cuyo slug termine
   * EXACTAMENTE en -<codigo>.
   */
  const discovered =
    await page.evaluate(
      (targetCode) => {
        const normalizeCandidate = (
          raw
        ) => {
          if (!raw) {
            return null;
          }

          try {
            const url = new URL(
              raw,
              window.location.href
            );

            const pathname =
              url.pathname
                .replace(/\/+$/, "")
                .toLowerCase();

            if (
              pathname.includes(
                "/decori/"
              ) &&
              pathname.endsWith(
                `-${String(
                  targetCode
                ).toLowerCase()}`
              )
            ) {
              return url.href;
            }
          } catch {
            return null;
          }

          return null;
        };

        const attributes = [
          "href",
          "data-href",
          "data-url",
          "data-link",
        ];

        const elements =
          document.querySelectorAll(
            "a[href], [data-href], [data-url], [data-link]"
          );

        for (
          const element of elements
        ) {
          for (
            const attribute
            of attributes
          ) {
            const candidate =
              normalizeCandidate(
                element.getAttribute(
                  attribute
                )
              );

            if (candidate) {
              return candidate;
            }
          }
        }

        /*
         * Fallback para frameworks que guardan
         * la URL en JSON/HTML pero todavía no la
         * montan como atributo href.
         */
        const html =
          document.documentElement
            .innerHTML;

        const escapedCode =
          String(targetCode)
            .replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            );

        const patterns = [
          new RegExp(
            `https?:\\/\\/[^\\"'<>\\s]+\\/[^\\"'<>\\s]*decori\\/[^\\"'<>\\s]*-${escapedCode}\\/?`,
            "i"
          ),
          new RegExp(
            `\\/(?:en|es|it|fr|de|pt)?\\/?decori\\/[^\\"'<>\\s]*-${escapedCode}\\/?`,
            "i"
          ),
          new RegExp(
            `\\/decori\\/[^\\"'<>\\s]*-${escapedCode}\\/?`,
            "i"
          ),
        ];

        for (
          const pattern of patterns
        ) {
          const match =
            html.match(pattern);

          if (!match?.[0]) {
            continue;
          }

          const candidate =
            normalizeCandidate(
              match[0]
                .replaceAll(
                  "&amp;",
                  "&"
                )
                .replaceAll(
                  "\\/",
                  "/"
                )
            );

          if (candidate) {
            return candidate;
          }
        }

        return null;
      },
      normalizedCode
    );

  if (
    discovered &&
    isExactDecorUrlForCode(
      discovered,
      normalizedCode
    )
  ) {
    return discovered;
  }

  return null;
}

function slugifyAbet(value) {
  return normalizeText(value)
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function buildDeterministicDecorCandidates({
  code,
  productName,
  collectionSlugs = [],
}) {
  const normalizedCode =
    String(code || "").trim();

  const nameSlug =
    slugifyAbet(productName);

  if (
    !normalizedCode ||
    !nameSlug
  ) {
    return [];
  }

  const cleanCollections = [
    ...new Set(
      (collectionSlugs || [])
        .map((slug) =>
          slugifyAbet(slug)
        )
        .filter(Boolean)
    ),
  ];

  const suffixes = [
    `${nameSlug}-${normalizedCode}`,
  ];

  for (
    const collection
    of cleanCollections
  ) {
    suffixes.push(
      `${collection}-${nameSlug}-${normalizedCode}`
    );
  }

  /*
   * Algunos decorados de Abet combinan dos familias
   * en el slug, por ejemplo foldline-rocks-...-580.
   * Probamos pares sin explotar combinatoriamente.
   */
  for (
    let i = 0;
    i < cleanCollections.length;
    i += 1
  ) {
    for (
      let j = i + 1;
      j < cleanCollections.length;
      j += 1
    ) {
      const first =
        cleanCollections[i];
      const second =
        cleanCollections[j];

      suffixes.push(
        `${first}-${second}-${nameSlug}-${normalizedCode}`,
        `${second}-${first}-${nameSlug}-${normalizedCode}`
      );
    }
  }

  const candidates = [];

  for (const base of ABET_DECOR_BASES) {
    for (
      const suffix
      of [...new Set(suffixes)]
    ) {
      candidates.push(
        `${base}${suffix}/`
      );
    }
  }

  return candidates;
}

async function tryDeterministicDecorCandidates({
  page,
  code,
  productName,
  collectionSlugs,
}) {
  const candidates =
    buildDeterministicDecorCandidates({
      code,
      productName,
      collectionSlugs,
    });

  for (const candidate of candidates) {
    try {
      const response =
        await page.goto(
          candidate,
          {
            /*
             * V14:
             * para validar una URL candidata solo necesitamos
             * respuesta HTTP + URL final. No esperamos que Abet
             * cargue todo su JavaScript.
             */
            waitUntil:
              "commit",
            timeout: 15000,
          }
        );

      const status =
        response?.status?.() ?? 0;

      const finalUrl =
        page.url();

      /*
       * V6:
       * Abet hidrata la ficha dinámicamente. El HTML inicial
       * puede contener {{code}} / {{title}}, por lo que NO
       * validamos el decorado leyendo body.innerText.
       *
       * La condición fuerte es:
       *   - HTTP válido
       *   - ruta /decori/
       *   - slug termina exactamente en -<codigo>
       */
      if (
        status >= 200 &&
        status < 400 &&
        isExactDecorUrlForCode(
          finalUrl,
          code
        )
      ) {
        return finalUrl;
      }
    } catch {
      // Probar siguiente candidato.
    }
  }

  return null;
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#038;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("\\/", "/");
}

function extractExactDecorUrlFromHtml({
  html,
  sourceUrl,
  code,
}) {
  const normalized =
    decodeBasicHtmlEntities(
      html
    );

  /*
   * Buscamos cualquier URL/atributo /decori/...-<codigo>/.
   * Abet puede guardar el enlace como href, data-url o JSON.
   */
  const candidates = [];

  const absolutePattern =
    /https?:\/\/[^"'\\\s<>]+\/decori\/[^"'\\\s<>]+\/?/gi;

  const relativePattern =
    /\/(?:en\/|es\/)?decori\/[^"'\\\s<>]+\/?/gi;

  for (
    const pattern
    of [
      absolutePattern,
      relativePattern,
    ]
  ) {
    let match;

    while (
      (match =
        pattern.exec(
          normalized
        )) !== null
    ) {
      candidates.push(
        match[0]
      );
    }
  }

  for (const raw of candidates) {
    try {
      const candidate =
        new URL(
          raw,
          sourceUrl
        ).href;

      if (
        isExactDecorUrlForCode(
          candidate,
          code
        )
      ) {
        return candidate;
      }
    } catch {
      // Continuar.
    }
  }

  return null;
}

async function fetchHtmlWithTimeout(
  url,
  timeoutMs = 20000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            accept:
              "text/html,application/xhtml+xml",
            "accept-language":
              "en-US,en;q=0.9,es;q=0.8",
          },
          redirect:
            "follow",
          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getRelevantCollectionSlugs(
  collectionSlugs,
  preferredCollection = null
) {
  const unique = [
    ...new Set(
      (collectionSlugs || [])
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    ),
  ];

  /*
   * En SAFE MASS priorizamos las colecciones visuales.
   * Si una relación extra acompaña al producto, queda detrás.
   */
  const preferred =
    String(
      preferredCollection || ""
    )
      .trim()
      .toLowerCase();

  return unique.sort(
    (a, b) => {
      const aPreferred =
        preferred && a === preferred
          ? 0
          : 1;

      const bPreferred =
        preferred && b === preferred
          ? 0
          : 1;

      if (
        aPreferred !==
        bPreferred
      ) {
        return (
          aPreferred -
          bPreferred
        );
      }

      const aDecorative =
        DECORATIVE_COLLECTION_SLUGS.has(
          a
        )
          ? 0
          : 1;

      const bDecorative =
        DECORATIVE_COLLECTION_SLUGS.has(
          b
        )
          ? 0
          : 1;

      return (
        aDecorative -
          bDecorative ||
        a.localeCompare(b)
      );
    }
  );
}

async function findDecorUrlFromCollectionPages({
  page,
  code,
  collectionSlugs,
  preferredCollection = null,
}) {
  const slugs =
    getRelevantCollectionSlugs(
      collectionSlugs,
      preferredCollection
    );

  /*
   * Primero HTTP directo: rápido y no depende de hidratación.
   */
  for (const slug of slugs) {
    for (
      const base
      of ABET_COLLECTION_BASES
    ) {
      const collectionUrl =
        `${base}${encodeURIComponent(
          slug
        )}/`;

      const html =
        await fetchHtmlWithTimeout(
          collectionUrl
        );

      if (!html) {
        continue;
      }

      const exactUrl =
        extractExactDecorUrlFromHtml({
          html,
          sourceUrl:
            collectionUrl,
          code,
        });

      if (exactUrl) {
        return exactUrl;
      }
    }
  }

  /*
   * Fallback por colección usando Playwright.
   * Sigue siendo mucho más pequeño que /abet-collection/.
   */
  for (const slug of slugs) {
    const collectionUrl =
      `https://abetlaminati.com/en/collections/${encodeURIComponent(
        slug
      )}/`;

    try {
      await page.goto(
        collectionUrl,
        {
          waitUntil:
            "commit",
          timeout: 25000,
        }
      );

      try {
        await page.waitForLoadState(
          "domcontentloaded",
          {
            timeout: 10000,
          }
        );
      } catch {
        // Podemos inspeccionar aunque el evento completo tarde.
      }

      const exactHref =
        await findExactDecorHref(
          page,
          code
        );

      if (exactHref) {
        return exactHref;
      }
    } catch {
      // Probar siguiente colección.
    }
  }

  return null;
}


function getCanonicalCollectionOverride({
  preferredCollection,
  code,
}) {
  const collection =
    String(
      preferredCollection || ""
    )
      .trim()
      .toLowerCase();

  const normalizedCode =
    String(code || "")
      .trim();

  if (
    !collection ||
    !normalizedCode
  ) {
    return null;
  }

  const collectionMap =
    COLLECTION_CANONICAL_URL_OVERRIDES.get(
      collection
    );

  if (!collectionMap) {
    return null;
  }

  return (
    collectionMap.get(
      normalizedCode
    ) ||
    null
  );
}

async function waitForDecorHydration({
  page,
  code,
  timeoutMs = 30000,
}) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
    timeoutMs
  ) {
    try {
      const state =
        await page.evaluate(
          (expectedCode) => {
            const bodyText =
              String(
                document.body?.innerText ||
                ""
              );

            const html =
              String(
                document.documentElement
                  ?.innerHTML ||
                ""
              );

            const hasExpectedCode =
              new RegExp(
                `(^|\\\\s)${String(expectedCode).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(\\\\s|$)`,
                "m"
              ).test(bodyText);

            const hasTemplateCode =
              html.includes(
                "{{code}}"
              );

            /*
             * No exigimos que todas las plantillas desaparezcan
             * porque Abet mantiene modales Vue ocultos en el DOM.
             * Basta con que el código real ya esté renderizado.
             */
            return {
              hasExpectedCode,
              hasTemplateCode,
              bodyLength:
                bodyText.length,
            };
          },
          String(code)
        );

      if (
        state.hasExpectedCode
      ) {
        return true;
      }
    } catch {
      // La navegación/hidratación aún puede estar cambiando el DOM.
    }

    await sleep(500);
  }

  return false;
}


function normalizeDecorUrlForCollection(
  url,
  preferredCollection
) {
  if (!url) {
    return url;
  }

  if (
    String(
      preferredCollection || ""
    )
      .trim()
      .toLowerCase() !==
    LEGNI_LIGHT_COLLECTION_SLUG
  ) {
    return url;
  }

  try {
    const parsed =
      new URL(url);

    parsed.protocol = "https:";
    parsed.hostname =
      "na.abetlaminati.com";
    parsed.port = "";

    parsed.pathname =
      parsed.pathname.replace(
        /^\/(?:en|es)\/decori\//i,
        "/decori/"
      );

    return parsed.href;
  } catch {
    return url;
  }
}

async function discoverDecorUrl({
  context,
  code,
  productName,
  collectionSlugs = [],
  preferredCollection = null,
}) {
  const page =
    await context.newPage();

  try {
    /*
     * V18 COLLECTION MODE:
     * 1) override canónico verificado
     * 2) página de colección
     * 3) URL determinística
     * 4) catálogo global como último recurso
     */
    if (preferredCollection) {
      const canonicalOverride =
        getCanonicalCollectionOverride({
          preferredCollection,
          code,
        });

      if (canonicalOverride) {
        return normalizeDecorUrlForCollection(
          canonicalOverride,
          preferredCollection
        );
      }

      const collectionHref =
        await findDecorUrlFromCollectionPages({
          page,
          code,
          collectionSlugs,
          preferredCollection,
        });

      if (collectionHref) {
        return normalizeDecorUrlForCollection(
          collectionHref,
          preferredCollection
        );
      }
    }

    const deterministicHref =
      await tryDeterministicDecorCandidates({
        page,
        code,
        productName,
        collectionSlugs,
      });

    if (deterministicHref) {
      return normalizeDecorUrlForCollection(
        deterministicHref,
        preferredCollection
      );
    }

    if (!preferredCollection) {
      const collectionHref =
        await findDecorUrlFromCollectionPages({
          page,
          code,
          collectionSlugs,
          preferredCollection,
        });

      if (collectionHref) {
        return normalizeDecorUrlForCollection(
          collectionHref,
          preferredCollection
        );
      }
    }

    try {
      await page.goto(
        ABET_COLLECTION_URL,
        {
          waitUntil:
            "commit",
          timeout: 20000,
        }
      );

      try {
        await page.waitForLoadState(
          "domcontentloaded",
          {
            timeout: 10000,
          }
        );
      } catch {
        // Continuar.
      }

      await dismissCookies(page);
      await dismissCountryLanguageModal(
        page
      );

      let exactHref =
        await findExactDecorHref(
          page,
          code
        );

      if (exactHref) {
        return normalizeDecorUrlForCollection(
          exactHref,
          preferredCollection
        );
      }

      const searchInput =
        await findDecorSearchInput(
          page
        );

      if (!searchInput) {
        return null;
      }

      await searchInput.fill(
        String(code)
      );

      await sleep(1200);

      exactHref =
        await findExactDecorHref(
          page,
          code
        );

      if (
        exactHref &&
        isExactDecorUrlForCode(
          exactHref,
          code
        )
      ) {
        return normalizeDecorUrlForCollection(
          exactHref,
          preferredCollection
        );
      }
    } catch {
      return null;
    }

    return null;
  } finally {
    await page.close();
  }
}
async function getPanelHref(
  page
) {
  const patterns = [
    /Download panel format/i,
    /Descargar formato del panel/i,
    /Scarica formato pannello/i,
  ];

  for (const pattern of patterns) {
    const links =
      page
        .locator("a")
        .filter({
          hasText: pattern,
        });

    const count =
      await links.count();

    for (
      let index = 0;
      index < count;
      index += 1
    ) {
      const link =
        links.nth(index);

      try {
        if (
          !(await link.isVisible({
            timeout: 250,
          }))
        ) {
          continue;
        }

        const href =
          await link.getAttribute(
            "href"
          );

        if (
          href &&
          href !== "#" &&
          !href
            .toLowerCase()
            .startsWith(
              "javascript:"
            )
        ) {
          return new URL(
            href,
            page.url()
          ).href;
        }
      } catch {
        // Probar siguiente.
      }
    }
  }

  return null;
}

async function getVisiblePanelControl(
  page
) {
  const pattern =
    /Download panel format|Descargar formato del panel|Scarica formato pannello/i;

  const matches =
    page.getByText(
      pattern,
      {
        exact: false,
      }
    );

  const count =
    await matches.count();

  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const candidate =
      matches.nth(index);

    try {
      if (
        await candidate.isVisible({
          timeout: 250,
        })
      ) {
        return candidate;
      }
    } catch {
      // Probar siguiente.
    }
  }

  return null;
}
async function downloadPanelBuffer({
  context,
  decorUrl,
  code,
}) {
  const page =
    await context.newPage();

  try {
    if (
      !isExactDecorUrlForCode(
        decorUrl,
        code
      )
    ) {
      throw new Error(
        `SEGURIDAD: ficha Abet no coincide con código ${code}: ${decorUrl}`
      );
    }

    await page.goto(
      decorUrl,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 90000,
      }
    );

    await dismissCookies(page);
    await dismissCountryLanguageModal(page);

    /*
     * Abet hidrata la ficha mediante JavaScript.
     * Damos tiempo a que aparezca el control REAL y visible
     * de descarga, no la plantilla {{...}} del HTML inicial.
     */
    let panelControl = null;

    for (
      let attempt = 0;
      attempt < 20;
      attempt += 1
    ) {
      panelControl =
        await getVisiblePanelControl(
          page
        );

      if (panelControl) {
        break;
      }

      await sleep(500);
    }

    if (!panelControl) {
      throw new Error(
        `No apareció un botón visible de descarga de panel para ${code}`
      );
    }

    /*
     * Si Abet expone un href directo, lo descargamos con
     * el mismo contexto/cookies del navegador.
     */
    const panelHref =
      await getPanelHref(
        page
      );

    if (panelHref) {
      const response =
        await context.request.get(
          panelHref,
          {
            headers: {
              referer:
                decorUrl,
            },
            timeout: 90000,
          }
        );

      if (
        !response.ok()
      ) {
        throw new Error(
          `HTTP ${response.status()} descargando panel`
        );
      }

      const buffer =
        await response.body();

      const contentType =
        String(
          response.headers()[
            "content-type"
          ] || ""
        );

      if (
        buffer.length === 0
      ) {
        throw new Error(
          "Abet devolvió archivo vacío"
        );
      }

      if (
        contentType.includes(
          "text/html"
        )
      ) {
        throw new Error(
          "El enlace del panel devolvió HTML"
        );
      }

      const parsed =
        new URL(panelHref);

      const filename =
        decodeURIComponent(
          parsed.pathname
            .split("/")
            .filter(Boolean)
            .at(-1) ||
          `ABET-LAMINATI_${code}_panel.jpg`
        );

      return {
        buffer,
        filename,
        panelHref,
      };
    }

    /*
     * Caso habitual en Abet: el control ejecuta JavaScript
     * y el navegador genera una descarga. Escuchamos el
     * evento download y hacemos click SOLO en el control
     * visible de la ficha correcta.
     */
    const downloadPromise =
      page.waitForEvent(
        "download",
        {
          timeout: 45000,
        }
      );

    await panelControl.click({
      force: true,
    });

    const download =
      await downloadPromise;

    const stream =
      await download.createReadStream();

    if (!stream) {
      throw new Error(
        `Abet inició la descarga del panel ${code}, pero no entregó stream`
      );
    }

    const chunks = [];

    for await (
      const chunk of stream
    ) {
      chunks.push(chunk);
    }

    const buffer =
      Buffer.concat(chunks);

    if (
      buffer.length === 0
    ) {
      throw new Error(
        `La descarga del panel ${code} llegó vacía`
      );
    }

    return {
      buffer,
      filename:
        download
          .suggestedFilename() ||
        `ABET-LAMINATI_${code}_panel.jpg`,
      panelHref: null,
    };
  } finally {
    await page.close();
  }
}
async function deleteGalleryStorageBestEffort(
  galleryRows
) {
  const keys =
    galleryRows
      .flatMap(
        (row) => [
          row.thumbnail_key,
          row.card_key,
          row.detail_key,
        ]
      )
      .filter(Boolean);

  if (
    keys.length === 0
  ) {
    return;
  }

  try {
    await deleteProductImageVariants(
      keys
    );
  } catch (error) {
    console.warn(
      `WARN gallery storage cleanup: ${String(error?.message || error)}`
    );
  }
}

async function normalizeProductImagesAfterGalleryRemoval({
  client,
  productId,
}) {
  /*
   * Evitar colisiones temporales de sort_order.
   */
  await client.query(
    `
      UPDATE product_images
      SET
        is_primary = FALSE,
        sort_order =
          COALESCE(sort_order, 0) + 1000
      WHERE product_id = $1
    `,
    [productId]
  );

  /*
   * Orden final:
   * sample primero,
   * panel segundo,
   * cualquier otra imagen después.
   */
  await client.query(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            ORDER BY
              CASE
                WHEN LOWER(COALESCE(image_type, '')) = 'sample' THEN 0
                WHEN LOWER(COALESCE(image_type, '')) = 'panel' THEN 1
                ELSE 2
              END,
              sort_order,
              created_at,
              id
          ) - 1 AS new_order
        FROM product_images
        WHERE product_id = $1
      )
      UPDATE product_images pi
      SET sort_order =
        ranked.new_order
      FROM ranked
      WHERE pi.id =
        ranked.id
    `,
    [productId]
  );

  /*
   * Si existe sample, queda principal.
   * Si aún no existe sample, el panel queda principal temporalmente.
   * El importador sample lo moverá luego a sort 1.
   */
  const primaryResult =
    await client.query(
      `
        SELECT id
        FROM product_images
        WHERE product_id = $1
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(image_type, '')) = 'sample' THEN 0
            WHEN LOWER(COALESCE(image_type, '')) = 'panel' THEN 1
            ELSE 2
          END,
          sort_order,
          created_at,
          id
        LIMIT 1
      `,
      [productId]
    );

  if (
    primaryResult.rowCount > 0
  ) {
    await client.query(
      `
        UPDATE product_images
        SET is_primary = TRUE
        WHERE id = $1
      `,
      [
        primaryResult.rows[0].id,
      ]
    );
  }
}

async function cleanupGalleryForExistingPanel(
  product
) {
  const client =
    await pool.connect();

  let galleryRows = [];

  try {
    await client.query(
      "BEGIN"
    );

    const panelResult =
      await client.query(
        `
          SELECT id
          FROM product_images
          WHERE product_id = $1
            AND LOWER(
              COALESCE(
                image_type,
                ''
              )
            ) = 'panel'
          LIMIT 1
          FOR UPDATE
        `,
        [product.id]
      );

    if (
      panelResult.rowCount === 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return {
        cleaned: 0,
      };
    }

    const galleryResult =
      await client.query(
        `
          SELECT
            id,
            thumbnail_key,
            card_key,
            detail_key
          FROM product_images
          WHERE product_id = $1
            AND LOWER(
              COALESCE(
                image_type,
                ''
              )
            ) = 'gallery'
          FOR UPDATE
        `,
        [product.id]
      );

    galleryRows =
      galleryResult.rows;

    if (
      galleryRows.length > 0
    ) {
      await client.query(
        `
          DELETE FROM product_images
          WHERE product_id = $1
            AND LOWER(
              COALESCE(
                image_type,
                ''
              )
            ) = 'gallery'
        `,
        [product.id]
      );
    }

    await normalizeProductImagesAfterGalleryRemoval({
      client,
      productId:
        product.id,
    });

    await client.query(
      "COMMIT"
    );
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {
      // Ignorar.
    }

    throw error;
  } finally {
    client.release();
  }

  /*
   * El bucket se limpia SOLO después del COMMIT.
   */
  await deleteGalleryStorageBestEffort(
    galleryRows
  );

  return {
    cleaned:
      galleryRows.length,
  };
}

async function persistPanel({
  product,
  file,
}) {
  const imageId =
    randomUUID();

  const storageResult =
    await uploadProductImage({
      buffer: file.buffer,
      sku: product.sku,
      imageType: "panel",
      imageId,
    });

  const uploadedKeys = [
    storageResult?.variants
      ?.thumbnail?.key,
    storageResult?.variants
      ?.card?.key,
    storageResult?.variants
      ?.detail?.key,
  ].filter(Boolean);

  const client =
    await pool.connect();

  let galleryRows = [];

  try {
    await client.query(
      "BEGIN"
    );

    const existing =
      await client.query(
        `
          SELECT id
          FROM product_images
          WHERE product_id = $1
            AND LOWER(
              COALESCE(
                image_type,
                ''
              )
            ) = 'panel'
          LIMIT 1
          FOR UPDATE
        `,
        [product.id]
      );

    if (
      existing.rowCount > 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      await deleteProductImageVariants(
        uploadedKeys
      );

      return {
        skipped: true,
        galleryDeleted: 0,
      };
    }

    /*
     * Guardamos primero las keys gallery para borrarlas
     * del bucket solo después del COMMIT.
     */
    const galleryResult =
      await client.query(
        `
          SELECT
            id,
            thumbnail_key,
            card_key,
            detail_key
          FROM product_images
          WHERE product_id = $1
            AND LOWER(
              COALESCE(
                image_type,
                ''
              )
            ) = 'gallery'
          FOR UPDATE
        `,
        [product.id]
      );

    galleryRows =
      galleryResult.rows;

    /*
     * El gallery se elimina en la MISMA transacción
     * que registra el panel.
     */
    await client.query(
      `
        DELETE FROM product_images
        WHERE product_id = $1
          AND LOWER(
            COALESCE(
              image_type,
              ''
            )
          ) = 'gallery'
      `,
      [product.id]
    );

    /*
     * Insert temporal; luego normalizamos.
     */
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
          $1,
          $2,
          NULL,
          $3,
          FALSE,
          999,
          'RAILWAY',
          'panel',
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )
      `,
      [
        imageId,
        product.id,
        `${product.name} ${product.sku} - Vista panel Abet Laminati`,
        storageResult
          .variants
          .thumbnail.key,
        storageResult
          .variants
          .card.key,
        storageResult
          .variants
          .detail.key,
        file.filename
          .slice(0, 255),
        storageResult
          .source.width,
        storageResult
          .source.height,
        storageResult
          .source.bytes,
      ]
    );

    await normalizeProductImagesAfterGalleryRemoval({
      client,
      productId:
        product.id,
    });

    const panelOrderResult =
      await client.query(
        `
          SELECT
            sort_order,
            is_primary
          FROM product_images
          WHERE id = $1
        `,
        [imageId]
      );

    await client.query(
      "COMMIT"
    );

    await deleteGalleryStorageBestEffort(
      galleryRows
    );

    return {
      skipped: false,
      imageId,
      sortOrder:
        Number(
          panelOrderResult.rows[0]
            ?.sort_order ?? 0
        ),
      isPrimary:
        Boolean(
          panelOrderResult.rows[0]
            ?.is_primary
        ),
      galleryDeleted:
        galleryRows.length,
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {
      // Ignorar.
    }

    /*
     * Si falla la BD, el gallery se conserva por rollback
     * y limpiamos solo el panel nuevo del bucket.
     */
    try {
      await deleteProductImageVariants(
        uploadedKeys
      );
    } catch {
      // Limpieza best effort.
    }

    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args =
    parseArgs(
      process.argv.slice(2)
    );

  if (args.dbInfo) {
    await printDbInfo();
  }

  if (args.storageInfo) {
    printStorageInfo();
  }

  const dbInfo =
    await getDbInfo();

  const mappingInfo =
    await getAbetMappingInfo();

  console.log(
    `Mapeo Abet:            ${mappingInfo.collections} colecciones / ${mappingInfo.decor_codes} códigos / ${mappingInfo.product_links} relaciones`
  );

  if (
    mappingInfo.collections <
      30 &&
    !args.onlySku &&
    !args.onlyCollection
  ) {
    console.warn("");
    console.warn(
      "ADVERTENCIA: el mapeo Abet de esta BD está incompleto."
    );
    console.warn(
      "Para pruebas locales usa --only-sku=STRAT-1381."
    );
    console.warn(
      "La importación masiva debe ejecutarse contra Railway, donde están las 39 colecciones."
    );
    console.warn("");
  }

  if (
    (
      args.dbInfo ||
      args.storageInfo
    ) &&
    !args.apply &&
    !args.onlySku &&
    !args.onlyCollection &&
    !args.limit
  ) {
    return;
  }

  if (args.apply) {
    if (
      args.confirm !==
      CONFIRM_TOKEN
    ) {
      throw new Error(
        `Para aplicar debes usar --confirm=${CONFIRM_TOKEN}`
      );
    }

    const actualDb =
      normalizeText(
        dbInfo.database_name
      );

    const expectedDb =
      normalizeText(
        args.confirmDb
      );

    if (!expectedDb) {
      throw new Error(
        "Debes indicar --confirm-db con el nombre exacto de la base conectada"
      );
    }

    if (
      expectedDb !==
      actualDb
    ) {
      throw new Error(
        `Confirmaste '${args.confirmDb}', pero la base conectada es '${dbInfo.database_name}'`
      );
    }

    /*
     * Seguridad adicional:
     * fuera de Railway solo permitimos una prueba
     * explícita por SKU. No se puede ejecutar el
     * importador masivo contra una BD local/dev.
     */
    if (
      actualDb !==
        CONFIRM_DB &&
      !args.onlySku
    ) {
      throw new Error(
        "Fuera de Railway, --apply requiere --only-sku=STRAT-XXXX"
      );
    }
  }

  let allProducts =
    await loadTargets({
      onlySku:
        args.onlySku,
      onlyCollection:
        args.onlyCollection,
    });

  let legniDarkOmittedProducts = [];

  if (
    args.onlyCollection ===
    LEGNI_LIGHT_COLLECTION_SLUG
  ) {
    legniDarkOmittedProducts =
      allProducts.filter(
        (product) =>
          !LEGNI_LIGHT_TARGET_SKUS.has(
            String(product.sku || "")
              .trim()
              .toUpperCase()
          )
      );

    allProducts =
      allProducts.filter(
        (product) =>
          LEGNI_LIGHT_TARGET_SKUS.has(
            String(product.sku || "")
              .trim()
              .toUpperCase()
          )
      );
  }

  const safeExcludedSkus =
    (
      args.onlyCollection &&
      !args.includeDiscontinued
    )
      ? (
          COLLECTION_SAFE_EXCLUSIONS.get(
            args.onlyCollection
          ) ||
          new Set()
        )
      : new Set();

  const excludedProducts =
    allProducts.filter(
      (product) =>
        safeExcludedSkus.has(
          String(product.sku || "")
            .toUpperCase()
        )
    );

  if (
    safeExcludedSkus.size > 0
  ) {
    allProducts =
      allProducts.filter(
        (product) =>
          !safeExcludedSkus.has(
            String(product.sku || "")
              .toUpperCase()
          )
      );
  }

  const classifiedProducts =
    allProducts.map(
      (product) => ({
        ...product,
        classification:
          classifyProduct(product),
      })
    );

  if (args.classificationReport) {
    printClassificationReport(
      allProducts
    );

    if (!args.apply) {
      return;
    }
  }

  const decorativeProducts =
    classifiedProducts.filter(
      (product) =>
        product.classification.type ===
        "DECORATIVE"
    );

  const plainProducts =
    classifiedProducts.filter(
      (product) =>
        product.classification.type ===
        "PLAIN"
    );

  const reviewProducts =
    classifiedProducts.filter(
      (product) =>
        product.classification.type ===
        "REVIEW"
    );

  const existingPanels =
    decorativeProducts.filter(
      (product) =>
        product.has_panel
    );

  let targets =
    decorativeProducts.filter(
      (product) =>
        !product.has_panel
    );

  if (args.limit) {
    targets =
      targets.slice(
        0,
        args.limit
      );
  }

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " ABET STRATIFICATO PANEL IMPORT LEGNI LIGHT V1 ACTIVE 62"
  );
  console.log(
    "========================================"
  );
  console.log(
    `Base:                  ${dbInfo.database_name}`
  );

  if (args.onlyCollection) {
    console.log(
      `Colección:             ${args.onlyCollection}`
    );
  }
  console.log(
    `STRAT encontrados:     ${allProducts.length}`
  );

  if (
    args.onlyCollection ===
    LEGNI_LIGHT_COLLECTION_SLUG
  ) {
    console.log(
      `Legni Light activos:     62`
    );
    console.log(
      `Discontinued omitido:  STRAT-680`
    );

    if (
      legniDarkOmittedProducts.length > 0
    ) {
      console.log(
        `Relaciones extra omitidas: ${legniDarkOmittedProducts.length}`
      );
    }
  }

  if (
    args.onlyCollection &&
    excludedProducts.length > 0
  ) {
    console.log(
      `Excluidos seguros:     ${excludedProducts.length} (${excludedProducts.map((p) => p.sku).join(", ")})`
    );
  }
  console.log(
    `Decorativos:           ${decorativeProducts.length}`
  );
  console.log(
    `Lisos omitidos:        ${plainProducts.length}`
  );
  console.log(
    `Revisión omitida:      ${reviewProducts.length}`
  );
  console.log(
    `Panel ya existente:    ${existingPanels.length}`
  );
  console.log(
    `Pendientes selección:  ${targets.length}`
  );
  console.log(
    `Modo:                  ${args.apply ? "APPLY" : "DRY-RUN"}`
  );

  if (
    args.apply &&
    normalizeText(dbInfo.database_name) !== CONFIRM_DB
  ) {
    console.log(
      "Seguridad:             APPLY local limitado a --only-sku"
    );
  }

  console.log("");

  if (
    args.onlyCollection
  ) {
    console.log(
      `COLLECTION MODE: ${args.onlyCollection} -> ${decorativeProducts.length} decorativos seleccionados.`
    );

    if (
      excludedProducts.length > 0
    ) {
      console.log(
        `Exclusión segura: ${excludedProducts.map((p) => p.sku).join(", ")}${args.includeDiscontinued ? " (incluidos por override)" : ""}`
      );
    }

    console.log("");
  } else if (
    !args.onlySku
  ) {
    console.log(
      `SAFE MASS: ${decorativeProducts.length} decorativos seguros; ${plainProducts.length} lisos; ${reviewProducts.length} en revisión.`
    );
    console.log("");
  }

  if (
    reviewProducts.length > 0 &&
    !args.onlySku &&
    !args.onlyCollection
  ) {
    console.warn(
      `ADVERTENCIA: ${reviewProducts.length} productos quedaron en REVISIÓN y no serán importados.`
    );
    console.warn(
      "Ejecuta --classification-report para ver el detalle antes del masivo."
    );
    console.warn("");
  }

  /*
   * Si el panel ya existe, en APPLY igualmente limpiamos
   * cualquier gallery antiguo que haya quedado.
   */
  if (
    args.apply &&
    existingPanels.length > 0
  ) {
    console.log(
      `Limpieza gallery con panel existente: ${existingPanels.length} producto(s)`
    );

    for (
      const product
      of existingPanels
    ) {
      const cleanup =
        await cleanupGalleryForExistingPanel(
          product
        );

      if (
        cleanup.cleaned > 0
      ) {
        console.log(
          `${product.sku} -> GALLERY ELIMINADO (${cleanup.cleaned})`
        );
      }
    }

    console.log("");
  }

  if (
    targets.length === 0
  ) {
    console.log(
      "No hay paneles decorativos pendientes."
    );
    return;
  }

  const browser =
    await chromium.launch({
      headless:
        !args.headful,
    });

  const context =
    await browser.newContext({
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 Laminatiword Catalog Importer",
      acceptDownloads: true,
    });

  const summary = {
    found: 0,
    uploaded: 0,
    missingPage: 0,
    missingPanel: 0,
    errors: 0,
  };

  try {
    for (
      let index = 0;
      index < targets.length;
      index += 1
    ) {
      const product =
        targets[index];

      const prefix =
        `[${index + 1}/${targets.length}] ${product.sku}`;

      try {
        console.log(
          `${prefix} -> buscando ficha Abet`
        );

        const decorUrl =
          await discoverDecorUrl({
            context,
            code:
              product.code,
            productName:
              product.name,
            collectionSlugs:
              product.abet_collection_slugs || [],
            preferredCollection:
              args.onlyCollection,
          });

        if (!decorUrl) {
          summary.missingPage +=
            1;

          console.log(
            `${prefix} -> SIN FICHA`
          );

          continue;
        }

        summary.found += 1;

        console.log(
          `${prefix} -> ${decorUrl}`
        );

        if (!args.apply) {
          continue;
        }

        const file =
          await downloadPanelBuffer({
            context,
            decorUrl,
            code:
              product.code,
          });

        const result =
          await persistPanel({
            product,
            file,
          });

        if (!result.skipped) {
          summary.uploaded += 1;

          console.log(
            `${prefix} -> PANEL OK`
          );

          if (
            result.galleryDeleted > 0
          ) {
            console.log(
              `${prefix} -> GALLERY ELIMINADO (${result.galleryDeleted})`
            );
          }
        }
      } catch (error) {
        const message =
          String(
            error?.message ||
            error
          );

        if (
          /panel/i.test(
            message
          )
        ) {
          summary.missingPanel +=
            1;
        } else {
          summary.errors += 1;
        }

        console.error(
          `${prefix} -> ERROR: ${message}`
        );
      }

      await sleep(450);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " RESUMEN"
  );
  console.log(
    "========================================"
  );
  console.log(
    `Fichas encontradas:  ${summary.found}`
  );
  console.log(
    `Paneles subidos:     ${summary.uploaded}`
  );
  console.log(
    `Sin ficha Abet:      ${summary.missingPage}`
  );
  console.log(
    `Sin panel:           ${summary.missingPanel}`
  );
  console.log(
    `Errores:             ${summary.errors}`
  );

  if (!args.apply) {
    console.log("");
    console.log(
      "DRY-RUN: no se descargó ni subió ningún panel."
    );
  }

  console.log("");
}

try {
  await main();
} catch (error) {
  console.error("");
  console.error(
    "IMPORTACIÓN ABORTADA:"
  );
  console.error(
    error?.stack ||
    error?.message ||
    error
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
