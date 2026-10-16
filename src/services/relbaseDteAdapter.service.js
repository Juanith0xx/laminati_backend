import {

  getTaxDocumentPreview,

} from "./taxDocumentPreview.service.js";

/* =========================================**

**   ERROR CONTROLADO**

**========================================= **/

const createServiceError = (

  message,

  status = 400,

  code = null

) => {

  const error =

    new Error(message);

  error.status =

    status;

  error.code =

    code;

  return error;

};

/* =========================================**

**   ENTERO POSITIVO DESDE ENV**

**========================================= **/

const getEnvInteger = (

  name,

  {

    required = false,

    defaultValue = null,

  } = {}

) => {

  const raw =

    process.env[name];

  if (

    raw === undefined ||

    raw === null ||

    String(raw).trim() === ""

  ) {

    if (required) {

      throw createServiceError(

        `Falta configuración ${name}`,

        500,

        "RELBASE_DTE_CONFIG_MISSING"

      );

    }

    return defaultValue;

  }

  const value =

    Number(raw);

  if (

    !Number.isInteger(value) ||

    value <= 0

  ) {

    throw createServiceError(

      `La configuración ${name} debe ser un entero positivo`,

      500,

      "RELBASE_DTE_CONFIG_INVALID"

    );

  }

  return value;

};

/* =========================================**

**   BOOLEAN DESDE ENV**

**========================================= **/

const getEnvBoolean = (

  name,

  defaultValue = false

) => {

  const raw =

    process.env[name];

  if (

    raw === undefined ||

    raw === null ||

    String(raw).trim() === ""

  ) {

    return defaultValue;

  }

  const normalized =

    String(raw)

      .trim()

      .toLowerCase();

  if (

    [

      "true",

      "1",

      "yes",

      "si",

      "sí",

    ].includes(normalized)

  ) {

    return true;

  }

  if (

    [

      "false",

      "0",

      "no",

    ].includes(normalized)

  ) {

    return false;

  }

  return defaultValue;

};

/* =========================================**

**   NÚMERO SEGURO**

**========================================= **/

const toNumber = (

  value,

  fallback = 0

) => {

  const number =

    Number(value);

  return Number.isFinite(number)

    ? number

    : fallback;

};





/* =========================================**

**   NÚMERO ESTRICTO**

**   A diferencia de toNumber(), no convierte**

**   valores inválidos a 0. Esto permite**

**   distinguir entre un 0 real y un dato**

**   inexistente/no numérico.**

**========================================= **/

const toStrictNumber = (

  value

) => {

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return null;

  }

  const number =

    Number(value);

  return Number.isFinite(number)

    ? number

    : null;

};

/* =========================================*

*   REDONDEO MONETARIO*

*========================================= */

const roundMoney = (value) => {

  const number = toStrictNumber(value);

  if (number === null) {

    return null;

  }

  return Math.round(

    (number + Number.EPSILON) * 100

  ) / 100;

};

/* =========================================*

*   TOTAL BRUTO DE ÍTEM*

*   La preparación tributaria almacena:*

*   - unit_price: neto para afectos.*

*   - total_amount: total final IVA incluido.*

*   El adapter acepta también variantes anidadas*

*   para no depender de una única forma del preview.*

*========================================= */

const resolveItemGrossTotal = (item) => {

  const directCandidates = [

    item?.total_amount,

    item?.amounts?.clp?.total,

    item?.amounts?.total,

  ];

  for (const candidate of directCandidates) {

    const value = toStrictNumber(candidate);

    if (value !== null && value >= 0) {

      return roundMoney(value);

    }

  }

  const net = toStrictNumber(

    item?.net_amount ??

      item?.amounts?.clp?.net ??

      item?.amounts?.net

  );

  const exempt = toStrictNumber(

    item?.exempt_amount ??

      item?.amounts?.clp?.exempt ??

      item?.amounts?.exempt

  );

  const tax = toStrictNumber(

    item?.tax_amount ??

      item?.amounts?.clp?.tax ??

      item?.amounts?.tax

  );

  if (

    net !== null ||

    exempt !== null ||

    tax !== null

  ) {

    return roundMoney(

      (net || 0) +

        (exempt || 0) +

        (tax || 0)

    );

  }

  return null;

};

/* =========================================*

*   PRECIO UNITARIO RELBASE*

*   REGLA VALIDADA EN PRODUCCIÓN 07-09-2026:*

*   BOLETA 39*

*   ---------*

*   Relbase interpretó products[].price como el*

*   precio final IVA incluido, aun con mnt_bruto=false.*

*   Por eso una boleta debe enviar precio BRUTO/final.*

*   FACTURA 33*

*   ----------*

*   Se mantiene el precio NETO ya preparado en*

*   tax_document_items.unit_price.*

*========================================= */

