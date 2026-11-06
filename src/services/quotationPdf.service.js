import PDFDocument from "pdfkit";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const money = (value) => {
  const number = Number(value || 0);
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(number) ? number : 0);
};

const cleanText = (value) => String(value ?? "").trim();


const LAMINATI_WORLD_LOGO_PATH =
  fileURLToPath(
    new URL(
      "../assets/logo-laminati-world.png",
      import.meta.url
    )
  );

const getLaminatiWorldLogoPath = () =>
  existsSync(
    LAMINATI_WORLD_LOGO_PATH
  )
    ? LAMINATI_WORLD_LOGO_PATH
    : null;

const drawLaminatiWorldLogo = ({
  doc,
  x,
  y,
  width,
  height = null,
  fallbackFontSize = 20,
}) => {
  const logoPath =
    getLaminatiWorldLogoPath();

  if (logoPath) {
    const imageOptions =
      height
        ? {
            fit: [
              width,
              height,
            ],
            align: "left",
            valign: "center",
          }
        : {
            width,
          };

    doc.image(
      logoPath,
      x,
      y,
      imageOptions
    );

    return true;
  }

  /*
   * Fallback de seguridad:
   * si el asset no se encuentra en el servidor,
   * mantiene la generación del PDF y muestra
   * la marca Laminati World en texto.
   */
  doc
    .font("Helvetica-Bold")
    .fontSize(
      fallbackFontSize
    )
    .fillColor("#111111")
    .text(
      "laminati world",
      x,
      y
    );

  return false;
};

const formatDate = (value) => {
  if (!value) return "—";

  const raw = String(value).trim();
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})/
  );

  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString("es-CL");
};


const writeLabelValue = (doc, label, value, x, y, width) => {
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#777777")
    .text(label.toUpperCase(), x, y, { width });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#111111")
    .text(cleanText(value) || "—", x, y + 12, { width });
};

const buildStandardQuotationPdfBuffer = async ({
  quotation,
  items,
}) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 42,
        info: {
          Title: `Cotización ${quotation.quote_number}`,
          Author: "Laminati World",
          Subject: "Cotización comercial",
        },
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - 84;

      const standardLogoDrawn =
        drawLaminatiWorldLogo({
          doc,
          x: 42,
          y: 24,
          width: 116,
          fallbackFontSize: 20,
        });

      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#777777")
        .text(
          "SHOWROOM · COTIZACIÓN COMERCIAL",
          42,
          standardLogoDrawn
            ? 75
            : 68
        );

      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .fillColor("#111111")
        .text(quotation.quote_number, 330, 42, {
          width: contentWidth - 288,
          align: "right",
        });

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#666666")
        .text(
          `Válida hasta: ${formatDate(quotation.valid_until)}`,
          330,
          68,
          {
            width: contentWidth - 288,
            align: "right",
          }
        );

      doc
        .moveTo(42, 95)
        .lineTo(pageWidth - 42, 95)
        .strokeColor("#dddddd")
        .stroke();

      writeLabelValue(
        doc,
        quotation.intended_document_type === "FACTURA"
          ? "Razón social"
          : "Cliente",
        quotation.legal_name || quotation.customer_name,
        42,
        115,
        245
      );

      writeLabelValue(
        doc,
        "RUT",
        quotation.rut,
        305,
        115,
        120
      );

      writeLabelValue(
        doc,
        "Correo",
        quotation.email,
        42,
        157,
        245
      );

      writeLabelValue(
        doc,
        "Teléfono",
        quotation.phone,
        305,
        157,
        120
      );

      writeLabelValue(
        doc,
        "Dirección",
        [
          quotation.address_line,
          quotation.commune,
          quotation.city,
        ]
          .filter(Boolean)
          .join(", "),
        42,
        199,
        383
      );

      if (quotation.intended_document_type === "FACTURA") {
        writeLabelValue(
          doc,
          "Giro",
          quotation.business_activity,
          42,
          241,
          383
        );
      }

      let y =
        quotation.intended_document_type === "FACTURA"
          ? 292
          : 250;

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("#111111")
        .text("DETALLE", 42, y);

      y += 20;

      const cols = {
        sku: 42,
        product: 100,
        qty: 340,
        price: 390,
        total: 480,
      };

      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#666666")
        .text("SKU", cols.sku, y)
        .text("Producto", cols.product, y)
        .text("Cant.", cols.qty, y, { width: 40, align: "right" })
        .text("Precio", cols.price, y, { width: 75, align: "right" })
        .text("Total", cols.total, y, { width: 72, align: "right" });

      y += 15;
      doc
        .moveTo(42, y)
        .lineTo(pageWidth - 42, y)
        .strokeColor("#e5e5e5")
        .stroke();
      y += 8;

      for (const item of items) {
        if (y > 690) {
          doc.addPage();
          y = 50;
        }

        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor("#222222")
          .text(item.sku, cols.sku, y, { width: 50 })
          .text(item.product_name, cols.product, y, { width: 225 })
          .text(String(item.quantity), cols.qty, y, {
            width: 40,
            align: "right",
          })
          .text(money(item.unit_price_gross), cols.price, y, {
            width: 75,
            align: "right",
          })
          .text(money(item.line_total), cols.total, y, {
            width: 72,
            align: "right",
          });

        y += 32;
      }

      y += 10;
      doc
        .moveTo(330, y)
        .lineTo(pageWidth - 42, y)
        .strokeColor("#dddddd")
        .stroke();

      y += 12;

      const totals = [
        ["Neto", quotation.net_total],
        ["IVA", quotation.tax_total],
        ["TOTAL", quotation.total],
      ];

      for (const [label, value] of totals) {
        const isTotal = label === "TOTAL";
        doc
          .font(isTotal ? "Helvetica-Bold" : "Helvetica")
          .fontSize(isTotal ? 12 : 9)
          .fillColor("#111111")
          .text(label, 350, y, { width: 80 })
          .text(money(value), 435, y, {
            width: 117,
            align: "right",
          });
        y += isTotal ? 24 : 18;
      }

      if (cleanText(quotation.notes)) {
        y += 8;
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#666666")
          .text("OBSERVACIONES", 42, y);
        y += 13;
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#333333")
          .text(quotation.notes, 42, y, { width: contentWidth });
      }

      const footerY = doc.page.height - 62;
      doc
        .moveTo(42, footerY - 10)
        .lineTo(pageWidth - 42, footerY - 10)
        .strokeColor("#e5e5e5")
        .stroke();

      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor("#777777")
        .text(
          "Cotización comercial. No constituye documento tributario ni reserva de stock. Precios válidos hasta la fecha indicada y productos sujetos a disponibilidad al momento de la compra.",
          42,
          footerY,
          { width: contentWidth, align: "center" }
        );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

const formatNumber = (
  value,
  maximumFractionDigits = 2
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
  ).format(
    number
  );
};


const ensureProjectSpace = (
  doc,
  y,
  required = 35
) => {
  const maxY =
    doc.page.height -
    65;

  if (
    y + required <=
    maxY
  ) {
    return y;
  }

  doc.addPage({
    size:
      "A4",
    layout:
      "landscape",
    margin:
      30,
  });

  return 40;
};


const PROJECT_QUOTATION_STATIC_CONTENT = {
  billing: {
    name:
      "Laminati Chile Spa",
    address:
      "Av. Santa Rosa 6898, La Granja, Santiago",
    phones:
      "56 44 289 07 84",
    rut:
      "76.376.809-0",
  },

  nationalTransfer: {
    name:
      "Laminati Chile Spa",
    rut:
      "76.376.809-0",
    bank:
      "Banco Santander",
    account:
      "Cta Corriente n° 6873340-5",
    email:
      "mtorres@laminati.cl",
  },

  specialOrders: [
    "Tiempo de fabricación es de 6 a 9 semanas (en caso de no encontrarse en stock de fábrica), dependiendo de la carga de trabajo que se encuentre en la línea de producción en el momento de hacer el pago al exterior o según se indique en las observaciones.",
    "Tiempo de flete marítimo es de 35 - 47 días aproximadamente, desde puerto de Génova.",
    "A los tiempos de flete, se les debe sumar los tiempos en puerto y aduana (información a confirmar por cada envío). En caso de producirse atrasos en la producción, transporte o aduana, Laminati Chile Spa no estará sujeto a multas de parte del cliente.",
  ],

  paymentTerms:
    "50% al momento de aprobar la orden de producción a Laminati Chile Spa y saldo contra entrega, o en función de lo especificado en las observaciones de la cotización.",

  internationalTransfer:
    "Banco Santander ; Laminati Chile Spa ; cta en Dollar US n° 051-0014885-6, SWIFT BSCHCLRMXXX; mtorres@laminati.cl",

  guaranteeNotice:
    "Laminati Chile no entrega boletas o pólizas de garantía.",
};


