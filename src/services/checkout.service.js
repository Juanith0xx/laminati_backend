import crypto from "crypto";

import pool from "../config/database.js";

import {

  buildPickupQrToken,

  hashPickupQrToken,

} from "./pickup.service.js";

import {

  relbaseRequest,

} from "./relbase.service.js";

import {

  normalizeRelbaseDteRecord,

  normalizeRelbaseHttpUrl,

  isRelbaseHttpUrlUsable,

} from "./relbaseDteSync.service.js";

import {
  resolveProductPrice,
} from "./productPricing.service.js";

/*  =========================================

   ERROR CONTROLADO

========================================= */

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

/*  =========================================

   BODEGA WEB

========================================= */

const getWebWarehouseId =

  () => {

    const warehouseId =

      Number.parseInt(

        process.env

          .RELBASE_DEFAULT_WAREHOUSE_ID,

        10

      );

    if (

      !Number.isSafeInteger(

        warehouseId

      ) ||

      warehouseId <= 0

    ) {

      throw createServiceError(

        "RELBASE_DEFAULT_WAREHOUSE_ID no se encuentra configurado correctamente",

        500,

        "WEB_WAREHOUSE_NOT_CONFIGURED"

      );

    }

    return warehouseId;

  };

/*  =========================================

   TEXTO

========================================= */

const cleanText = (

  value

) => {

  return String(

    value ?? ""

  ).trim();

};

const optionalText = (

  value

) => {

  const normalized =

    cleanText(value);

  return (

    normalized ||

    null

  );

};

/*  =========================================

   EMAIL

========================================= */

const isValidEmail = (

  value

) => {

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(

    cleanText(value)

  );

};

/*  =========================================

   UUID

========================================= */

const isUuid = (

  value

) => {

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(

    cleanText(value)

  );

};

/*  =========================================

   MONEDA

========================================= */

const roundMoney = (

  value

) => {

  const number =

    Number(value);

  if (

    !Number.isFinite(

      number

    )

  ) {

    return null;

  }

  return (

    Math.round(

      (

        number +

        Number.EPSILON

      ) *

        100

    ) /

    100

  );

};

/*  =========================================

   HASH SHA-256

========================================= */

const hashToken = (

  value

) => {

  return crypto

    .createHash(

      "sha256"

    )

    .update(

      value

    )

    .digest(

      "hex"

    );

};



/*  =========================================

   HASH CONSTANT-TIME

========================================= */

const safeHexHashMatches = (

  expectedHash,

  candidateHash

) => {

  const expected =

    String(

      expectedHash || ""

    )

      .trim()

      .toLowerCase();

  const candidate =

    String(

      candidateHash || ""

    )

      .trim()

      .toLowerCase();

  if (

    expected.length !== 64 ||

    candidate.length !== 64

  ) {

    return false;

  }

  try {

    return crypto.timingSafeEqual(

      Buffer.from(

        expected,

        "hex"

      ),

      Buffer.from(

        candidate,

        "hex"

      )

    );

  } catch {

    return false;

  }

};



/*  =========================================

   RETIRO PARA CHECKOUT INVITADO

   IMPORTANTE:

   - Sólo se usa DESPUÉS de validar el

   X-Guest-Order-Token de la orden.

   - Nunca expone token_hash.

   - Reconstruye LWPU2 con PICKUP_QR_SECRET.

   - Verifica que la credencial reconstruida

   coincida con el hash guardado.

========================================= */

const getGuestPickupForOrder =

  async (

    client,

    orderId

  ) => {

    const result =

      await client.query(

        `

          SELECT

            sp.id,

            sp.order_id,

            sp.shipping_method_id,

            sp.token_hash,

            sp.status,

            sp.generated_at,

            sp.expires_at,

            sp.used_at,

            sp.revoked_at,

            sp.revoke_reason,

            sp.created_at,

            sp.updated_at,

            sm.code AS shipping_method_code,

            sm.name AS shipping_method_name

          FROM store_pickups sp

          INNER JOIN shipping_methods sm

            ON sm.id = sp.shipping_method_id

          WHERE sp.order_id = $1

          LIMIT 1

        `,

        [

          orderId,

        ]

      );

    if (

      result.rowCount ===

      0

    ) {

      return null;

    }

    const row =

      result.rows[0];

    const status =

      String(

        row.status || ""

      )

        .trim()

        .toUpperCase();

    let credential =

      null;

    let credentialMatches =

      false;

    if (

      row.id &&

      row.generated_at &&

      row.token_hash

    ) {

      credential =

        buildPickupQrToken(

          row.id,

          row.generated_at

        );

      const candidateHash =

        hashPickupQrToken(

          credential

        );

      credentialMatches =

        safeHexHashMatches(

          row.token_hash,

          candidateHash

        );

    }

    const canExposeQr =

      Boolean(

        credential &&

        credentialMatches

      ) &&

      ![

        "USED",

        "REVOKED",

        "EXPIRED",

      ].includes(

        status

      );

    return {

      id:

        row.id,

      order_id:

        row.order_id,

      shipping_method_id:

        row.shipping_method_id,

      status,

      generated_at:

        row.generated_at,

      expires_at:

        row.expires_at,

      used_at:

        row.used_at,

      revoked_at:

        row.revoked_at,

      revoke_reason:

        row.revoke_reason,

      created_at:

        row.created_at,

      updated_at:

        row.updated_at,

      shipping_method: {

        code:

          row.shipping_method_code,

        name:

          row.shipping_method_name,

      },

      qr: canExposeQr

        ? {

            version:

              "LWPU2",

            value:

              credential,

            token:

              credential,

            one_time:

              true,

            contains_personal_data:

              false,

          }

        : null,

      qr_plaintext_available:

        canExposeQr,

      legacy_credential:

        !credentialMatches,

    };

  };

