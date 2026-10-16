import pool from "../config/database.js";
import {
  ensureCustomerDocumentAccessForAcceptedDte,
} from "./customerDocumentAccess.service.js";
import {
  resolveCustomerProductPrice,
} from "./customerPricing.service.js";
import {
  getProductImageSignedUrl,
} from "./productImageStorage.service.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const cleanText = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeRole = (role) =>
  String(role || "")
    .trim()
    .toUpperCase();

const roleLabel = (role) => {
  const normalized = normalizeRole(role);

  if (normalized === "CLIENTE") {
    return "Cliente";
  }

  if (normalized === "USUARIO_EMPRESA") {
    return "Empresa cliente";
  }

  return normalized;
};

const assertUuid = (value, fieldName) => {
  const normalized = String(value || "").trim();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
  ) {
    throw createServiceError(
      `${fieldName} no posee un UUID válido`,
      400,
      "INVALID_UUID"
    );
  }

  return normalized;
};

const getPagination = (query = {}) => {
  const page = Math.max(
    Number.parseInt(query.page, 10) || DEFAULT_PAGE,
    1
  );

  const requestedLimit =
    Number.parseInt(query.limit, 10) || DEFAULT_LIMIT;

  const limit = Math.min(
    Math.max(requestedLimit, 1),
    MAX_LIMIT
  );

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
};

const buildPagination = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  total_pages:
    total === 0 ? 0 : Math.ceil(total / limit),
  has_next_page: page * limit < total,
  has_previous_page: page > 1,
});

const accountOrderAccessSql = (role, userParam) => {
  if (normalizeRole(role) === "USUARIO_EMPRESA") {
    return `(
      o.user_id = ${userParam}
      OR EXISTS (
        SELECT 1
        FROM company_users cu
        INNER JOIN customer_companies cc
          ON cc.id = cu.company_id
        WHERE cu.user_id = ${userParam}
          AND cu.company_id = o.company_id
          AND cu.is_active = TRUE
          AND cc.is_active = TRUE
      )
    )`;
  }

  return `o.user_id = ${userParam}`;
};

const getCompaniesForUser = async (db, userId) => {
  const result = await db.query(
    `
      SELECT
        cc.id,
        cc.legal_name,
        cc.trade_name,
        cc.rut,
        cc.business_activity,
        cc.billing_email,
        cc.phone,
        cc.address_line,
        cc.commune,
        cc.city,
        cc.region,
        cc.country,
        cc.relbase_customer_id,
        cc.is_active,
        cu.position_name,
        cu.is_primary_contact,
        cu.is_active AS relation_active
      FROM company_users cu
      INNER JOIN customer_companies cc
        ON cc.id = cu.company_id
      WHERE cu.user_id = $1
        AND cu.is_active = TRUE
        AND cc.is_active = TRUE
      ORDER BY
        cu.is_primary_contact DESC,
        cc.legal_name ASC
    `,
    [userId]
  );

  return result.rows;
};

export const getAccountMe = async ({ userId }) => {
  const normalizedUserId = assertUuid(userId, "userId");

  const result = await pool.query(
    `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.rut,
        u.is_active,
        u.email_verified,
        u.last_login_at,
        u.created_at,
        u.updated_at,
        r.name AS role
      FROM users u
      INNER JOIN roles r
        ON r.id = u.role_id
      WHERE u.id = $1
        AND u.is_active = TRUE
      LIMIT 1
    `,
    [normalizedUserId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La cuenta no existe o se encuentra deshabilitada",
      404,
      "ACCOUNT_NOT_FOUND"
    );
  }

  const user = result.rows[0];
  const companies = await getCompaniesForUser(
    pool,
    normalizedUserId
  );

  return {
    ...user,
    role_label: roleLabel(user.role),
    companies,
  };
};

