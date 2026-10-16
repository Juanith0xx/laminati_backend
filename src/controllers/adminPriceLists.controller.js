import pool from "../config/database.js";

const PRICE_LIST_SCOPES = new Set([
  "PRODUCT",
  "COLLECTION",
]);

const DISCOUNT_TYPES = new Set([
  "PERCENTAGE",
  "FIXED_AMOUNT",
]);

const normalizeText = (value) =>
  String(value ?? "").trim();

const normalizeUpper = (value) =>
  normalizeText(value).toUpperCase();

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );

const createServiceError = (
  message,
  status = 400,
  code = "ADMIN_PRICE_LIST_ERROR"
) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const sendError = (
  res,
  error,
  fallbackMessage
) => {
  const status = Number(error?.status) || 500;

  if (status >= 500) {
    console.error(fallbackMessage, error);
  }

  if (error?.code === "23505") {
    return res.status(409).json({
      success: false,
      message:
        "Ya existe un registro con esa combinación",
      code: "ADMIN_PRICE_LIST_DUPLICATE",
    });
  }

  if (error?.code === "23503") {
    return res.status(409).json({
      success: false,
      message:
        "La operación no se puede completar porque existen datos relacionados",
      code: "ADMIN_PRICE_LIST_RELATION_CONFLICT",
    });
  }

  return res.status(status).json({
    success: false,
    message:
      error?.message || fallbackMessage,
    code:
      error?.code || "ADMIN_PRICE_LIST_ERROR",
  });
};

const normalizeBoolean = (
  value,
  fallback
) => {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw createServiceError(
      "El estado debe ser verdadero o falso",
      400,
      "ADMIN_PRICE_LIST_INVALID_STATUS"
    );
  }

  return value;
};

const normalizeDateOnly = (
  value,
  fieldLabel
) => {
  if (
    value === undefined ||
    value === null ||
    normalizeText(value) === ""
  ) {
    return null;
  }

  const normalized = normalizeText(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createServiceError(
      `${fieldLabel} debe tener formato YYYY-MM-DD`,
      400,
      "ADMIN_PRICE_LIST_INVALID_DATE"
    );
  }

  const parsed = new Date(
    `${normalized}T12:00:00Z`
  );

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw createServiceError(
      `${fieldLabel} no es una fecha válida`,
      400,
      "ADMIN_PRICE_LIST_INVALID_DATE"
    );
  }

  return normalized;
};

const validateDateRange = (
  validFrom,
  validUntil
) => {
  if (
    validFrom &&
    validUntil &&
    validUntil < validFrom
  ) {
    throw createServiceError(
      "La fecha de término no puede ser anterior a la fecha de inicio",
      400,
      "ADMIN_PRICE_LIST_INVALID_DATE_RANGE"
    );
  }
};

const normalizeDiscountValue = (
  value,
  discountType
) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createServiceError(
      "El descuento debe ser mayor que 0",
      400,
      "ADMIN_PRICE_LIST_INVALID_DISCOUNT"
    );
  }

  if (
    discountType === "PERCENTAGE" &&
    parsed > 100
  ) {
    throw createServiceError(
      "El descuento porcentual no puede superar 100%",
      400,
      "ADMIN_PRICE_LIST_INVALID_DISCOUNT"
    );
  }

  return Math.round(
    (parsed + Number.EPSILON) * 100
  ) / 100;
};

const assertPriceListId = (value) => {
  if (!isUuid(value)) {
    throw createServiceError(
      "Lista de precios inválida",
      400,
      "ADMIN_PRICE_LIST_INVALID_ID"
    );
  }

  return normalizeText(value);
};

const assertRuleId = (value) => {
  if (!isUuid(value)) {
    throw createServiceError(
      "Regla de descuento inválida",
      400,
      "ADMIN_PRICE_LIST_RULE_INVALID_ID"
    );
  }

  return normalizeText(value);
};

const assertUserId = (value) => {
  if (!isUuid(value)) {
    throw createServiceError(
      "Usuario inválido",
      400,
      "ADMIN_PRICE_LIST_USER_INVALID_ID"
    );
  }

  return normalizeText(value);
};