const drawProjectDocumentHeader = ({
  doc,
  quotation,
  compact = false,
}) => {
  const pageWidth =
    doc.page.width;

  const margin =
    34;

  /*
   * El logo Laminati World se inserta dentro de una caja
   * vertical fija para conservar su proporción y mantener
   * el wordmark + isotipo centrados visualmente en la misma
   * línea del encabezado, tanto en páginas normales como
   * compactas.
   */
  const logoBoxY =
    compact
      ? 20
      : 24;

  const logoBoxHeight =
    compact
      ? 31
      : 36;

  const projectLogoDrawn =
    drawLaminatiWorldLogo({
      doc,
      x:
        margin - 9.5,
      y:
        logoBoxY,
      width:
        compact
          ? 108
          : 124,
      height:
        logoBoxHeight,
      fallbackFontSize:
        compact
          ? 17
          : 20,
    });

  const subtitleY =
    projectLogoDrawn
      ? (
          logoBoxY +
          logoBoxHeight +
          (compact ? 4 : 5)
        )
      : (
          compact
            ? 50
            : 55
        );

  if (
    projectLogoDrawn
  ) {
    doc
      .font(
        "Helvetica"
      )
      .fontSize(
        compact
          ? 6.2
          : 6.6
      )
      .fillColor(
        "#666666"
      )
      .text(
        "Laminati Chile, distribuidor exclusivo de Abet Laminati en Chile",
        margin,
        subtitleY,
        {
          width:
            compact
              ? 250
              : 275,
          align:
            "left",
          lineBreak:
            false,
        }
      );
  }

  const projectTitleY =
    projectLogoDrawn
      ? (
          subtitleY +
          (compact ? 14 : 16)
        )
      : (
          compact
            ? 53
            : 60
        );

  doc
    .font(
      "Helvetica"
    )
    .fontSize(
      7
    )
    .fillColor(
      "#777777"
    )
    .text(
      "COTIZACIÓN DE PROYECTO",
      margin,
      projectTitleY
    );

  doc
    .font(
      "Helvetica-Bold"
    )
    .fontSize(
      compact
        ? 11.5
        : 13
    )
    .fillColor(
      "#111111"
    )
    .text(
      quotation
        .quote_number,
      pageWidth -
        250,
      compact
        ? 30
        : 34,
      {
        width:
          216,
        align:
          "right",
      }
    );

  doc
    .font(
      "Helvetica"
    )
    .fontSize(
      7.5
    )
    .fillColor(
      "#666666"
    )
    .text(
      `Válida hasta: ${formatDate(
        quotation
          .valid_until
      )}`,
      pageWidth -
        250,
      compact
        ? 50
        : 55,
      {
        width:
          216,
        align:
          "right",
      }
    );

  const lineY =
    projectLogoDrawn
      ? (
          projectTitleY +
          (compact ? 15 : 16)
        )
      : (
          compact
            ? 79
            : 88
        );

  doc
    .moveTo(
      margin,
      lineY
    )
    .lineTo(
      pageWidth -
        margin,
      lineY
    )
    .strokeColor(
      "#dddddd"
    )
    .stroke();

  return (
    lineY +
    14
  );
};


const drawProjectFooter = ({
  doc,
  pageNumber,
  totalPages,
}) => {
  const pageWidth =
    doc.page.width;

  const footerY =
    doc.page.height -
    38;

  doc
    .moveTo(
      34,
      footerY -
        9
    )
    .lineTo(
      pageWidth -
        34,
      footerY -
        9
    )
    .strokeColor(
      "#e5e5e5"
    )
    .stroke();

  const footerLogoDrawn =
    drawLaminatiWorldLogo({
      doc,
      x: 34,
      y: footerY - 6,
      width: 78,
      height: 18,
      fallbackFontSize: 7.2,
    });

  doc
    .font(
      "Helvetica"
    )
    .fontSize(
      5.8
    )
    .fillColor(
      "#888888"
    )
    .text(
      "SOLUCIONES EN SUPERFICIES DE ALTO DESEMPEÑO",
      footerLogoDrawn
        ? 135
        : 155,
      footerY +
        1,
      {
        width:
          footerLogoDrawn
            ? 305
            : 285,
        align:
          "center",
      }
    );

  doc
    .fontSize(
      6.5
    )
    .fillColor(
      "#666666"
    )
    .text(
      `Pág. ${pageNumber} de ${totalPages}`,
      pageWidth -
        110,
      footerY,
      {
        width:
          76,
        align:
          "right",
      }
    );
};


const drawProjectInfoPanel = ({
  doc,
  quotation,
  y,
}) => {
  const x =
    34;

  const width =
    doc.page.width -
    68;

  const height =
    112;

  doc
    .roundedRect(
      x,
      y,
      width,
      height,
      3
    )
    .fillColor(
      "#f6f6f6"
    )
    .fill();

  const leftX =
    x +
    14;

  const rightX =
    x +
    282;

  const leftValueX =
    leftX +
    83;

  const rightValueX =
    rightX +
    67;

  const rowYs =
    [
      y + 16,
      y + 40,
      y + 64,
      y + 88,
    ];

  const drawPair =
    (
      label,
      value,
      labelX,
      valueX,
      rowY,
      valueWidth
    ) => {
      doc
        .font(
          "Helvetica-Bold"
        )
        .fontSize(
          6.2
        )
        .fillColor(
          "#777777"
        )
        .text(
          label.toUpperCase(),
          labelX,
          rowY,
          {
            width:
              valueX -
              labelX -
              6,
          }
        );

      doc
        .font(
          "Helvetica"
        )
        .fontSize(
          7.6
        )
        .fillColor(
          "#222222"
        )
        .text(
          cleanText(
            value
          ) ||
            "—",
          valueX,
          rowY -
            1,
          {
            width:
              valueWidth,
            lineGap:
              1,
          }
        );
    };

  drawPair(
    quotation
        .intended_document_type ===
      "FACTURA"
      ? "Razón social"
      : "Cliente",
    quotation
      .legal_name ||
      quotation
        .customer_name,
    leftX,
    leftValueX,
    rowYs[0],
    155
  );

  drawPair(
    "RUT",
    quotation.rut,
    leftX,
    leftValueX,
    rowYs[1],
    155
  );

  drawPair(
    "Proyecto",
    quotation
      .project_name,
    leftX,
    leftValueX,
    rowYs[2],
    155
  );

  drawPair(
    "Referencia",
    quotation
      .project_reference,
    leftX,
    leftValueX,
    rowYs[3],
    155
  );

  drawPair(
    "Correo",
    quotation.email,
    rightX,
    rightValueX,
    rowYs[0],
    164
  );

  drawPair(
    "Teléfono",
    quotation.phone,
    rightX,
    rightValueX,
    rowYs[1],
    164
  );

  drawPair(
    "Dirección",
    [
      quotation
        .address_line,
      quotation
        .commune,
      quotation
        .city,
    ]
      .filter(
        Boolean
      )
      .join(
        ", "
      ),
    rightX,
    rightValueX,
    rowYs[2],
    164
  );

  if (
    quotation
      .intended_document_type ===
    "FACTURA"
  ) {
    drawPair(
      "Giro",
      quotation
        .business_activity,
      rightX,
      rightValueX,
      rowYs[3],
      164
    );
  }

  return (
    y +
    height +
    22
  );
};


const drawProjectSectionTitle = ({
  doc,
  title,
  y,
}) => {
  doc
    .font(
      "Helvetica-Bold"
    )
    .fontSize(
      8.2
    )
    .fillColor(
      "#111111"
    )
    .text(
      title.toUpperCase(),
      34,
      y
    );

  doc
    .moveTo(
      34,
      y +
        13
    )
    .lineTo(
      72,
      y +
        13
    )
    .lineWidth(
      1
    )
    .strokeColor(
      "#111111"
    )
    .stroke();

  return (
    y +
    24
  );
};