const resolveRelbaseProductPrice = ({

  item,

  typeDocument,

  quantity,

  taxAffected,

  blockingIssues,

}) => {

  const netUnitPrice = toStrictNumber(

    item?.unit_price

  );

  if (typeDocument === 33) {

    if (

      netUnitPrice === null ||

      netUnitPrice < 0

    ) {

      blockingIssues.push({

        code:

          "RELBASE_INVALID_NET_PRICE",

        message:

          `El ítem ${item.line_number} posee un price neto inválido para FACTURA.`,

        line_number:

          item.line_number,

      });

      return null;

    }

    return roundMoney(netUnitPrice);

  }

  if (typeDocument !== 39) {

    blockingIssues.push({

      code:

        "RELBASE_PRODUCT_PRICE_MODE_NOT_SUPPORTED",

      message:

        `No existe una estrategia de price para el tipo de documento ${typeDocument}.`,

      line_number:

        item.line_number,

    });

    return null;

  }

  /**

*   * BOLETA CON DESCUENTO:*

*   * products[].price debe representar el precio*

*   * bruto ANTES del descuento, porque Relbase*

*   * aplicará products[].discount después.*

*   *

*   * Si usáramos total_amount / quantity aquí,*

*   * estaríamos enviando un precio ya descontado*

*   * y luego Relbase volvería a descontarlo.*

*   */

  const discountAmount =

    toStrictNumber(

      item?.discount_amount

    ) || 0;

  if (

    discountAmount > 0 &&

    netUnitPrice !== null &&

    netUnitPrice >= 0

  ) {

    if (taxAffected === false) {

      return roundMoney(

        netUnitPrice

      );

    }

    const taxRate =

      toStrictNumber(

        item?.tax?.rate ??

          item?.tax_rate

      );

    if (

      taxAffected === true &&

      taxRate !== null &&

      taxRate >= 0

    ) {

      return roundMoney(

        netUnitPrice *

          (1 + taxRate / 100)

      );

    }

  }

  /**

*   * BOLETA SIN DESCUENTO: mantenemos el criterio*

*   * ya validado en producción y preferimos el*

*   * total bruto/final del snapshot local.*

*   */

  const grossLineTotal =

    resolveItemGrossTotal(item);

  if (

    grossLineTotal !== null &&

    quantity !== null &&

    quantity > 0

  ) {

    const grossUnitPrice = roundMoney(

      grossLineTotal / quantity

    );

    if (

      grossUnitPrice !== null &&

      grossUnitPrice >= 0

    ) {

      return grossUnitPrice;

    }

  }

  /**

*   * Fallback seguro:*

*   * - exento: neto = bruto.*

*   * - afecto: sólo reconstruimos si conocemos*

*   *   explícitamente la tasa del ítem.*

*   */

  if (

    netUnitPrice !== null &&

    netUnitPrice >= 0

  ) {

    if (taxAffected === false) {

      return roundMoney(netUnitPrice);

    }

    const taxRate = toStrictNumber(

      item?.tax?.rate ??

        item?.tax_rate

    );

    if (

      taxAffected === true &&

      taxRate !== null &&

      taxRate >= 0

    ) {

      return roundMoney(

        netUnitPrice *

          (1 + taxRate / 100)

      );

    }

  }

  blockingIssues.push({

    code:

      "RELBASE_BOLETA_GROSS_PRICE_UNRESOLVED",

    message:

      `No fue posible resolver el precio bruto/final del ítem ${item.line_number} para BOLETA.`,

    line_number:

      item.line_number,

  });

  return null;

};

/* =========================================**

**   ID RELBASE**

**========================================= **/

const toRelbaseId = (

  value

) => {

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return null;

  }

  const number =

    Number(value);

  if (

    !Number.isInteger(number) ||

    number <= 0

  ) {

    return null;

  }

  return number;

};

/* =========================================**

**   DOCUMENTO RELBASE**

**   Valores confirmados directamente**

**   desde los formularios de Relbase:**

**   FACTURA = 33**

**   BOLETA  = 39**

**========================================= **/

const resolveRelbaseDocumentType = (

  documentType

) => {

  switch (

    String(documentType)

      .trim()

      .toUpperCase()

  ) {

    case "FACTURA":

      return 33;

    case "BOLETA":

      return 39;

    default:

      throw createServiceError(

        `Tipo de documento no soportado: ${documentType}`,

        409,

        "RELBASE_DOCUMENT_TYPE_NOT_SUPPORTED"

      );

  }

};

/* =========================================**

**   CANAL RELBASE SEGÚN ORIGEN**

**========================================= **/

const resolveRelbaseChannelId = (

  source

) => {

  const normalized =

    String(source || "")

      .trim()

      .toUpperCase();

  if (normalized === "WEB") {

    return getEnvInteger(

      "RELBASE_WEB_CHANNEL_ID",

      {

        required: true,

      }

    );

  }

  if (

    normalized === "STORE" ||

    normalized === "BACKOFFICE"

  ) {

    return getEnvInteger(

      "RELBASE_STORE_CHANNEL_ID",

      {

        required: true,

      }

    );

  }

  throw createServiceError(

    `Origen de venta no soportado para Relbase: ${source}`,

    409,

    "RELBASE_CHANNEL_NOT_SUPPORTED"

  );

};

/* =========================================**

**   FORMA DE PAGO RELBASE**

**   Inicialmente soportamos únicamente**

**   los métodos que tenemos confirmados.**

**   MANUAL_BANK_TRANSFER -> 5820**

**========================================= **/

