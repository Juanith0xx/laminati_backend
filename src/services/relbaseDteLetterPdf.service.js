import PDFDocument from "pdfkit";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

import pool from "../config/database.js";

const ABET_LAMINATI_LOGO_PATH =
  fileURLToPath(
    new URL(
      "../assets/abet-laminati-imp.png",
      import.meta.url
    )
  );

/* =========================================
   TIPOGRAFÍA / TEMA FACTURA A4
========================================= */

const resolveExistingFontPath = (
  relativePaths
) => {
  for (
    const relativePath of
    relativePaths
  ) {
    const resolvedPath =
      fileURLToPath(
        new URL(
          relativePath,
          import.meta.url
        )
      );

    if (
      existsSync(
        resolvedPath
      )
    ) {
      return resolvedPath;
    }
  }

  return null;
};

/*
 * PDFKit/fontkit en Node 24 puede fallar al procesar
 * algunos WOFF2 con:
 *
 * "Offset is outside the bounds of the DataView"
 *
 * Por eso el PDF tributario utiliza Poppins en TTF/OTF.
 * Si los archivos todavía no existen, el documento usa
 * temporalmente Helvetica sin romper la vista.
 */
const POPPINS_REGULAR_PATH =
  resolveExistingFontPath([
    "../assets/fonts/Poppins-Regular.ttf",
    "../assets/fonts/Poppins-Regular.otf",
  ]);

const POPPINS_MEDIUM_PATH =
  resolveExistingFontPath([
    "../assets/fonts/Poppins-Medium.ttf",
    "../assets/fonts/Poppins-Medium.otf",
  ]);

const POPPINS_SEMIBOLD_PATH =
  resolveExistingFontPath([
    "../assets/fonts/Poppins-SemiBold.ttf",
    "../assets/fonts/Poppins-SemiBold.otf",
  ]);

const POPPINS_BOLD_PATH =
  resolveExistingFontPath([
    "../assets/fonts/Poppins-Bold.ttf",
    "../assets/fonts/Poppins-Bold.otf",
  ]);

const HAS_POPPINS =
  Boolean(
    POPPINS_REGULAR_PATH &&
    POPPINS_MEDIUM_PATH &&
    POPPINS_SEMIBOLD_PATH &&
    POPPINS_BOLD_PATH
  );

const FONT_REGULAR =
  HAS_POPPINS
    ? "Poppins"
    : "Helvetica";

const FONT_MEDIUM =
  HAS_POPPINS
    ? "Poppins-Medium"
    : "Helvetica";

const FONT_SEMIBOLD =
  HAS_POPPINS
    ? "Poppins-SemiBold"
    : "Helvetica-Bold";

const FONT_BOLD =
  HAS_POPPINS
    ? "Poppins-Bold"
    : "Helvetica-Bold";

const BRAND_DARK = "#171717";
const BRAND_MUTED = "#6B7280";
const BRAND_BORDER = "#D9D9D9";
const TABLE_HEADER_BG = "#171717";
const TABLE_HEADER_TEXT = "#FFFFFF";

const registerPoppinsFonts = (
  doc
) => {
  if (
    !HAS_POPPINS
  ) {
    return false;
  }

  doc.registerFont(
    "Poppins",
    POPPINS_REGULAR_PATH
  );

  doc.registerFont(
    "Poppins-Medium",
    POPPINS_MEDIUM_PATH
  );

  doc.registerFont(
    "Poppins-SemiBold",
    POPPINS_SEMIBOLD_PATH
  );

  doc.registerFont(
    "Poppins-Bold",
    POPPINS_BOLD_PATH
  );

  return true;
};


const cleanText = (value) =>
  String(
    value ??
      ""
  ).trim();

const normalizeLine = (value) =>
  cleanText(value)
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const splitLines = (value) =>
  String(
    value ??
      ""
  )
    .replace(/\r/g, "")
    .split("\n")
    .map((line) =>
      line.trim()
    )
    .filter(Boolean);

const normalizeKey = (value) =>
  cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const parseLabeledBlock = (value) => {
  const result = {};

  for (
    const line of
    splitLines(value)
  ) {
    const index =
      line.indexOf(":");

    if (index <= 0) {
      continue;
    }

    const key =
      normalizeKey(
        line.slice(
          0,
          index
        )
      );

    const parsedValue =
      cleanText(
        line.slice(
          index + 1
        )
      );

    if (
      key &&
      parsedValue
    ) {
      result[key] =
        parsedValue;
    }
  }

  return result;
};

