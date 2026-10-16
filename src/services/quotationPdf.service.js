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


const ABET_LAMINATI_LOGO_PATH =
  fileURLToPath(
    new URL(
      "../assets/abet-laminati-logo.png",
      import.meta.url
    )
  );

const drawAbetLaminatiLogo = ({
  doc,
  x,
  y,
  width,
  fallbackFontSize = 20,
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

    return true;
  }

  /*
   * Fallback de seguridad:
   * si el asset no se encuentra en el servidor,
   * mantiene la cabecera anterior para no impedir
   * la generación de cotizaciones.
   */
  doc
    .font("Helvetica-Bold")
    .fontSize(
      fallbackFontSize
    )
    .fillColor("#111111")
    .text(
      "LAMINATI",
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
          Author: "Laminati",
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
        drawAbetLaminatiLogo({
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

  const projectLogoDrawn =
    drawAbetLaminatiLogo({
      doc,
      x:
        margin - 9.5,
      y:
        compact
          ? 17
          : 20,
      width:
        compact
          ? 108
          : 124,
      fallbackFontSize:
        compact
          ? 17
          : 20,
    });

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
        margin ,
        compact
          ? 50
          : 55,
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
      projectLogoDrawn
        ? (
            compact
              ? 64
              : 72
          )
        : (
            compact
              ? 53
              : 60
          )
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
    compact
      ? 79
      : 88;

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

  doc
    .font(
      "Helvetica-Bold"
    )
    .fontSize(
      6.8
    )
    .fillColor(
      "#111111"
    )
    .text(
      "LAMINATI",
      34,
      footerY
    );

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
      155,
      footerY +
        1,
      {
        width:
          285,
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


const buildProjectQuotationPdfBuffer =
  async ({
    quotation,
    project_lines = [],
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
                  "Laminati",
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
      });
    }

    return buildStandardQuotationPdfBuffer({
      quotation,
      items,
    });
  };