const resolveRelbasePaymentId = (

  payment

) => {

  if (!payment) {

    return null;

  }

  const methodCode =

    String(

      payment.method?.code ||

      ""

    )

      .trim()

      .toUpperCase();

  switch (methodCode) {

    case "MANUAL_BANK_TRANSFER":

      return getEnvInteger(

        "RELBASE_TRANSFER_PAYMENT_ID",

        {

          required: true,

        }

      );

    case "CASH":

      return getEnvInteger(

        "RELBASE_CASH_PAYMENT_ID",

        {

          required: true,

        }

      );

    case "DEBIT_CARD":

      return getEnvInteger(

        "RELBASE_DEBIT_CARD_PAYMENT_ID",

        {

          required: true,

        }

      );

    case "CREDIT_CARD":

      return getEnvInteger(

        "RELBASE_CREDIT_CARD_PAYMENT_ID",

        {

          required: true,

        }

      );

    case "WEBPAY":

      return getEnvInteger(

        "RELBASE_WEBPAY_PAYMENT_ID",

        {

          required: true,

        }

      );

    default:

      return null;

  }

};

/* =========================================**

**   CLIENTE RELBASE**

**========================================= **/

const resolveRelbaseCustomerId = (

  preview

) => {

  const documentType =

    String(

      preview.document.type

    )

      .trim()

      .toUpperCase();

  /***

**   * FACTURA**

**   ***

**   * Requiere cliente real relacionado**

**   * con Relbase.**

**   **/

  if (

    documentType ===

    "FACTURA"

  ) {

    return toRelbaseId(

      preview.receiver

        ?.relbase_customer_id

    );

  }

  /***

**   * BOLETA**

**   ***

**   * Si tenemos un cliente Relbase**

**   * concreto, lo usamos.**

**   ***

**   * De lo contrario usamos el**

**   * cliente genérico configurado.**

**   **/

  if (

    documentType ===

    "BOLETA"

  ) {

    const existing =

      toRelbaseId(

        preview.receiver

          ?.relbase_customer_id

      );

    if (existing) {

      return existing;

    }

    return getEnvInteger(

      "RELBASE_DEFAULT_BOLETA_CUSTOMER_ID",

      {

        required: true,

      }

    );

  }

  return null;

};

/* =========================================**

**   DESCUENTO RELBASE**

**   Relbase recibe products[].discount**

**   como PORCENTAJE.**

**   tax_document_items.discount_amount**

**   guarda el descuento en la misma base**

**   monetaria que unit_price:**

**   - afectos: NETO.**

**   - exentos: EXENTO/BRUTO.**

**   Por eso podemos resolver de forma segura:**

**   descuento % = discount_amount /

**                 (unit_price × quantity) × 100**

**   Usamos hasta 8 decimales para conservar**

**   la equivalencia del snapshot local incluso**

**   en montos grandes y descuentos distribuidos.**

**========================================= **/

const roundPercentage = (value) => {

  const number =

    toStrictNumber(value);

  if (number === null) {

    return null;

  }

  /**
   * Relbase acepta como máximo 2 decimales
   * en products[].discount.
   */
  return Math.round(

    (number + Number.EPSILON) *

      100

  ) / 100;

};

const resolveProductDiscount = (

  item,

  blockingIssues

) => {

  const discountAmount =

    toStrictNumber(

      item?.discount_amount

    );

  if (

    discountAmount === null ||

    discountAmount === 0

  ) {

    return null;

  }

  if (discountAmount < 0) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_INVALID",

      message:

        `El ítem ${item.line_number} posee un descuento negativo.`,

      line_number:

        item.line_number,

      discount_amount:

        discountAmount,

    });

    return null;

  }

  const quantity =

    toStrictNumber(

      item?.quantity

    );

  const unitPrice =

    toStrictNumber(

      item?.unit_price

    );

  if (

    quantity === null ||

    quantity <= 0 ||

    unitPrice === null ||

    unitPrice < 0

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_BASE_INVALID",

      message:

        `No fue posible calcular la base del descuento del ítem ${item.line_number}.`,

      line_number:

        item.line_number,

      quantity,

      unit_price:

        unitPrice,

    });

    return null;

  }

  const baseAmount =

    roundMoney(

      unitPrice * quantity

    );

  if (

    baseAmount === null ||

    baseAmount <= 0

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_BASE_ZERO",

      message:

        `El ítem ${item.line_number} posee descuento pero su base es 0.`,

      line_number:

        item.line_number,

      base_amount:

        baseAmount,

      discount_amount:

        discountAmount,

    });

    return null;

  }

  if (

    discountAmount - baseAmount > 0.01

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_EXCEEDS_BASE",

      message:

        `El descuento del ítem ${item.line_number} supera su base antes de descuento.`,

      line_number:

        item.line_number,

      base_amount:

        baseAmount,

      discount_amount:

        discountAmount,

    });

    return null;

  }

  const percentage =

    roundPercentage(

      (discountAmount /

        baseAmount) * 100

    );

  if (

    percentage === null ||

    percentage <= 0 ||

    percentage > 100

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_PERCENT_INVALID",

      message:

        `No fue posible resolver un porcentaje válido para el descuento del ítem ${item.line_number}.`,

      line_number:

        item.line_number,

      percentage,

      base_amount:

        baseAmount,

      discount_amount:

        discountAmount,

    });

    return null;

  }

  const reconstructedDiscount =

    roundMoney(

      baseAmount *

        (percentage / 100)

    );

  if (

    reconstructedDiscount === null ||

    Math.abs(

      reconstructedDiscount -

        discountAmount

    ) > 1

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ITEM_DISCOUNT_PERCENT_MISMATCH",

      message:

        `El porcentaje calculado para el ítem ${item.line_number} no reproduce el descuento local dentro de la tolerancia permitida.`,

      line_number:

        item.line_number,

      percentage,

      base_amount:

        baseAmount,

      discount_amount:

        discountAmount,

      reconstructed_discount:

        reconstructedDiscount,

      tolerance_clp: 1,

    });

    return null;

  }

  return percentage;

};

