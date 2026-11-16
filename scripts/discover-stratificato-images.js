import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://abetlaminati.com/es/abet-collection/";

const REPORT_DIR = path.resolve(
  process.cwd(),
  "tmp",
  "stratificato-images"
);

const PRODUCTS_JSON = path.resolve(
  process.cwd(),
  "tmp",
  "stratificato-import",
  "stratificato_source.json"
);

const args = process.argv.slice(2);

const sourceFileArg = args.find((arg) =>
  arg.startsWith("--source-file=")
);

const SOURCE_FILE = sourceFileArg
  ? path.resolve(
      process.cwd(),
      sourceFileArg.slice(
        "--source-file=".length
      )
    )
  : null;

const htmlOutArg = args.find((arg) =>
  arg.startsWith("--save-html=")
);

const HTML_OUT = htmlOutArg
  ? path.resolve(
      process.cwd(),
      htmlOutArg.slice(
        "--save-html=".length
      )
    )
  : null;

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function stripTags(value = "") {
  return decodeHtml(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value = "") {
  return decodeHtml(String(value))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag, name) {
  const patterns = [
    new RegExp(
      `\\b${name}\\s*=\\s*"([^"]*)"`,
      "i"
    ),
    new RegExp(
      `\\b${name}\\s*=\\s*'([^']*)'`,
      "i"
    ),
    new RegExp(
      `\\b${name}\\s*=\\s*([^\\s>]+)`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = String(tag).match(pattern);
    if (match) return decodeHtml(match[1]);
  }

  return "";
}

function absolutize(url) {
  const raw = decodeHtml(
    String(url || "").trim()
  );

  if (!raw) return "";

  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }

  try {
    return new URL(
      raw,
      SOURCE_URL
    ).toString();
  } catch {
    return "";
  }
}

function chooseSrcFromSrcset(srcset = "") {
  const candidates = String(srcset)
    .split(",")
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const url = bits[0] || "";
      const descriptor = bits[1] || "";
      const scoreMatch =
        descriptor.match(/^(\d+)(?:w|x)$/i);

      return {
        url,
        score: scoreMatch
          ? Number(scoreMatch[1])
          : 0,
      };
    })
    .filter((item) => item.url);

  candidates.sort(
    (a, b) => b.score - a.score
  );

  return candidates[0]?.url || "";
}

function extractImgTags(html) {
  const tags =
    String(html).match(/<img\b[^>]*>/gi) || [];

  return tags
    .map((tag, index) => {
      const srcset =
        attr(tag, "srcset") ||
        attr(tag, "data-srcset");

      const source =
        attr(tag, "data-full") ||
        attr(tag, "data-large-file") ||
        attr(tag, "data-orig-file") ||
        chooseSrcFromSrcset(srcset) ||
        attr(tag, "data-lazy-src") ||
        attr(tag, "data-src") ||
        attr(tag, "src");

      return {
        index,
        url: absolutize(source),
        alt: attr(tag, "alt"),
        title: attr(tag, "title"),
        className: attr(tag, "class"),
        raw: tag,
      };
    })
    .filter((item) =>
      /^https?:\/\//i.test(item.url)
    );
}

function extractImageUrlsFromText(text) {
  const urls = new Set();

  const rawMatches =
    String(text).match(
      /https?:\\?\/\\?\/[^"'<>\\\s)]+/gi
    ) || [];

  for (let candidate of rawMatches) {
    candidate = candidate
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/[),.;]+$/g, "");

    if (
      /\.(?:jpe?g|png|webp|avif)(?:\?.*)?$/i.test(
        candidate
      ) ||
      /wp-content\/uploads/i.test(candidate)
    ) {
      urls.add(candidate);
    }
  }

  return [...urls];
}

function isLikelyDecorImage(url) {
  const value = String(url || "").toLowerCase();

  if (!value) return false;

  if (
    /logo|icon|favicon|sprite|placeholder|avatar|loader|spinner|flag|social|newsletter|google|analytics/.test(
      value
    )
  ) {
    return false;
  }

  return (
    /wp-content\/uploads/.test(value) ||
    /\.(?:jpe?g|png|webp|avif)(?:\?.*)?$/.test(
      value
    )
  );
}

