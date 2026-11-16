import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const args = process.argv.slice(2);

const APPLY =
  args.includes("--apply");

const DB_INFO_ONLY =
  args.includes("--db-info");

const STORAGE_INFO_ONLY =
  args.includes("--storage-info");

const CONFIRM =
  args.includes(
    "--confirm=STRATIFICATO_IMAGES"
  );

const getArgValue = (prefix) => {
  const arg =
    args.find((item) =>
      item.startsWith(prefix)
    );

  if (!arg) {
    return null;
  }

  return arg.slice(prefix.length);
};

const CONFIRM_DB =
  getArgValue("--confirm-db=");

const ONLY_RAW =
  getArgValue("--only=");

const LIMIT_RAW =
  getArgValue("--limit=");

const ONLY_CODES =
  ONLY_RAW
    ? new Set(
        ONLY_RAW
          .split(",")
          .map((value) =>
            String(value).trim()
          )
          .filter(Boolean)
      )
    : null;

const LIMIT =
  LIMIT_RAW === null
    ? null
    : Number(LIMIT_RAW);

if (
  LIMIT !== null &&
  (
    !Number.isInteger(LIMIT) ||
    LIMIT < 1
  )
) {
  throw new Error(
    "--limit debe ser un entero mayor o igual a 1"
  );
}

const IMPORT_DATABASE_URL =
  process.env.IMPORT_DATABASE_URL || "";

const DISCOVERY_FILE =
  path.resolve(
    "tmp/stratificato-images/stratificato_image_discovery.json"
  );

const REPORT_DIR =
  path.resolve(
    "tmp/stratificato-images/import"
  );

const REPORT_JSON =
  path.join(
    REPORT_DIR,
    "stratificato_images_import_report.json"
  );

const REPORT_CSV =
  path.join(
    REPORT_DIR,
    "stratificato_images_import_report.csv"
  );

const APPROVED_REVIEW_URLS =
  new Map([
    [
      "414",
      "https://abetlaminati.com/CAMPIONI/414.jpg",
    ],
    [
      "416",
      "https://abetlaminati.com/CAMPIONI/416.jpg",
    ],
    [
      "475",
      "https://abetlaminati.com/CAMPIONI/475.jpg",
    ],
    [
      "604",
      "https://abetlaminati.com/CAMPIONI/604.jpg",
    ],
    [
      "880",
      "https://abetlaminati.com/CAMPIONI/880_LUCIDA.jpg",
    ],
    [
      "726",
      "https://abetlaminati.com/CAMPIONI/726_LUCIDA.jpg",
    ],
    [
      "881",
      "https://abetlaminati.com/CAMPIONI/881_LUCIDA.jpg",
    ],
    [
      "740",
      "https://abetlaminati.com/CAMPIONI/740_MORBIDA.jpg",
    ],
    [
      "265",
      "https://abetlaminati.com/CAMPIONI/265.jpg",
    ],
  ]);

const INTENTIONALLY_SKIPPED =
  new Map([
    [
      "461",
      "Playfield: la URL detectada corresponde a una imagen editorial; queda pendiente de una muestra oficial exacta.",
    ],
  ]);

const REQUIRED_STORAGE_VARS = [
  "RAILWAY_STORAGE_ENDPOINT",
  "RAILWAY_STORAGE_ACCESS_KEY_ID",
  "RAILWAY_STORAGE_SECRET_ACCESS_KEY",
  "RAILWAY_STORAGE_BUCKET",
];

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

const csvEscape = (value) => {
  const text =
    value === null ||
    value === undefined
      ? ""
      : String(value);

  if (
    /[",\n\r]/.test(text)
  ) {
    return `"${text.replaceAll(
      '"',
      '""'
    )}"`;
  }

  return text;
};

const writeReports = async (
  rows
) => {
  await fs.mkdir(
    REPORT_DIR,
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    REPORT_JSON,
    JSON.stringify(
      rows,
      null,
      2
    ),
    "utf8"
  );

  const headers = [
    "code",
    "sku",
    "name",
    "status",
    "reason",
    "source_url",
    "content_type",
    "bytes",
    "image_id",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) =>
          csvEscape(
            row[header]
          )
        )
        .join(",")
    ),
  ];

  await fs.writeFile(
    REPORT_CSV,
    lines.join("\n"),
    "utf8"
  );
};