/* =========================================**

**   PRODUCTO RELBASE**

**   CONTRATO CONFIRMADO EN SWAGGER V1:**

**   obligatorios dentro de products[]:**

**   - product_id**

**   - price**

**   - quantity**

**   - tax_affected**

**   Para BOLETA (39), unit_item también es**

**   obligatorio según la documentación.**

**========================================= **/

const RELBASE_ALLOWED_UNIT_ITEMS =

  new Set([

    "UNID",

    "DISP",

    "KG",

    "M3",

    "MR",

    "PP",

    "PM",

    "QTAL",

    "TON",

  ]);





const resolveRelbaseUnitItem = (

  item,

  typeDocument,

  blockingIssues

) => {

  const rawUnit =

    item?.unit_item ||

    process.env

      .RELBASE_DEFAULT_UNIT_ITEM ||

    "";

  const unitItem =

    String(

      rawUnit

    )

      .trim()

      .toUpperCase();

  /***

**   * Swagger:**

**   * unit_item es obligatorio para BOLETA.**

**   **/

  if (

    typeDocument === 39 &&

    !unitItem

  ) {

    blockingIssues.push({

      code:

        "RELBASE_BOLETA_UNIT_ITEM_REQUIRED",

      message:

        `El ítem ${item.line_number} requiere unit_item para emitir una boleta.`,

      line_number:

        item.line_number,

    });

    return null;

  }

  /***

**   * Si se informa una unidad, debe estar**

**   * dentro del catálogo documentado.**

**   **/

  if (

    unitItem &&

    !RELBASE_ALLOWED_UNIT_ITEMS.has(

      unitItem

    )

  ) {

    blockingIssues.push({

      code:

        "RELBASE_UNIT_ITEM_INVALID",

      message:

        `El ítem ${item.line_number} posee unit_item inválido: ${unitItem}.`,

      line_number:

        item.line_number,

      allowed_values:

        Array.from(

          RELBASE_ALLOWED_UNIT_ITEMS

        ),

    });

    return null;

  }

  return unitItem || null;

};





const buildRelbaseProduct = (

  item,

  typeDocument,

  blockingIssues

) => {

  const productId = toRelbaseId(

    item.identifiers

      ?.relbase_product_id

  );

  if (!productId) {

    blockingIssues.push({

      code:

        "RELBASE_PRODUCT_ID_MISSING",

      message:

        `El ítem ${item.line_number} no posee un product_id Relbase válido.`,

      line_number:

        item.line_number,

    });

  }

  const quantity = toStrictNumber(

    item.quantity

  );

  if (

    quantity === null ||

    quantity <= 0

  ) {

    blockingIssues.push({

      code:

        "RELBASE_INVALID_QUANTITY",

      message:

        `El ítem ${item.line_number} posee una quantity inválida.`,

      line_number:

        item.line_number,

    });

  }

  const rawTaxAffected =

    item.tax?.taxable;

  const taxAffectedIsValid =

    typeof rawTaxAffected ===

    "boolean";

  if (!taxAffectedIsValid) {

    blockingIssues.push({

      code:

        "RELBASE_TAX_AFFECTED_REQUIRED",

      message:

        `El ítem ${item.line_number} no posee tax_affected booleano válido.`,

      line_number:

        item.line_number,

    });

  }

  const price = resolveRelbaseProductPrice({

    item,

    typeDocument,

    quantity,

    taxAffected:

      taxAffectedIsValid

        ? rawTaxAffected

        : null,

    blockingIssues,

  });

  const unitItem =

    resolveRelbaseUnitItem(

      item,

      typeDocument,

      blockingIssues

    );

  /**

*   * Convierte discount_amount local a porcentaje*

*   * products[].discount de Relbase.*

*   *

*   * Si no hay descuento, la propiedad se omite.*

*   */

  const discount =

    resolveProductDiscount(

      item,

      blockingIssues

    );

  return {

    product_id:

      productId,

    /**

*     * BOLETA 39  -> precio BRUTO/final IVA incluido.*

*     * FACTURA 33 -> precio NETO.*

*     **

*     * Esta separación evita repetir el incidente real*

*     * donde $38.571,43 netos fueron interpretados por*

*     * Relbase como precio final de una boleta de $38.571.*

*     */

    price,

    quantity,

    tax_affected:

      taxAffectedIsValid

        ? rawTaxAffected

        : null,

    /**

*     * Relbase interpreta discount como porcentaje.*

*     * Si es 0/no aplica, se omite por completo.*

*     */

    ...(discount !== null

      ? { discount }

      : {}),

    /**

*     * No enviamos surcharge ni impuestos adicionales*

*     * con 0. Si no aplican, se omiten.*

*     */

    description:

      item.description ||

      item.name ||

      "",

    unit_item:

      unitItem,

  };

};