/*  =========================================

   TOKEN INVITADO

========================================= */

const createGuestAccessToken =

  () => {

    const token =

      crypto

        .randomBytes(

          32

        )

        .toString(

          "base64url"

        );

    return {

      token,

      hash:

        hashToken(

          token

        ),

    };

  };

/*  =========================================

   VALIDAR CONTACTO

========================================= */

const normalizeContact =

  (contact) => {

    const firstName =

      cleanText(

        contact?.first_name

      );

    const lastName =

      cleanText(

        contact?.last_name

      );

    const email =

      cleanText(

        contact?.email

      ).toLowerCase();

    const phone =

      cleanText(

        contact?.phone

      );

    const rut =

      optionalText(

        contact?.rut

      );

    if (!firstName) {

      throw createServiceError(

        "El nombre es obligatorio",

        400,

        "CHECKOUT_FIRST_NAME_REQUIRED"

      );

    }

    if (!lastName) {

      throw createServiceError(

        "El apellido es obligatorio",

        400,

        "CHECKOUT_LAST_NAME_REQUIRED"

      );

    }

    if (!email) {

      throw createServiceError(

        "El correo electrónico es obligatorio",

        400,

        "CHECKOUT_EMAIL_REQUIRED"

      );

    }

    if (

      !isValidEmail(

        email

      )

    ) {

      throw createServiceError(

        "El correo electrónico no es válido",

        400,

        "CHECKOUT_EMAIL_INVALID"

      );

    }

    if (!phone) {

      throw createServiceError(

        "El teléfono es obligatorio",

        400,

        "CHECKOUT_PHONE_REQUIRED"

      );

    }

    return {

      first_name:

        firstName,

      last_name:

        lastName,

      customer_name:

        `${firstName} ${lastName}`,

      email,

      phone,

      rut,

    };

  };

/*  =========================================

   DOCUMENTO TRIBUTARIO

========================================= */

const normalizeBilling = ({

  documentType,

  billing,

  contact,

}) => {

  const normalizedType =

    cleanText(

      documentType

    ).toUpperCase();

  if (

    normalizedType !==

      "BOLETA" &&

    normalizedType !==

      "FACTURA"

  ) {

    throw createServiceError(

      "El documento tributario debe ser BOLETA o FACTURA",

      400,

      "CHECKOUT_DOCUMENT_TYPE_INVALID"

    );

  }

  if (

    normalizedType ===

    "BOLETA"

  ) {

    const hasRut =

      Boolean(

        contact.rut

      );

    const normalized = {

      document_type:

        "BOLETA",

      customer_type:

        "PERSON",

      rut:

        contact.rut,

      legal_name:

        contact.customer_name,

      trade_name:

        null,

      business_activity:

        null,

      billing_email:

        contact.email,

      phone:

        contact.phone,

      address_line:

        hasRut

          ? cleanText(

              billing

                ?.address_line

            )

          : null,

      commune:

        hasRut

          ? cleanText(

              billing?.commune

            )

          : null,

      city:

        hasRut

          ? cleanText(

              billing?.city

            )

          : null,

      region:

        hasRut

          ? optionalText(

              billing?.region

            )

          : null,

      country:

        hasRut

          ? cleanText(

              billing?.country

            ) ||

            "Chile"

          : "Chile",

      relbase_customer_id:

        null,

    };

    if (hasRut) {

      const requiredFields = [

        [

          "Dirección",

          normalized

            .address_line,

          "CHECKOUT_BOLETA_ADDRESS_REQUIRED",

        ],

        [

          "Comuna",

          normalized.commune,

          "CHECKOUT_BOLETA_COMMUNE_REQUIRED",

        ],

        [

          "Ciudad",

          normalized.city,

          "CHECKOUT_BOLETA_CITY_REQUIRED",

        ],

        [

          "Región",

          normalized.region,

          "CHECKOUT_BOLETA_REGION_REQUIRED",

        ],

      ];

      for (

        const [

          label,

          value,

          code,

        ] of requiredFields

      ) {

        if (!value) {

          throw createServiceError(

            `Completa el campo ${label}`,

            400,

            code

          );

        }

      }

    }

    return normalized;

  }

  const normalized = {

    document_type:

      "FACTURA",

    customer_type:

      "COMPANY",

    rut:

      cleanText(

        billing?.rut

      ),

    legal_name:

      cleanText(

        billing?.legal_name

      ),

    trade_name:

      optionalText(

        billing?.trade_name

      ),

    business_activity:

      cleanText(

        billing

          ?.business_activity

      ),

    billing_email:

      cleanText(

        billing?.billing_email

      ).toLowerCase(),

    phone:

      optionalText(

        billing?.phone

      ) ||

      contact.phone,

    address_line:

      cleanText(

        billing?.address_line

      ),

    commune:

      cleanText(

        billing?.commune

      ),

    city:

      cleanText(

        billing?.city

      ),

    region:

      optionalText(

        billing?.region

      ),

    country:

      cleanText(

        billing?.country

      ) ||

      "Chile",

    relbase_customer_id:

      optionalText(

        billing

          ?.relbase_customer_id

      ),

  };

  const requiredFields = [

    [

      "RUT empresa",

      normalized.rut,

      "CHECKOUT_BILLING_RUT_REQUIRED",

    ],

    [

      "Razón social",

      normalized.legal_name,

      "CHECKOUT_BILLING_LEGAL_NAME_REQUIRED",

    ],

    [

      "Giro",

      normalized.business_activity,

      "CHECKOUT_BILLING_ACTIVITY_REQUIRED",

    ],

    [

      "Correo de facturación",

      normalized.billing_email,

      "CHECKOUT_BILLING_EMAIL_REQUIRED",

    ],

    [

      "Dirección",

      normalized.address_line,

      "CHECKOUT_BILLING_ADDRESS_REQUIRED",

    ],

    [

      "Comuna",

      normalized.commune,

      "CHECKOUT_BILLING_COMMUNE_REQUIRED",

    ],

    [

      "Ciudad",

      normalized.city,

      "CHECKOUT_BILLING_CITY_REQUIRED",

    ],

  ];

  for (

    const [

      label,

      value,

      code,

    ] of requiredFields

  ) {

    if (!value) {

      throw createServiceError(

        `Completa el campo ${label}`,

        400,

        code

      );

    }

  }

  if (

    !isValidEmail(

      normalized

        .billing_email

    )

  ) {

    throw createServiceError(

      "El correo de facturación no es válido",

      400,

      "CHECKOUT_BILLING_EMAIL_INVALID"

    );

  }

  return normalized;

};