const printStorageInfo =
  () => {
    const info = {};

    for (
      const variable
      of REQUIRED_STORAGE_VARS
    ) {
      info[variable] =
        process.env[variable]
          ? "OK"
          : "MISSING";
    }

    console.log(
      "\nVariables Railway Storage:"
    );

    console.table(info);

    const endpoint =
      process.env
        .RAILWAY_STORAGE_ENDPOINT;

    if (endpoint) {
      try {
        console.log(
          "Storage endpoint host:",
          new URL(
            endpoint
          ).host
        );
      } catch {
        console.log(
          "Storage endpoint:",
          "configurado"
        );
      }
    }

    if (
      process.env
        .RAILWAY_STORAGE_BUCKET
    ) {
      console.log(
        "Storage bucket:",
        process.env
          .RAILWAY_STORAGE_BUCKET
      );
    }
  };

const assertStorageEnv =
  () => {
    const missing =
      REQUIRED_STORAGE_VARS
        .filter(
          (name) =>
            !process.env[name]
        );

    if (
      missing.length > 0
    ) {
      throw new Error(
        `Faltan variables Railway Storage: ${missing.join(
          ", "
        )}`
      );
    }
  };

const createPool = () => {
  if (
    !IMPORT_DATABASE_URL
  ) {
    throw new Error(
      "Falta IMPORT_DATABASE_URL. Usa explícitamente la URL del túnel Railway."
    );
  }

  return new Pool({
    connectionString:
      IMPORT_DATABASE_URL,
  });
};

const getConnectionInfo =
  async (client) => {
    const result =
      await client.query(`
        SELECT
          current_database()
            AS database_name,
          current_user
            AS database_user,
          inet_server_addr()::text
            AS server_ip,
          inet_server_port()
            AS server_port,
          (
            SELECT COUNT(*)::int
            FROM products p
            JOIN project_product_families f
              ON f.id =
                p.project_family_id
            WHERE
              f.code =
                'STRATIFICATO'
          )
            AS stratificato_count,
          (
            SELECT COUNT(*)::int
            FROM product_images pi
            JOIN products p
              ON p.id =
                pi.product_id
            JOIN project_product_families f
              ON f.id =
                p.project_family_id
            WHERE
              f.code =
                'STRATIFICATO'
          )
            AS stratificato_images
      `);

    return result.rows[0];
  };

const printConnectionInfo =
  (info) => {
    console.log(
      "\nBase de datos conectada:"
    );

    console.table({
      database:
        info.database_name,
      user:
        info.database_user,
      server_ip:
        info.server_ip,
      server_port:
        info.server_port,
      stratificato_count:
        info.stratificato_count,
      stratificato_images:
        info.stratificato_images,
    });
  };

const loadDiscovery =
  async () => {
    const raw =
      await fs.readFile(
        DISCOVERY_FILE,
        "utf8"
      );

    const data =
      JSON.parse(raw);

    if (
      !Array.isArray(data)
    ) {
      throw new Error(
        "El JSON de descubrimiento no contiene un array"
      );
    }

    return data;
  };

const getApprovedSource =
  (item) => {
    const code =
      String(
        item.code || ""
      ).trim();

    if (
      INTENTIONALLY_SKIPPED
        .has(code)
    ) {
      return {
        ok: false,
        reason:
          INTENTIONALLY_SKIPPED
            .get(code),
      };
    }

    if (
      item.status ===
        "MATCH_REVIEW"
    ) {
      const approved =
        APPROVED_REVIEW_URLS
          .get(code);

      if (!approved) {
        return {
          ok: false,
          reason:
            "MATCH_REVIEW no aprobado explícitamente",
        };
      }

      return {
        ok: true,
        url: approved,
        approval:
          "MANUAL_REVIEW_APPROVED",
      };
    }

    if (
      item.status !==
        "MATCH_HIGH"
    ) {
      return {
        ok: false,
        reason:
          `Estado no automatizable: ${item.status}`,
      };
    }

    const selectedUrl =
      String(
        item.selected_url ||
        ""
      ).trim();

    if (!selectedUrl) {
      return {
        ok: false,
        reason:
          "MATCH_HIGH sin selected_url",
      };
    }

    return {
      ok: true,
      url: selectedUrl,
      approval:
        "MATCH_HIGH",
    };
  };