const getPriceListOrFail = async (
  client,
  priceListId,
  options = {}
) => {
  const result = await client.query(
    `
      SELECT
        id,
        name,
        description,
        is_active,
        valid_from,
        valid_until,
        created_by,
        updated_by,
        created_at,
        updated_at
      FROM price_lists
      WHERE id = $1
      LIMIT 1
    `,
    [priceListId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "Lista de precios no encontrada",
      404,
      "ADMIN_PRICE_LIST_NOT_FOUND"
    );
  }

  const priceList = result.rows[0];

  if (
    options.requireActive &&
    !priceList.is_active
  ) {
    throw createServiceError(
      "La lista de precios está deshabilitada",
      409,
      "ADMIN_PRICE_LIST_INACTIVE"
    );
  }

  return priceList;
};

const getRuleOrFail = async (
  client,
  priceListId,
  ruleId
) => {
  const result = await client.query(
    `
      SELECT
        id,
        price_list_id,
        scope_type,
        product_id,
        collection_id,
        discount_type,
        discount_value,
        is_active,
        created_at,
        updated_at
      FROM price_list_rules
      WHERE id = $1
        AND price_list_id = $2
      LIMIT 1
    `,
    [ruleId, priceListId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "Regla de descuento no encontrada",
      404,
      "ADMIN_PRICE_LIST_RULE_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const assertProduct = async (
  client,
  productId
) => {
  if (!isUuid(productId)) {
    throw createServiceError(
      "Producto inválido",
      400,
      "ADMIN_PRICE_LIST_PRODUCT_INVALID_ID"
    );
  }

  const result = await client.query(
    `
      SELECT
        id,
        sku,
        name,
        collection_id,
        base_price,
        is_active
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "El producto seleccionado no existe",
      404,
      "ADMIN_PRICE_LIST_PRODUCT_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const assertCollection = async (
  client,
  collectionId
) => {
  if (!isUuid(collectionId)) {
    throw createServiceError(
      "Colección inválida",
      400,
      "ADMIN_PRICE_LIST_COLLECTION_INVALID_ID"
    );
  }

  const result = await client.query(
    `
      SELECT
        c.id,
        c.name,
        c.slug,
        c.is_active,
        b.name AS brand_name
      FROM collections c
      LEFT JOIN brands b
        ON b.id = c.brand_id
      WHERE c.id = $1
      LIMIT 1
    `,
    [collectionId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La colección seleccionada no existe",
      404,
      "ADMIN_PRICE_LIST_COLLECTION_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const assertUser = async (
  client,
  userId
) => {
  const result = await client.query(
    `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.is_active,
        r.name AS role
      FROM users u
      INNER JOIN roles r
        ON r.id = u.role_id
      WHERE u.id = $1
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [userId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "Usuario no encontrado",
      404,
      "ADMIN_PRICE_LIST_USER_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const normalizeRuleInput = async (
  client,
  body,
  currentRule = null
) => {
  const scopeType =
    body.scope_type === undefined
      ? currentRule?.scope_type
      : normalizeUpper(body.scope_type);

  const discountType =
    body.discount_type === undefined
      ? currentRule?.discount_type
      : normalizeUpper(body.discount_type);

  if (!PRICE_LIST_SCOPES.has(scopeType)) {
    throw createServiceError(
      "El alcance debe ser PRODUCT o COLLECTION",
      400,
      "ADMIN_PRICE_LIST_INVALID_SCOPE"
    );
  }

  if (!DISCOUNT_TYPES.has(discountType)) {
    throw createServiceError(
      "El tipo de descuento debe ser PERCENTAGE o FIXED_AMOUNT",
      400,
      "ADMIN_PRICE_LIST_INVALID_DISCOUNT_TYPE"
    );
  }

  const discountValue = normalizeDiscountValue(
    body.discount_value === undefined
      ? currentRule?.discount_value
      : body.discount_value,
    discountType
  );

  const isActive = normalizeBoolean(
    body.is_active,
    currentRule?.is_active ?? true
  );

  let productId = null;
  let collectionId = null;
  let target = null;

  if (scopeType === "PRODUCT") {
    productId = normalizeText(
      body.product_id === undefined &&
        currentRule?.scope_type === "PRODUCT"
        ? currentRule.product_id
        : body.product_id
    );

    target = await assertProduct(
      client,
      productId
    );
  } else {
    collectionId = normalizeText(
      body.collection_id === undefined &&
        currentRule?.scope_type === "COLLECTION"
        ? currentRule.collection_id
        : body.collection_id
    );

    target = await assertCollection(
      client,
      collectionId
    );
  }

  return {
    scopeType,
    productId,
    collectionId,
    discountType,
    discountValue,
    isActive,
    target,
  };
};

const selectRuleById = async (
  client,
  ruleId
) => {
  const result = await client.query(
    `
      SELECT
        r.id,
        r.price_list_id,
        r.scope_type,
        r.product_id,
        r.collection_id,
        r.discount_type,
        r.discount_value,
        r.is_active,
        r.created_at,
        r.updated_at,

        p.sku AS product_sku,
        p.name AS product_name,
        p.base_price AS product_base_price,
        p.is_active AS product_is_active,

        c.name AS collection_name,
        c.slug AS collection_slug,
        c.is_active AS collection_is_active,
        b.name AS collection_brand_name

      FROM price_list_rules r
      LEFT JOIN products p
        ON p.id = r.product_id
      LEFT JOIN collections c
        ON c.id = r.collection_id
      LEFT JOIN brands b
        ON b.id = c.brand_id
      WHERE r.id = $1
      LIMIT 1
    `,
    [ruleId]
  );

  return result.rows[0] || null;
};

const selectUserAssignment = async (
  client,
  userId
) => {
  const result = await client.query(
    `
      SELECT
        upl.id,
        upl.user_id,
        upl.price_list_id,
        upl.assigned_by,
        upl.assigned_at,
        upl.updated_at,

        u.first_name,
        u.last_name,
        u.email,

        pl.name AS price_list_name,
        pl.description AS price_list_description,
        pl.is_active AS price_list_is_active,
        pl.valid_from,
        pl.valid_until

      FROM user_price_lists upl
      INNER JOIN users u
        ON u.id = upl.user_id
      INNER JOIN price_lists pl
        ON pl.id = upl.price_list_id
      WHERE upl.user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

export const listAdminPriceLists = async (
  req,
  res
) => {
  try {
    const search = normalizeText(
      req.query.search
    ).slice(0, 120);

    const status = normalizeUpper(
      req.query.status
    );

    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        pl.name ILIKE $${params.length}
        OR COALESCE(pl.description, '') ILIKE $${params.length}
      )`);
    }

    if (status === "ACTIVE") {
      conditions.push("pl.is_active = TRUE");
    } else if (status === "INACTIVE") {
      conditions.push("pl.is_active = FALSE");
    }

    const whereSql =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
        SELECT
          pl.id,
          pl.name,
          pl.description,
          pl.is_active,
          pl.valid_from,
          pl.valid_until,
          pl.created_at,
          pl.updated_at,

          COUNT(DISTINCT r.id)::int AS rules_count,
          COUNT(DISTINCT r.id) FILTER (
            WHERE r.is_active = TRUE
          )::int AS active_rules_count,
          COUNT(DISTINCT upl.user_id)::int AS assigned_users_count

        FROM price_lists pl
        LEFT JOIN price_list_rules r
          ON r.price_list_id = pl.id
        LEFT JOIN user_price_lists upl
          ON upl.price_list_id = pl.id

        ${whereSql}

        GROUP BY pl.id
        ORDER BY
          pl.is_active DESC,
          pl.name ASC
      `,
      params
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Error listando listas de precios"
    );
  }
};

export const getAdminPriceList = async (
  req,
  res
) => {
  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );

    const priceListResult = await pool.query(
      `
        SELECT
          pl.id,
          pl.name,
          pl.description,
          pl.is_active,
          pl.valid_from,
          pl.valid_until,
          pl.created_at,
          pl.updated_at,

          COUNT(DISTINCT r.id)::int AS rules_count,
          COUNT(DISTINCT upl.user_id)::int AS assigned_users_count

        FROM price_lists pl
        LEFT JOIN price_list_rules r
          ON r.price_list_id = pl.id
        LEFT JOIN user_price_lists upl
          ON upl.price_list_id = pl.id
        WHERE pl.id = $1
        GROUP BY pl.id
        LIMIT 1
      `,
      [priceListId]
    );

    if (priceListResult.rowCount === 0) {
      throw createServiceError(
        "Lista de precios no encontrada",
        404,
        "ADMIN_PRICE_LIST_NOT_FOUND"
      );
    }

    const [rulesResult, assignmentsResult] =
      await Promise.all([
        pool.query(
          `
            SELECT
              r.id,
              r.price_list_id,
              r.scope_type,
              r.product_id,
              r.collection_id,
              r.discount_type,
              r.discount_value,
              r.is_active,
              r.created_at,
              r.updated_at,

              p.sku AS product_sku,
              p.name AS product_name,
              p.base_price AS product_base_price,
              p.is_active AS product_is_active,

              c.name AS collection_name,
              c.slug AS collection_slug,
              c.is_active AS collection_is_active,
              b.name AS collection_brand_name

            FROM price_list_rules r
            LEFT JOIN products p
              ON p.id = r.product_id
            LEFT JOIN collections c
              ON c.id = r.collection_id
            LEFT JOIN brands b
              ON b.id = c.brand_id
            WHERE r.price_list_id = $1
            ORDER BY
              CASE r.scope_type
                WHEN 'PRODUCT' THEN 1
                ELSE 2
              END,
              COALESCE(p.name, c.name) ASC
          `,
          [priceListId]
        ),
        pool.query(
          `
            SELECT
              upl.id,
              upl.user_id,
              upl.assigned_at,
              u.first_name,
              u.last_name,
              u.email,
              u.is_active,
              r.name AS role
            FROM user_price_lists upl
            INNER JOIN users u
              ON u.id = upl.user_id
            INNER JOIN roles r
              ON r.id = u.role_id
            WHERE upl.price_list_id = $1
              AND u.deleted_at IS NULL
            ORDER BY
              u.first_name ASC,
              u.last_name ASC,
              u.email ASC
          `,
          [priceListId]
        ),
      ]);

    return res.json({
      success: true,
      data: {
        ...priceListResult.rows[0],
        rules: rulesResult.rows,
        assigned_users: assignmentsResult.rows,
      },
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Error obteniendo lista de precios"
    );
  }
};

export const createAdminPriceList = async (
  req,
  res
) => {
  try {
    const name = normalizeText(req.body.name);
    const description =
      normalizeText(req.body.description) || null;
    const isActive = normalizeBoolean(
      req.body.is_active,
      true
    );
    const validFrom = normalizeDateOnly(
      req.body.valid_from,
      "La fecha de inicio"
    );
    const validUntil = normalizeDateOnly(
      req.body.valid_until,
      "La fecha de término"
    );

    if (!name) {
      throw createServiceError(
        "El nombre de la lista es obligatorio",
        400,
        "ADMIN_PRICE_LIST_NAME_REQUIRED"
      );
    }

    if (name.length > 120) {
      throw createServiceError(
        "El nombre de la lista no puede superar 120 caracteres",
        400,
        "ADMIN_PRICE_LIST_NAME_TOO_LONG"
      );
    }

    validateDateRange(
      validFrom,
      validUntil
    );

    const result = await pool.query(
      `
        INSERT INTO price_lists (
          name,
          description,
          is_active,
          valid_from,
          valid_until,
          created_by,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        RETURNING
          id,
          name,
          description,
          is_active,
          valid_from,
          valid_until,
          created_at,
          updated_at
      `,
      [
        name,
        description,
        isActive,
        validFrom,
        validUntil,
        req.user.id,
      ]
    );

    return res.status(201).json({
      success: true,
      message:
        "Lista de precios creada correctamente",
      data: result.rows[0],
    });
  } catch (error) {
    if (error?.code === "23505") {
      error.status = 409;
      error.code =
        "ADMIN_PRICE_LIST_NAME_EXISTS";
      error.message =
        "Ya existe una lista de precios con ese nombre";
    }

    return sendError(
      res,
      error,
      "Error creando lista de precios"
    );
  }
};

export const updateAdminPriceList = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );

    await client.query("BEGIN");

    const current = await getPriceListOrFail(
      client,
      priceListId
    );

    const name =
      req.body.name === undefined
        ? current.name
        : normalizeText(req.body.name);
    const description =
      req.body.description === undefined
        ? current.description
        : normalizeText(req.body.description) || null;
    const isActive = normalizeBoolean(
      req.body.is_active,
      current.is_active
    );
    const validFrom =
      req.body.valid_from === undefined
        ? current.valid_from
        : normalizeDateOnly(
            req.body.valid_from,
            "La fecha de inicio"
          );
    const validUntil =
      req.body.valid_until === undefined
        ? current.valid_until
        : normalizeDateOnly(
            req.body.valid_until,
            "La fecha de término"
          );

    if (!name) {
      throw createServiceError(
        "El nombre de la lista es obligatorio",
        400,
        "ADMIN_PRICE_LIST_NAME_REQUIRED"
      );
    }

    if (name.length > 120) {
      throw createServiceError(
        "El nombre de la lista no puede superar 120 caracteres",
        400,
        "ADMIN_PRICE_LIST_NAME_TOO_LONG"
      );
    }

    validateDateRange(
      validFrom,
      validUntil
    );

    const result = await client.query(
      `
        UPDATE price_lists
        SET
          name = $1,
          description = $2,
          is_active = $3,
          valid_from = $4,
          valid_until = $5,
          updated_by = $6
        WHERE id = $7
        RETURNING
          id,
          name,
          description,
          is_active,
          valid_from,
          valid_until,
          created_at,
          updated_at
      `,
      [
        name,
        description,
        isActive,
        validFrom,
        validUntil,
        req.user.id,
        priceListId,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Lista de precios actualizada correctamente",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    if (error?.code === "23505") {
      error.status = 409;
      error.code =
        "ADMIN_PRICE_LIST_NAME_EXISTS";
      error.message =
        "Ya existe una lista de precios con ese nombre";
    }

    return sendError(
      res,
      error,
      "Error actualizando lista de precios"
    );
  } finally {
    client.release();
  }
};

export const deleteAdminPriceList = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );

    await client.query("BEGIN");

    const priceList = await getPriceListOrFail(
      client,
      priceListId
    );

    const assignmentsResult =
      await client.query(
        `
          SELECT COUNT(*)::int AS total
          FROM user_price_lists
          WHERE price_list_id = $1
        `,
        [priceListId]
      );

    const assignedUsers = Number(
      assignmentsResult.rows[0]?.total || 0
    );

    if (assignedUsers > 0) {
      throw createServiceError(
        `No puedes eliminar la lista porque está asignada a ${assignedUsers} usuario(s). Desasígnala primero.`,
        409,
        "ADMIN_PRICE_LIST_HAS_USERS"
      );
    }

    await client.query(
      `
        DELETE FROM price_lists
        WHERE id = $1
      `,
      [priceListId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Lista de precios eliminada correctamente",
      data: {
        id: priceList.id,
        name: priceList.name,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    return sendError(
      res,
      error,
      "Error eliminando lista de precios"
    );
  } finally {
    client.release();
  }
};

export const createAdminPriceListRule = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );

    await client.query("BEGIN");

    await getPriceListOrFail(
      client,
      priceListId
    );

    const rule = await normalizeRuleInput(
      client,
      req.body
    );

    const result = await client.query(
      `
        INSERT INTO price_list_rules (
          price_list_id,
          scope_type,
          product_id,
          collection_id,
          discount_type,
          discount_value,
          is_active,
          created_by,
          updated_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $8
        )
        RETURNING id
      `,
      [
        priceListId,
        rule.scopeType,
        rule.productId,
        rule.collectionId,
        rule.discountType,
        rule.discountValue,
        rule.isActive,
        req.user.id,
      ]
    );

    const createdRule = await selectRuleById(
      client,
      result.rows[0].id
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message:
        "Regla de descuento creada correctamente",
      data: createdRule,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    if (error?.code === "23505") {
      error.status = 409;
      error.code =
        "ADMIN_PRICE_LIST_RULE_EXISTS";
      error.message =
        "Ese producto o colección ya tiene una regla en esta lista";
    }

    return sendError(
      res,
      error,
      "Error creando regla de descuento"
    );
  } finally {
    client.release();
  }
};

export const updateAdminPriceListRule = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );
    const ruleId = assertRuleId(
      req.params.ruleId
    );

    await client.query("BEGIN");

    await getPriceListOrFail(
      client,
      priceListId
    );

    const currentRule = await getRuleOrFail(
      client,
      priceListId,
      ruleId
    );

    const rule = await normalizeRuleInput(
      client,
      req.body,
      currentRule
    );

    await client.query(
      `
        UPDATE price_list_rules
        SET
          scope_type = $1,
          product_id = $2,
          collection_id = $3,
          discount_type = $4,
          discount_value = $5,
          is_active = $6,
          updated_by = $7
        WHERE id = $8
          AND price_list_id = $9
      `,
      [
        rule.scopeType,
        rule.productId,
        rule.collectionId,
        rule.discountType,
        rule.discountValue,
        rule.isActive,
        req.user.id,
        ruleId,
        priceListId,
      ]
    );

    const updatedRule = await selectRuleById(
      client,
      ruleId
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Regla de descuento actualizada correctamente",
      data: updatedRule,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    if (error?.code === "23505") {
      error.status = 409;
      error.code =
        "ADMIN_PRICE_LIST_RULE_EXISTS";
      error.message =
        "Ese producto o colección ya tiene una regla en esta lista";
    }

    return sendError(
      res,
      error,
      "Error actualizando regla de descuento"
    );
  } finally {
    client.release();
  }
};

export const deleteAdminPriceListRule = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const priceListId = assertPriceListId(
      req.params.priceListId
    );
    const ruleId = assertRuleId(
      req.params.ruleId
    );

    await client.query("BEGIN");

    await getPriceListOrFail(
      client,
      priceListId
    );

    const rule = await getRuleOrFail(
      client,
      priceListId,
      ruleId
    );

    await client.query(
      `
        DELETE FROM price_list_rules
        WHERE id = $1
          AND price_list_id = $2
      `,
      [ruleId, priceListId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Regla de descuento eliminada correctamente",
      data: {
        id: rule.id,
        price_list_id: rule.price_list_id,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    return sendError(
      res,
      error,
      "Error eliminando regla de descuento"
    );
  } finally {
    client.release();
  }
};

export const getAdminUserPriceList = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const userId = assertUserId(
      req.params.userId
    );

    await assertUser(client, userId);

    const assignment =
      await selectUserAssignment(
        client,
        userId
      );

    return res.json({
      success: true,
      data: assignment,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Error obteniendo lista asignada al usuario"
    );
  } finally {
    client.release();
  }
};

export const assignAdminUserPriceList = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const userId = assertUserId(
      req.params.userId
    );
    const priceListId = assertPriceListId(
      req.body.price_list_id
    );

    await client.query("BEGIN");

    await assertUser(client, userId);
    await getPriceListOrFail(
      client,
      priceListId,
      { requireActive: true }
    );

    await client.query(
      `
        INSERT INTO user_price_lists (
          user_id,
          price_list_id,
          assigned_by,
          assigned_at
        )
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          price_list_id = EXCLUDED.price_list_id,
          assigned_by = EXCLUDED.assigned_by,
          assigned_at = NOW()
      `,
      [
        userId,
        priceListId,
        req.user.id,
      ]
    );

    const assignment =
      await selectUserAssignment(
        client,
        userId
      );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Lista de precios asignada correctamente",
      data: assignment,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    return sendError(
      res,
      error,
      "Error asignando lista de precios"
    );
  } finally {
    client.release();
  }
};

export const removeAdminUserPriceList = async (
  req,
  res
) => {
  const client = await pool.connect();

  try {
    const userId = assertUserId(
      req.params.userId
    );

    await client.query("BEGIN");

    await assertUser(client, userId);

    const result = await client.query(
      `
        DELETE FROM user_price_lists
        WHERE user_id = $1
        RETURNING
          id,
          user_id,
          price_list_id
      `,
      [userId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        result.rowCount > 0
          ? "Lista de precios desasignada correctamente"
          : "El usuario no tenía una lista de precios asignada",
      data:
        result.rows[0] || null,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(
      () => null
    );

    return sendError(
      res,
      error,
      "Error desasignando lista de precios"
    );
  } finally {
    client.release();
  }
};