const parseChileanNumber = (value) => {
  const raw =
    cleanText(value)
      .replace(/\$/g, "")
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(",", ".");

  const number =
    Number(raw);

  return Number.isFinite(
    number
  )
    ? number
    : null;
};

const formatClp = (value) => {
  const number =
    Number(value);

  return new Intl.NumberFormat(
    "es-CL",
    {
      style:
        "currency",
      currency:
        "CLP",
      maximumFractionDigits:
        0,
    }
  ).format(
    Number.isFinite(
      number
    )
      ? Math.round(
          number
        )
      : 0
  );
};

const formatNumber = (
  value,
  maximumFractionDigits = 3
) => {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return "—";
  }

  return new Intl.NumberFormat(
    "es-CL",
    {
      minimumFractionDigits:
        0,
      maximumFractionDigits,
    }
  ).format(number);
};

const parseHeader = (
  printData
) => {
  const lines =
    splitLines(
      printData
        ?.print_header_v2 ||
      printData
        ?.print_header
    );

  const rutLine =
    lines.find(
      (line) =>
        /^R\.?U\.?T/i.test(
          line
        )
    ) ||
    "";

  const documentLine =
    lines.find(
      (line) =>
        /ELECTR[ÓO]NICA/i.test(
          line
        )
    ) ||
    "";

  const folioLine =
    lines.find(
      (line) =>
        /^Nro\b/i.test(
          line
        )
    ) ||
    "";

  const siiLine =
    lines.find(
      (line) =>
        /^S\.?I\.?I/i.test(
          line
        )
    ) ||
    "";

  return {
    issuerRut:
      cleanText(
        rutLine
          .replace(
            /^R\.?U\.?T\s*:?\s*/i,
            ""
          )
      ),
    documentName:
      cleanText(
        documentLine
      ),
    folio:
      cleanText(
        folioLine
          .replace(
            /^Nro\s*/i,
            ""
          )
      ),
    siiOffice:
      cleanText(
        siiLine
      ),
  };
};

const parseCompany = (
  printData
) => {
  const lines =
    splitLines(
      printData
        ?.print_company_v2 ||
      (
        Array.isArray(
          printData
            ?.print_content
        )
          ? printData
              .print_content[0]
          : ""
      )
    )
      .map((line) =>
        line
          .replace(
            /\[.\]/g,
            ""
          )
          .replace(
            /<\/?b>/gi,
            ""
          )
          .replace(
            /^_+$/,
            ""
          )
          .trim()
      )
      .filter(Boolean);

  return {
    name:
      lines[0] ||
      "LAMINATI CHILE SPA",
    address:
      lines[1] ||
      "",
    branch:
      lines[2] ||
      "",
  };
};

const parseExternalProducts = (
  printData
) => {
  const values =
    Array.isArray(
      printData
        ?.print_products_v2
    )
      ? printData
          .print_products_v2
      : [];

  const products = [];

  let current =
    null;

  for (
    const raw of
    values
  ) {
    const line =
      normalizeLine(
        raw
      );

    if (
      !line ||
      /^_+$/.test(
        line
      )
    ) {
      continue;
    }

    const priceMatch =
      line.match(
        /^(.+?)\s+x\s+\$([\d.]+(?:,\d+)?)\s+c\/u\s+\$([\d.]+(?:,\d+)?)$/i
      );

    if (
      priceMatch &&
      current
    ) {
      current.quantity =
        parseChileanNumber(
          priceMatch[1]
        );

      current.unitPrice =
        parseChileanNumber(
          priceMatch[2]
        );

      current.subtotal =
        parseChileanNumber(
          priceMatch[3]
        );

      continue;
    }

    const discountMatch =
      line.match(
        /^Descuento\s+([\d.,]+)%\s*:\s*-\s*\$?([\d.]+(?:,\d+)?)$/i
      );

    if (
      discountMatch &&
      current
    ) {
      current.discountPct =
        parseChileanNumber(
          discountMatch[1]
        );

      current.discountAmount =
        parseChileanNumber(
          discountMatch[2]
        );

      continue;
    }

    current = {
      relbaseName:
        line,
      quantity:
        null,
      unitPrice:
        null,
      subtotal:
        null,
      discountPct:
        0,
      discountAmount:
        0,
    };

    products.push(
      current
    );
  }

  return products;
};