const drawProjectProductHeader = ({
  doc,
  y,
}) => {
  const columns =
    [
      {
        key:
          "product",
        label:
          "PRODUCTO",
        x:
          34,
        width:
          92,
        align:
          "left",
      },
      {
        key:
          "code",
        label:
          "CÓDIGO",
        x:
          126,
        width:
          78,
        align:
          "left",
      },
      {
        key:
          "finish",
        label:
          "ACABADO",
        x:
          204,
        width:
          55,
        align:
          "left",
      },
      {
        key:
          "thickness",
        label:
          "ESPESOR",
        x:
          259,
        width:
          43,
        align:
          "right",
      },
      {
        key:
          "quantity",
        label:
          "CANT.",
        x:
          302,
        width:
          39,
        align:
          "right",
      },
      {
        key:
          "format",
        label:
          "FORMATO",
        x:
          341,
        width:
          62,
        align:
          "left",
      },
      {
        key:
          "m2",
        label:
          "VALOR m²",
        x:
          403,
        width:
          48,
        align:
          "right",
      },
      {
        key:
          "unit",
        label:
          "VALOR UNIT.",
        x:
          451,
        width:
          52,
        align:
          "right",
      },
      {
        key:
          "total",
        label:
          "TOTAL",
        x:
          503,
        width:
          58,
        align:
          "right",
      },
    ];

  const headerHeight =
    27;

  doc
    .rect(
      34,
      y,
      527,
      headerHeight
    )
    .fillColor(
      "#111111"
    )
    .fill();

  for (
    const column
    of columns
  ) {
    doc
      .font(
        "Helvetica-Bold"
      )
      .fontSize(
        5.4
      )
      .fillColor(
        "#ffffff"
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
        }
      );
  }

  return {
    columns,
    y:
      y +
      headerHeight,
  };
};


const drawProjectProductRow = ({
  doc,
  line,
  columns,
  y,
}) => {
  const values = {
    product:
      cleanText(
        line
          .description
      ) ||
      "—",

    code:
      cleanText(
        line
          .code
      ) ||
      "—",

    finish:
      cleanText(
        line
          .finish
      ) ||
      "—",

    thickness:
      line
          .thickness_mm !==
        null &&
      line
          .thickness_mm !==
        undefined
        ? `${formatNumber(
            line
              .thickness_mm
          )} mm`
        : "—",

    quantity:
      formatNumber(
        line
          .quantity,
        3
      ),

    format:
      cleanText(
        line
          .format_label
      ) ||
      cleanText(
        line
          .unit
      ) ||
      "—",

    m2:
      line
          .price_m2_gross !==
        null &&
      line
          .price_m2_gross !==
        undefined
        ? money(
            line
              .price_m2_gross
          )
        : "—",

    unit:
      money(
        line
          .unit_price_gross
      ),

    total:
      money(
        line
          .line_total_gross
      ),
  };

  let rowHeight =
    27;

  for (
    const column
    of columns
  ) {
    const height =
      doc
        .font(
          column.key ===
            "total"
            ? "Helvetica-Bold"
            : "Helvetica"
        )
        .fontSize(
          6.1
        )
        .heightOfString(
          values[
            column.key
          ],
          {
            width:
              column.width -
              7,
            lineGap:
              1,
          }
        );

    rowHeight =
      Math.max(
        rowHeight,
        height +
          12
      );
  }

  doc
    .rect(
      34,
      y,
      527,
      rowHeight
    )
    .fillColor(
      "#ffffff"
    )
    .fill()
    .strokeColor(
      "#dddddd"
    )
    .lineWidth(
      0.5
    )
    .stroke();

  for (
    const column
    of columns
  ) {
    doc
      .font(
        column.key ===
          "total"
          ? "Helvetica-Bold"
          : "Helvetica"
      )
      .fontSize(
        6.1
      )
      .fillColor(
        "#222222"
      )
      .text(
        values[
          column.key
        ],
        column.x +
          3,
        y +
          7,
        {
          width:
            column.width -
            7,
          align:
            column.align,
          lineGap:
            1,
        }
      );
  }

  return (
    y +
    rowHeight
  );
};


const drawProjectServiceHeader = ({
  doc,
  y,
}) => {
  const columns =
    [
      {
        key:
          "description",
        label:
          "DESCRIPCIÓN",
        x:
          34,
        width:
          278,
        align:
          "left",
      },
      {
        key:
          "quantity",
        label:
          "CANTIDAD",
        x:
          312,
        width:
          56,
        align:
          "right",
      },
      {
        key:
          "unit",
        label:
          "UNIDAD",
        x:
          368,
        width:
          52,
        align:
          "center",
      },
      {
        key:
          "unitPrice",
        label:
          "VALOR UNIT.",
        x:
          420,
        width:
          70,
        align:
          "right",
      },
      {
        key:
          "total",
        label:
          "TOTAL",
        x:
          490,
        width:
          71,
        align:
          "right",
      },
    ];

  doc
    .rect(
      34,
      y,
      527,
      22
    )
    .fillColor(
      "#111111"
    )
    .fill();

  for (
    const column
    of columns
  ) {
    doc
      .font(
        "Helvetica-Bold"
      )
      .fontSize(
        5.8
      )
      .fillColor(
        "#ffffff"
      )
      .text(
        column.label,
        column.x +
          4,
        y +
          7,
        {
          width:
            column.width -
            8,
          align:
            column.align,
        }
      );
  }

  return {
    columns,
    y:
      y +
      22,
  };
};


const drawProjectServiceRow = ({
  doc,
  line,
  columns,
  y,
}) => {
  const values = {
    description:
      cleanText(
        line
          .description
      ) ||
      "—",

    quantity:
      formatNumber(
        line
          .quantity,
        3
      ),

    unit:
      cleanText(
        line.unit
      ) ||
      "—",

    unitPrice:
      money(
        line
          .unit_price_gross
      ),

    total:
      money(
        line
          .line_total_gross
      ),
  };

  const descriptionHeight =
    doc
      .font(
        "Helvetica"
      )
      .fontSize(
        6.5
      )
      .heightOfString(
        values
          .description,
        {
          width:
            268,
          lineGap:
            1,
        }
      );

  const rowHeight =
    Math.max(
      24,
      descriptionHeight +
        11
    );

  doc
    .rect(
      34,
      y,
      527,
      rowHeight
    )
    .fillColor(
      "#ffffff"
    )
    .fill()
    .strokeColor(
      "#dddddd"
    )
    .lineWidth(
      0.5
    )
    .stroke();

  for (
    const column
    of columns
  ) {
    doc
      .font(
        column.key ===
          "total"
          ? "Helvetica-Bold"
          : "Helvetica"
      )
      .fontSize(
        6.5
      )
      .fillColor(
        "#222222"
      )
      .text(
        values[
          column.key
        ],
        column.x +
          4,
        y +
          7,
        {
          width:
            column.width -
            8,
          align:
            column.align,
        }
      );
  }

  return (
    y +
    rowHeight
  );
};


const drawProjectTermsBlock = ({
  doc,
  title,
  body,
  y,
  labelWidth = 0,
}) => {
  const x =
    34;

  const width =
    doc.page.width -
    68;

  const titleHeight =
    23;

  const normalizedBody =
    Array.isArray(
      body
    )
      ? body
      : [
          body,
        ];

  let bodyHeight =
    0;

  for (
    const paragraph
    of normalizedBody
  ) {
    bodyHeight +=
      doc
        .font(
          "Helvetica"
        )
        .fontSize(
          7.4
        )
        .heightOfString(
          cleanText(
            paragraph
          ),
          {
            width:
              width -
              34,
            lineGap:
              2,
          }
        ) +
      7;
  }

  bodyHeight =
    Math.max(
      bodyHeight +
        12,
      40
    );

  doc
    .roundedRect(
      x,
      y,
      width,
      titleHeight +
        bodyHeight,
      3
    )
    .fillColor(
      "#f8f8f8"
    )
    .fill();

  doc
    .rect(
      x,
      y,
      width,
      titleHeight
    )
    .fillColor(
      "#efefef"
    )
    .fill();

  doc
    .font(
      "Helvetica-Bold"
    )
    .fontSize(
      7
    )
    .fillColor(
      "#222222"
    )
    .text(
      title.toUpperCase(),
      x +
        14,
      y +
        8,
      {
        width:
          width -
          28,
      }
    );

  let textY =
    y +
    titleHeight +
    10;

  for (
    const paragraph
    of normalizedBody
  ) {
    doc
      .font(
        "Helvetica"
      )
      .fontSize(
        7.4
      )
      .fillColor(
        "#333333"
      )
      .text(
        cleanText(
          paragraph
        ),
        x +
          14,
        textY,
        {
          width:
            width -
            28,
          lineGap:
            2,
        }
      );

    textY =
      doc.y +
      6;
  }

  return (
    y +
    titleHeight +
    bodyHeight +
    9
  );
};