/*  =========================================

   ITEMS

   El checkout actual trabaja con unidades.

   Sólo recibimos product_id + quantity.

   Precio, SKU, nombre e IVA se obtienen

   nuevamente desde PostgreSQL.

========================================= */

const normalizeItems = (

  items

) => {

  if (

    !Array.isArray(items) ||

    items.length === 0

  ) {

    throw createServiceError(

      "El carrito no posee productos",

      400,

      "CHECKOUT_ITEMS_REQUIRED"

    );

  }

  if (

    items.length > 100

  ) {

    throw createServiceError(

      "El carrito contiene demasiados productos",

      400,

      "CHECKOUT_TOO_MANY_ITEMS"

    );

  }

  const consolidated =

    new Map();

  for (

    const item of items

  ) {

    const productId =

      cleanText(

        item?.product_id

      );

    const quantity =

      Number(

        item?.quantity

      );

    if (

      !isUuid(

        productId

      )

    ) {

      throw createServiceError(

        "Existe un producto con identificador inválido",

        400,

        "CHECKOUT_PRODUCT_ID_INVALID"

      );

    }

    if (

      !Number.isInteger(

        quantity

      ) ||

      quantity <= 0

    ) {

      throw createServiceError(

        "Las cantidades del carrito deben ser números enteros mayores que cero",

        400,

        "CHECKOUT_QUANTITY_INVALID"

      );

    }

    if (

      quantity > 999

    ) {

      throw createServiceError(

        "La cantidad solicitada para un producto supera el máximo permitido",

        400,

        "CHECKOUT_QUANTITY_TOO_LARGE"

      );

    }

    const current =

      consolidated.get(

        productId

      ) || 0;

    const nextQuantity =

      current +

      quantity;

    if (

      nextQuantity > 999

    ) {

      throw createServiceError(

        "La cantidad acumulada para un producto supera el máximo permitido",

        400,

        "CHECKOUT_QUANTITY_TOO_LARGE"

      );

    }

    consolidated.set(

      productId,

      nextQuantity

    );

  }

  return [

    ...consolidated.entries(),

  ]

    .map(

      ([

        product_id,

        quantity,

      ]) => ({

        product_id,

        quantity,

      })

    )

    .sort(

      (a, b) =>

        a.product_id.localeCompare(

          b.product_id

        )

    );

};

/*  =========================================

   PRECIO / INVENTARIO REAL

========================================= */

const getCheckoutProduct =

  async ({

    client,

    productId,

    quantity,

    warehouseId,

  }) => {

    const productResult =

      await client.query(

        `

          SELECT

            v.id,

            v.sku,

            v.internal_code,

            v.name,

            v.finish,

            v.tax_rate,

            v.base_price,

            v.final_price,

            v.is_active,

            v.is_published,

            v.allow_sale

          FROM vw_product_catalog v

          WHERE v.id = $1

            AND v.is_active = TRUE

            AND v.is_published = TRUE

            AND v.allow_sale = TRUE

          LIMIT 1

        `,

        [

          productId,

        ]

      );

    if (

      productResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "Uno de los productos ya no está disponible para venta",

        409,

        "CHECKOUT_PRODUCT_NOT_AVAILABLE"

      );

    }

    const product =

      productResult.rows[0];

    const pricing =

      await resolveProductPrice({

        productId:

          product.id,

        quantity,

        db:

          client,

      });

    const unitPrice =

      roundMoney(

        pricing.unit_price

      );

    if (

      unitPrice === null ||

      unitPrice < 0

    ) {

      throw createServiceError(

        `El producto ${product.sku} no posee un precio válido`,

        409,

        "CHECKOUT_PRODUCT_PRICE_INVALID"

      );

    }

    const inventoryResult =

      await client.query(

        `

          SELECT

            id,

            product_id,

            stock_quantity,

            reserved_quantity,

            safety_stock,

            relbase_warehouse_id

          FROM inventory

          WHERE product_id = $1

            AND relbase_warehouse_id = $2

          LIMIT 1

          FOR UPDATE

        `,

        [

          product.id,

          warehouseId,

        ]

      );

    if (

      inventoryResult.rowCount ===

      0

    ) {

      throw createServiceError(

        `El producto ${product.sku} no posee inventario en la bodega web`,

        409,

        "CHECKOUT_INVENTORY_NOT_FOUND"

      );

    }

    const inventory =

      inventoryResult.rows[0];

    const reservationResult =

      await client.query(

        `

          SELECT

            COALESCE(

              SUM(quantity),

              0

            ) AS active_reserved

          FROM inventory_reservations

          WHERE inventory_id = $1

            AND status = 'ACTIVE'

            AND (

              expires_at IS NULL

              OR expires_at > NOW()

            )

        `,

        [

          inventory.id,

        ]

      );

    const stockQuantity =

      Number(

        inventory

          .stock_quantity ||

        0

      );

    const reservedQuantity =

      Number(

        inventory

          .reserved_quantity ||

        0

      );

    const safetyStock =

      Number(

        inventory

          .safety_stock ||

        0

      );

    const activeReserved =

      Number(

        reservationResult

          .rows[0]

          ?.active_reserved ||

        0

      );

    const available =

      Math.max(

        stockQuantity -

          reservedQuantity -

          safetyStock -

          activeReserved,

        0

      );

    if (

      quantity >

      available

    ) {

      throw createServiceError(

        `Stock insuficiente para ${product.sku}. Disponible: ${available}`,

        409,

        "CHECKOUT_STOCK_INSUFFICIENT"

      );

    }

    const taxRate =

      Number(

        product.tax_rate ??

          19

      );

    if (

      !Number.isFinite(

        taxRate

      ) ||

      taxRate < 0

    ) {

      throw createServiceError(

        `El IVA del producto ${product.sku} no es válido`,

        409,

        "CHECKOUT_PRODUCT_TAX_INVALID"

      );

    }

    const lineSubtotal =

      roundMoney(

        unitPrice *

          quantity

      );

    const discountAmount =

      0;

    const lineTotal =

      roundMoney(

        lineSubtotal -

          discountAmount

      );

    const taxAmount =

      taxRate <= 0

        ? 0

        : roundMoney(

            lineTotal -

              roundMoney(

                lineTotal /

                  (

                    1 +

                    taxRate /

                      100

                  )

              )

          );

    return {

      product,

      inventory,

      quantity,

      available_before:

        available,

      unit_price:

        unitPrice,

      pricing,

      discount_amount:

        discountAmount,

      tax_rate:

        taxRate,

      line_subtotal:

        lineSubtotal,

      line_total:

        lineTotal,

      tax_amount:

        taxAmount,

    };

  };