async function loadProducts() {
  const raw = await fs.readFile(
    PRODUCTS_JSON,
    "utf8"
  );

  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Formato inesperado en ${PRODUCTS_JSON}`
    );
  }

  const rows = parsed
    .map((item) => ({
      code: String(
        item.source_code ||
          item.internal_code ||
          ""
      ).trim(),
      name: String(item.name || "").trim(),
      sku: String(item.sku || "").trim(),
    }))
    .filter((item) =>
      /^\d{3,4}$/.test(item.code)
    );

  const unique = new Map();

  for (const row of rows) {
    if (!unique.has(row.code)) {
      unique.set(row.code, row);
    }
  }

  return [...unique.values()];
}

async function loadHtml() {
  if (SOURCE_FILE) {
    return fs.readFile(
      SOURCE_FILE,
      "utf8"
    );
  }

  const response = await fetch(
    SOURCE_URL,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 Laminatiword-Stratificato-Image-Discovery/1.0",
        accept:
          "text/html,application/xhtml+xml",
        "accept-language":
          "es-CL,es;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    }
  );

  if (!response.ok) {
    throw new Error(
      `Abet respondió HTTP ${response.status}`
    );
  }

  return response.text();
}

function scoreImageForProduct(
  image,
  product
) {
  const haystack = normalize(
    [
      image.alt,
      image.title,
      image.url,
      image.className,
    ].join(" ")
  );

  const code = normalize(product.code);
  const name = normalize(product.name);

  let score = 0;

  if (
    new RegExp(
      `(^| )${code}( |$)`
    ).test(haystack)
  ) {
    score += 100;
  }

  if (
    name &&
    haystack.includes(name)
  ) {
    score += 70;
  }

  const nameWords =
    name
      .split(" ")
      .filter((word) => word.length >= 4);

  const matchedWords =
    nameWords.filter((word) =>
      haystack.includes(word)
    ).length;

  score += matchedWords * 8;

  if (
    /decori|decor|laminat|abet/.test(
      haystack
    )
  ) {
    score += 5;
  }

  if (
    /thumb|thumbnail|150x|300x300|icon/.test(
      haystack
    )
  ) {
    score -= 20;
  }

  return score;
}

function discoverFromImgTags(
  products,
  images
) {
  const results = [];

  for (const product of products) {
    const ranked = images
      .filter((image) =>
        isLikelyDecorImage(image.url)
      )
      .map((image) => ({
        ...image,
        score: scoreImageForProduct(
          image,
          product
        ),
      }))
      .filter((image) => image.score > 0)
      .sort((a, b) =>
        b.score - a.score
      );

    results.push({
      ...product,
      candidates: ranked.slice(0, 5),
    });
  }

  return results;
}

function discoverFromNeighborhood(
  html,
  product
) {
  const codePattern =
    new RegExp(
      `(?:>|\\s|["'])${product.code}(?:<|\\s|["'])`,
      "gi"
    );

  const urls = new Set();
  let match;

  while (
    (match = codePattern.exec(html))
  ) {
    const from = Math.max(
      0,
      match.index - 3500
    );

    const to = Math.min(
      html.length,
      match.index + 5000
    );

    const block =
      html.slice(from, to);

    for (
      const url
      of extractImageUrlsFromText(block)
    ) {
      if (isLikelyDecorImage(url)) {
        urls.add(url);
      }
    }

    if (urls.size >= 10) break;
  }

  return [...urls].slice(0, 10);
}

function pickBest({
  tagCandidates,
  neighborhoodUrls,
  product,
}) {
  const candidates = [];

  for (const item of tagCandidates) {
    candidates.push({
      url: item.url,
      score: item.score,
      source: "IMG_TAG",
      alt: item.alt || "",
      title: item.title || "",
    });
  }

  for (const url of neighborhoodUrls) {
    const synthetic = {
      url,
      alt: "",
      title: "",
      className: "",
    };

    let score =
      scoreImageForProduct(
        synthetic,
        product
      );

    if (
      new RegExp(
        `(?:^|[^0-9])${product.code}(?:[^0-9]|$)`
      ).test(
        decodeURIComponent(url)
      )
    ) {
      score += 70;
    }

    candidates.push({
      url,
      score,
      source: "HTML_NEIGHBORHOOD",
      alt: "",
      title: "",
    });
  }

  const byUrl = new Map();

  for (const item of candidates) {
    const previous =
      byUrl.get(item.url);

    if (
      !previous ||
      item.score > previous.score
    ) {
      byUrl.set(item.url, item);
    }
  }

  const ranked = [...byUrl.values()]
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
    );

  const first = ranked[0] || null;
  const second = ranked[1] || null;

  let status = "NOT_FOUND";

  if (first) {
    const gap =
      first.score -
      (second?.score || 0);

    if (
      first.score >= 100 &&
      gap >= 20
    ) {
      status = "MATCH_HIGH";
    } else if (
      first.score >= 70
    ) {
      status = "MATCH_REVIEW";
    } else {
      status = "MATCH_LOW";
    }
  }

  return {
    status,
    selected_url:
      first?.url || "",
    selected_score:
      first?.score || 0,
    selected_source:
      first?.source || "",
    selected_alt:
      first?.alt || "",
    candidates:
      ranked.slice(0, 5),
  };
}