const resolvePrintData = (
  printPayload
) => {
  const candidate =
    printPayload
      ?.data &&
    typeof printPayload
      .data ===
      "object" &&
    !Array.isArray(
      printPayload.data
    )
      ? printPayload.data
      : printPayload;

  if (
    !candidate ||
    typeof candidate !==
      "object" ||
    Array.isArray(
      candidate
    )
  ) {
    const error =
      new Error(
        "Relbase no entregó un contrato de impresión DTE utilizable"
      );

    error.code =
      "RELBASE_DTE_PRINT_PAYLOAD_INVALID";

    error.status =
      502;

    throw error;
  }

  return candidate;
};

const loadLocalItems =
  async (
    taxDocumentId
  ) => {
    const result =
      await pool.query(
        `
          SELECT
            id,
            product_code,
            sku,
            description,
            detail_description,
            quantity,
            unit_price,
            discount_amount,
            tax_rate,
            net_amount,
            exempt_amount,
            tax_amount,
            total_amount,
            created_at
          FROM tax_document_items
          WHERE tax_document_id = $1
          ORDER BY
            created_at ASC,
            id ASC
        `,
        [
          taxDocumentId,
        ]
      );

    return (
      result.rows ||
      []
    );
  };

const matchLocalItems = ({
  externalProducts,
  localItems,
}) => {
  const available =
    localItems.map(
      (
        item,
        index
      ) => ({
        item,
        index,
        used:
          false,
      })
    );

  return externalProducts.map(
    (
      external,
      externalIndex
    ) => {
      const matched =
        available.find(
          (entry) => {
            if (
              entry.used
            ) {
              return false;
            }

            const localQuantity =
              Number(
                entry.item
                  .quantity
              );

            const localUnitPrice =
              Number(
                entry.item
                  .unit_price
              );

            const quantityMatches =
              Number.isFinite(
                external
                  .quantity
              ) &&
              Number.isFinite(
                localQuantity
              ) &&
              Math.abs(
                localQuantity -
                external.quantity
              ) <=
                0.001;

            const priceMatches =
              Number.isFinite(
                external
                  .unitPrice
              ) &&
              Number.isFinite(
                localUnitPrice
              ) &&
              Math.abs(
                Math.round(
                  localUnitPrice
                ) -
                Math.round(
                  external
                    .unitPrice
                )
              ) <=
                1;

            return (
              quantityMatches &&
              priceMatches
            );
          }
        ) ||
        available.find(
          (entry) =>
            !entry.used &&
            entry.index ===
              externalIndex
        ) ||
        available.find(
          (entry) =>
            !entry.used
        ) ||
        null;

      if (
        matched
      ) {
        matched.used =
          true;
      }

      const local =
        matched
          ?.item ||
        null;

      const subtotal =
        Number.isFinite(
          external
            .subtotal
        )
          ? external.subtotal
          : (
              Number(
                local
                  ?.unit_price
              ) *
              Number(
                local
                  ?.quantity
              )
            );

      const discountAmount =
        Number.isFinite(
          external
            .discountAmount
        )
          ? external
              .discountAmount
          : Number(
              local
                ?.discount_amount ||
              0
            );

      const lineValue =
        Number.isFinite(
          subtotal
        )
          ? subtotal -
            (
              Number.isFinite(
                discountAmount
              )
                ? discountAmount
                : 0
            )
          : Number(
              local
                ?.net_amount ||
              0
            );

      const taxRate =
        Number(
          local
            ?.tax_rate ||
          0
        );

      return {
        code:
          cleanText(
            local
              ?.product_code ||
            local
              ?.sku
          ) ||
          "—",
        description:
          cleanText(
            local
              ?.description
          ) ||
          cleanText(
            local
              ?.detail_description
          ) ||
          external
            .relbaseName ||
          "—",
        quantity:
          Number.isFinite(
            external
              .quantity
          )
            ? external
                .quantity
            : Number(
                local
                  ?.quantity ||
                0
              ),
        unitPrice:
          Number.isFinite(
            external
              .unitPrice
          )
            ? external
                .unitPrice
            : Number(
                local
                  ?.unit_price ||
                0
              ),
        discountPct:
          Number.isFinite(
            external
              .discountPct
          )
            ? external
                .discountPct
            : (
                subtotal >
                0
                  ? (
                      discountAmount /
                      subtotal
                    ) *
                    100
                  : 0
              ),
        lineValue,
        affectation:
          taxRate >
          0
            ? "AFECTO"
            : "EXENTO",
      };
    }
  );
};