/*  =========================================

   CONFIGURACIÓN TRANSFERENCIA

========================================= */

const getManualTransferConfiguration =

  async (

    client

  ) => {

    const methodResult =

      await client.query(

        `

          SELECT

            id,

            code,

            name,

            requires_manual_confirmation

          FROM payment_methods

          WHERE code = 'MANUAL_BANK_TRANSFER'

            AND is_active = TRUE

          LIMIT 1

        `

      );

    if (

      methodResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "El método de transferencia bancaria no está activo",

        409,

        "MANUAL_BANK_TRANSFER_METHOD_NOT_AVAILABLE"

      );

    }

    const providerResult =

      await client.query(

        `

          SELECT

            id,

            code,

            name,

            environment,

            supports_idempotency

          FROM payment_providers

          WHERE code = 'MANUAL_TRANSFER'

            AND is_active = TRUE

          LIMIT 1

        `

      );

    if (

      providerResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "El proveedor de transferencia manual no está activo",

        409,

        "MANUAL_TRANSFER_PROVIDER_NOT_AVAILABLE"

      );

    }

    const bankResult =

      await client.query(

        `

          SELECT

            id,

            bank_name,

            account_type,

            account_number,

            account_holder,

            rut,

            email,

            currency,

            is_default,

            sort_order

          FROM bank_accounts

          WHERE is_active = TRUE

          ORDER BY

            is_default DESC,

            sort_order ASC,

            created_at ASC

          LIMIT 1

        `

      );

    if (

      bankResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "No existe una cuenta bancaria activa configurada para recibir transferencias",

        409,

        "BANK_ACCOUNT_NOT_CONFIGURED"

      );

    }

    return {

      method:

        methodResult.rows[0],

      provider:

        providerResult.rows[0],

      bank_account:

        bankResult.rows[0],

    };

  };

/*  =========================================

   CREAR ORDEN CHECKOUT WEB

   PASO ACTUAL:

   - compra invitado

   - user_id = NULL

   - company_id = NULL

   En el siguiente ajuste se podrá asociar

   automáticamente un JWT opcional sin bloquear

   el checkout invitado.

========================================= */