export const updateAccountProfile = async ({
  userId,
  data,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");

  const allowedFields = [
    "first_name",
    "last_name",
    "phone",
    "rut",
  ];

  const sets = [];
  const values = [];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      values.push(
        data[field] === null ? null : data[field]
      );
      sets.push(`${field} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    throw createServiceError(
      "No hay campos válidos para actualizar",
      400,
      "ACCOUNT_UPDATE_EMPTY"
    );
  }

  values.push(normalizedUserId);

  const result = await pool.query(
    `
      UPDATE users
      SET ${sets.join(", ")}
      WHERE id = $${values.length}
        AND is_active = TRUE
      RETURNING
        id,
        first_name,
        last_name,
        email,
        phone,
        rut,
        is_active,
        email_verified,
        last_login_at,
        created_at,
        updated_at
    `,
    values
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La cuenta no existe o se encuentra deshabilitada",
      404,
      "ACCOUNT_NOT_FOUND"
    );
  }

  return result.rows[0];
};

export const listAccountAddresses = async ({ userId }) => {
  const normalizedUserId = assertUuid(userId, "userId");

  const result = await pool.query(
    `
      SELECT
        id,
        label,
        recipient_name,
        rut,
        phone,
        street,
        street_number,
        apartment,
        commune,
        city,
        region,
        country,
        postal_code,
        delivery_notes,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE user_id = $1
        AND is_active = TRUE
      ORDER BY
        is_default DESC,
        created_at DESC,
        id DESC
    `,
    [normalizedUserId]
  );

  return result.rows;
};

export const createAccountAddress = async ({
  userId,
  data,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const activeResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM addresses
        WHERE user_id = $1
          AND is_active = TRUE
      `,
      [normalizedUserId]
    );

    const firstAddress =
      Number(activeResult.rows[0].total) === 0;

    const shouldBeDefault =
      data.is_default === true || firstAddress;

    if (shouldBeDefault) {
      await client.query(
        `
          UPDATE addresses
          SET is_default = FALSE
          WHERE user_id = $1
            AND is_active = TRUE
            AND is_default = TRUE
        `,
        [normalizedUserId]
      );
    }

    const result = await client.query(
      `
        INSERT INTO addresses (
          user_id,
          label,
          recipient_name,
          rut,
          phone,
          street,
          street_number,
          apartment,
          commune,
          city,
          region,
          country,
          postal_code,
          delivery_notes,
          is_default,
          is_active
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,$14,$15,TRUE
        )
        RETURNING *
      `,
      [
        normalizedUserId,
        cleanText(data.label),
        data.recipient_name,
        cleanText(data.rut),
        cleanText(data.phone),
        data.street,
        data.street_number,
        cleanText(data.apartment),
        data.commune,
        cleanText(data.city),
        data.region,
        cleanText(data.country) || "Chile",
        cleanText(data.postal_code),
        cleanText(data.delivery_notes),
        shouldBeDefault,
      ]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const updateAccountAddress = async ({
  userId,
  addressId,
  data,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const normalizedAddressId = assertUuid(
    addressId,
    "addressId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
        SELECT id
        FROM addresses
        WHERE id = $1
          AND user_id = $2
          AND is_active = TRUE
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedAddressId, normalizedUserId]
    );

    if (existingResult.rowCount === 0) {
      throw createServiceError(
        "La dirección no existe",
        404,
        "ACCOUNT_ADDRESS_NOT_FOUND"
      );
    }

    if (data.is_default === true) {
      await client.query(
        `
          UPDATE addresses
          SET is_default = FALSE
          WHERE user_id = $1
            AND id <> $2
            AND is_active = TRUE
            AND is_default = TRUE
        `,
        [normalizedUserId, normalizedAddressId]
      );
    }

    const allowedFields = [
      "label",
      "recipient_name",
      "rut",
      "phone",
      "street",
      "street_number",
      "apartment",
      "commune",
      "city",
      "region",
      "country",
      "postal_code",
      "delivery_notes",
      "is_default",
    ];

    const sets = [];
    const values = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(data[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }

    values.push(normalizedAddressId);
    values.push(normalizedUserId);

    const result = await client.query(
      `
        UPDATE addresses
        SET ${sets.join(", ")}
        WHERE id = $${values.length - 1}
          AND user_id = $${values.length}
          AND is_active = TRUE
        RETURNING *
      `,
      values
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const deleteAccountAddress = async ({
  userId,
  addressId,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const normalizedAddressId = assertUuid(
    addressId,
    "addressId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
        SELECT id, is_default
        FROM addresses
        WHERE id = $1
          AND user_id = $2
          AND is_active = TRUE
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedAddressId, normalizedUserId]
    );

    if (existingResult.rowCount === 0) {
      throw createServiceError(
        "La dirección no existe",
        404,
        "ACCOUNT_ADDRESS_NOT_FOUND"
      );
    }

    const wasDefault =
      existingResult.rows[0].is_default === true;

    await client.query(
      `
        UPDATE addresses
        SET
          is_active = FALSE,
          is_default = FALSE
        WHERE id = $1
          AND user_id = $2
      `,
      [normalizedAddressId, normalizedUserId]
    );

    let newDefault = null;

    if (wasDefault) {
      const replacementResult = await client.query(
        `
          SELECT id
          FROM addresses
          WHERE user_id = $1
            AND is_active = TRUE
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `,
        [normalizedUserId]
      );

      if (replacementResult.rowCount > 0) {
        const updatedDefault = await client.query(
          `
            UPDATE addresses
            SET is_default = TRUE
            WHERE id = $1
            RETURNING *
          `,
          [replacementResult.rows[0].id]
        );

        newDefault = updatedDefault.rows[0];
      }
    }

    await client.query("COMMIT");

    return {
      deleted: true,
      address_id: normalizedAddressId,
      new_default: newDefault,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const listAccountCompanies = async ({ userId }) => {
  const normalizedUserId = assertUuid(userId, "userId");
  return getCompaniesForUser(pool, normalizedUserId);
};

export const updateAccountCompany = async ({
  userId,
  companyId,
  data,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const normalizedCompanyId = assertUuid(
    companyId,
    "companyId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const membershipResult = await client.query(
      `
        SELECT
          cc.id,
          cc.relbase_customer_id,
          cu.is_primary_contact
        FROM company_users cu
        INNER JOIN customer_companies cc
          ON cc.id = cu.company_id
        WHERE cu.user_id = $1
          AND cu.company_id = $2
          AND cu.is_active = TRUE
          AND cc.is_active = TRUE
        LIMIT 1
        FOR UPDATE OF cc, cu
      `,
      [normalizedUserId, normalizedCompanyId]
    );

    if (membershipResult.rowCount === 0) {
      throw createServiceError(
        "La empresa no está asociada a tu cuenta",
        403,
        "ACCOUNT_COMPANY_ACCESS_DENIED"
      );
    }

    if (
      membershipResult.rows[0].is_primary_contact !== true
    ) {
      throw createServiceError(
        "Sólo el contacto principal puede actualizar los datos de la empresa",
        403,
        "ACCOUNT_COMPANY_PRIMARY_CONTACT_REQUIRED"
      );
    }

    const allowedFields = [
      "trade_name",
      "business_activity",
      "billing_email",
      "phone",
      "address_line",
      "commune",
      "city",
      "region",
      "country",
    ];

    const sets = [];
    const values = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(data[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }

    values.push(normalizedCompanyId);

    const result = await client.query(
      `
        UPDATE customer_companies
        SET ${sets.join(", ")}
        WHERE id = $${values.length}
          AND is_active = TRUE
        RETURNING
          id,
          legal_name,
          trade_name,
          rut,
          business_activity,
          billing_email,
          phone,
          address_line,
          commune,
          city,
          region,
          country,
          relbase_customer_id,
          is_active,
          created_at,
          updated_at
      `,
      values
    );

    await client.query("COMMIT");

    return {
      company: result.rows[0],
      relbase_sync_required:
        Boolean(
          membershipResult.rows[0].relbase_customer_id
        ),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const listAccountOrders = async ({
  userId,
  role,
  query = {},
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const { page, limit, offset } = getPagination(query);
  const values = [normalizedUserId];
  const conditions = [
    accountOrderAccessSql(role, "$1"),
  ];

  const filters = [
    ["status", query.status],
    ["payment_status", query.payment_status],
    ["source", query.source],
  ];

  for (const [column, rawValue] of filters) {
    const value = cleanText(rawValue);

    if (value) {
      values.push(value.toUpperCase());
      conditions.push(
        `UPPER(o.${column}) = $${values.length}`
      );
    }
  }

  const countResult = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM orders o
      WHERE ${conditions.join(" AND ")}
    `,
    values
  );

  const total = Number(countResult.rows[0].total);
  const listValues = [...values, limit, offset];
  const limitParam = `$${listValues.length - 1}`;
  const offsetParam = `$${listValues.length}`;

  const result = await pool.query(
    `
      SELECT
        o.id,
        o.order_number,
        o.user_id,
        o.company_id,
        o.email,
        o.customer_name,
        o.source,
        o.status,
        o.payment_status,
        o.fulfillment_status,
        o.subtotal,
        o.discount_total,
        o.shipping_total,
        o.tax_total,
        o.total,
        o.currency,
        o.created_at,
        o.updated_at,
        obd.document_type,
        p.status AS payment_record_status,
        td.id AS tax_document_id,
        td.folio AS tax_document_folio,
        td.status AS tax_document_status,
        CASE
          WHEN o.company_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM company_users cu_scope
              WHERE cu_scope.user_id = $1
                AND cu_scope.company_id = o.company_id
                AND cu_scope.is_active = TRUE
            )
          THEN 'COMPANY'
          ELSE 'PERSONAL'
        END AS access_scope
      FROM orders o
      LEFT JOIN order_billing_data obd
        ON obd.order_id = o.id
      LEFT JOIN payments p
        ON p.order_id = o.id
      LEFT JOIN tax_documents td
        ON td.order_id = o.id
       AND td.document_type IN ('BOLETA', 'FACTURA')
      WHERE ${conditions.join(" AND ")}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    listValues
  );

  return {
    pagination: buildPagination({
      page,
      limit,
      total,
    }),
    orders: result.rows,
  };
};

export const getAccountOrder = async ({
  userId,
  role,
  orderId,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const normalizedOrderId = assertUuid(orderId, "orderId");
  const accessSql = accountOrderAccessSql(role, "$2");

  const orderResult = await pool.query(
    `
      SELECT
        o.*,
        CASE
          WHEN o.company_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM company_users cu_scope
              WHERE cu_scope.user_id = $2
                AND cu_scope.company_id = o.company_id
                AND cu_scope.is_active = TRUE
            )
          THEN 'COMPANY'
          ELSE 'PERSONAL'
        END AS access_scope
      FROM orders o
      WHERE o.id = $1
        AND ${accessSql}
      LIMIT 1
    `,
    [normalizedOrderId, normalizedUserId]
  );

  if (orderResult.rowCount === 0) {
    throw createServiceError(
      "El pedido no existe o no tienes permiso para verlo",
      404,
      "ACCOUNT_ORDER_NOT_FOUND"
    );
  }

  const [
    itemsResult,
    billingResult,
    addressResult,
    paymentResult,
    taxDocumentResult,
  ] = await Promise.all([
    pool.query(
      `
        SELECT
          id,
          product_id,
          sku,
          product_name,
          product_code,
          finish,
          reference_code,
          quantity,
          unit_price,
          discount_amount,
          tax_rate,
          line_subtotal,
          line_total,
          created_at
        FROM order_items
        WHERE order_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [normalizedOrderId]
    ),
    pool.query(
      `
        SELECT *
        FROM order_billing_data
        WHERE order_id = $1
        LIMIT 1
      `,
      [normalizedOrderId]
    ),
    pool.query(
      `
        SELECT *
        FROM order_addresses
        WHERE order_id = $1
        LIMIT 1
      `,
      [normalizedOrderId]
    ),
    pool.query(
      `
        SELECT
          p.id,
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
          pp.code AS provider_code,
          pp.name AS provider_name
        FROM payments p
        INNER JOIN payment_methods pm
          ON pm.id = p.payment_method_id
        INNER JOIN payment_providers pp
          ON pp.id = p.provider_id
        WHERE p.order_id = $1
        LIMIT 1
      `,
      [normalizedOrderId]
    ),
    pool.query(
      `
        SELECT
          id,
          document_type,
          sii_code,
          folio,
          status,
          relbase_status,
          sii_status,
          sii_status_name,
          net_amount,
          exempt_amount,
          tax_amount,
          total_amount,
          issued_at,
          created_at,
          updated_at
        FROM tax_documents
        WHERE order_id = $1
          AND document_type IN ('BOLETA', 'FACTURA')
        LIMIT 1
      `,
      [normalizedOrderId]
    ),
  ]);

  return {
    order: orderResult.rows[0],
    items: itemsResult.rows,
    billing: billingResult.rows[0] || null,
    address: addressResult.rows[0] || null,
    payment: paymentResult.rows[0] || null,
    tax_document: taxDocumentResult.rows[0] || null,
  };
};

export const listAccountDocuments = async ({
  userId,
  role,
  query = {},
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const { page, limit, offset } = getPagination(query);
  const accessSql = accountOrderAccessSql(role, "$1");
  const values = [normalizedUserId];
  const conditions = [accessSql];

  const status = cleanText(query.status);
  const documentType = cleanText(query.document_type);

  if (status) {
    values.push(status.toUpperCase());
    conditions.push(`UPPER(td.status) = $${values.length}`);
  }

  if (documentType) {
    values.push(documentType.toUpperCase());
    conditions.push(
      `UPPER(td.document_type) = $${values.length}`
    );
  }

  const countResult = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM tax_documents td
      INNER JOIN orders o
        ON o.id = td.order_id
      WHERE td.document_type IN ('BOLETA', 'FACTURA')
        AND ${conditions.join(" AND ")}
    `,
    values
  );

  const total = Number(countResult.rows[0].total);
  const listValues = [...values, limit, offset];
  const limitParam = `$${listValues.length - 1}`;
  const offsetParam = `$${listValues.length}`;

  const result = await pool.query(
    `
      SELECT
        td.id,
        td.order_id,
        o.order_number,
        o.company_id,
        o.customer_name,
        o.payment_status,
        td.document_type,
        td.sii_code,
        td.folio,
        td.status,
        td.relbase_status,
        td.sii_status,
        td.sii_status_name,
        td.net_amount,
        td.exempt_amount,
        td.tax_amount,
        td.total_amount,
        td.issued_at,
        td.created_at,
        td.updated_at,
        CASE
          WHEN td.status = 'ACCEPTED'
            AND o.payment_status = 'PAID'
          THEN TRUE
          ELSE FALSE
        END AS pdf_available,
        CASE
          WHEN o.company_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM company_users cu_scope
              WHERE cu_scope.user_id = $1
                AND cu_scope.company_id = o.company_id
                AND cu_scope.is_active = TRUE
            )
          THEN 'COMPANY'
          ELSE 'PERSONAL'
        END AS access_scope
      FROM tax_documents td
      INNER JOIN orders o
        ON o.id = td.order_id
      WHERE td.document_type IN ('BOLETA', 'FACTURA')
        AND ${conditions.join(" AND ")}
      ORDER BY COALESCE(td.issued_at, td.created_at) DESC, td.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    listValues
  );

  return {
    pagination: buildPagination({
      page,
      limit,
      total,
    }),
    documents: result.rows,
  };
};

export const createAccountDocumentAccess = async ({
  userId,
  role,
  taxDocumentId,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");
  const normalizedTaxDocumentId = assertUuid(
    taxDocumentId,
    "taxDocumentId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accessSql = accountOrderAccessSql(role, "$2");

    const documentResult = await client.query(
      `
        SELECT
          td.id,
          td.order_id,
          td.document_type,
          td.status,
          o.order_number,
          o.payment_status
        FROM tax_documents td
        INNER JOIN orders o
          ON o.id = td.order_id
        WHERE td.id = $1
          AND td.document_type IN ('BOLETA', 'FACTURA')
          AND ${accessSql}
        LIMIT 1
      `,
      [normalizedTaxDocumentId, normalizedUserId]
    );

    if (documentResult.rowCount === 0) {
      throw createServiceError(
        "El documento no existe o no tienes permiso para acceder",
        404,
        "ACCOUNT_DOCUMENT_NOT_FOUND"
      );
    }

    const document = documentResult.rows[0];

    if (
      String(document.status || "").toUpperCase() !==
        "ACCEPTED" ||
      String(document.payment_status || "").toUpperCase() !==
        "PAID"
    ) {
      throw createServiceError(
        "El documento todavía no se encuentra disponible para descarga",
        409,
        "ACCOUNT_DOCUMENT_NOT_AVAILABLE"
      );
    }

    const access =
      await ensureCustomerDocumentAccessForAcceptedDte(
        client,
        normalizedTaxDocumentId
      );

    await client.query("COMMIT");

    return {
      tax_document_id: normalizedTaxDocumentId,
      order_id: document.order_id,
      order_number: document.order_number,
      document_type: document.document_type,
      credential: access.credential,
      pdf_path:
        `/api/checkout/documents/${encodeURIComponent(
          access.credential
        )}/pdf`,
      expires_at: access.access.expires_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/* =========================================
   PRODUCTOS EXCLUSIVOS DE LA CUENTA

   - La lista interna nunca se expone al cliente.
   - PRODUCT tiene prioridad sobre COLLECTION
     porque el cálculo final se delega al motor
     central customerPricing.service.js.
   - Promoción pública y lista privada NO se
     acumulan. Sólo mostramos productos donde
     PRICE_LIST mejora realmente el precio
     público vigente.
========================================= */

const getExclusiveProductsImageMap = async (
  productIds
) => {
  if (
    !Array.isArray(productIds) ||
    productIds.length === 0
  ) {
    return new Map();
  }

  /*
   * La vista vw_product_catalog puede tener
   * primary_image_url = NULL cuando la imagen vive
   * en Railway Storage privado.
   *
   * Por eso obtenemos la imagen principal desde
   * product_images y generamos la misma URL firmada
   * que utiliza el catálogo público.
   */
  const result = await pool.query(
    `
      SELECT DISTINCT ON (pi.product_id)
        pi.id,
        pi.product_id,
        pi.image_url,
        pi.alt_text,
        pi.is_primary,
        pi.sort_order,
        pi.storage_provider,
        pi.thumbnail_key,
        pi.card_key,
        pi.detail_key,
        pi.created_at
      FROM product_images pi
      WHERE pi.product_id = ANY($1::uuid[])
      ORDER BY
        pi.product_id ASC,
        pi.is_primary DESC,
        pi.sort_order ASC,
        pi.created_at ASC
    `,
    [productIds]
  );

  const imageMap = new Map();

  await Promise.all(
    result.rows.map(async (image) => {
      let imageUrl =
        image.image_url || null;

      if (
        image.storage_provider === "RAILWAY"
      ) {
        const key =
          image.card_key ||
          image.thumbnail_key ||
          image.detail_key ||
          null;

        if (key) {
          try {
            imageUrl =
              await getProductImageSignedUrl(
                key
              );
          } catch (error) {
            console.error(
              "Error generando imagen firmada para producto exclusivo:",
              {
                product_id:
                  image.product_id,
                image_id:
                  image.id,
                error:
                  error?.message ||
                  error,
              }
            );

            imageUrl = null;
          }
        }
      }

      imageMap.set(
        image.product_id,
        {
          url: imageUrl,
          alt:
            image.alt_text ||
            null,
        }
      );
    })
  );

  return imageMap;
};


export const listAccountExclusiveProducts = async ({
  userId,
}) => {
  const normalizedUserId = assertUuid(userId, "userId");

  const priceListResult = await pool.query(
    `
      SELECT
        pl.id
      FROM user_price_lists upl
      INNER JOIN price_lists pl
        ON pl.id = upl.price_list_id
      WHERE upl.user_id = $1
        AND pl.is_active = TRUE
        AND (
          pl.valid_from IS NULL
          OR pl.valid_from <= CURRENT_DATE
        )
        AND (
          pl.valid_until IS NULL
          OR pl.valid_until >= CURRENT_DATE
        )
      LIMIT 1
    `,
    [normalizedUserId]
  );

  if (priceListResult.rowCount === 0) {
    return {
      has_exclusive_pricing: false,
      has_exclusive_products: false,
      count: 0,
      products: [],
    };
  }

  const priceListId = priceListResult.rows[0].id;

  const candidatesResult = await pool.query(
    `
      SELECT DISTINCT
        v.id,
        v.sku,
        v.name,
        v.slug,
        v.collection_id,
        v.collection,
        v.base_price,
        v.promotional_price,
        v.final_price,
        v.has_promotion,
        v.available_web,
        v.primary_image_url,
        v.primary_image_alt
      FROM vw_product_catalog v
      WHERE v.is_active = TRUE
        AND v.is_published = TRUE
        AND v.allow_sale = TRUE
        AND EXISTS (
          SELECT 1
          FROM price_list_rules r
          WHERE r.price_list_id = $1
            AND r.is_active = TRUE
            AND (
              (
                r.scope_type = 'PRODUCT'
                AND r.product_id = v.id
              )
              OR
              (
                r.scope_type = 'COLLECTION'
                AND v.collection_id IS NOT NULL
                AND r.collection_id = v.collection_id
              )
            )
        )
      ORDER BY v.name ASC, v.sku ASC
    `,
    [priceListId]
  );

  const imageMap =
    await getExclusiveProductsImageMap(
      candidatesResult.rows.map(
        (product) => product.id
      )
    );

  const products = [];

  for (const product of candidatesResult.rows) {
    const pricing = await resolveCustomerProductPrice({
      userId: normalizedUserId,
      product,
    });

    const publicPrice = Number(pricing.public_price || 0);
    const exclusivePrice = Number(pricing.final_price || 0);

    /*
     * Si una promoción pública ya entrega un precio
     * igual o menor, el producto no se presenta como
     * "exclusivo" porque el beneficio privado no está
     * determinando el precio vigente.
     */
    if (
      pricing.pricing_source !== "PRICE_LIST" ||
      !Number.isFinite(publicPrice) ||
      !Number.isFinite(exclusivePrice) ||
      exclusivePrice <= 0 ||
      exclusivePrice >= publicPrice
    ) {
      continue;
    }

    const exclusiveSavings =
      Math.round((publicPrice - exclusivePrice) * 100) / 100;

    products.push({
      id: product.id,
      sku: product.sku,
      name: product.name,
      slug: product.slug,
      collection: product.collection || null,
      image_url:
        imageMap.get(product.id)?.url ||
        product.primary_image_url ||
        null,
      image_alt:
        imageMap.get(product.id)?.alt ||
        product.primary_image_alt ||
        product.name,
      available_web: Number(product.available_web || 0),
      in_stock: Number(product.available_web || 0) > 0,

      base_price: Number(pricing.base_price || 0),
      regular_price: publicPrice,
      final_price: exclusivePrice,
      exclusive_savings: exclusiveSavings,
      discount_percentage:
        Number(pricing.effective_discount_percentage || 0),

      rule_scope: pricing.rule?.scope_type || null,
      label: "Descuento exclusivo cliente",
    });
  }

  return {
    has_exclusive_pricing: true,
    has_exclusive_products: products.length > 0,
    count: products.length,
    products,
  };
};