const drawLogo = ({
  doc,
  x,
  y,
  width,
}) => {
  if (
    existsSync(
      ABET_LAMINATI_LOGO_PATH
    )
  ) {
    doc.image(
      ABET_LAMINATI_LOGO_PATH,
      x,
      y,
      {
        width,
      }
    );

    return;
  }

  doc
    .font(
      FONT_SEMIBOLD
    )
    .fontSize(
      19
    )
    .fillColor(
      "#111111"
    )
    .text(
      "LAMINATI",
      x,
      y
    );
};

const drawInfoPair = ({
  doc,
  label,
  value,
  labelX,
  valueX,
  y,
  valueWidth,
}) => {
  doc
    .font(
      FONT_REGULAR
    )
    .fontSize(
      7
    )
    .fillColor(
      BRAND_MUTED
    )
    .text(
      `${label}:`,
      labelX,
      y,
      {
        width:
          valueX -
          labelX -
          5,
      }
    );

  doc
    .font(
      FONT_MEDIUM
    )
    .fontSize(
      7.3
    )
    .fillColor(
      "#111111"
    )
    .text(
      cleanText(
        value
      ) ||
        "—",
      valueX,
      y,
      {
        width:
          valueWidth,
        lineBreak:
          false,
        ellipsis:
          true,
      }
    );
};

const drawTableHeader = ({
  doc,
  y,
}) => {
  const columns =
    [
      {
        key:
          "code",
        label:
          "Código",
        x:
          36,
        width:
          55,
        align:
          "left",
      },
      {
        key:
          "description",
        label:
          "Descripción",
        x:
          91,
        width:
          190,
        align:
          "left",
      },
      {
        key:
          "quantity",
        label:
          "Cant.",
        x:
          281,
        width:
          40,
        align:
          "right",
      },
      {
        key:
          "price",
        label:
          "Precio",
        x:
          321,
        width:
          65,
        align:
          "right",
      },
      {
        key:
          "discount",
        label:
          "Dscto.(%)",
        x:
          386,
        width:
          50,
        align:
          "right",
      },
      {
        key:
          "affectation",
        label:
          "Af/Ex",
        x:
          436,
        width:
          48,
        align:
          "center",
      },
      {
        key:
          "value",
        label:
          "Valor",
        x:
          484,
        width:
          75,
        align:
          "right",
      },
    ];

  doc
    .rect(
      36,
      y,
      523,
      20
    )
    .fillColor(
      TABLE_HEADER_BG
    )
    .fill();

  for (
    const column of
    columns
  ) {
    doc
      .font(
        FONT_SEMIBOLD
      )
      .fontSize(
        6.2
      )
      .fillColor(
        TABLE_HEADER_TEXT
      )
      .text(
        column.label,
        column.x +
          3,
        y +
          8,
        {
          width:
            column.width -
            6,
          align:
            column.align,
          lineBreak:
            false,
        }
      );
  }

  doc
    .moveTo(
      36,
      y + 20
    )
    .lineTo(
      559,
      y + 20
    )
    .lineWidth(
      0.6
    )
    .strokeColor(
      "#bcbcbc"
    )
    .stroke();

  return {
    columns,
    y:
      y +
      22,
  };
};