export const createGuestCheckoutOrder =

  async (

    payload

  ) => {

    const {

      contact:

        rawContact,

      document_type:

        rawDocumentType,

      billing:

        rawBilling = {},

      items:

        rawItems,

      payment_method:

        rawPaymentMethod =

          "MANUAL_BANK_TRANSFER",

    } =

      payload || {};

    const contact =

      normalizeContact(

        rawContact

      );

    const billing =

      normalizeBilling({

        documentType:

          rawDocumentType,

        billing:

          rawBilling,

        contact,

      });

    const items =

      normalizeItems(

        rawItems

      );

    const paymentMethod =

      cleanText(

        rawPaymentMethod

      ).toUpperCase();

    if (

      paymentMethod !==

      "MANUAL_BANK_TRANSFER"

    ) {

      throw createServiceError(

        "El método de pago seleccionado no está disponible",

        400,

        "CHECKOUT_PAYMENT_METHOD_NOT_AVAILABLE"

      );

    }

    const warehouseId =

      getWebWarehouseId();

    const guestAccess =

      createGuestAccessToken();

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      const resolvedItems =

        [];

      for (

        const item of items

      ) {

        const resolved =

          await getCheckoutProduct({

            client,

            productId:

              item.product_id,

            quantity:

              item.quantity,

            warehouseId,

          });

        resolvedItems.push(

          resolved

        );

      }

      const subtotal =

        roundMoney(

          resolvedItems.reduce(

            (

              total,

              item

            ) =>

              total +

              item.line_subtotal,

            0

          )

        );

      const discountTotal =

        roundMoney(

          resolvedItems.reduce(

            (

              total,

              item

            ) =>

              total +

              item.discount_amount,

            0

          )

        );

      const shippingTotal =

        0;

      const taxTotal =

        roundMoney(

          resolvedItems.reduce(

            (

              total,

              item

            ) =>

              total +

              item.tax_amount,

            0

          )

        );

      const total =

        roundMoney(

          resolvedItems.reduce(

            (

              sum,

              item

            ) =>

              sum +

              item.line_total,

            0

          ) +

          shippingTotal

        );

      if (

        subtotal === null ||

        discountTotal === null ||

        taxTotal === null ||

        total === null ||

        total <= 0

      ) {

        throw createServiceError(

          "No fue posible calcular el total del pedido",

          409,

          "CHECKOUT_TOTAL_INVALID"

        );

      }

      const orderResult =

        await client.query(

          `

            INSERT INTO orders (

              user_id,

              email,

              customer_name,

              customer_rut,

              customer_phone,

              status,

              payment_status,

              fulfillment_status,

              subtotal,

              discount_total,

              shipping_total,

              tax_total,

              total,

              currency,

              notes,

              company_id,

              source,

              guest_access_token_hash,

              guest_access_expires_at,

              guest_access_revoked_at

            )

            VALUES (

              NULL,

              $1,

              $2,

              $3,

              $4,

              'PENDING',

              'PENDING',

              'PENDING',

              $5,

              $6,

              $7,

              $8,

              $9,

              'CLP',

              'Checkout WEB - compra como invitado',

              NULL,

              'WEB',

              $10,

              NOW() + INTERVAL '30 days',

              NULL

            )

            RETURNING

              id,

              order_number,

              user_id,

              email,

              customer_name,

              customer_rut,

              customer_phone,

              status,

              payment_status,

              fulfillment_status,

              subtotal,

              discount_total,

              shipping_total,

              tax_total,

              total,

              currency,

              source,

              guest_access_expires_at,

              created_at

          `,

          [

            contact.email,

            contact

              .customer_name,

            contact.rut,

            contact.phone,

            subtotal,

            discountTotal,

            shippingTotal,

            taxTotal,

            total,

            guestAccess.hash,

          ]

        );

      const order =

        orderResult.rows[0];

      const createdItems =

        [];

      let reservationExpiresAt =

        null;

      for (

        const item of

          resolvedItems

      ) {

        const itemResult =

          await client.query(

            `

              INSERT INTO order_items (

                order_id,

                product_id,

                sku,

                product_name,

                quantity,

                unit_price,

                discount_amount,

                tax_rate,

                line_subtotal,

                line_total,

                product_code,

                finish,

                reference_code

              )

              VALUES (

                $1,

                $2,

                $3,

                $4,

                $5,

                $6,

                $7,

                $8,

                $9,

                $10,

                $11,

                $12,

                $13

              )

              RETURNING

                id,

                order_id,

                product_id,

                sku,

                product_name,

                quantity,

                unit_price,

                discount_amount,

                tax_rate,

                line_subtotal,

                line_total,

                product_code,

                finish,

                reference_code,

                created_at

            `,

            [

              order.id,

              item.product.id,

              item.product.sku,

              item.product.name,

              item.quantity,

              item.unit_price,

              item.discount_amount,

              item.tax_rate,

              item.line_subtotal,

              item.line_total,

              item.product

                .internal_code ||

                null,

              item.product.finish ||

                null,

              item.product.sku,

            ]

          );

        createdItems.push(

          itemResult.rows[0]

        );

        const reservationResult =

          await client.query(

            `

              INSERT INTO inventory_reservations (

                inventory_id,

                order_id,

                quantity,

                status,

                expires_at

              )

              VALUES (

                $1,

                $2,

                $3,

                'ACTIVE',

                NOW() + INTERVAL '24 hours'

              )

              RETURNING

                id,

                inventory_id,

                order_id,

                quantity,

                status,

                expires_at,

                created_at

            `,

            [

              item.inventory.id,

              order.id,

              item.quantity,

            ]

          );

        reservationExpiresAt =

          reservationResult

            .rows[0]

            .expires_at;

      }

      const billingResult =

        await client.query(

          `

            INSERT INTO order_billing_data (

              order_id,

              document_type,

              customer_type,

              rut,

              legal_name,

              trade_name,

              business_activity,

              billing_email,

              phone,

              address_line,

              commune,

              city,

              region,

              country,

              relbase_customer_id

            )

            VALUES (

              $1,

              $2,

              $3,

              $4,

              $5,

              $6,

              $7,

              $8,

              $9,

              $10,

              $11,

              $12,

              $13,

              $14,

              $15

            )

            RETURNING

              id,

              order_id,

              document_type,

              customer_type,

              rut,

              legal_name,

              trade_name,

              business_activity,

              billing_email,

              phone,

              address_line,

              commune,

              city,

              region,

              country,

              relbase_customer_id,

              created_at

          `,

          [

            order.id,

            billing

              .document_type,

            billing

              .customer_type,

            billing.rut,

            billing.legal_name,

            billing.trade_name,

            billing

              .business_activity,

            billing

              .billing_email,

            billing.phone,

            billing

              .address_line,

            billing.commune,

            billing.city,

            billing.region,

            billing.country,

            billing

              .relbase_customer_id,

          ]

        );

      const transferConfiguration =

        await getManualTransferConfiguration(

          client

        );

      if (

        cleanText(

          transferConfiguration

            .bank_account

            .currency

        ).toUpperCase() !==

        "CLP"

      ) {

        throw createServiceError(

          "La moneda de la cuenta bancaria no coincide con la orden",

          409,

          "BANK_ACCOUNT_CURRENCY_MISMATCH"

        );

      }

      const paymentResult =

        await client.query(

          `

            INSERT INTO payments (

              order_id,

              provider_id,

              payment_method_id,

              bank_account_id,

              amount,

              currency,

              status,

              customer_reference,

              notes

            )

            VALUES (

              $1,

              $2,

              $3,

              $4,

              $5,

              'CLP',

              'PENDING',

              $6,

              'Pago mediante transferencia bancaria manual'

            )

            RETURNING

              id,

              order_id,

              amount,

              currency,

              status,

              customer_reference,

              created_at

          `,

          [

            order.id,

            transferConfiguration

              .provider.id,

            transferConfiguration

              .method.id,

            transferConfiguration

              .bank_account.id,

            order.total,

            order

              .order_number,

          ]

        );

      const payment =

        paymentResult.rows[0];

      await client.query(

        "COMMIT"

      );

      const bankAccount =

        transferConfiguration

          .bank_account;

      return {

        order,

        billing:

          billingResult.rows[0],

        items:

          createdItems,

        reservation: {

          warehouse_id:

            warehouseId,

          status:

            "ACTIVE",

          expires_at:

            reservationExpiresAt,

        },

        payment: {

          ...payment,

          method: {

            code:

              transferConfiguration

                .method.code,

            name:

              transferConfiguration

                .method.name,

            requires_manual_confirmation:

              transferConfiguration

                .method

                .requires_manual_confirmation,

          },

          provider: {

            code:

              transferConfiguration

                .provider.code,

            name:

              transferConfiguration

                .provider.name,

          },

          bank_account: {

            bank_name:

              bankAccount

                .bank_name,

            account_type:

              bankAccount

                .account_type,

            account_number:

              bankAccount

                .account_number,

            account_holder:

              bankAccount

                .account_holder,

            rut:

              bankAccount.rut,

            email:

              bankAccount.email,

            currency:

              bankAccount

                .currency,

          },

        },

        guest_access: {

          token:

            guestAccess.token,

          expires_at:

            order

              .guest_access_expires_at,

        },

        next: {

          relative_url:

            `/pago/transferencia?order=${encodeURIComponent(

              order.id

            )}&token=${encodeURIComponent(

              guestAccess.token

            )}`,

        },

        warnings:

          billing

              .document_type ===

              "FACTURA" &&

            !billing

              .relbase_customer_id

            ? [

                {

                  code:

                    "FACTURA_RELBASE_CUSTOMER_PENDING",

                  message:

                    "La orden de factura fue creada, pero antes de emitir el DTE deberá resolverse el cliente Relbase asociado al RUT.",

                },

              ]

            : [],

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede haber terminado.

      }

      throw error;

    } finally {

      client.release();

    }

  };