/* =========================================**

**   VALIDAR TOTALES**

**========================================= **/

const validateTotals = (

  preview,

  blockingIssues

) => {

  const net =

    Math.round(

      toNumber(

        preview.totals

          ?.clp

          ?.net

      )

    );

  const exempt =

    Math.round(

      toNumber(

        preview.totals

          ?.clp

          ?.exempt

      )

    );

  const tax =

    Math.round(

      toNumber(

        preview.totals

          ?.clp

          ?.tax

      )

    );

  const total =

    Math.round(

      toNumber(

        preview.totals

          ?.clp

          ?.total

      )

    );

  if (

    net +

      exempt +

      tax !==

    total

  ) {

    blockingIssues.push({

      code:

        "RELBASE_TOTALS_DO_NOT_MATCH",

      message:

        "Los totales CLP del documento no cuadran antes de enviar a Relbase.",

      values: {

        net,

        exempt,

        tax,

        total,

      },

    });

  }

};

/* =========================================*

*   VALIDAR CAMPOS OPCIONALES EN CERO*

*   Relbase interpreta algunos campos opcionales*

*   como una operación comercial real sólo por estar*

*   presentes. Por seguridad, cuando su valor es 0*

*   deben omitirse completamente del payload.*

*========================================= */

const validateNoZeroOptionalCommercialFields = (

  payload,

  blockingIssues

) => {

  const hasOwn = (object, key) =>

    Object.prototype.hasOwnProperty.call(

      object,

      key

    );

  if (

    hasOwn(payload, "global_discount") &&

    toNumber(payload.global_discount) === 0

  ) {

    blockingIssues.push({

      code:

        "RELBASE_ZERO_GLOBAL_DISCOUNT_MUST_BE_OMITTED",

      message:

        "global_discount no debe enviarse con valor 0; debe omitirse del payload.",

    });

  }

  if (

    hasOwn(payload, "global_discount_type") &&

    !hasOwn(payload, "global_discount")

  ) {

    blockingIssues.push({

      code:

        "RELBASE_GLOBAL_DISCOUNT_TYPE_WITHOUT_DISCOUNT",

      message:

        "global_discount_type no debe enviarse si global_discount está omitido.",

    });

  }

  const optionalProductFields = [

    "discount",

    "surcharge",

    "additional_tax_fee",

    "additional_tax_code",

  ];

  (payload.products || []).forEach(

    (product, index) => {

      optionalProductFields.forEach(

        (field) => {

          if (

            hasOwn(product, field) &&

            toNumber(product[field]) === 0

          ) {

            blockingIssues.push({

              code:

                "RELBASE_ZERO_OPTIONAL_PRODUCT_FIELD_MUST_BE_OMITTED",

              message:

                `products[${index}].${field} no debe enviarse con valor 0; debe omitirse del payload.`,

              product_index:

                index,

              field,

            });

          }

        }

      );

    }

  );

};

/* =========================================*

*   VALIDAR TOTAL BRUTO DE BOLETA*

*   Guardia aprendida del incidente real del folio 790.*

*   Antes de permitir payload_ready=true verificamos que:*

*   SUM(products[].price * quantity)*

*   \~= total tributario local.*

*   Como descuentos distintos de 0 siguen bloqueados y*

*   el retiro en tienda no tiene despacho, esta igualdad*

*   debe cumplirse para las boletas actualmente soportadas.*

*========================================= */

const validateBoletaGrossPayloadTotal = (

  payload,

  preview,

  blockingIssues

) => {

  if (

    Number(payload?.type_document) !== 39

  ) {

    return;

  }

  const expectedTotal = toStrictNumber(

    preview?.totals?.clp?.total

  );

  if (

    expectedTotal === null ||

    expectedTotal < 0

  ) {

    blockingIssues.push({

      code:

        "RELBASE_BOLETA_EXPECTED_TOTAL_INVALID",

      message:

        "No fue posible resolver el total local esperado de la boleta.",

    });

    return;

  }

  let calculatedGrossTotal = 0;

  for (

    let index = 0;

    index < (payload.products || []).length;

    index += 1

  ) {

    const product =

      payload.products[index];

    const price = toStrictNumber(

      product?.price

    );

    const quantity = toStrictNumber(

      product?.quantity

    );

    if (

      price === null ||

      price < 0 ||

      quantity === null ||

      quantity <= 0

    ) {

      blockingIssues.push({

        code:

          "RELBASE_BOLETA_PRODUCT_GROSS_TOTAL_INVALID",

        message:

          `No se puede validar el total bruto de products[${index}] porque price o quantity es inválido.`,

        product_index:

          index,

      });

      continue;

    }

    const discount =

      toStrictNumber(

        product?.discount

      ) || 0;

    if (

      discount < 0 ||

      discount > 100

    ) {

      blockingIssues.push({

        code:

          "RELBASE_BOLETA_PRODUCT_DISCOUNT_INVALID",

        message:

          `products[${index}].discount no es un porcentaje válido.`,

        product_index:

          index,

        discount,

      });

      continue;

    }

    calculatedGrossTotal = roundMoney(

      calculatedGrossTotal +

        price *

          quantity *

          (1 - discount / 100)

    );

  }

  if (calculatedGrossTotal === null) {

    blockingIssues.push({

      code:

        "RELBASE_BOLETA_GROSS_TOTAL_UNRESOLVED",

      message:

        "No fue posible calcular el total bruto del payload de la boleta.",

    });

    return;

  }

  const difference = roundMoney(

    calculatedGrossTotal -

      expectedTotal

  );

  /**

*   * Tolerancia máxima: $1 CLP para absorber redondeos*

*   * de líneas con cantidades fraccionarias.*

*   */

  if (

    difference === null ||

    Math.abs(difference) > 1

  ) {

    blockingIssues.push({

      code:

        "RELBASE_BOLETA_GROSS_TOTAL_MISMATCH",

      message:

        "El total bruto que recibiría Relbase no coincide con el total local de la boleta.",

      values: {

        expected_total:

          roundMoney(expectedTotal),

        payload_gross_total:

          calculatedGrossTotal,

        difference,

      },

    });

  }

};