const drawProductRow = ({
  doc,
  product,
  columns,
  y,
}) => {
  doc
    .font(
      FONT_REGULAR
    )
    .fontSize(
      6.25
    );

  const descriptionHeight =
    doc.heightOfString(
      product.description,
      {
        width:
          184,
        lineGap:
          0.5,
      }
    );

  const rowHeight =
    Math.max(
      23,
      Math.min(
        38,
        descriptionHeight +
          7
      )
    );

  doc
    .font(
      FONT_REGULAR
    )
    .fontSize(
      6.25
    )
    .fillColor(
      "#222222"
    )
    .text(
      product.code,
      columns[0].x +
        3,
      y + 6,
      {
        width:
          columns[0]
            .width -
          6,
      }
    )
    .text(
      product.description,
      columns[1].x +
        3,
      y + 6,
      {
        width:
          columns[1]
            .width -
          6,
        lineGap:
          0.5,
        height:
          rowHeight -
          8,
        ellipsis:
          true,
      }
    )
    .text(
      formatNumber(
        product.quantity
      ),
      columns[2].x +
        2,
      y + 6,
      {
        width:
          columns[2]
            .width -
          4,
        align:
          "right",
      }
    )
    .text(
      formatNumber(
        product.unitPrice,
        1
      ),
      columns[3].x +
        2,
      y + 6,
      {
        width:
          columns[3]
            .width -
          4,
        align:
          "right",
      }
    )
    .text(
      formatNumber(
        product.discountPct,
        2
      ),
      columns[4].x +
        2,
      y + 6,
      {
        width:
          columns[4]
            .width -
          4,
        align:
          "right",
      }
    )
    .fontSize(
      5.8
    )
    .text(
      product.affectation,
      columns[5].x +
        2,
      y + 6,
      {
        width:
          columns[5]
            .width -
          4,
        align:
          "center",
      }
    )
    .fontSize(
      6.25
    )
    .text(
      formatNumber(
        product.lineValue,
        0
      ),
      columns[6].x +
        2,
      y + 6,
      {
        width:
          columns[6]
            .width -
          4,
        align:
          "right",
      }
    );

  doc
    .moveTo(
      36,
      y +
        rowHeight
    )
    .lineTo(
      559,
      y +
        rowHeight
    )
    .lineWidth(
      0.35
    )
    .strokeColor(
      BRAND_BORDER
    )
    .stroke();

  return (
    y +
    rowHeight
  );
};

const getOfficialTotal = (
  printData,
  label
) => {
  const totals =
    Array.isArray(
      printData
        ?.print_totals_v2
    )
      ? printData
          .print_totals_v2
      : [];

  const normalizedLabel =
    normalizeKey(
      label
    );

  const entry =
    totals.find(
      (item) =>
        Array.isArray(
          item
        ) &&
        normalizeKey(
          item[0]
        ) ===
          normalizedLabel
    );

  return (
    entry?.[1] ||
    null
  );
};

const ensureFinalPageSpace = ({
  doc,
  y,
}) => {
  if (
    y <=
    610
  ) {
    return y;
  }

  doc.addPage({
    size:
      "A4",
    margin:
      36,
  });

  return 58;
};