const loadProducts =
  async (client) => {
    const result =
      await client.query(`
        SELECT
          p.id,
          p.sku,
          p.internal_code,
          p.name,
          p.is_active,
          p.is_published,
          EXISTS (
            SELECT 1
            FROM product_images pi
            WHERE
              pi.product_id =
                p.id
          ) AS has_image
        FROM products p
        JOIN project_product_families f
          ON f.id =
            p.project_family_id
        WHERE
          f.code =
            'STRATIFICATO'
        ORDER BY
          p.sort_order ASC,
          p.created_at ASC
      `);

    return result.rows;
  };

const buildPlan =
  (
    discovery,
    products
  ) => {
    const discoveryByCode =
      new Map(
        discovery.map(
          (item) => [
            String(
              item.code || ""
            ).trim(),
            item,
          ]
        )
      );

    const plan = [];

    for (
      const product
      of products
    ) {
      const code =
        String(
          product.internal_code ||
          ""
        ).trim();

      if (
        ONLY_CODES &&
        !ONLY_CODES.has(code)
      ) {
        continue;
      }

      const item =
        discoveryByCode
          .get(code);

      if (!item) {
        plan.push({
          code,
          product,
          eligible: false,
          reason:
            "Código no presente en discovery JSON",
          source_url: null,
        });

        continue;
      }

      if (
        product.has_image
      ) {
        plan.push({
          code,
          product,
          eligible: false,
          reason:
            "El producto ya tiene una imagen",
          source_url:
            item.selected_url ||
            null,
          already_has_image:
            true,
        });

        continue;
      }

      const approved =
        getApprovedSource(
          item
        );

      plan.push({
        code,
        product,
        eligible:
          approved.ok,
        reason:
          approved.ok
            ? approved.approval
            : approved.reason,
        source_url:
          approved.url ||
          item.selected_url ||
          null,
      });
    }

    if (
      LIMIT !== null
    ) {
      let eligibleSeen = 0;

      return plan.filter(
        (item) => {
          if (
            !item.eligible
          ) {
            return true;
          }

          eligibleSeen += 1;

          return (
            eligibleSeen <= LIMIT
          );
        }
      );
    }

    return plan;
  };

const summarizePlan =
  (plan) => {
    const summary = {
      total_plan_rows:
        plan.length,
      upload:
        plan.filter(
          (item) =>
            item.eligible
        ).length,
      already_has_image:
        plan.filter(
          (item) =>
            item.already_has_image
        ).length,
      skipped:
        plan.filter(
          (item) =>
            !item.eligible &&
            !item
              .already_has_image
        ).length,
    };

    console.log(
      "\nPlan de imágenes:"
    );

    console.table(summary);

    const skipped =
      plan.filter(
        (item) =>
          !item.eligible &&
          !item
            .already_has_image
      );

    if (
      skipped.length > 0
    ) {
      console.log(
        "\nPendientes / omitidos:"
      );

      console.table(
        skipped.map(
          (item) => ({
            code:
              item.code,
            sku:
              item.product
                ?.sku ||
              "",
            reason:
              item.reason,
          })
        )
      );
    }

    return summary;
  };