/*  =========================================

   CONSULTAR ORDEN INVITADO

   SEGURIDAD:

   - order_id válido

   - token enviado por header

   - SHA-256 debe coincidir

   - token no revocado

   - token no expirado

   No se permite acceso por email.

========================================= */

export const getGuestCheckoutOrder =

  async ({

    orderId,

    guestToken,

  }) => {

    const normalizedOrderId =

      cleanText(

        orderId

      );

    const normalizedToken =

      cleanText(

        guestToken

      );

    if (

      !isUuid(

        normalizedOrderId

      )

    ) {

      throw createServiceError(

        "El pedido solicitado no es válido",

        400,

        "GUEST_ORDER_ID_INVALID"

      );

    }

    if (

      !normalizedToken ||

      normalizedToken.length < 20 ||

      normalizedToken.length > 200

    ) {

      throw createServiceError(

        "El acceso privado del pedido no es válido",

        401,

        "GUEST_ORDER_TOKEN_INVALID"

      );

    }

    const tokenHash =

      hashToken(

        normalizedToken

      );

    const client =

      await pool.connect();

    try {

      const orderResult =

        await client.query(

          `

            SELECT

              id,

              order_number,

              user_id,

              email,

              customer_name,

              customer_rut,

              customer_phone,

              status,

              payment_status,

              fulfillment_status,

              subtotal,

              discount_total,

              shipping_total,

              tax_total,

              total,

              currency,

              source,

              guest_access_expires_at,

              created_at,

              updated_at

            FROM orders

            WHERE id = $1

              AND guest_access_token_hash = $2

              AND guest_access_revoked_at IS NULL

              AND guest_access_expires_at IS NOT NULL

              AND guest_access_expires_at > NOW()

            LIMIT 1

          `,

          [

            normalizedOrderId,

            tokenHash,

          ]

        );

      if (

        orderResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El enlace privado del pedido no es válido o expiró",

          404,

          "GUEST_ORDER_ACCESS_INVALID"

        );

      }

      const order =

        orderResult.rows[0];

      const billingResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              document_type,

              customer_type,

              rut,

              legal_name,

              trade_name,

              business_activity,

              billing_email,

              phone,

              address_line,

              commune,

              city,

              region,

              country,

              relbase_customer_id,

              created_at,

              updated_at

            FROM order_billing_data

            WHERE order_id = $1

            LIMIT 1

          `,

          [

            order.id,

          ]

        );

      const itemsResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              product_id,

              sku,

              product_name,

              quantity,

              unit_price,

              discount_amount,

              tax_rate,

              line_subtotal,

              line_total,

              product_code,

              finish,

              reference_code,

              created_at

            FROM order_items

            WHERE order_id = $1

            ORDER BY created_at ASC, id ASC

          `,

          [

            order.id,

          ]

        );

      const paymentResult =

        await client.query(

          `

            SELECT

              p.id,

              p.order_id,

              p.amount,

              p.currency,

              p.status,

              p.customer_reference,

              p.external_reference,

              p.transfer_date,

              p.confirmed_at,

              p.rejected_at,

              p.rejection_reason,

              p.created_at,

              p.updated_at,

              pm.code AS payment_method_code,

              pm.name AS payment_method_name,

              pm.requires_manual_confirmation,

              pp.code AS provider_code,

              pp.name AS provider_name,

              ba.bank_name,

              ba.account_type,

              ba.account_number,

              ba.account_holder,

              ba.rut AS bank_account_rut,

              ba.email AS bank_account_email,

              ba.currency AS bank_account_currency

            FROM payments p

            INNER JOIN payment_methods pm

              ON pm.id = p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id = p.provider_id

            LEFT JOIN bank_accounts ba

              ON ba.id = p.bank_account_id

            WHERE p.order_id = $1

            LIMIT 1

          `,

          [

            order.id,

          ]

        );

      if (

        paymentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El pedido no posee un pago asociado",

          409,

          "GUEST_ORDER_PAYMENT_NOT_FOUND"

        );

      }

      const paymentRow =

        paymentResult.rows[0];

      const paymentStatus =

        String(

          paymentRow.status ||

          ""

        )

          .trim()

          .toUpperCase();

      const orderPaymentStatus =

        String(

          order.payment_status ||

          ""

        )

          .trim()

          .toUpperCase();

      /*

   * El QR sólo se consulta después de que

   * el token guest ya fue validado arriba.

   * Además, sólo se expone cuando tanto la

   * orden como el registro de pago están PAID.

       */

      const pickup =

        paymentStatus ===

          "PAID" &&

        orderPaymentStatus ===

          "PAID"

          ? await getGuestPickupForOrder(

              client,

              order.id

            )

          : null;

      return {

        order,

        billing:

          billingResult.rows[0] ||

          null,

        items:

          itemsResult.rows,

        payment: {

          id:

            paymentRow.id,

          order_id:

            paymentRow.order_id,

          amount:

            paymentRow.amount,

          currency:

            paymentRow.currency,

          status:

            paymentRow.status,

          customer_reference:

            paymentRow.customer_reference,

          external_reference:

            paymentRow.external_reference,

          transfer_date:

            paymentRow.transfer_date,

          confirmed_at:

            paymentRow.confirmed_at,

          rejected_at:

            paymentRow.rejected_at,

          rejection_reason:

            paymentRow.rejection_reason,

          created_at:

            paymentRow.created_at,

          updated_at:

            paymentRow.updated_at,

          method: {

            code:

              paymentRow.payment_method_code,

            name:

              paymentRow.payment_method_name,

            requires_manual_confirmation:

              paymentRow.requires_manual_confirmation,

          },

          provider: {

            code:

              paymentRow.provider_code,

            name:

              paymentRow.provider_name,

          },

          bank_account: {

            bank_name:

              paymentRow.bank_name,

            account_type:

              paymentRow.account_type,

            account_number:

              paymentRow.account_number,

            account_holder:

              paymentRow.account_holder,

            rut:

              paymentRow.bank_account_rut,

            email:

              paymentRow.bank_account_email,

            currency:

              paymentRow.bank_account_currency,

          },

        },

        pickup,

        pickup_next_action:

          !pickup

            ? (

                paymentStatus ===

                  "PAID" &&

                orderPaymentStatus ===

                  "PAID"

                  ? "WAIT_FOR_PICKUP_CREATION"

                  : "WAIT_FOR_PAYMENT_CONFIRMATION"

              )

            : pickup.status ===

                "PENDING"

              ? "WAIT_FOR_ORDER_READY"

              : pickup.status ===

                  "ACTIVE"

                ? "PRESENT_QR_AT_STORE"

                : pickup.status ===

                    "USED"

                  ? "PICKUP_COMPLETED"

                  : null,

      };

    } finally {

      client.release();

    }

  };