/* =========================================*

*   VALIDAR TOTAL NETO DE FACTURA*

*   FACTURA 33 usa price NETO y discount %.*

*   Verificamos que la suma que recibirá Relbase*

*   reproduzca neto + exento del snapshot local.*

*========================================= */

const validateFacturaNetPayloadTotal = (

  payload,

  preview,

  blockingIssues

) => {

  if (

    Number(payload?.type_document) !== 33

  ) {

    return;

  }

  const expectedNet =

    toStrictNumber(

      preview?.totals?.clp?.net

    ) || 0;

  const expectedExempt =

    toStrictNumber(

      preview?.totals?.clp?.exempt

    ) || 0;

  const expectedCommercialBase =

    roundMoney(

      expectedNet +

        expectedExempt

    );

  let calculatedCommercialBase = 0;

  for (

    let index = 0;

    index <

      (payload.products || []).length;

    index += 1

  ) {

    const product =

      payload.products[index];

    const price =

      toStrictNumber(

        product?.price

      );

    const quantity =

      toStrictNumber(

        product?.quantity

      );

    const discount =

      toStrictNumber(

        product?.discount

      ) || 0;

    if (

      price === null ||

      price < 0 ||

      quantity === null ||

      quantity <= 0 ||

      discount < 0 ||

      discount > 100

    ) {

      blockingIssues.push({

        code:

          "RELBASE_FACTURA_PRODUCT_COMMERCIAL_TOTAL_INVALID",

        message:

          `No se puede validar el total neto de products[${index}] porque price, quantity o discount es inválido.`,

        product_index:

          index,

        price,

        quantity,

        discount,

      });

      continue;

    }

    calculatedCommercialBase =

      roundMoney(

        calculatedCommercialBase +

          price *

            quantity *

            (1 - discount / 100)

      );

  }

  const difference =

    roundMoney(

      calculatedCommercialBase -

        expectedCommercialBase

    );

  if (

    difference === null ||

    Math.abs(difference) > 1

  ) {

    blockingIssues.push({

      code:

        "RELBASE_FACTURA_NET_TOTAL_MISMATCH",

      message:

        "El neto que recibiría Relbase no coincide con el neto/exento del documento local.",

      values: {

        expected_net_plus_exempt:

          expectedCommercialBase,

        payload_net_after_discounts:

          calculatedCommercialBase,

        difference,

        tolerance_clp: 1,

      },

    });

  }

};

/* =========================================**

**   PREVIEW PAYLOAD RELBASE**

**========================================= **/