const downloadImage =
  async (
    url,
    attempts = 3
  ) => {
    let lastError;

    for (
      let attempt = 1;
      attempt <= attempts;
      attempt += 1
    ) {
      const controller =
        new AbortController();

      const timer =
        setTimeout(
          () =>
            controller.abort(),
          30000
        );

      try {
        const response =
          await fetch(
            url,
            {
              redirect:
                "follow",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 Laminatiword-Stratificato-Importer/1.0",
                Accept:
                  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
              },
              signal:
                controller.signal,
            }
          );

        if (
          !response.ok
        ) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        const contentType =
          String(
            response.headers
              .get(
                "content-type"
              ) ||
            ""
          )
            .split(";")[0]
            .trim()
            .toLowerCase();

        if (
          !contentType
            .startsWith(
              "image/"
            )
        ) {
          throw new Error(
            `Content-Type no es imagen: ${contentType || "vacío"}`
          );
        }

        const arrayBuffer =
          await response
            .arrayBuffer();

        const buffer =
          Buffer.from(
            arrayBuffer
          );

        if (
          buffer.length < 500
        ) {
          throw new Error(
            `Imagen demasiado pequeña: ${buffer.length} bytes`
          );
        }

        if (
          buffer.length >
          25 * 1024 * 1024
        ) {
          throw new Error(
            `Imagen supera 25 MB: ${buffer.length} bytes`
          );
        }

        return {
          buffer,
          contentType,
          bytes:
            buffer.length,
        };
      } catch (error) {
        lastError =
          error;

        if (
          attempt < attempts
        ) {
          await sleep(
            750 * attempt
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  };

const getOriginalFilename =
  (url, code) => {
    try {
      const pathname =
        new URL(
          url
        ).pathname;

      const filename =
        decodeURIComponent(
          pathname
            .split("/")
            .filter(Boolean)
            .at(-1) ||
          ""
        );

      if (
        filename &&
        filename.length <= 255
      ) {
        return filename;
      }
    } catch {
      // continúa con fallback
    }

    return `stratificato-${code}.jpg`;
  };

const persistProductImage =
  async ({
    pool,
    product,
    code,
    sourceUrl,
    storageResult,
    imageId,
  }) => {
    const client =
      await pool.connect();

    const uploadedKeys = [
      storageResult
        ?.variants
        ?.thumbnail
        ?.key,
      storageResult
        ?.variants
        ?.card
        ?.key,
      storageResult
        ?.variants
        ?.detail
        ?.key,
    ].filter(Boolean);

    try {
      await client.query(
        "BEGIN"
      );

      const locked =
        await client.query(
          `
            SELECT
              p.id,
              p.sku,
              p.name
            FROM products p
            JOIN project_product_families f
              ON f.id =
                p.project_family_id
            WHERE
              p.id = $1
              AND f.code =
                'STRATIFICATO'
            LIMIT 1
            FOR UPDATE
          `,
          [product.id]
        );

      if (
        locked.rowCount === 0
      ) {
        throw new Error(
          "Producto Stratificato no encontrado durante persistencia"
        );
      }

      const existing =
        await client.query(
          `
            SELECT id
            FROM product_images
            WHERE product_id = $1
            LIMIT 1
          `,
          [product.id]
        );

      if (
        existing.rowCount > 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return {
          inserted: false,
          alreadyExists:
            true,
        };
      }

      const altText =
        `Stratificato ${code} ${product.name} - Abet Laminati`
          .slice(
            0,
            255
          );

      const originalFilename =
        getOriginalFilename(
          sourceUrl,
          code
        );

      const result =
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
              TRUE,
              0,
              'RAILWAY',
              'gallery',
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10
            )
            RETURNING id
          `,
          [
            imageId,
            product.id,
            altText,
            storageResult
              .variants
              .thumbnail
              .key,
            storageResult
              .variants
              .card
              .key,
            storageResult
              .variants
              .detail
              .key,
            originalFilename,
            storageResult
              .source
              .width,
            storageResult
              .source
              .height,
            storageResult
              .source
              .bytes,
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        inserted: true,
        imageId:
          result.rows[0].id,
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // ignorar rollback secundario
      }

      error.uploadedKeys =
        uploadedKeys;

      throw error;
    } finally {
      client.release();
    }
  };

const main =
  async () => {
    if (
      STORAGE_INFO_ONLY
    ) {
      printStorageInfo();

      console.log(
        "\nSTORAGE-INFO: no se descargó ni subió ninguna imagen."
      );

      return;
    }

    const pool =
      createPool();

    let client;

    try {
      client =
        await pool.connect();

      const connectionInfo =
        await getConnectionInfo(
          client
        );

      printConnectionInfo(
        connectionInfo
      );

      if (
        DB_INFO_ONLY
      ) {
        console.log(
          "\nDB-INFO: no se descargó ni subió ninguna imagen."
        );

        return;
      }

      const discovery =
        await loadDiscovery();

      const products =
        await loadProducts(
          client
        );

      const plan =
        buildPlan(
          discovery,
          products
        );

      const summary =
        summarizePlan(plan);

      console.log(
        "\nDiscovery:",
        DISCOVERY_FILE
      );

      if (!APPLY) {
        console.log(
          "\nDRY-RUN: no se descargó, no se subió y no se modificó PostgreSQL."
        );

        console.log(
          `Para prueba real controlada: node scripts/import-stratificato-images.js --apply --limit=3 --confirm=STRATIFICATO_IMAGES --confirm-db=${connectionInfo.database_name}`
        );

        return;
      }

      if (!CONFIRM) {
        throw new Error(
          "Para subir imágenes debes agregar --confirm=STRATIFICATO_IMAGES"
        );
      }

      if (!CONFIRM_DB) {
        throw new Error(
          `Debes confirmar la base con --confirm-db=${connectionInfo.database_name}`
        );
      }

      if (
        CONFIRM_DB !==
        connectionInfo.database_name
      ) {
        throw new Error(
          `Confirmación incorrecta: conectado a "${connectionInfo.database_name}" pero recibí --confirm-db=${CONFIRM_DB}`
        );
      }

      assertStorageEnv();

      const {
        uploadProductImage,
        deleteProductImageVariants,
      } =
        await import(
          "../src/services/productImageStorage.service.js"
        );

      const results = [];

      let current = 0;
      const toUpload =
        plan.filter(
          (item) =>
            item.eligible
        );

      for (
        const item
        of plan
      ) {
        const {
          code,
          product,
          source_url:
            sourceUrl,
        } = item;

        if (
          item
            .already_has_image
        ) {
          results.push({
            code,
            sku:
              product.sku,
            name:
              product.name,
            status:
              "SKIPPED_EXISTING",
            reason:
              item.reason,
            source_url:
              sourceUrl,
            content_type:
              null,
            bytes:
              null,
            image_id:
              null,
          });

          continue;
        }

        if (
          !item.eligible
        ) {
          results.push({
            code,
            sku:
              product?.sku ||
              "",
            name:
              product?.name ||
              "",
            status:
              "SKIPPED",
            reason:
              item.reason,
            source_url:
              sourceUrl,
            content_type:
              null,
            bytes:
              null,
            image_id:
              null,
          });

          continue;
        }

        current += 1;

        console.log(
          `\n[${current}/${toUpload.length}] ${product.sku} · ${product.name}`
        );

        let download;

        try {
          download =
            await downloadImage(
              sourceUrl
            );

          console.log(
            `  descarga OK · ${download.contentType} · ${download.bytes} bytes`
          );
        } catch (error) {
          console.error(
            "  descarga ERROR:",
            error.message
          );

          results.push({
            code,
            sku:
              product.sku,
            name:
              product.name,
            status:
              "DOWNLOAD_ERROR",
            reason:
              error.message,
            source_url:
              sourceUrl,
            content_type:
              null,
            bytes:
              null,
            image_id:
              null,
          });

          continue;
        }

        const imageId =
          randomUUID();

        let storageResult;

        try {
          storageResult =
            await uploadProductImage({
              buffer:
                download.buffer,
              sku:
                product.sku,
              imageType:
                "gallery",
              imageId,
            });

          console.log(
            "  Railway Storage OK"
          );
        } catch (error) {
          console.error(
            "  storage ERROR:",
            error.message
          );

          results.push({
            code,
            sku:
              product.sku,
            name:
              product.name,
            status:
              "STORAGE_ERROR",
            reason:
              error.message,
            source_url:
              sourceUrl,
            content_type:
              download
                .contentType,
            bytes:
              download.bytes,
            image_id:
              null,
          });

          break;
        }

        try {
          const persisted =
            await persistProductImage({
              pool,
              product,
              code,
              sourceUrl,
              storageResult,
              imageId,
            });

          if (
            persisted
              .alreadyExists
          ) {
            const keys = [
              storageResult
                ?.variants
                ?.thumbnail
                ?.key,
              storageResult
                ?.variants
                ?.card
                ?.key,
              storageResult
                ?.variants
                ?.detail
                ?.key,
            ].filter(Boolean);

            if (
              keys.length > 0
            ) {
              await deleteProductImageVariants(
                keys
              );
            }

            results.push({
              code,
              sku:
                product.sku,
              name:
                product.name,
              status:
                "SKIPPED_EXISTING",
              reason:
                "Imagen creada concurrentemente; objetos recién subidos fueron limpiados",
              source_url:
                sourceUrl,
              content_type:
                download
                  .contentType,
              bytes:
                download
                  .bytes,
              image_id:
                null,
            });

            continue;
          }

          console.log(
            "  PostgreSQL OK"
          );

          results.push({
            code,
            sku:
              product.sku,
            name:
              product.name,
            status:
              "IMPORTED",
            reason:
              item.reason,
            source_url:
              sourceUrl,
            content_type:
              download
                .contentType,
            bytes:
              download.bytes,
            image_id:
              persisted
                .imageId,
          });
        } catch (error) {
          console.error(
            "  PostgreSQL ERROR:",
            error.message
          );

          const keys =
            error.uploadedKeys ||
            [];

          if (
            keys.length > 0
          ) {
            try {
              await deleteProductImageVariants(
                keys
              );

              console.log(
                "  limpieza Storage OK"
              );
            } catch (
              cleanupError
            ) {
              console.error(
                "  limpieza Storage ERROR:",
                cleanupError
                  .message
              );
            }
          }

          results.push({
            code,
            sku:
              product.sku,
            name:
              product.name,
            status:
              "DB_ERROR",
            reason:
              error.message,
            source_url:
              sourceUrl,
            content_type:
              download
                .contentType,
            bytes:
              download.bytes,
            image_id:
              null,
          });

          break;
        }

        await sleep(150);
      }

      await writeReports(
        results
      );

      const finalInfo =
        await getConnectionInfo(
          client
        );

      const resultSummary = {
        imported:
          results.filter(
            (row) =>
              row.status ===
                "IMPORTED"
          ).length,
        skipped_existing:
          results.filter(
            (row) =>
              row.status ===
                "SKIPPED_EXISTING"
          ).length,
        skipped:
          results.filter(
            (row) =>
              row.status ===
                "SKIPPED"
          ).length,
        download_error:
          results.filter(
            (row) =>
              row.status ===
                "DOWNLOAD_ERROR"
          ).length,
        storage_error:
          results.filter(
            (row) =>
              row.status ===
                "STORAGE_ERROR"
          ).length,
        db_error:
          results.filter(
            (row) =>
              row.status ===
                "DB_ERROR"
          ).length,
      };

      console.log(
        "\nResultado:"
      );

      console.table(
        resultSummary
      );

      console.log(
        `Stratificato imágenes en "${finalInfo.database_name}": ${finalInfo.stratificato_images}`
      );

      console.log(
        "JSON:",
        REPORT_JSON
      );

      console.log(
        "CSV: ",
        REPORT_CSV
      );
    } finally {
      if (client) {
        client.release();
      }

      await pool.end();
    }
  };

main().catch(
  (error) => {
    console.error(
      "\nIMPORT ERROR"
    );

    console.error({
      message:
        error.message,
      code:
        error.code,
      detail:
        error.detail,
      constraint:
        error.constraint,
    });

    process.exitCode = 1;
  }
);
