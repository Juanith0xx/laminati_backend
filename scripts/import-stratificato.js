import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const IMPORT_DATABASE_URL =
  process.env.IMPORT_DATABASE_URL || "";

const pool = IMPORT_DATABASE_URL
  ? new Pool({
      connectionString:
        IMPORT_DATABASE_URL,
    })
  : null;

const SOURCE_URL =
  "https://abetlaminati.com/es/abet-collection/";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const EXTRACT_ONLY = args.includes("--extract-only");
const DB_INFO_ONLY = args.includes("--db-info");
const CONFIRM = args.includes("--confirm=STRATIFICATO");

const confirmDbArg = args.find((arg) =>
  arg.startsWith("--confirm-db=")
);

const CONFIRM_DB = confirmDbArg
  ? confirmDbArg.slice("--confirm-db=".length)
  : null;

const sourceFileArg = args.find((arg) =>
  arg.startsWith("--source-file=")
);

const sourceFile = sourceFileArg
  ? sourceFileArg.slice("--source-file=".length)
  : null;

const REPORT_DIR = path.resolve(
  process.cwd(),
  "tmp",
  "stratificato-import"
);

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&times;/gi, "×")
    .replace(/&#215;/gi, "×")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&agrave;/gi, "à")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&egrave;/gi, "è")
    .replace(/&iacute;/gi, "í")
    .replace(/&igrave;/gi, "ì")
    .replace(/&oacute;/gi, "ó")
    .replace(/&ograve;/gi, "ò")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ugrave;/gi, "ù")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function htmlToLines(html) {
  const withoutNoise = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n");

  const withBreaks = withoutNoise
    .replace(
      /<\/?(?:article|section|div|li|ul|ol|p|h[1-6]|br|tr|td|th|a|button|label|option|figure|figcaption|span)\b[^>]*>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(withBreaks)
    .split(/\r?\n/)
    .map((line) =>
      line.replace(/\s+/g, " ").trim()
    )
    .filter(Boolean);
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCatalogName(value) {
  return normalizeName(value)
    .toLocaleLowerCase("es")
    .replace(
      /(^|[\s\-\/])([\p{L}\p{N}])/gu,
      (_, separator, char) =>
        `${separator}${char.toLocaleUpperCase("es")}`
    );
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function isInvalidDecorName(value) {
  const text = normalizeName(value);
  if (!text) return true;

  if (
    /^(?:mm|cm|core|hex|filtros?|designer|espesor|acabados?|colores?|interior|exterior)$/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^\d+(?:[.,]\d+)?\s*(?:mm|cm)?$/i.test(text)
  ) {
    return true;
  }

  if (
    /\d+\s*[×x]\s*\d+/i.test(text)
  ) {
    return true;
  }

  return false;
}

function extractDecorCandidates(lines) {
  /*
   * La página de Abet contiene muchos números fuera del catálogo:
   * formatos, espesores, códigos postales, datos legales, etc.
   *
   * Por seguridad SOLO procesamos el bloque real de resultados:
   *   "Restablecer filtros"
   *        ...
   *   "No se han encontrado decoraciones..."
   */
  const start = lines.findIndex((line) =>
    /restablecer filtros|reimposta i filtri|reset filters/i.test(
      line
    )
  );

  if (start < 0) {
    throw new Error(
      "No se encontró el inicio del listado de decorativos Abet."
    );
  }

  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) =>
      /no se han encontrado decoraciones|no decorations found|nessuna decorazione trovata/i.test(
        line
      )
    );

  if (relativeEnd < 0) {
    throw new Error(
      "No se encontró el final del listado de decorativos Abet."
    );
  }

  const end =
    start + 1 + relativeEnd;

  const scoped =
    lines.slice(start + 1, end);

  const products = [];
  const seen = new Set();

  const oneLinePattern =
    /^(\d{3,4})\s+(.{2,160})$/;

  for (
    let i = 0;
    i < scoped.length;
    i += 1
  ) {
    const current =
      normalizeName(scoped[i]);

    let code = "";
    let name = "";

    const oneLineMatch =
      current.match(oneLinePattern);

    if (oneLineMatch) {
      code = oneLineMatch[1];
      name = oneLineMatch[2];
    } else if (
      /^\d{3,4}$/.test(current)
    ) {
      const next =
        normalizeName(
          scoped[i + 1] || ""
        );

      if (
        next &&
        !/^\d{3,4}$/.test(next)
      ) {
        code = current;
        name = next;
      }
    }

    name = normalizeName(name);

    if (
      !code ||
      isInvalidDecorName(name)
    ) {
      continue;
    }

    const numericCode =
      Number(code);

    if (
      !Number.isInteger(
        numericCode
      ) ||
      numericCode < 100 ||
      numericCode > 9999
    ) {
      continue;
    }

    const key =
      `${code}:${name.toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    /*
     * "core x" aparece inmediatamente después de algunos
     * decorativos. No miramos un contexto amplio para evitar
     * atribuir el core del producto siguiente.
     */
    const nextLine =
      normalizeName(
        scoped[i + 1] || ""
      );

    const nextNextLine =
      normalizeName(
        scoped[i + 2] || ""
      );

    const coreLine =
      /^core\s+[a-z0-9-]+$/i.test(
        nextLine
      )
        ? nextLine
        : /^core\s+[a-z0-9-]+$/i.test(
              nextNextLine
            )
          ? nextNextLine
          : "";

    const coreMatch =
      coreLine.match(
        /^core\s+([a-z0-9-]+)$/i
      );

    /*
     * Avisos especiales se buscan solo en unas pocas líneas
     * posteriores al producto y antes del próximo código.
     */
    const localContext = [];

    for (
      let j = i + 1;
      j < Math.min(
        scoped.length,
        i + 6
      );
      j += 1
    ) {
      const candidate =
        normalizeName(scoped[j]);

      if (
        oneLinePattern.test(
          candidate
        ) ||
        /^\d{3,4}$/.test(
          candidate
        )
      ) {
        break;
      }

      localContext.push(
        candidate
      );
    }

    const context =
      localContext
        .join(" | ")
        .toLowerCase();

    products.push({
      code,
      name: toCatalogName(name),
      core: coreMatch
        ? coreMatch[1].toUpperCase()
        : null,
      discontinued_soon:
        /\bdiscontinued soon\b/i.test(
          context
        ),
      vertical_use_only:
        /\bvertical use only\b/i.test(
          context
        ),
    });

    seen.add(key);
  }

  /*
   * Un SKU Stratificato se basa en el código Abet.
   * Si la fuente repite un código, conservamos la primera
   * aparición y dejamos el conflicto en el reporte.
   */
  const byCode =
    new Map();

  const duplicates = [];

  for (const item of products) {
    if (
      byCode.has(item.code)
    ) {
      duplicates.push({
        code: item.code,
        first_name:
          byCode.get(
            item.code
          ).name,
        duplicate_name:
          item.name,
      });
      continue;
    }

    byCode.set(
      item.code,
      item
    );
  }

  return {
    products: [
      ...byCode.values(),
    ],
    duplicates,
    source_scope: {
      start_line:
        start + 1,
      end_line:
        end + 1,
      scoped_lines:
        scoped.length,
    },
  };
}
async function loadSourceHtml() {
  if (sourceFile) {
    return fs.readFile(
      path.resolve(process.cwd(), sourceFile),
      "utf8"
    );
  }

  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 Laminatiword-Stratificato-Importer/1.0",
      accept:
        "text/html,application/xhtml+xml",
      "accept-language":
        "es-CL,es;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `Abet respondió HTTP ${response.status}`
    );
  }

  return response.text();
}

async function getStratificatoFamily(client) {
  const result = await client.query(`
    SELECT
      id,
      code,
      name,
      category_id,
      brand_id,
      collection_id,
      is_active
    FROM project_product_families
    WHERE UPPER(code) = 'STRATIFICATO'
    LIMIT 1
  `);

  const family = result.rows[0];

  if (!family) {
    throw new Error(
      "No existe la familia STRATIFICATO en project_product_families"
    );
  }

  if (!family.category_id) {
    throw new Error(
      "La familia STRATIFICATO no posee category_id y products.category_id es obligatorio"
    );
  }

  if (!family.is_active) {
    throw new Error(
      "La familia STRATIFICATO está inactiva"
    );
  }

  return family;
}

async function getExistingState(client) {
  const result = await client.query(`
    SELECT
      p.id,
      p.sku,
      p.internal_code,
      p.name,
      p.slug,
      p.allow_sale,
      p.commercial_mode,
      p.project_family_id
    FROM products p
    WHERE
      p.sku LIKE 'STRAT-%'
      OR p.project_family_id = (
        SELECT id
        FROM project_product_families
        WHERE UPPER(code) = 'STRATIFICATO'
        LIMIT 1
      )
  `);

  return result.rows;
}

function buildRows({
  products,
  family,
  existingRows,
}) {
  const existingBySku = new Map(
    existingRows.map((row) => [
      String(row.sku).toUpperCase(),
      row,
    ])
  );

  return products.map((decor, index) => {
    const sku = `STRAT-${decor.code}`;
    const existing =
      existingBySku.get(sku.toUpperCase()) ||
      null;

    const slug =
      `stratificato-${decor.code}-${slugify(
        decor.name
      )}`;

    const notes = [
      "Stratificato HPL compacto decorativo Abet Laminati.",
      "Producto a pedido para proyectos; no se mantiene en stock.",
    ];

    if (decor.core) {
      notes.push(
        `Core informado en Abet Collection: ${decor.core}.`
      );
    }

    if (decor.vertical_use_only) {
      notes.push(
        "Abet indica uso únicamente vertical para este decorativo."
      );
    }

    if (decor.discontinued_soon) {
      notes.push(
        "Abet indica que este decorativo será discontinuado próximamente."
      );
    }

    return {
      action: existing
        ? "EXISTS"
        : "INSERT",
      source_code: decor.code,
      sku,
      internal_code: decor.code,
      name: decor.name,
      slug,
      category_id: family.category_id,
      brand_id: family.brand_id,
      collection_id: family.collection_id,
      project_family_id: family.id,
      base_price: null,
      tax_rate: 19,
      is_active:
        !decor.discontinued_soon,
      is_published:
        !decor.discontinued_soon,
      is_featured: false,
      allow_sale: false,
      commercial_mode: "PROJECT_ONLY",
      sort_order: index,
      short_description:
        `Stratificato HPL – ${decor.name} (Producto a pedido, no se mantiene en stock)`,
      description: notes.join(" "),
      core: decor.core,
      vertical_use_only:
        decor.vertical_use_only,
      discontinued_soon:
        decor.discontinued_soon,
      existing_id:
        existing?.id || null,
    };
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (
    /[",\n\r]/.test(text)
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function writeReports({
  rows,
  duplicates,
}) {
  await fs.mkdir(REPORT_DIR, {
    recursive: true,
  });

  const columns = [
    "action",
    "source_code",
    "sku",
    "internal_code",
    "name",
    "slug",
    "core",
    "vertical_use_only",
    "discontinued_soon",
    "is_active",
    "is_published",
    "allow_sale",
    "commercial_mode",
    "existing_id",
  ];

  const csv = [
    columns.join(","),
    ...rows.map((row) =>
      columns
        .map((column) =>
          csvEscape(row[column])
        )
        .join(",")
    ),
  ].join("\n");

  await fs.writeFile(
    path.join(
      REPORT_DIR,
      "stratificato_dry_run.csv"
    ),
    csv,
    "utf8"
  );

  await fs.writeFile(
    path.join(
      REPORT_DIR,
      "stratificato_source.json"
    ),
    JSON.stringify(rows, null, 2),
    "utf8"
  );

  await fs.writeFile(
    path.join(
      REPORT_DIR,
      "stratificato_source_duplicates.json"
    ),
    JSON.stringify(duplicates, null, 2),
    "utf8"
  );
}

async function getConnectionInfo(client) {
  const result = await client.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      inet_server_addr()::text AS server_ip,
      inet_server_port() AS server_port,
      (
        SELECT COUNT(*)::int
        FROM products p
        JOIN project_product_families f
          ON f.id = p.project_family_id
        WHERE f.code = 'STRATIFICATO'
      ) AS stratificato_count
  `);

  return result.rows[0];
}

function printConnectionInfo(info) {
  console.log("\nBase de datos conectada:");
  console.table({
    database: info.database_name,
    user: info.database_user,
    server_ip: info.server_ip,
    server_port: info.server_port,
    stratificato_count: info.stratificato_count,
  });
}

async function applyRows(client, rows) {
  const insertRows =
    rows.filter(
      (row) => row.action === "INSERT"
    );

  let inserted = 0;

  for (const row of insertRows) {
    const insertResult = await client.query(
      `
        INSERT INTO products (
          category_id,
          brand_id,
          collection_id,
          sku,
          internal_code,
          name,
          slug,
          short_description,
          description,
          base_price,
          tax_rate,
          is_active,
          is_published,
          is_featured,
          allow_sale,
          sort_order,
          commercial_mode,
          project_family_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          NULL, $10, $11, $12, false, false, $13,
          'PROJECT_ONLY', $14
        )
        ON CONFLICT (sku)
        DO NOTHING
      `,
      [
        row.category_id,
        row.brand_id,
        row.collection_id,
        row.sku,
        row.internal_code,
        row.name,
        row.slug,
        row.short_description,
        row.description,
        row.tax_rate,
        row.is_active,
        row.is_published,
        row.sort_order,
        row.project_family_id,
      ]
    );

    inserted += insertResult.rowCount || 0;
  }

  return {
    requested: insertRows.length,
    inserted,
    skipped:
      insertRows.length - inserted,
  };
}

async function main() {
  let client;

  try {
    if (DB_INFO_ONLY) {
      if (!pool) {
        throw new Error(
          "Falta IMPORT_DATABASE_URL. Este importador no utilizará la conexión normal del backend."
        );
      }

      client =
        await pool.connect();

      const connectionInfo =
        await getConnectionInfo(
          client
        );

      printConnectionInfo(
        connectionInfo
      );

      console.log(
        "\nDB-INFO: no se consultó Abet y no se modificó la base."
      );

      return;
    }

    console.log(
      `Fuente: ${
        sourceFile || SOURCE_URL
      }`
    );

    if (!EXTRACT_ONLY) {
      console.log(
        "Conexión DB: IMPORT_DATABASE_URL explícita"
      );
    }

    const html =
      await loadSourceHtml();

    const lines =
      htmlToLines(html);

    const {
      products,
      duplicates,
      source_scope,
    } = extractDecorCandidates(lines);

    console.log(
      `Decorativos detectados: ${products.length}`
    );

    console.log(
      "Bloque fuente:",
      source_scope
    );

    if (
      products.length < 500 ||
      products.length > 750
    ) {
      throw new Error(
        `Conteo de decorativos fuera del rango de seguridad: ${products.length}. No se continuará.`
      );
    }

    await fs.mkdir(
      REPORT_DIR,
      {
        recursive: true,
      }
    );

    await fs.writeFile(
      path.join(
        REPORT_DIR,
        "abet_decorativos_extraidos.json"
      ),
      JSON.stringify(
        {
          total:
            products.length,
          source_scope,
          duplicates,
          products,
        },
        null,
        2
      ),
      "utf8"
    );

    if (EXTRACT_ONLY) {
      console.log(
        `Reporte extracción: ${path.join(
          REPORT_DIR,
          "abet_decorativos_extraidos.json"
        )}`
      );

      console.log(
        "\nEXTRACT-ONLY: no se abrió conexión a PostgreSQL."
      );

      return;
    }

    if (!pool) {
      throw new Error(
        "Falta IMPORT_DATABASE_URL. Define explícitamente la base destino antes del dry-run o apply."
      );
    }

    client =
      await pool.connect();

    const connectionInfo =
      await getConnectionInfo(
        client
      );

    printConnectionInfo(
      connectionInfo
    );

    const family =
      await getStratificatoFamily(client);

    console.log(
      `Familia: ${family.code} · ${family.name}`
    );

    const existingRows =
      await getExistingState(client);

    const rows =
      buildRows({
        products,
        family,
        existingRows,
      });

    const summary = {
      source_total: products.length,
      insert:
        rows.filter(
          (row) =>
            row.action === "INSERT"
        ).length,
      exists:
        rows.filter(
          (row) =>
            row.action === "EXISTS"
        ).length,
      discontinued_soon:
        rows.filter(
          (row) =>
            row.discontinued_soon
        ).length,
      vertical_use_only:
        rows.filter(
          (row) =>
            row.vertical_use_only
        ).length,
      source_duplicate_codes:
        duplicates.length,
    };

    await writeReports({
      rows,
      duplicates,
    });

    console.table(summary);

    console.log(
      `Reporte: ${path.join(
        REPORT_DIR,
        "stratificato_dry_run.csv"
      )}`
    );

    if (!APPLY) {
      console.log(
        "\nDRY-RUN: no se modificó la base de datos."
      );
      console.log(
        "Para aplicar: node scripts/import-stratificato.js --apply --confirm=STRATIFICATO --confirm-db=<BASE>"
      );
      return;
    }

    if (!CONFIRM) {
      throw new Error(
        "Para modificar la base debes agregar --confirm=STRATIFICATO"
      );
    }

    if (!CONFIRM_DB) {
      throw new Error(
        `Para modificar la base debes confirmar el destino con --confirm-db=${connectionInfo.database_name}`
      );
    }

    if (
      CONFIRM_DB !==
      connectionInfo.database_name
    ) {
      throw new Error(
        `Confirmación de base incorrecta. Conectado a "${connectionInfo.database_name}" pero recibí --confirm-db=${CONFIRM_DB}`
      );
    }

    await client.query("BEGIN");

    try {
      const result =
        await applyRows(
          client,
          rows
        );

      await client.query("COMMIT");

      const postImportInfo =
        await getConnectionInfo(
          client
        );

      console.log(
        "\nImportación confirmada."
      );
      console.log(result);

      console.log(
        `Stratificato total en "${postImportInfo.database_name}": ${postImportInfo.stratificato_count}`
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (client) {
      client.release();
    }

    if (pool) {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error("\nIMPORT ERROR");
  console.error({
    message: error?.message,
    code: error?.code,
    detail: error?.detail,
    constraint: error?.constraint,
  });
  process.exitCode = 1;
});