const resolveGuestRelbaseDteDetailRecord = (
  payload
) => {
  const data =
    payload?.data ??
    payload ??
    null;

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return null;
  }

  if (
    data.dte &&
    typeof data.dte === "object" &&
    !Array.isArray(data.dte)
  ) {
    return data.dte;
  }

  if (
    data.document &&
    typeof data.document === "object" &&
    !Array.isArray(data.document)
  ) {
    return data.document;
  }

  return data;
};

/* =========================================
   PDF TRIBUTARIO PARA CHECKOUT INVITADO

   SEGURIDAD:
   - Reutiliza getGuestCheckoutOrder() para
     revalidar order_id + X-Guest-Order-Token.
   - Requiere pago PAID tanto en la orden
     como en payments.
   - Sólo expone BOLETA/FACTURA local con
     estado ISSUED o ACCEPTED.
   - Requiere identidad externa persistida
     y pdf_url disponible.
   - No emite, no reconcilia y no modifica
     ningún documento tributario.
========================================= */
export const getGuestTaxDocumentPdf =
  async ({
    orderId,
    guestToken,
  }) => {
    /*
     * Reutilizamos el flujo de consulta guest
     * porque allí ya se valida de forma segura:
     * - UUID de la orden
     * - hash SHA-256 del token
     * - token no revocado
     * - token no expirado
     * - existencia del pago asociado
     */
    const guestOrder =
      await getGuestCheckoutOrder({
        orderId,
        guestToken,
      });

    const order =
      guestOrder?.order ||
      null;

    const payment =
      guestOrder?.payment ||
      null;

    const orderPaymentStatus =
      cleanText(
        order?.payment_status
      ).toUpperCase();

    const paymentStatus =
      cleanText(
        payment?.status
      ).toUpperCase();

    if (
      orderPaymentStatus !== "PAID" ||
      paymentStatus !== "PAID"
    ) {
      throw createServiceError(
        "El documento tributario estará disponible cuando el pago esté confirmado",
        409,
        "GUEST_TAX_DOCUMENT_PAYMENT_NOT_CONFIRMED"
      );
    }

    const client =
      await pool.connect();

    try {
      const documentResult =
        await client.query(
          `
            SELECT
              id,
              order_id,
              document_type,
              sii_code,
              relbase_document_id,
              folio,
              track_id,
              status,
              external_status,
              relbase_status,
              sii_status,
              sii_status_name,
              total_amount,
              issued_at,
              last_status_sync_at,
              pdf_url,
              created_at,
              updated_at
            FROM tax_documents
            WHERE order_id = $1
              AND document_type IN (
                'BOLETA',
                'FACTURA'
              )
            ORDER BY
              created_at DESC,
              id DESC
            LIMIT 1
          `,
          [
            order.id,
          ]
        );

      if (
        documentResult.rowCount ===
        0
      ) {
        throw createServiceError(
          "El documento tributario todavía no ha sido preparado",
          409,
          "GUEST_TAX_DOCUMENT_NOT_PREPARED"
        );
      }

      const document =
        documentResult.rows[0];

      const documentStatus =
        cleanText(
          document.status
        ).toUpperCase();

      if (
        ![
          "ISSUED",
          "ACCEPTED",
        ].includes(
          documentStatus
        )
      ) {
        throw createServiceError(
          "El documento tributario todavía no está disponible para descarga",
          409,
          "GUEST_TAX_DOCUMENT_NOT_AVAILABLE"
        );
      }

      const relbaseDocumentId =
        cleanText(
          document.relbase_document_id
        );

      const folio =
        cleanText(
          document.folio
        );

      if (
        !relbaseDocumentId ||
        !folio
      ) {
        throw createServiceError(
          "El documento tributario no posee una identidad externa completa",
          409,
          "GUEST_TAX_DOCUMENT_EXTERNAL_IDENTITY_INCOMPLETE"
        );
      }

      const localPdfUrl =
        normalizeRelbaseHttpUrl(
          document.pdf_url
        );

      let pdfUrl =
        isRelbaseHttpUrlUsable(
          localPdfUrl,
          60
        )
          ? localPdfUrl
          : null;

      let pdfSource =
        pdfUrl
          ? "LOCAL_PDF_URL"
          : null;

      let relbaseGetExecuted =
        false;

      if (!pdfUrl) {
        const endpoint =
          `/api/v2/dtes/${encodeURIComponent(
            relbaseDocumentId
          )}`;

        const detailResult =
          await relbaseRequest(
            endpoint,
            {
              method:
                "GET",
            }
          );

        relbaseGetExecuted =
          true;

        const record =
          resolveGuestRelbaseDteDetailRecord(
            detailResult?.data ??
            null
          );

        if (
          !record ||
          typeof record !==
            "object" ||
          Array.isArray(record)
        ) {
          throw createServiceError(
            "Relbase respondió con una estructura DTE no reconocida",
            502,
            "GUEST_RELBASE_DTE_DETAIL_INVALID"
          );
        }

        const normalized =
          normalizeRelbaseDteRecord(
            record
          );

        if (
          String(
            normalized.relbase_document_id ||
            ""
          ) !==
          relbaseDocumentId
        ) {
          throw createServiceError(
            "El DTE obtenido desde Relbase no coincide con el documento del pedido",
            409,
            "GUEST_RELBASE_DTE_ID_MISMATCH"
          );
        }

        if (
          normalized.type_document !==
            null &&
          document.sii_code !==
            null &&
          Number(
            normalized.type_document
          ) !==
          Number(
            document.sii_code
          )
        ) {
          throw createServiceError(
            "El tipo del DTE de Relbase no coincide con el documento del pedido",
            409,
            "GUEST_RELBASE_DTE_TYPE_MISMATCH"
          );
        }

        if (
          folio &&
          normalized.folio &&
          String(
            normalized.folio
          ) !==
          folio
        ) {
          throw createServiceError(
            "El folio del DTE de Relbase no coincide con el documento del pedido",
            409,
            "GUEST_RELBASE_DTE_FOLIO_MISMATCH"
          );
        }

        const externalTotal =
          normalized.amounts?.total;

        const localDocumentTotal =
          roundMoney(
            document.total_amount
          );

        if (
          externalTotal !==
            null &&
          externalTotal !==
            undefined &&
          localDocumentTotal !==
            null &&
          Math.abs(
            Number(externalTotal) -
              localDocumentTotal
          ) > 1
        ) {
          throw createServiceError(
            "El total del DTE obtenido desde Relbase no coincide con el documento del pedido",
            409,
            "GUEST_RELBASE_DTE_TOTAL_MISMATCH"
          );
        }

        const refreshedPdfUrl =
          normalizeRelbaseHttpUrl(
            normalized.pdf_url
          );

        if (
          !isRelbaseHttpUrlUsable(
            refreshedPdfUrl,
            60
          )
        ) {
          throw createServiceError(
            "El PDF del documento tributario todavía no está disponible",
            409,
            "GUEST_TAX_DOCUMENT_PDF_NOT_AVAILABLE"
          );
        }

        pdfUrl =
          refreshedPdfUrl;

        pdfSource =
          "RELBASE_DTE_DETAIL";
      }

      const orderTotal =
        roundMoney(
          order.total
        );

      const documentTotal =
        roundMoney(
          document.total_amount
        );

      if (
        orderTotal === null ||
        documentTotal === null ||
        Math.abs(
          orderTotal -
            documentTotal
        ) > 1
      ) {
        throw createServiceError(
          "El total del documento tributario no coincide con el total del pedido",
          409,
          "GUEST_TAX_DOCUMENT_TOTAL_MISMATCH"
        );
      }

      return {
        ready: true,

        order_id:
          order.id,

        order_number:
          order.order_number,

        document: {
          document_type:
            document.document_type,

          sii_code:
            document.sii_code,

          folio:
            document.folio,

          status:
            documentStatus,

          external_status:
            document.external_status,

          relbase_status:
            document.relbase_status,

          sii_status:
            document.sii_status,

          sii_status_name:
            document.sii_status_name,

          total_amount:
            document.total_amount,

          issued_at:
            document.issued_at,

          last_status_sync_at:
            document.last_status_sync_at,
        },

        pdf_source:
          pdfSource,

        relbase_get_executed:
          relbaseGetExecuted,

        local_pdf_url_stale:
          Boolean(
            localPdfUrl &&
            !isRelbaseHttpUrlUsable(
              localPdfUrl,
              60
            )
          ),

        pdf_url:
          pdfUrl,
      };
    } finally {
      client.release();
    }
  };