/* =========================================
   ANEXO TÉCNICO · BAÑOS
   Mantiene intacta la cotización comercial
   y agrega el despiece desde la página 3.
========================================= */
const safePdfNumber = (
  value,
  fallback = 0
) => {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
};

const getBathroomOptimizationData =
  (snapshot) => {
    if (
      !snapshot ||
      typeof snapshot !== "object"
    ) {
      return null;
    }

    const optimization =
      snapshot.optimization ||
      snapshot.optimization_json ||
      snapshot.data ||
      null;

    if (
      !optimization ||
      typeof optimization !== "object"
    ) {
      return null;
    }

    return optimization;
  };

const getBathroomPieceType =
  (piece) =>
    cleanText(
      piece?.type ||
      piece?.partType ||
      piece?.kind ||
      piece?.pieceType ||
      piece?.label ||
      piece?.name ||
      "Pieza"
    ) || "Pieza";

const getBathroomPieceMaterial =
  (piece) =>
    cleanText(
      piece?.materialCode ||
      piece?.material_code ||
      piece?.material?.code ||
      piece?.material ||
      "—"
    ) || "—";

const aggregateBathroomPieces =
  (pieces = []) => {
    const grouped =
      new Map();

    for (
      const piece
      of Array.isArray(pieces)
        ? pieces
        : []
    ) {
      const type =
        getBathroomPieceType(
          piece
        );

      const material =
        getBathroomPieceMaterial(
          piece
        );

      const width =
        safePdfNumber(
          piece?.width,
          0
        );

      const height =
        safePdfNumber(
          piece?.height,
          0
        );

      const key =
        [
          type,
          material,
          width,
          height,
        ].join("|");

      const current =
        grouped.get(key) || {
          type,
          material,
          width,
          height,
          quantity: 0,
        };

      current.quantity += 1;

      grouped.set(
        key,
        current
      );
    }

    return [
      ...grouped.values(),
    ].sort(
      (a, b) =>
        a.material.localeCompare(
          b.material
        ) ||
        a.type.localeCompare(
          b.type
        ) ||
        b.width - a.width ||
        b.height - a.height
    );
  };

const drawBathroomMetricCard = ({
  doc,
  x,
  y,
  width,
  label,
  value,
}) => {
  doc
    .roundedRect(
      x,
      y,
      width,
      55,
      3
    )
    .fillColor(
      "#f6f6f6"
    )
    .fill();

  doc
    .font(
      "Helvetica"
    )
    .fontSize(
      5.8
    )
    .fillColor(
      "#888888"
    )
    .text(
      String(label || "")
        .toUpperCase(),
      x + 10,
      y + 10,
      {
        width:
          width - 20,
      }
    );

  doc
    .font(
      "Helvetica-Bold"
    )
    .fontSize(
      15
    )
    .fillColor(
      "#111111"
    )
    .text(
      String(value ?? "—"),
      x + 10,
      y + 26,
      {
        width:
          width - 20,
      }
    );
};

const drawBathroomMaterialSummary = ({
  doc,
  materials,
  y,
}) => {
  const x = 34;
  const width = 527;
  const columns = [
    {
      label: "MATERIAL",
      x,
      width: 170,
      align: "left",
    },
    {
      label: "ESPESOR",
      x: x + 170,
      width: 75,
      align: "right",
    },
    {
      label: "PLACAS",
      x: x + 245,
      width: 70,
      align: "right",
    },
    {
      label: "APROV.",
      x: x + 315,
      width: 95,
      align: "right",
    },
    {
      label: "DESPERDICIO",
      x: x + 410,
      width: 117,
      align: "right",
    },
  ];

  doc
    .rect(
      x,
      y,
      width,
      25
    )
    .fillColor(
      "#111111"
    )
    .fill();

  for (
    const column
    of columns
  ) {
    doc
      .font("Helvetica-Bold")
      .fontSize(5.5)
      .fillColor("#ffffff")
      .text(
        column.label,
        column.x + 5,
        y + 8,
        {
          width:
            column.width - 10,
          align:
            column.align,
        }
      );
  }

  let rowY =
    y + 25;

  for (
    const group
    of materials
  ) {
    const material =
      group?.material || {};

    const metrics =
      group?.optimization
        ?.metrics || {};

    const values = [
      cleanText(
        material.code ||
        material.label
      ) || "—",
      material.thickness !== undefined &&
      material.thickness !== null
        ? `${formatNumber(
            material.thickness
          )} mm`
        : "—",
      formatNumber(
        metrics.sheetsRequired || 0
      ),
      `${formatNumber(
        metrics.utilization || 0,
        2
      )}%`,
      `${formatNumber(
        metrics.wastePercentage || 0,
        2
      )}%`,
    ];

    const rowHeight =
      25;

    doc
      .rect(
        x,
        rowY,
        width,
        rowHeight
      )
      .fillColor("#ffffff")
      .fill()
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .stroke();

    columns.forEach(
      (
        column,
        index
      ) => {
        doc
          .font(
            index === 0
              ? "Helvetica-Bold"
              : "Helvetica"
          )
          .fontSize(6.2)
          .fillColor("#222222")
          .text(
            values[index],
            column.x + 5,
            rowY + 8,
            {
              width:
                column.width - 10,
              align:
                column.align,
            }
          );
      }
    );

    rowY +=
      rowHeight;
  }

  return rowY;
};

const drawBathroomPiecesTable = ({
  doc,
  pieces,
  quotation,
  y,
}) => {
  const rows =
    aggregateBathroomPieces(
      pieces
    );

  let currentY = y;

  const drawHeader = () => {
    currentY =
      drawProjectSectionTitle({
        doc,
        title:
          "Despiece calculado",
        y:
          currentY,
      });

    doc
      .rect(
        34,
        currentY,
        527,
        25
      )
      .fillColor("#111111")
      .fill();

    const headerColumns = [
      ["PIEZA", 34, 165, "left"],
      ["MATERIAL", 199, 145, "left"],
      ["MEDIDA", 344, 135, "right"],
      ["CANT.", 479, 82, "right"],
    ];

    for (
      const [
        label,
        x,
        width,
        align,
      ]
      of headerColumns
    ) {
      doc
        .font("Helvetica-Bold")
        .fontSize(5.5)
        .fillColor("#ffffff")
        .text(
          label,
          x + 5,
          currentY + 8,
          {
            width:
              width - 10,
            align,
          }
        );
    }

    currentY += 25;
  };

  drawHeader();

  if (
    rows.length === 0
  ) {
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#777777")
      .text(
        "El optimizador no informó piezas individuales.",
        34,
        currentY + 10
      );

    return currentY + 35;
  }

  for (
    const row
    of rows
  ) {
    if (
      currentY > 675
    ) {
      doc.addPage({
        size: "A4",
        margin: 0,
      });

      currentY =
        drawProjectDocumentHeader({
          doc,
          quotation,
          compact: true,
        });

      drawHeader();
    }

    doc
      .rect(
        34,
        currentY,
        527,
        24
      )
      .fillColor("#ffffff")
      .fill()
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .stroke();

    const values = [
      row.type,
      row.material,
      `${formatNumber(
        row.width
      )} × ${formatNumber(
        row.height
      )} mm`,
      formatNumber(
        row.quantity
      ),
    ];

    const cells = [
      [34, 165, "left"],
      [199, 145, "left"],
      [344, 135, "right"],
      [479, 82, "right"],
    ];

    cells.forEach(
      (
        [x, width, align],
        index
      ) => {
        doc
          .font(
            index === 0
              ? "Helvetica-Bold"
              : "Helvetica"
          )
          .fontSize(6.1)
          .fillColor("#222222")
          .text(
            values[index],
            x + 5,
            currentY + 7,
            {
              width:
                width - 10,
              align,
            }
          );
      }
    );

    currentY += 24;
  }

  return currentY;
};