function csvEscape(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function main() {
  console.log(
    "Descubrimiento de imágenes Stratificato"
  );

  const products =
    await loadProducts();

  console.log(
    `Productos de referencia: ${products.length}`
  );

  if (products.length !== 655) {
    throw new Error(
      `Se esperaban 655 productos y se encontraron ${products.length}.`
    );
  }

  const html =
    await loadHtml();

  if (HTML_OUT) {
    await fs.writeFile(
      HTML_OUT,
      html,
      "utf8"
    );

    console.log(
      `HTML guardado: ${HTML_OUT}`
    );
  }

  console.log(
    `HTML descargado: ${html.length.toLocaleString("es-CL")} caracteres`
  );

  const images =
    extractImgTags(html);

  console.log(
    `Etiquetas <img> detectadas: ${images.length}`
  );

  const tagResults =
    discoverFromImgTags(
      products,
      images
    );

  const finalRows = [];

  for (
    let i = 0;
    i < products.length;
    i += 1
  ) {
    const product =
      products[i];

    const neighborhoodUrls =
      discoverFromNeighborhood(
        html,
        product
      );

    const picked =
      pickBest({
        tagCandidates:
          tagResults[i].candidates,
        neighborhoodUrls,
        product,
      });

    finalRows.push({
      ...product,
      ...picked,
    });
  }

  const counts =
    finalRows.reduce(
      (acc, row) => {
        acc[row.status] =
          (acc[row.status] || 0) + 1;
        return acc;
      },
      {}
    );

  console.table({
    total: finalRows.length,
    high:
      counts.MATCH_HIGH || 0,
    review:
      counts.MATCH_REVIEW || 0,
    low:
      counts.MATCH_LOW || 0,
    not_found:
      counts.NOT_FOUND || 0,
  });

  await fs.mkdir(
    REPORT_DIR,
    { recursive: true }
  );

  const jsonPath =
    path.join(
      REPORT_DIR,
      "stratificato_image_discovery.json"
    );

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      finalRows,
      null,
      2
    ),
    "utf8"
  );

  const csvPath =
    path.join(
      REPORT_DIR,
      "stratificato_image_discovery.csv"
    );

  const columns = [
    "status",
    "code",
    "sku",
    "name",
    "selected_score",
    "selected_source",
    "selected_url",
    "selected_alt",
  ];

  const csv = [
    columns.join(","),
    ...finalRows.map((row) =>
      columns
        .map((column) =>
          csvEscape(row[column])
        )
        .join(",")
    ),
  ].join("\n");

  await fs.writeFile(
    csvPath,
    csv,
    "utf8"
  );

  console.log(
    `JSON: ${jsonPath}`
  );

  console.log(
    `CSV:  ${csvPath}`
  );

  console.log(
    "\nIMPORTANTE: este script NO modifica PostgreSQL ni Railway Storage."
  );
}

main().catch((error) => {
  console.error(
    "\nDISCOVERY ERROR"
  );

  console.error({
    message: error?.message,
    code: error?.code,
  });

  process.exitCode = 1;
});