export const buildRelbaseDteLetterPdfBuffer =
  async ({
    taxDocumentId,
    localDocument,
    printPayload,
    items:
      suppliedItems = null,
  }) => {
    const printData =
      resolvePrintData(
        printPayload
      );

    const header =
      parseHeader(
        printData
      );

    const company =
      parseCompany(
        printData
      );

    const metadata =
      parseLabeledBlock(
        Array.isArray(
          printData
            .print_content_v2
        )
          ? printData
              .print_content_v2[0]
          : ""
      );

    const customer =
      parseLabeledBlock(
        Array.isArray(
          printData
            .print_content_v2
        )
          ? printData
              .print_content_v2[1]
          : ""
      );

    const localItems =
      Array.isArray(
        suppliedItems
      )
        ? suppliedItems
        : await loadLocalItems(
            taxDocumentId
          );

    if (
      localItems.length ===
      0
    ) {
      const error =
        new Error(
          "El DTE local no posee líneas para generar la representación A4"
        );

      error.code =
        "TAX_DOCUMENT_ITEMS_NOT_FOUND";

      error.status =
        409;

      throw error;
    }

    const externalProducts =
      parseExternalProducts(
        printData
      );

    const products =
      externalProducts.length >
      0
        ? matchLocalItems({
            externalProducts,
            localItems,
          })
        : localItems.map(
            (item) => {
              const subtotal =
                Number(
                  item
                    .unit_price ||
                  0
                ) *
                Number(
                  item
                    .quantity ||
                  0
                );

              const discount =
                Number(
                  item
                    .discount_amount ||
                  0
                );

              return {
                code:
                  cleanText(
                    item
                      .product_code ||
                    item
                      .sku
                  ) ||
                  "—",
                description:
                  cleanText(
                    item
                      .description
                  ) ||
                  cleanText(
                    item
                      .detail_description
                  ) ||
                  "—",
                quantity:
                  Number(
                    item
                      .quantity ||
                    0
                  ),
                unitPrice:
                  Number(
                    item
                      .unit_price ||
                    0
                  ),
                discountPct:
                  subtotal >
                  0
                    ? (
                        discount /
                        subtotal
                      ) *
                      100
                    : 0,
                lineValue:
                  Number(
                    item
                      .net_amount ||
                    0
                  ),
                affectation:
                  Number(
                    item
                      .tax_rate ||
                    0
                  ) >
                  0
                    ? "AFECTO"
                    : "EXENTO",
              };
            }
          );

    const stampBase64 =
      cleanText(
        printData
          .print_stamp
      );

    if (
      !stampBase64
    ) {
      const error =
        new Error(
          "Relbase no entregó el timbre electrónico S.I.I. para la representación A4"
        );

      error.code =
        "RELBASE_DTE_PRINT_STAMP_MISSING";

      error.status =
        502;

      throw error;
    }

    const stampBuffer =
      Buffer.from(
        stampBase64,
        "base64"
      );

    return new Promise(
      (
        resolve,
        reject
      ) => {
        try {
          const folio =
            cleanText(
              localDocument
                ?.folio ||
              header.folio
            ) ||
            "—";

          const documentName =
            cleanText(
              header
                .documentName
            ) ||
            (
              String(
                localDocument
                  ?.document_type ||
                ""
              )
                .trim()
                .toUpperCase() ===
              "FACTURA"
                ? "FACTURA ELECTRÓNICA"
                : "DOCUMENTO TRIBUTARIO ELECTRÓNICO"
            );

          const doc =
            new PDFDocument({
              size:
                "A4",
              margin:
                36,
              info: {
                Title:
                  `${documentName} N° ${folio}`,
                Author:
                  "Laminati Chile Spa",
                Subject:
                  "Representación impresa de DTE",
              },
            });

          registerPoppinsFonts(
            doc
          );

          const chunks =
            [];

          doc.on(
            "data",
            (chunk) =>
              chunks.push(
                chunk
              )
          );

          doc.on(
            "end",
            () =>
              resolve(
                Buffer.concat(
                  chunks
                )
              )
          );

          doc.on(
            "error",
            reject
          );

          const pageWidth =
            doc.page.width;

          drawLogo({
            doc,
            x:
              36,
            y:
              24,
            width:
              110,
          });

          doc
            .font(
              FONT_SEMIBOLD
            )
            .fontSize(
              8.2
            )
            .fillColor(
              "#222222"
            )
            .text(
              company.name,
              158,
              27,
              {
                width:
                  245,
              }
            );

          doc
            .font(
              FONT_REGULAR
            )
            .fontSize(
              6.7
            )
            .fillColor(
              "#444444"
            )
            .text(
              `R.U.T: ${
                header
                  .issuerRut ||
                "76.376.809-0"
              }`,
              158,
              42,
              {
                width:
                  245,
              }
            )
            .text(
              "COMER. DE LAMINAS PARA MUEBLES Y REVESTIMIENTOS",
              158,
              54,
              {
                width:
                  245,
              }
            )
            .text(
              company.address ||
                "La Concepcion 81, Of 304, Providencia",
              158,
              66,
              {
                width:
                  245,
              }
            );

          if (
            company.branch
          ) {
            doc.text(
              company.branch,
              158,
              78,
              {
                width:
                  245,
              }
            );
          }

          const boxX =
            414;

          const boxY =
            24;

          const boxW =
            145;

          const boxH =
            78;

          doc
            .roundedRect(
              boxX,
              boxY,
              boxW,
              boxH,
              2
            )
            .lineWidth(
              1.4
            )
            .strokeColor(
              BRAND_DARK
            )
            .stroke();

          doc
            .font(
              FONT_SEMIBOLD
            )
            .fontSize(
              8.5
            )
            .fillColor(
              BRAND_DARK
            )
            .text(
              `R.U.T. ${header.issuerRut || "76.376.809-0"}`,
              boxX +
                8,
              boxY +
                10,
              {
                width:
                  boxW -
                  16,
                align:
                  "center",
              }
            )
            .fontSize(
              10
            )
            .text(
              documentName,
              boxX +
                8,
              boxY +
                29,
              {
                width:
                  boxW -
                  16,
                align:
                  "center",
              }
            )
            .fontSize(
              9
            )
            .text(
              `N° ${folio}`,
              boxX +
                8,
              boxY +
                47,
              {
                width:
                  boxW -
                  16,
                align:
                  "center",
              }
            )
            .font(
              FONT_REGULAR
            )
            .fontSize(
              6.8
            )
            .text(
              header
                .siiOffice ||
                "S.I.I.",
              boxX +
                8,
              boxY +
                63,
              {
                width:
                  boxW -
                  16,
                align:
                  "center",
              }
            );

          doc
            .font(
              FONT_REGULAR
            )
            .fontSize(
              6.8
            )
            .fillColor(
              "#333333"
            )
            .text(
              `Fecha emisión: ${
                metadata
                  .fechaemision ||
                "—"
              }`,
              350,
              116,
              {
                width:
                  209,
                align:
                  "right",
              }
            );

          const customerTop =
            134;

          doc
            .moveTo(
              36,
              customerTop -
                10
            )
            .lineTo(
              559,
              customerTop -
                10
            )
            .lineWidth(
              0.45
            )
            .strokeColor(
              BRAND_BORDER
            )
            .stroke();

          drawInfoPair({
            doc,
            label:
              "Señor(es)",
            value:
              customer
                .senores ||
              customer
                .senores_ ||
              "—",
            labelX:
              36,
            valueX:
              90,
            y:
              customerTop,
            valueWidth:
              267,
          });

          drawInfoPair({
            doc,
            label:
              "RUT",
            value:
              customer.rut,
            labelX:
              372,
            valueX:
              414,
            y:
              customerTop,
            valueWidth:
              145,
          });

          drawInfoPair({
            doc,
            label:
              "Dirección",
            value:
              customer
                .direccion,
            labelX:
              36,
            valueX:
              90,
            y:
              customerTop +
              17,
            valueWidth:
              267,
          });

          drawInfoPair({
            doc,
            label:
              "Comuna",
            value:
              customer
                .comuna,
            labelX:
              372,
            valueX:
              414,
            y:
              customerTop +
              17,
            valueWidth:
              145,
          });

          drawInfoPair({
            doc,
            label:
              "Giro",
            value:
              customer.giro,
            labelX:
              36,
            valueX:
              90,
            y:
              customerTop +
              34,
            valueWidth:
              267,
          });

          drawInfoPair({
            doc,
            label:
              "Ciudad",
            value:
              customer
                .ciudad,
            labelX:
              372,
            valueX:
              414,
            y:
              customerTop +
              34,
            valueWidth:
              145,
          });

          drawInfoPair({
            doc,
            label:
              "Vendedor",
            value:
              metadata
                .vendedor,
            labelX:
              36,
            valueX:
              90,
            y:
              customerTop +
              51,
            valueWidth:
              267,
          });

          drawInfoPair({
            doc,
            label:
              "Forma pago",
            value:
              metadata
                .formapago,
            labelX:
              372,
            valueX:
              427,
            y:
              customerTop +
              51,
            valueWidth:
              132,
          });

          drawInfoPair({
            doc,
            label:
              "Canal venta",
            value:
              metadata
                .canalventa,
            labelX:
              36,
            valueX:
              90,
            y:
              customerTop +
              68,
            valueWidth:
              267,
          });

          doc
            .moveTo(
              36,
              customerTop +
                89
            )
            .lineTo(
              559,
              customerTop +
                89
            )
            .lineWidth(
              0.45
            )
            .strokeColor(
              BRAND_BORDER
            )
            .stroke();

          let table =
            drawTableHeader({
              doc,
              y:
                customerTop +
                98,
            });

          let y =
            table.y;

          let columns =
            table.columns;

          for (
            const product
            of products
          ) {
            doc
              .font(
                FONT_REGULAR
              )
              .fontSize(
                6.7
              );

            const estimatedHeight =
              Math.max(
                26,
                Math.min(
                  46,
                  doc.heightOfString(
                    product
                      .description,
                    {
                      width:
                        184,
                      lineGap:
                        0.5,
                    }
                  ) +
                    9
                )
              );

            if (
              y +
                estimatedHeight >
              615
            ) {
              doc.addPage({
                size:
                  "A4",
                margin:
                  36,
              });

              doc
                .font(
                  FONT_SEMIBOLD
                )
                .fontSize(
                  8
                )
                .fillColor(
                  "#333333"
                )
                .text(
                  `${documentName} N° ${folio} · continuación`,
                  36,
                  30,
                  {
                    width:
                      pageWidth -
                      72,
                    align:
                      "right",
                  }
                );

              table =
                drawTableHeader({
                  doc,
                  y:
                    55,
                });

              y =
                table.y;

              columns =
                table.columns;
            }

            y =
              drawProductRow({
                doc,
                product,
                columns,
                y,
              });
          }

          y =
            ensureFinalPageSpace({
              doc,
              y:
                y + 12,
            });

          const comment =
            cleanText(
              printData
                .comment_v2
            )
              .replace(
                /^Observaciones:\s*/i,
                ""
              )
              .replace(
                /\r/g,
                ""
              )
              .trim();

          doc
            .font(
              FONT_SEMIBOLD
            )
            .fontSize(
              7
            )
            .fillColor(
              "#333333"
            )
            .text(
              "Observaciones generales:",
              36,
              y,
              {
                width:
                  300,
              }
            );

          doc
            .font(
              FONT_REGULAR
            )
            .fontSize(
              6.6
            )
            .fillColor(
              "#333333"
            )
            .text(
              comment ||
                "Sin observaciones.",
              36,
              y +
                14,
              {
                width:
                  292,
                height:
                  54,
                ellipsis:
                  true,
                lineGap:
                  1,
              }
            );

          const totalsX =
            372;

          const totalsValueX =
            466;

          const totalRows =
            [
              [
                "Subtotal:",
                getOfficialTotal(
                  printData,
                  "Subtotal:"
                ),
              ],
              [
                "Monto neto:",
                getOfficialTotal(
                  printData,
                  "Monto neto:"
                ),
              ],
              [
                "IVA (19%):",
                getOfficialTotal(
                  printData,
                  "IVA:"
                ),
              ],
              [
                "Total:",
                getOfficialTotal(
                  printData,
                  "TOTAL:"
                ),
              ],
            ];

          let totalsY =
            y;

          for (
            const [
              label,
              value,
            ] of totalRows
          ) {
            const isTotal =
              label ===
              "Total:";

            doc
              .font(
                isTotal
                  ? FONT_SEMIBOLD
                  : FONT_REGULAR
              )
              .fontSize(
                isTotal
                  ? 8.7
                  : 7
              )
              .fillColor(
                "#222222"
              )
              .text(
                label,
                totalsX,
                totalsY,
                {
                  width:
                    88,
                  align:
                    "right",
                }
              )
              .text(
                cleanText(
                  value
                ) ||
                  formatClp(
                    isTotal
                      ? localDocument
                          ?.total_amount
                      : 0
                  ),
                totalsValueX,
                totalsY,
                {
                  width:
                    93,
                  align:
                    "right",
                }
              );

            totalsY +=
              isTotal
                ? 19
                : 15;
          }

          const stampY =
            Math.max(
              y + 70,
              totalsY + 10
            );

          try {
            doc.image(
              stampBuffer,
              36,
              stampY,
              {
                width:
                  190,
              }
            );
          } catch (error) {
            reject(
              error
            );
            return;
          }

          doc
            .font(
              FONT_REGULAR
            )
            .fontSize(
              6.1
            )
            .fillColor(
              "#444444"
            )
            .text(
              "Timbre Electrónico S.I.I.",
              36,
              stampY +
                66,
              {
                width:
                  190,
                align:
                  "center",
              }
            );

          /*
           * Mantener el pie dentro del área imprimible de PDFKit.
           *
           * Antes se usaba page.height - 32, pero el documento tiene
           * margin = 36. Eso dejaba el texto 4 pt fuera del área útil
           * y PDFKit creaba automáticamente una segunda página que
           * contenía solamente el pie de representación.
           */
          const footerY =
            doc.page.height -
            doc.page.margins.bottom -
            12;

          doc
            .moveTo(
              36,
              footerY -
                8
            )
            .lineTo(
              559,
              footerY -
                8
            )
            .lineWidth(
              0.35
            )
            .strokeColor(
              "#d8d8d8"
            )
            .stroke();

          doc
            .font(
              FONT_REGULAR
            )
            .fontSize(
              5.8
            )
            .fillColor(
              "#777777"
            )
            .text(
              "Representación impresa del documento tributario electrónico.",
              36,
              footerY,
              {
                width:
                  523,
                align:
                  "center",
              }
            );

          doc.end();
        } catch (error) {
          reject(
            error
          );
        }
      }
    );
  };