const BATHROOM_PIECE_STYLES = {
  DIVIDER: {
    label: "Divisor",
    fill: "#DDF1CD",
    stroke: "#5E9D32",
  },
  DOOR: {
    label: "Puerta",
    fill: "#DCEEFF",
    stroke: "#3985C6",
  },
  PILASTER: {
    label: "Pilastra",
    fill: "#FFF0BF",
    stroke: "#C99A20",
  },
  UNKNOWN: {
    label: "Pieza",
    fill: "#ECECEC",
    stroke: "#777777",
  },
};

const getBathroomPlacementType =
  (placement) =>
    cleanText(
      placement
        ?.metadata
        ?.type ||
      placement?.type ||
      placement?.partType ||
      placement?.kind ||
      "UNKNOWN"
    )
      .toUpperCase();

const getBathroomPlacementStyle =
  (placement) => {
    const type =
      getBathroomPlacementType(
        placement
      );

    return (
      BATHROOM_PIECE_STYLES[
        type
      ] ||
      BATHROOM_PIECE_STYLES
        .UNKNOWN
    );
  };

const aggregateBathroomSheetCuts =
  (sheet) => {
    const grouped =
      new Map();

    const placements =
      Array.isArray(
        sheet?.placements
      )
        ? sheet.placements
        : [];

    for (
      const placement
      of placements
    ) {
      const type =
        getBathroomPlacementType(
          placement
        );

      const width =
        safePdfNumber(
          placement?.width,
          0
        );

      const height =
        safePdfNumber(
          placement?.height,
          0
        );

      const key =
        `${type}|${width}|${height}`;

      const current =
        grouped.get(key) || {
          type,
          width,
          height,
          quantity: 0,
        };

      current.quantity += 1;

      grouped.set(
        key,
        current
      );
    }

    return [
      ...grouped.values(),
    ];
  };

const getBathroomSheetCutSummary =
  (sheet) =>
    aggregateBathroomSheetCuts(
      sheet
    )
      .map((cut) => {
        const style =
          BATHROOM_PIECE_STYLES[
            cut.type
          ] ||
          BATHROOM_PIECE_STYLES
            .UNKNOWN;

        return `${style.label} ×${formatNumber(
          cut.quantity
        )} · ${formatNumber(
          cut.width
        )} × ${formatNumber(
          cut.height
        )} mm`;
      })
      .join("  |  ");

const drawBathroomLegend = ({
  doc,
  x,
  y,
  width,
}) => {
  doc
    .font("Helvetica-Bold")
    .fontSize(7.2)
    .fillColor("#111111")
    .text(
      "LEYENDA · TIPOS DE PIEZA",
      x,
      y,
      {
        width,
      }
    );

  let rowY =
    y + 18;

  const items = [
    [
      "DIVIDER",
      "Panel divisor",
    ],
    [
      "DOOR",
      "Hoja de puerta",
    ],
    [
      "PILASTER",
      "Pilastra / remate",
    ],
  ];

  for (
    const [
      type,
      description,
    ]
    of items
  ) {
    const style =
      BATHROOM_PIECE_STYLES[
        type
      ];

    doc
      .roundedRect(
        x,
        rowY,
        18,
        11,
        2
      )
      .fillColor(
        style.fill
      )
      .fill()
      .strokeColor(
        style.stroke
      )
      .lineWidth(0.7)
      .stroke();

    doc
      .font("Helvetica-Bold")
      .fontSize(6)
      .fillColor("#222222")
      .text(
        style.label,
        x + 26,
        rowY - 1,
        {
          width:
            width - 26,
        }
      );

    doc
      .font("Helvetica")
      .fontSize(5.1)
      .fillColor("#777777")
      .text(
        description,
        x + 26,
        rowY + 7,
        {
          width:
            width - 26,
        }
      );

    rowY += 27;
  }

  doc
    .rect(
      x,
      rowY,
      18,
      11
    )
    .fillColor("#ffffff")
    .fill()
    .strokeColor("#999999")
    .lineWidth(0.6)
    .dash(3, {
      space: 2,
    })
    .stroke()
    .undash();

  doc
    .font("Helvetica-Bold")
    .fontSize(6)
    .fillColor("#222222")
    .text(
      "Desperdicio",
      x + 26,
      rowY - 1,
      {
        width:
          width - 26,
      }
    );

  doc
    .font("Helvetica")
    .fontSize(5.1)
    .fillColor("#777777")
    .text(
      "Área no utilizada",
      x + 26,
      rowY + 7,
      {
        width:
          width - 26,
      }
    );

  return rowY + 19;
};