export const buildRelbaseDtePreview =

  async (

    orderId

  ) => {

    /***

**     * Este servicio NO llama Relbase.**

**     ***

**     * Sólo construye el JSON que**

**     * potencialmente se enviaría.**

**     **/

    const preview =

      await getTaxDocumentPreview(

        orderId

      );

    const blockingIssues =

      [];

    const warnings =

      [];

    /* =====================================**

**       1. DOCUMENTO**

**    ===================================== **/

    const typeDocument =

      resolveRelbaseDocumentType(

        preview.document.type

      );

    /* =====================================**

**       2. CLIENTE**

**    ===================================== **/

    const customerId =

      resolveRelbaseCustomerId(

        preview

      );

    if (!customerId) {

      blockingIssues.push({

        code:

          "RELBASE_CUSTOMER_ID_MISSING",

        message:

          preview.document.type ===

          "FACTURA"

            ? "La factura requiere un cliente asociado a Relbase."

            : "No se pudo resolver el cliente Relbase de la boleta.",

      });

    }

    /* =====================================**

**       3. FORMA DE PAGO**

**    ===================================== **/

    const typePaymentId =

      resolveRelbasePaymentId(

        preview.payment

      );

    if (!typePaymentId) {

      blockingIssues.push({

        code:

          "RELBASE_PAYMENT_METHOD_NOT_MAPPED",

        message:

          `La forma de pago ${preview.payment?.method?.code || "UNKNOWN"} no posee un mapeo Relbase disponible.`,

      });

    }

    /* =====================================**

**       4. CANAL**

**    ===================================== **/

    const channelId =

      resolveRelbaseChannelId(

        preview.document.source

      );

    /* =====================================**

**       5. VENDEDOR**

**    ===================================== **/

    const sellerId =

      getEnvInteger(

        "RELBASE_DEFAULT_SELLER_ID",

        {

          required: false,

        }

      );

    if (!sellerId) {

      blockingIssues.push({

        code:

          "RELBASE_SELLER_ID_MISSING",

        message:

          "No está configurado RELBASE_DEFAULT_SELLER_ID.",

      });

    }

    /* =====================================**

**       6. BODEGA**

**    ===================================== **/

    const warehouseId =

      getEnvInteger(

        "RELBASE_DEFAULT_WAREHOUSE_ID",

        {

          required: false,

        }

      );

    if (!warehouseId) {

      blockingIssues.push({

        code:

          "RELBASE_WAREHOUSE_ID_MISSING",

        message:

          "No está configurado RELBASE_DEFAULT_WAREHOUSE_ID.",

      });

    }

    /* =====================================**

**       7. PAGO**

**    ===================================== **/

    if (

      !preview.payment ||

      preview.payment.status !==

        "PAID"

    ) {

      blockingIssues.push({

        code:

          "RELBASE_ORDER_NOT_PAID",

        message:

          "El documento no puede prepararse para Relbase mientras el pago no esté confirmado como PAID.",

      });

    }

    /* =====================================**

**       8. TOTALES**

**    ===================================== **/

    validateTotals(

      preview,

      blockingIssues

    );

    /* =====================================**

**       9. PRODUCTOS**

**    ===================================== **/

    const products =

      preview.items.map(

        (item) =>

          buildRelbaseProduct(

            item,

            typeDocument,

            blockingIssues

          )

      );

    /* =====================================**

**       10. DIRECCIÓN**

**       Para FACTURA usaremos nombres**

**       de ciudad/comuna.**

**       Así no dependemos actualmente**

**       del endpoint /ciudades que nos**

**       presentó el problema de scopes.**

**    ===================================== **/

    const isInvoice =

      preview.document.type ===

      "FACTURA";

    const invoiceObservation =

      isInvoice

        ? String(

            preview.document

              ?.invoice_observation ||

            ""

          ).trim()

        : "";

    const address =

      isInvoice

        ? preview.receiver

            ?.address ||

          ""

        : "";

    const strCommune =

      isInvoice

        ? preview.receiver

            ?.commune ||

          ""

        : "";

    const strCity =

      isInvoice

        ? preview.receiver

            ?.city ||

          ""

        : "";

    if (isInvoice) {

      if (!address) {

        blockingIssues.push({

          code:

            "RELBASE_BILLING_ADDRESS_MISSING",

          message:

            "La factura requiere dirección de facturación.",

        });

      }

      if (!strCommune) {

        blockingIssues.push({

          code:

            "RELBASE_BILLING_COMMUNE_MISSING",

          message:

            "La factura requiere comuna de facturación.",

        });

      }

      if (!strCity) {

        blockingIssues.push({

          code:

            "RELBASE_BILLING_CITY_MISSING",

          message:

            "La factura requiere ciudad de facturación.",

        });

      }

    }

    /* =====================================**

**       11. type_document_sii**

**       CONTRATO CONFIRMADO EN SWAGGER:**

**       type_document_sii se utiliza solamente**

**       para NOTA DE VENTA.**

**       Laminatiword emite actualmente:**

**       - FACTURA  = 33**

**       - BOLETA   = 39**

**       Por lo tanto este campo NO se incluye**

**       en el payload de FACTURA/BOLETA.**

**    ===================================== **/

    /* =====================================**

**       12. PAYLOAD**

**    ===================================== **/

    /***

**     * Payload base común para BOLETA y FACTURA.**

**     ***

**     * No enviamos campos opcionales vacíos.**

**     **/

    const payload = {

      type_document:

        typeDocument,

      start_date:

        preview.document

          .proposed_issue_date,

      end_date:

        preview.document

          .proposed_issue_date,

      customer_id:

        customerId,

      type_payment_id:

        typePaymentId,

      continuous:

        getEnvBoolean(

          "RELBASE_DTE_CONTINUOUS",

          true

        ),

      channel_id:

        channelId,

      seller_id:

        sellerId,

      ware_house_id:

        warehouseId,

      comment:

        invoiceObservation ||

        `Laminatiword ${preview.document.order_number}`,

      /***

**       * Swagger:**

**       * label_value = Nº pedido.**

**       **/

      label_value:

        preview.document

          .order_number,

      /***

**       * Orden PAID.**

**       **/

      paid:

        preview.payment?.status ===

        "PAID",

      /***

**       * Confirmado en formularios**

**       * reales de Relbase:**

**       ***

**       * BOLETA usa price bruto/final; FACTURA usa price neto.**

**       **/

      mnt_bruto:

        false,

      addon_ecommerce:

        getEnvBoolean(

          "RELBASE_DTE_ADDON_ECOMMERCE",

          false

        ),

      amount_paid:

        toNumber(

          preview.payment?.amount

        ),

      change_due:

        0,

      products,

    };

    /***

**     * FACTURA:**

**     ***

**     * Enviamos dirección, comuna y ciudad**

**     * porque corresponden al receptor.**

**     ***

**     * BOLETA:**

**     ***

**     * Estos campos se omiten completamente**

**     * en lugar de enviarlos como strings vacíos.**

**     **/

    if (isInvoice) {

      payload.address =

        address;

      payload.is_str_city_and_comune =

        true;

      payload.str_commune =

        strCommune;

      payload.str_city =

        strCity;

    }

    /**

*     * Guardia semántica aprendida del contrato real*

*     * de Relbase: los opcionales en 0 deben omitirse.*

*     */

    validateNoZeroOptionalCommercialFields(

      payload,

      blockingIssues

    );

    /**

*     * Guardia de neto para FACTURA 33 con o sin*

*     * descuentos por línea.*

*     */

    validateFacturaNetPayloadTotal(

      payload,

      preview,

      blockingIssues

    );

    /**

*     * Guardia de precio bruto/final para BOLETA 39.*

*     * No hace llamadas externas ni modifica la DB.*

*     */

    validateBoletaGrossPayloadTotal(

      payload,

      preview,

      blockingIssues

    );

    /* =====================================**

**       13. RESPUESTA PREVIEW**

**    ===================================== **/

    return {

      schema:

        "LAMINATIWORD_RELBASE_DTE_V1",

      contract_validation: {

        source:

          "RELBASE_SWAGGER_V1",

        status:

          "VALIDATED_FOR_PAYLOAD_STRUCTURE",

        confirmed_required_fields: [

          "type_document",

          "start_date",

          "end_date",

          "products[].product_id",

          "products[].price",

          "products[].quantity",

          "products[].tax_affected",

        ],

        boleta_required_fields: [

          "products[].unit_item",

        ],

        omitted_for_boleta_factura: [

          "type_document_sii",

        ],

        omitted_when_empty_or_not_applicable: [

          "references",

          "address (BOLETA)",

          "is_str_city_and_comune (BOLETA)",

          "str_commune (BOLETA)",

          "str_city (BOLETA)",

          "global_discount (cuando es 0)",

          "global_discount_type (si no hay descuento global)",

          "products[].discount (cuando es 0)",

          "products[].surcharge (cuando es 0)",

          "products[].additional_tax_fee (cuando es 0)",

          "products[].additional_tax_code (cuando no aplica)",

        ],

        runtime_validated_pricing_rules: [

          "BOLETA 39: products[].price usa precio bruto/final IVA incluido",

          "FACTURA 33: products[].price mantiene precio neto",

          "products[].discount usa porcentaje derivado desde discount_amount local",

          "FACTURA 33: suma price × quantity × (1 - discount/100) debe coincidir con neto + exento local",

          "BOLETA 39: suma price × quantity × (1 - discount/100) debe coincidir con total local",

        ],

        runtime_validation_reference:

          "RELBASE_REAL_BOLETA_2026-09-07_FOLIO_790_ANULADA",

        api_v2_write_contract_confirmed:

          true,

      },

      generated_at:

        new Date()

          .toISOString(),

      /***

**       * En este Paso 84.2 no existe**

**       * ningún código capaz de emitir.**

**       **/

      emission_enabled:

        false,

      payload_ready:

        blockingIssues.length ===

        0,

      blocking_issues:

        blockingIssues,

      warnings,

      source: {

        schema:

          preview.schema,

        tax_document_id:

          preview.document.local_id,

        order_id:

          preview.document.order_id,

        order_number:

          preview.document

            .order_number,

        document_type:

          preview.document.type,

        sii_code:

          preview.document.sii_code,

        idempotency_key:

          preview.document

            .idempotency_key,

      },

      configuration: {

        document: {

          type_document:

            typeDocument,

          mnt_bruto:

            false,

          pricing_mode:

            typeDocument === 39

              ? "GROSS_FINAL_PRICE"

              : "NET_PRICE",

          boleta_payload_total_guard:

            typeDocument === 39,

        },

        customer: {

          customer_id:

            customerId,

          generic_boleta:

            preview.document.type ===

              "BOLETA" &&

            !preview.receiver

              ?.relbase_customer_id,

        },

        payment: {

          local_method:

            preview.payment

              ?.method

              ?.code ||

            null,

          relbase_type_payment_id:

            typePaymentId,

        },

        channel: {

          source:

            preview.document.source,

          relbase_channel_id:

            channelId,

        },

        warehouse: {

          relbase_warehouse_id:

            warehouseId,

        },

        units: {

          default_unit_item:

            String(

              process.env

                .RELBASE_DEFAULT_UNIT_ITEM ||

              "UNID"

            )

              .trim()

              .toUpperCase(),

          allowed_unit_items:

            Array.from(

              RELBASE_ALLOWED_UNIT_ITEMS

            ),

        },

        seller: {

          relbase_seller_id:

            sellerId,

        },

      },

      /***

**       * Este es el JSON candidato**

**       * para Relbase.**

**       ***

**       * NO se envía.**

**       **/

      payload,

    };

  };