const drawBathroomSheetCard = ({
  doc,
  x,
  y,
  width,
  height,
  sheet,
  sheetIndex,
  material,
}) => {
  doc
    .roundedRect(
      x,
      y,
      width,
      height,
      4
    )
    .fillColor("#fafafa")
    .fill()
    .strokeColor("#d9d9d9")
    .lineWidth(0.7)
    .stroke();

  const sheetWidth =
    safePdfNumber(
      material?.sheetWidth ||
      sheet?.width,
      1220
    );

  const sheetHeight =
    safePdfNumber(
      material?.sheetHeight ||
      sheet?.height,
      3050
    );

  doc
    .font("Helvetica-Bold")
    .fontSize(7.2)
    .fillColor("#111111")
    .text(
      `PLACA ${sheetIndex + 1}`,
      x + 10,
      y + 9,
      {
        width:
          width - 20,
      }
    );

  doc
    .font("Helvetica")
    .fontSize(5.8)
    .fillColor("#777777")
    .text(
      `${formatNumber(
        sheetWidth
      )} × ${formatNumber(
        sheetHeight
      )} mm`,
      x + 10,
      y + 10,
      {
        width:
          width - 20,
        align: "right",
      }
    );

  const sheetCutSummary =
    getBathroomSheetCutSummary(
      sheet
    );

  if (sheetCutSummary) {
    doc
      .font("Helvetica-Bold")
      .fontSize(4.7)
      .fillColor("#555555")
      .text(
        sheetCutSummary,
        x + 10,
        y + 24,
        {
          width:
            width - 20,
          align: "center",
          ellipsis: true,
          lineBreak: false,
        }
      );
  }

  const maxDiagramWidth =
    width - 62;

  const maxDiagramHeight =
    height - 72;

  const scale =
    Math.min(
      maxDiagramWidth /
        sheetWidth,
      maxDiagramHeight /
        sheetHeight
    );

  const diagramWidth =
    sheetWidth * scale;

  const diagramHeight =
    sheetHeight * scale;

  const diagramX =
    x +
    (width - diagramWidth) /
      2 +
    4;

  const diagramY =
    y + 53;

  /*
   * Cota horizontal de la placa.
   */
  const topDimY =
    diagramY - 10;

  doc
    .moveTo(
      diagramX,
      topDimY
    )
    .lineTo(
      diagramX +
        diagramWidth,
      topDimY
    )
    .strokeColor("#555555")
    .lineWidth(0.45)
    .stroke();

  doc
    .moveTo(
      diagramX,
      topDimY - 2
    )
    .lineTo(
      diagramX,
      topDimY + 2
    )
    .stroke();

  doc
    .moveTo(
      diagramX +
        diagramWidth,
      topDimY - 2
    )
    .lineTo(
      diagramX +
        diagramWidth,
      topDimY + 2
    )
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(4.8)
    .fillColor("#333333")
    .text(
      `${formatNumber(
        sheetWidth
      )} mm`,
      diagramX,
      topDimY - 8,
      {
        width:
          diagramWidth,
        align: "center",
      }
    );

  /*
   * Cota vertical de la placa.
   */
  const leftDimX =
    diagramX - 9;

  doc
    .moveTo(
      leftDimX,
      diagramY
    )
    .lineTo(
      leftDimX,
      diagramY +
        diagramHeight
    )
    .strokeColor("#555555")
    .lineWidth(0.45)
    .stroke();

  doc
    .moveTo(
      leftDimX - 2,
      diagramY
    )
    .lineTo(
      leftDimX + 2,
      diagramY
    )
    .stroke();

  doc
    .moveTo(
      leftDimX - 2,
      diagramY +
        diagramHeight
    )
    .lineTo(
      leftDimX + 2,
      diagramY +
        diagramHeight
    )
    .stroke();

  doc
    .save()
    .font("Helvetica")
    .fontSize(4.8)
    .fillColor("#333333")
    .rotate(
      -90,
      {
        origin: [
          leftDimX - 8,
          diagramY +
            diagramHeight /
              2,
        ],
      }
    )
    .text(
      `${formatNumber(
        sheetHeight
      )} mm`,
      leftDimX -
        8 -
        diagramHeight /
          2,
      diagramY +
        diagramHeight /
          2 -
        3,
      {
        width:
          diagramHeight,
        align: "center",
        lineBreak: false,
      }
    )
    .restore();

  doc
    .rect(
      diagramX,
      diagramY,
      diagramWidth,
      diagramHeight
    )
    .fillColor("#ffffff")
    .fill()
    .strokeColor("#111111")
    .lineWidth(0.9)
    .stroke();

  const placements =
    Array.isArray(
      sheet?.placements
    )
      ? sheet.placements
      : [];

  placements.forEach(
    (
      placement,
      placementIndex
    ) => {
      const px =
        diagramX +
        safePdfNumber(
          placement?.x,
          0
        ) * scale;

      const py =
        diagramY +
        safePdfNumber(
          placement?.y,
          0
        ) * scale;

      const pieceWidthMm =
        safePdfNumber(
          placement?.width,
          0
        );

      const pieceHeightMm =
        safePdfNumber(
          placement?.height,
          0
        );

      const pw =
        pieceWidthMm *
        scale;

      const ph =
        pieceHeightMm *
        scale;

      if (
        pw <= 0 ||
        ph <= 0
      ) {
        return;
      }

      const style =
        getBathroomPlacementStyle(
          placement
        );

      doc
        .rect(
          px,
          py,
          pw,
          ph
        )
        .fillColor(
          style.fill
        )
        .fill()
        .strokeColor(
          style.stroke
        )
        .lineWidth(0.65)
        .stroke();

      const label =
        cleanText(
          placement?.instanceId ||
          placement?.pieceId ||
          placement?.id
        ) ||
        `P${placementIndex + 1}`;

      if (
        pw >= 28 &&
        ph >= 25
      ) {
        doc
          .font("Helvetica-Bold")
          .fontSize(4.5)
          .fillColor("#222222")
          .text(
            label,
            px + 2,
            py + 4,
            {
              width:
                Math.max(
                  pw - 4,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          );

        doc
          .font("Helvetica")
          .fontSize(4.1)
          .fillColor("#333333")
          .text(
            style.label,
            px + 2,
            py + 13,
            {
              width:
                Math.max(
                  pw - 4,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          );

        doc
          .font("Helvetica-Bold")
          .fontSize(4.2)
          .fillColor("#222222")
          .text(
            `${formatNumber(
              pieceWidthMm
            )} × ${formatNumber(
              pieceHeightMm
            )} mm`,
            px + 2,
            py + 21,
            {
              width:
                Math.max(
                  pw - 4,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          );
      } else if (
        pw >= 20 &&
        ph >= 28
      ) {
        /*
         * Formato compacto para puertas u otras piezas
         * que no alcanzan a mostrar el ID completo.
         */
        doc
          .font("Helvetica-Bold")
          .fontSize(3.7)
          .fillColor("#222222")
          .text(
            style.label,
            px + 1,
            py + 6,
            {
              width:
                Math.max(
                  pw - 2,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          );

        doc
          .font("Helvetica-Bold")
          .fontSize(3.35)
          .fillColor("#222222")
          .text(
            `${formatNumber(
              pieceWidthMm
            )}×${formatNumber(
              pieceHeightMm
            )}`,
            px + 1,
            py + 15,
            {
              width:
                Math.max(
                  pw - 2,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          );
      } else if (
        pw >= 5 &&
        ph >= 35
      ) {
        /*
         * Las pilastras son demasiado angostas para
         * texto horizontal. Se muestra su medida
         * rotada dentro de la pieza.
         */
        const centerX =
          px + pw / 2;

        const centerY =
          py + ph / 2;

        doc
          .save()
          .font("Helvetica-Bold")
          .fontSize(2.9)
          .fillColor("#333333")
          .rotate(
            -90,
            {
              origin: [
                centerX,
                centerY,
              ],
            }
          )
          .text(
            `${formatNumber(
              pieceWidthMm
            )} × ${formatNumber(
              pieceHeightMm
            )} mm`,
            centerX -
              ph / 2 + 2,
            centerY - 2,
            {
              width:
                Math.max(
                  ph - 4,
                  1
                ),
              align: "center",
              ellipsis: true,
              lineBreak: false,
            }
          )
          .restore();
      }
    }
  );
};

const drawBathroomCutDetailPanel = ({
  doc,
  x,
  y,
  width,
  height,
  sheets,
  startIndex,
  metrics,
  material,
}) => {
  doc
    .roundedRect(
      x,
      y,
      width,
      height,
      4
    )
    .fillColor("#ffffff")
    .fill()
    .strokeColor("#d9d9d9")
    .lineWidth(0.7)
    .stroke();

  const inset =
    12;

  let currentY =
    y + 12;

  currentY =
    drawBathroomLegend({
      doc,
      x:
        x + inset,
      y:
        currentY,
      width:
        width -
        inset * 2,
    });

  currentY += 9;

  doc
    .moveTo(
      x + inset,
      currentY
    )
    .lineTo(
      x +
        width -
        inset,
      currentY
    )
    .strokeColor("#e2e2e2")
    .lineWidth(0.5)
    .stroke();

  currentY += 10;

  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor("#111111")
    .text(
      "DETALLE DE CORTES POR PLACA",
      x + inset,
      currentY,
      {
        width:
          width -
          inset * 2,
      }
    );

  currentY += 16;

  for (
    let sheetOffset = 0;
    sheetOffset <
    sheets.length;
    sheetOffset += 1
  ) {
    const sheet =
      sheets[sheetOffset];

    const rows =
      aggregateBathroomSheetCuts(
        sheet
      );

    doc
      .font("Helvetica-Bold")
      .fontSize(5.8)
      .fillColor("#111111")
      .text(
        `PLACA ${startIndex + sheetOffset + 1}`,
        x + inset,
        currentY,
        {
          width:
            42,
        }
      );

    let rowY =
      currentY;

    if (
      rows.length === 0
    ) {
      doc
        .font("Helvetica")
        .fontSize(5.2)
        .fillColor("#777777")
        .text(
          "Sin piezas",
          x +
            inset +
            46,
          rowY,
          {
            width:
              width -
              inset * 2 -
              46,
          }
        );

      currentY += 15;
      continue;
    }

    rows.forEach(
      (
        row,
        rowIndex
      ) => {
        const style =
          BATHROOM_PIECE_STYLES[
            row.type
          ] ||
          BATHROOM_PIECE_STYLES
            .UNKNOWN;

        if (
          rowIndex > 0
        ) {
          rowY += 13;
        }

        doc
          .roundedRect(
            x +
              inset +
              46,
            rowY - 1,
            7,
            7,
            1
          )
          .fillColor(
            style.fill
          )
          .fill()
          .strokeColor(
            style.stroke
          )
          .lineWidth(0.45)
          .stroke();

        doc
          .font("Helvetica")
          .fontSize(5)
          .fillColor("#333333")
          .text(
            `${style.label} ×${row.quantity}`,
            x +
              inset +
              57,
            rowY - 1,
            {
              width:
                55,
              ellipsis: true,
              lineBreak: false,
            }
          );

        doc
          .font("Helvetica")
          .fontSize(4.9)
          .fillColor("#555555")
          .text(
            `${formatNumber(
              row.width
            )} × ${formatNumber(
              row.height
            )}`,
            x +
              width -
              inset -
              66,
            rowY - 1,
            {
              width:
                66,
              align: "right",
              lineBreak: false,
            }
          );
      }
    );

    currentY =
      rowY +
      16;

    if (
      currentY >
      y + height - 86
    ) {
      break;
    }
  }

  const summaryY =
    y + height - 69;

  doc
    .roundedRect(
      x + inset,
      summaryY,
      width -
        inset * 2,
      54,
      3
    )
    .fillColor("#F4F8EB")
    .fill();

  doc
    .font("Helvetica-Bold")
    .fontSize(6.4)
    .fillColor("#4D7600")
    .text(
      "RESUMEN DEL MATERIAL",
      x + inset + 10,
      summaryY + 9,
      {
        width:
          width -
          inset * 2 -
          20,
      }
    );

  const materialCode =
    cleanText(
      material?.code ||
      material?.label
    ) || "Material";

  doc
    .font("Helvetica")
    .fontSize(5.3)
    .fillColor("#333333")
    .text(
      `${materialCode} · ${formatNumber(
        metrics.sheetsRequired || 0
      )} placas`,
      x + inset + 10,
      summaryY + 23,
      {
        width:
          width -
          inset * 2 -
          20,
      }
    );

  doc
    .font("Helvetica")
    .fontSize(5.1)
    .fillColor("#555555")
    .text(
      `Aprovechamiento ${formatNumber(
        metrics.utilization || 0,
        2
      )}% · Desperdicio ${formatNumber(
        metrics.wastePercentage || 0,
        2
      )}% · Kerf ${formatNumber(
        metrics.kerf || 0,
        2
      )} mm`,
      x + inset + 10,
      summaryY + 36,
      {
        width:
          width -
          inset * 2 -
          20,
        lineGap: 1,
      }
    );
};

const drawBathroomOptimizationAnnex = ({
  doc,
  quotation,
  snapshot,
}) => {
  const optimization =
    getBathroomOptimizationData(
      snapshot
    );

  if (!optimization) {
    return;
  }

  const totals =
    optimization.totals || {};

  const materials =
    Array.isArray(
      optimization.materials
    )
      ? optimization.materials
      : [];

  const generatedPieces =
    Array.isArray(
      optimization.generatedPieces
    )
      ? optimization.generatedPieces
      : [];

  /*
   * Página resumen del anexo en formato vertical.
   */
  doc.addPage({
    size: "A4",
    margin: 0,
  });

  let y =
    drawProjectDocumentHeader({
      doc,
      quotation,
      compact: true,
    });

  y =
    drawProjectSectionTitle({
      doc,
      title:
        "Anexo técnico · Despiece optimizado",
      y,
    });

  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#666666")
    .text(
      "Este anexo corresponde al cálculo técnico de corte asociado a la cotización. Las cantidades comerciales de placas de la página principal se obtienen de este resultado.",
      34,
      y,
      {
        width: 527,
        lineGap: 2,
      }
    );

  y =
    doc.y + 16;

  const cardGap = 8;
  const cardWidth =
    (527 - cardGap * 3) /
    4;

  const metricCards = [
    [
      "Placas",
      formatNumber(
        totals.sheetsRequired || 0
      ),
    ],
    [
      "Piezas",
      formatNumber(
        totals.pieces ||
        generatedPieces.length ||
        0
      ),
    ],
    [
      "Materiales",
      formatNumber(
        totals.materialGroups ||
        materials.length ||
        0
      ),
    ],
    [
      "Optimizer",
      cleanText(
        optimization.optimizerVersion ||
        snapshot?.optimizer_version
      ) || "—",
    ],
  ];

  metricCards.forEach(
    (
      [label, value],
      index
    ) =>
      drawBathroomMetricCard({
        doc,
        x:
          34 +
          index *
            (cardWidth + cardGap),
        y,
        width:
          cardWidth,
        label,
        value,
      })
  );

  y += 72;

  y =
    drawProjectSectionTitle({
      doc,
      title:
        "Resumen por material",
      y,
    });

  y =
    drawBathroomMaterialSummary({
      doc,
      materials,
      y,
    });

  y += 20;

  drawBathroomPiecesTable({
    doc,
    pieces:
      generatedPieces,
    quotation,
    y,
  });

  /*
   * Los patrones pasan a A4 horizontal para que
   * las piezas, cotas y la tabla sean legibles.
   */
  for (
    const group
    of materials
  ) {
    const material =
      group?.material || {};

    const sheets =
      Array.isArray(
        group?.optimization
          ?.sheets
      )
        ? group.optimization
            .sheets
        : [];

    if (
      sheets.length === 0
    ) {
      continue;
    }

    for (
      let start = 0;
      start < sheets.length;
      start += 4
    ) {
      doc.addPage({
        size: "A4",
        layout: "landscape",
        margin: 0,
      });

      let pageY =
        drawProjectDocumentHeader({
          doc,
          quotation,
          compact: true,
        });

      const materialLabel =
        [
          cleanText(
            material.code ||
            material.label
          ) || "Material",
          material.thickness !== undefined &&
          material.thickness !== null
            ? `${formatNumber(
                material.thickness
              )} mm`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

      pageY =
        drawProjectSectionTitle({
          doc,
          title:
            `Patrones de corte · ${materialLabel}`,
          y:
            pageY,
        });

      const metrics =
        group?.optimization
          ?.metrics || {};

      const pageWidth =
        doc.page.width;

      const contentWidth =
        pageWidth - 68;

      doc
        .font("Helvetica")
        .fontSize(6.6)
        .fillColor("#666666")
        .text(
          `Placas: ${formatNumber(
            metrics.sheetsRequired ||
            sheets.length
          )} · Aprovechamiento: ${formatNumber(
            metrics.utilization || 0,
            2
          )}% · Desperdicio: ${formatNumber(
            metrics.wastePercentage || 0,
            2
          )}% · Kerf: ${formatNumber(
            metrics.kerf || 0,
            2
          )} mm`,
          34,
          pageY,
          {
            width:
              contentWidth,
          }
        );

      pageY += 21;

      const chunk =
        sheets.slice(
          start,
          start + 4
        );

      const sidebarWidth =
        190;

      const layoutGap =
        14;

      const drawingWidth =
        contentWidth -
        sidebarWidth -
        layoutGap;

      const cardGapX =
        12;

      const cardGapY =
        12;

      const cardWidth =
        (drawingWidth -
          cardGapX) /
        2;

      const bottomLimit =
        doc.page.height -
        54;

      const availableHeight =
        bottomLimit -
        pageY;

      const cardHeight =
        (availableHeight -
          cardGapY) /
        2;

      chunk.forEach(
        (
          sheet,
          index
        ) => {
          const column =
            index % 2;

          const row =
            Math.floor(
              index / 2
            );

          drawBathroomSheetCard({
            doc,
            x:
              34 +
              column *
                (cardWidth +
                  cardGapX),
            y:
              pageY +
              row *
                (cardHeight +
                  cardGapY),
            width:
              cardWidth,
            height:
              cardHeight,
            sheet,
            sheetIndex:
              start + index,
            material,
          });
        }
      );

      drawBathroomCutDetailPanel({
        doc,
        x:
          34 +
          drawingWidth +
          layoutGap,
        y:
          pageY,
        width:
          sidebarWidth,
        height:
          availableHeight,
        sheets:
          chunk,
        startIndex:
          start,
        metrics,
        material,
      });
    }
  }
};

const buildProjectQuotationPdfBuffer =
  async ({
    quotation,
    project_lines = [],
    bathroom_optimization = null,
  }) => {
    return new Promise(
      (
        resolve,
        reject
      ) => {
        try {
          const doc =
            new PDFDocument({
              size:
                "A4",
              margin:
                0,
              bufferPages:
                true,
              info: {
                Title:
                  `Cotización ${quotation.quote_number}`,
                Author:
                  "Laminati World",
                Subject:
                  "Cotización de proyecto",
              },
            });

          const chunks =
            [];

          doc.on(
            "data",
            (
              chunk
            ) =>
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

          const productLines =
            project_lines.filter(
              (
                line
              ) =>
                line
                  .line_type ===
                "PRODUCT"
            );

          const extraLines =
            project_lines.filter(
              (
                line
              ) =>
                line
                  .line_type !==
                "PRODUCT"
            );

          let y =
            drawProjectDocumentHeader({
              doc,
              quotation,
            });

          y =
            drawProjectInfoPanel({
              doc,
              quotation,
              y,
            });

          y =
            drawProjectSectionTitle({
              doc,
              title:
                "Detalle de productos",
              y,
            });

          let productHeader =
            drawProjectProductHeader({
              doc,
              y,
            });

          let productColumns =
            productHeader
              .columns;

          y =
            productHeader.y;

          if (
            productLines
              .length ===
            0
          ) {
            doc
              .font(
                "Helvetica"
              )
              .fontSize(
                7
              )
              .fillColor(
                "#777777"
              )
              .text(
                "Sin productos asociados.",
                34,
                y +
                  10
              );

            y += 34;
          } else {
            for (
              const line
              of productLines
            ) {
              if (
                y >
                640
              ) {
                doc.addPage({
                  size:
                    "A4",
                  margin:
                    0,
                });

                y =
                  drawProjectDocumentHeader({
                    doc,
                    quotation,
                    compact:
                      true,
                  });

                y =
                  drawProjectSectionTitle({
                    doc,
                    title:
                      "Detalle de productos · continuación",
                    y,
                  });

                productHeader =
                  drawProjectProductHeader({
                    doc,
                    y,
                  });

                productColumns =
                  productHeader
                    .columns;

                y =
                  productHeader.y;
              }

              y =
                drawProjectProductRow({
                  doc,
                  line,
                  columns:
                    productColumns,
                  y,
                });
            }
          }

          if (
            extraLines
              .length >
            0
          ) {
            if (
              y >
              600
            ) {
              doc.addPage({
                size:
                  "A4",
                margin:
                  0,
              });

              y =
                drawProjectDocumentHeader({
                  doc,
                  quotation,
                  compact:
                    true,
                });
            } else {
              y += 22;
            }

            y =
              drawProjectSectionTitle({
                doc,
                title:
                  "Servicios y otros",
                y,
              });

            let serviceHeader =
              drawProjectServiceHeader({
                doc,
                y,
              });

            let serviceColumns =
              serviceHeader
                .columns;

            y =
              serviceHeader.y;

            for (
              const line
              of extraLines
            ) {
              if (
                y >
                655
              ) {
                doc.addPage({
                  size:
                    "A4",
                  margin:
                    0,
                });

                y =
                  drawProjectDocumentHeader({
                    doc,
                    quotation,
                    compact:
                      true,
                  });

                y =
                  drawProjectSectionTitle({
                    doc,
                    title:
                      "Servicios y otros · continuación",
                    y,
                  });

                serviceHeader =
                  drawProjectServiceHeader({
                    doc,
                    y,
                  });

                serviceColumns =
                  serviceHeader
                    .columns;

                y =
                  serviceHeader.y;
              }

              y =
                drawProjectServiceRow({
                  doc,
                  line,
                  columns:
                    serviceColumns,
                  y,
                });
            }
          }

          if (
            y >
            670
          ) {
            doc.addPage({
              size:
                "A4",
              margin:
                0,
            });

            y =
              drawProjectDocumentHeader({
                doc,
                quotation,
                compact:
                  true,
              });
          } else {
            y += 22;
          }

          const totalsX =
            365;

          const totalsWidth =
            196;

          doc
            .roundedRect(
              totalsX,
              y,
              totalsWidth,
              92,
              3
            )
            .fillColor(
              "#f6f6f6"
            )
            .fill();

          const totals =
            [
              [
                "NETO",
                quotation
                  .net_total,
              ],
              [
                "IVA",
                quotation
                  .tax_total,
              ],
              [
                "TOTAL",
                quotation
                  .total,
              ],
            ];

          let totalY =
            y +
            15;

          for (
            const [
              label,
              value,
            ]
            of totals
          ) {
            const isTotal =
              label ===
              "TOTAL";

            if (
              isTotal
            ) {
              doc
                .moveTo(
                  totalsX +
                    15,
                  totalY -
                    5
                )
                .lineTo(
                  totalsX +
                    totalsWidth -
                    15,
                  totalY -
                    5
                )
                .strokeColor(
                  "#d7d7d7"
                )
                .stroke();
            }

            doc
              .font(
                isTotal
                  ? "Helvetica-Bold"
                  : "Helvetica"
              )
              .fontSize(
                isTotal
                  ? 10.5
                  : 7.8
              )
              .fillColor(
                "#222222"
              )
              .text(
                label,
                totalsX +
                  16,
                totalY,
                {
                  width:
                    50,
                }
              )
              .text(
                money(
                  value
                ),
                totalsX +
                  70,
                totalY,
                {
                  width:
                    totalsWidth -
                    86,
                  align:
                    "right",
                }
              );

            totalY +=
              isTotal
                ? 24
                : 20;
          }

          /*
           * La información corporativa y comercial se
           * genera automáticamente en una página separada.
           * Las observaciones continúan siendo dinámicas.
           */
          doc.addPage({
            size:
              "A4",
            margin:
              0,
          });

          y =
            drawProjectDocumentHeader({
              doc,
              quotation,
              compact:
                true,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Observaciones",
              body:
                cleanText(
                  quotation
                    .notes
                ) ||
                "Sin observaciones adicionales.",
              y,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Datos de facturación",
              body: [
                `Nombre: ${PROJECT_QUOTATION_STATIC_CONTENT.billing.name}`,
                `Dirección: ${PROJECT_QUOTATION_STATIC_CONTENT.billing.address}`,
                `Teléfonos: ${PROJECT_QUOTATION_STATIC_CONTENT.billing.phones}`,
                `Rut: ${PROJECT_QUOTATION_STATIC_CONTENT.billing.rut}`,
              ],
              y,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Datos para transferencias electrónicas nacionales",
              body: [
                `Nombre: ${PROJECT_QUOTATION_STATIC_CONTENT.nationalTransfer.name}`,
                `Rut: ${PROJECT_QUOTATION_STATIC_CONTENT.nationalTransfer.rut}`,
                `${PROJECT_QUOTATION_STATIC_CONTENT.nationalTransfer.bank}, ${PROJECT_QUOTATION_STATIC_CONTENT.nationalTransfer.account}`,
                `Mail: ${PROJECT_QUOTATION_STATIC_CONTENT.nationalTransfer.email}`,
              ],
              y,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Plazos pedidos especiales",
              body:
                PROJECT_QUOTATION_STATIC_CONTENT.specialOrders,
              y,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Condiciones de pago",
              body:
                PROJECT_QUOTATION_STATIC_CONTENT.paymentTerms,
              y,
            });

          y =
            drawProjectTermsBlock({
              doc,
              title:
                "Transferencias internacionales",
              body:
                PROJECT_QUOTATION_STATIC_CONTENT.internationalTransfer,
              y,
            });

          const noticeHeight =
            38;

          if (
            y +
              noticeHeight >
            doc.page.height -
              55
          ) {
            doc.addPage({
              size:
                "A4",
              margin:
                0,
            });

            y =
              drawProjectDocumentHeader({
                doc,
                quotation,
                compact:
                  true,
              });
          }

          doc
            .roundedRect(
              34,
              y,
              doc.page.width -
                68,
              noticeHeight,
              3
            )
            .fillColor(
              "#ece9e4"
            )
            .fill();

          doc
            .circle(
              52,
              y +
                19,
              9
            )
            .lineWidth(
              1
            )
            .strokeColor(
              "#333333"
            )
            .stroke();

          doc
            .font(
              "Helvetica-Bold"
            )
            .fontSize(
              8
            )
            .fillColor(
              "#111111"
            )
            .text(
              "!",
              49.4,
              y +
                13.2,
              {
                width:
                  6,
                align:
                  "center",
              }
            );

          doc
            .font(
              "Helvetica-Bold"
            )
            .fontSize(
              7.6
            )
            .fillColor(
              "#222222"
            )
            .text(
              PROJECT_QUOTATION_STATIC_CONTENT
                .guaranteeNotice,
              71,
              y +
                14,
              {
                width:
                  doc.page.width -
                  110,
              }
            );

          if (
            bathroom_optimization
          ) {
            drawBathroomOptimizationAnnex({
              doc,
              quotation,
              snapshot:
                bathroom_optimization,
            });
          }

          /*
           * Numeración final una vez conocidas todas
           * las páginas generadas por el detalle.
           */
          const range =
            doc.bufferedPageRange();

          const totalPages =
            range.count;

          for (
            let index = 0;
            index <
            totalPages;
            index += 1
          ) {
            doc.switchToPage(
              index
            );

            drawProjectFooter({
              doc,
              pageNumber:
                index +
                1,
              totalPages,
            });
          }

          doc.end();
        } catch (
          error
        ) {
          reject(
            error
          );
        }
      }
    );
  };

export const buildQuotationPdfBuffer =
  async ({
    quotation,
    items = [],
    project_lines = [],
    bathroom_optimization = null,
  }) => {
    if (
      cleanText(
        quotation
          ?.quotation_type
      ).toUpperCase() ===
      "PROJECT"
    ) {
      return buildProjectQuotationPdfBuffer({
        quotation,
        project_lines,
        bathroom_optimization,
      });
    }

    return buildStandardQuotationPdfBuffer({
      quotation,
      items,
    });
  };
