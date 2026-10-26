import bcrypt from "bcryptjs";
import pool from "../config/database.js";
import {
  getOnlineUserCount,
  getPresenceForUsers,
} from "../services/realtime.service.js";

const ADMIN_ROLE = "ADMIN";
const COMPANY_ROLE = "USUARIO_EMPRESA";

const normalizeText = (value) => String(value ?? "").trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const normalizeRole = (value) => normalizeText(value).toUpperCase();

const normalizeRutIdentity = (value) =>
  normalizeText(value)
    .toUpperCase()
    .replace(/[^0-9K]/g, "");

const formatRutForStorage = (value) => {
  const normalized = normalizeRutIdentity(value);

  if (!normalized) {
    return null;
  }

  if (normalized.length < 2) {
    return normalizeText(value) || null;
  }

  return `${normalized.slice(0, -1)}-${normalized.slice(-1)}`;
};

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );

const sendError = (res, error, fallbackMessage) => {
  const status = Number(error?.status) || 500;

  if (status >= 500) {
    console.error(fallbackMessage, error);
  }

  return res.status(status).json({
    success: false,
    message: error?.message || fallbackMessage,
    code: error?.code || "ADMIN_USERS_ERROR",
  });
};

const createServiceError = (message, status = 400, code = null) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const assertEmail = (email) => {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createServiceError(
      "Ingresa un correo electrónico válido",
      400,
      "ADMIN_USER_INVALID_EMAIL"
    );
  }
};

const getRole = async (client, roleName) => {
  const result = await client.query(
    `
      SELECT id, name, description
      FROM roles
      WHERE UPPER(name) = UPPER($1)
      LIMIT 1
    `,
    [roleName]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "El perfil seleccionado no existe",
      400,
      "ADMIN_USER_ROLE_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const assertEmailAvailable = async (client, email, excludeUserId = null) => {
  const params = [email];
  let excludeSql = "";

  if (excludeUserId) {
    params.push(excludeUserId);
    excludeSql = `AND id <> $${params.length}`;
  }

  const result = await client.query(
    `
      SELECT id
      FROM users
      WHERE LOWER(email) = LOWER($1)
      ${excludeSql}
      LIMIT 1
    `,
    params
  );

  if (result.rowCount > 0) {
    throw createServiceError(
      "Ya existe un usuario con ese correo electrónico",
      409,
      "ADMIN_USER_EMAIL_EXISTS"
    );
  }
};

const assertCompany = async (client, companyId) => {
  if (!isUuid(companyId)) {
    throw createServiceError(
      "Debes seleccionar una empresa válida",
      400,
      "ADMIN_USER_COMPANY_REQUIRED"
    );
  }

  const result = await client.query(
    `
      SELECT id, legal_name, trade_name
      FROM customer_companies
      WHERE id = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [companyId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La empresa seleccionada no existe o está deshabilitada",
      400,
      "ADMIN_USER_COMPANY_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const getUserForUpdate = async (client, userId) => {
  if (!isUuid(userId)) {
    throw createServiceError(
      "Usuario inválido",
      400,
      "ADMIN_USER_INVALID_ID"
    );
  }

  const result = await client.query(
    `
      SELECT
        u.id,
        u.role_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.rut,
        u.is_active,
        u.deleted_at,
        r.name AS role
      FROM users u
      INNER JOIN roles r
        ON r.id = u.role_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (result.rowCount === 0 || result.rows[0].deleted_at) {
    throw createServiceError(
      "Usuario no encontrado",
      404,
      "ADMIN_USER_NOT_FOUND"
    );
  }

  return result.rows[0];
};

const countActiveAdmins = async (client) => {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM users u
      INNER JOIN roles r
        ON r.id = u.role_id
      WHERE r.name = 'ADMIN'
        AND u.is_active = TRUE
        AND u.deleted_at IS NULL
    `
  );

  return Number(result.rows[0]?.total || 0);
};

const protectLastAdmin = async (client, targetUser) => {
  if (targetUser.role !== ADMIN_ROLE || !targetUser.is_active) {
    return;
  }

  const activeAdmins = await countActiveAdmins(client);

  if (activeAdmins <= 1) {
    throw createServiceError(
      "No puedes deshabilitar, eliminar ni cambiar el perfil del último administrador activo",
      409,
      "ADMIN_USER_LAST_ADMIN"
    );
  }
};

const syncCompanyMembership = async (
  client,
  userId,
  roleName,
  companyId,
  positionName
) => {
  if (roleName !== COMPANY_ROLE) {
    await client.query(
      `
        UPDATE company_users
        SET is_active = FALSE
        WHERE user_id = $1
          AND is_active = TRUE
      `,
      [userId]
    );

    return null;
  }

  const company = await assertCompany(client, companyId);

  await client.query(
    `
      UPDATE company_users
      SET
        is_active = FALSE,
        is_primary_contact = FALSE
      WHERE user_id = $1
        AND company_id <> $2
        AND is_active = TRUE
    `,
    [userId, company.id]
  );

  await client.query(
    `
      INSERT INTO company_users (
        company_id,
        user_id,
        position_name,
        is_primary_contact,
        is_active
      )
      VALUES ($1, $2, $3, FALSE, TRUE)
      ON CONFLICT (company_id, user_id)
      DO UPDATE SET
        position_name = EXCLUDED.position_name,
        is_active = TRUE
    `,
    [company.id, userId, normalizeText(positionName) || null]
  );

  return company;
};

const selectUserById = async (client, userId) => {
  const result = await client.query(
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
        r.id AS role_id,
        r.name AS role,
        r.description AS role_description,
        company.company_id,
        company.company_name,
        company.position_name
      FROM users u
      INNER JOIN roles r
        ON r.id = u.role_id
      LEFT JOIN LATERAL (
        SELECT
          cc.id AS company_id,
          COALESCE(NULLIF(cc.trade_name, ''), cc.legal_name) AS company_name,
          cu.position_name
        FROM company_users cu
        INNER JOIN customer_companies cc
          ON cc.id = cu.company_id
        WHERE cu.user_id = u.id
          AND cu.is_active = TRUE
          AND cc.is_active = TRUE
        ORDER BY
          cu.is_primary_contact DESC,
          cu.created_at ASC
        LIMIT 1
      ) company ON TRUE
      WHERE u.id = $1
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

export const listAdminUsers = async (req, res) => {
  try {
    const search = normalizeText(req.query.search).slice(0, 120);
    const role = normalizeRole(req.query.role);
    const status = normalizeRole(req.query.status);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 20)
    );
    const offset = (page - 1) * limit;

    const params = [];
    const conditions = ["u.deleted_at IS NULL"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        u.first_name ILIKE $${params.length}
        OR u.last_name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR COALESCE(u.rut, '') ILIKE $${params.length}
        OR CONCAT_WS(' ', u.first_name, u.last_name) ILIKE $${params.length}
      )`);
    }

    if (role && role !== "ALL") {
      params.push(role);
      conditions.push(`r.name = $${params.length}`);
    }

    if (status === "ACTIVE") {
      conditions.push("u.is_active = TRUE");
    } else if (status === "INACTIVE") {
      conditions.push("u.is_active = FALSE");
    }

    const whereSql = conditions.join(" AND ");

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM users u
        INNER JOIN roles r
          ON r.id = u.role_id
        WHERE ${whereSql}
      `,
      params
    );

    const dataParams = [...params, limit, offset];
    const limitIndex = dataParams.length - 1;
    const offsetIndex = dataParams.length;

    const usersResult = await pool.query(
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
          r.id AS role_id,
          r.name AS role,
          r.description AS role_description,
          company.company_id,
          company.company_name,
          company.position_name,
          (u.id = $${dataParams.length + 1}) AS is_self
        FROM users u
        INNER JOIN roles r
          ON r.id = u.role_id
        LEFT JOIN LATERAL (
          SELECT
            cc.id AS company_id,
            COALESCE(NULLIF(cc.trade_name, ''), cc.legal_name) AS company_name,
            cu.position_name
          FROM company_users cu
          INNER JOIN customer_companies cc
            ON cc.id = cu.company_id
          WHERE cu.user_id = u.id
            AND cu.is_active = TRUE
            AND cc.is_active = TRUE
          ORDER BY
            cu.is_primary_contact DESC,
            cu.created_at ASC
          LIMIT 1
        ) company ON TRUE
        WHERE ${whereSql}
        ORDER BY
          CASE WHEN r.name = 'ADMIN' THEN 0 ELSE 1 END,
          u.created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      [...dataParams, req.user.id]
    );

    const summaryResult = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total,
          (COUNT(*) FILTER (WHERE u.is_active = TRUE))::int AS active,
          (COUNT(*) FILTER (WHERE u.is_active = FALSE))::int AS inactive,
          (COUNT(*) FILTER (WHERE r.name = 'ADMIN'))::int AS admins
        FROM users u
        INNER JOIN roles r
          ON r.id = u.role_id
        WHERE u.deleted_at IS NULL
      `
    );

    const total = Number(countResult.rows[0]?.total || 0);

    const presenceByUser = getPresenceForUsers(
      usersResult.rows.map((user) => user.id)
    );

    const usersWithPresence = usersResult.rows.map(
      (user) => ({
        ...user,
        presence:
          presenceByUser[String(user.id)] || {
            is_online: false,
            connected_at: null,
            last_seen_at: null,
            disconnected_at: null,
            active_sessions: 0,
            device_type: null,
            platform: null,
            browser: null,
            browser_version: null,
            sessions: [],
          },
      })
    );

    return res.json({
      success: true,
      data: usersWithPresence,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: {
        ...(summaryResult.rows[0] || {
          total: 0,
          active: 0,
          inactive: 0,
          admins: 0,
        }),
        online: getOnlineUserCount(),
      },
    });
  } catch (error) {
    return sendError(res, error, "Error listando usuarios administrativos");
  }
};

export const getAdminUserOptions = async (req, res) => {
  try {
    const [rolesResult, companiesResult] = await Promise.all([
      pool.query(
        `
          SELECT id, name, description
          FROM roles
          ORDER BY
            CASE name
              WHEN 'ADMIN' THEN 1
              WHEN 'CLIENTE' THEN 2
              WHEN 'USUARIO_EMPRESA' THEN 3
              ELSE 99
            END,
            name ASC
        `
      ),
      pool.query(
        `
          SELECT
            id,
            legal_name,
            trade_name,
            rut
          FROM customer_companies
          WHERE is_active = TRUE
          ORDER BY COALESCE(NULLIF(trade_name, ''), legal_name) ASC
        `
      ),
    ]);

    return res.json({
      success: true,
      roles: rolesResult.rows,
      companies: companiesResult.rows,
    });
  } catch (error) {
    return sendError(res, error, "Error cargando opciones de usuarios");
  }
};

export const createAdminUser = async (req, res) => {
  const client = await pool.connect();

  try {
    const firstName = normalizeText(req.body.first_name);
    const lastName = normalizeText(req.body.last_name);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const phone = normalizeText(req.body.phone) || null;
    const rut = formatRutForStorage(req.body.rut);
    const roleName = normalizeRole(req.body.role || ADMIN_ROLE);
    const companyId = normalizeText(req.body.company_id) || null;
    const positionName = normalizeText(req.body.position_name) || null;

    if (!firstName || !lastName) {
      throw createServiceError(
        "Nombre y apellido son obligatorios",
        400,
        "ADMIN_USER_NAME_REQUIRED"
      );
    }

    assertEmail(email);

    if (password.length < 8) {
      throw createServiceError(
        "La contraseña debe tener al menos 8 caracteres",
        400,
        "ADMIN_USER_PASSWORD_TOO_SHORT"
      );
    }

    await client.query("BEGIN");

    await assertEmailAvailable(client, email);
    const role = await getRole(client, roleName);

    if (role.name === COMPANY_ROLE) {
      await assertCompany(client, companyId);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await client.query(
      `
        INSERT INTO users (
          role_id,
          first_name,
          last_name,
          email,
          password_hash,
          phone,
          rut,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        RETURNING id
      `,
      [
        role.id,
        firstName,
        lastName,
        email,
        passwordHash,
        phone,
        rut,
      ]
    );

    const userId = result.rows[0].id;

    await syncCompanyMembership(
      client,
      userId,
      role.name,
      companyId,
      positionName
    );

    const user = await selectUserById(client, userId);

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Usuario creado correctamente",
      data: user,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    return sendError(res, error, "Error creando usuario");
  } finally {
    client.release();
  }
};

export const updateAdminUser = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const target = await getUserForUpdate(client, req.params.userId);

    const firstName =
      req.body.first_name === undefined
        ? target.first_name
        : normalizeText(req.body.first_name);
    const lastName =
      req.body.last_name === undefined
        ? target.last_name
        : normalizeText(req.body.last_name);
    const email =
      req.body.email === undefined
        ? normalizeEmail(target.email)
        : normalizeEmail(req.body.email);
    const phone =
      req.body.phone === undefined
        ? target.phone
        : normalizeText(req.body.phone) || null;
    const rut =
      req.body.rut === undefined
        ? target.rut
        : formatRutForStorage(req.body.rut);
    const roleName =
      req.body.role === undefined
        ? target.role
        : normalizeRole(req.body.role);
    const password = String(req.body.password || "");
    const companyId = normalizeText(req.body.company_id) || null;
    const positionName = normalizeText(req.body.position_name) || null;

    if (!firstName || !lastName) {
      throw createServiceError(
        "Nombre y apellido son obligatorios",
        400,
        "ADMIN_USER_NAME_REQUIRED"
      );
    }

    assertEmail(email);
    await assertEmailAvailable(client, email, target.id);

    const role = await getRole(client, roleName);
    const isSelf = String(target.id) === String(req.user.id);

    if (isSelf && role.name !== ADMIN_ROLE) {
      throw createServiceError(
        "No puedes quitarte tu propio perfil de administrador",
        409,
        "ADMIN_USER_SELF_ROLE_CHANGE"
      );
    }

    if (target.role === ADMIN_ROLE && role.name !== ADMIN_ROLE) {
      await protectLastAdmin(client, target);
    }

    if (password && password.length < 8) {
      throw createServiceError(
        "La nueva contraseña debe tener al menos 8 caracteres",
        400,
        "ADMIN_USER_PASSWORD_TOO_SHORT"
      );
    }

    if (role.name === COMPANY_ROLE) {
      const currentCompany = await client.query(
        `
          SELECT company_id
          FROM company_users
          WHERE user_id = $1
            AND is_active = TRUE
          ORDER BY is_primary_contact DESC, created_at ASC
          LIMIT 1
        `,
        [target.id]
      );

      const resolvedCompanyId =
        companyId || currentCompany.rows[0]?.company_id || null;

      await assertCompany(client, resolvedCompanyId);
      req.body.company_id = resolvedCompanyId;
    }

    let passwordSql = "";
    const params = [
      role.id,
      firstName,
      lastName,
      email,
      phone,
      rut,
    ];

    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      params.push(passwordHash);
      passwordSql = `, password_hash = $${params.length}`;
    }

    params.push(target.id);

    await client.query(
      `
        UPDATE users
        SET
          role_id = $1,
          first_name = $2,
          last_name = $3,
          email = $4,
          phone = $5,
          rut = $6
          ${passwordSql}
        WHERE id = $${params.length}
          AND deleted_at IS NULL
      `,
      params
    );

    await syncCompanyMembership(
      client,
      target.id,
      role.name,
      normalizeText(req.body.company_id) || null,
      positionName
    );

    const user = await selectUserById(client, target.id);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Usuario actualizado correctamente",
      data: user,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    return sendError(res, error, "Error actualizando usuario");
  } finally {
    client.release();
  }
};

export const setAdminUserStatus = async (req, res) => {
  const client = await pool.connect();

  try {
    if (typeof req.body.is_active !== "boolean") {
      throw createServiceError(
        "Debes indicar el estado del usuario",
        400,
        "ADMIN_USER_STATUS_REQUIRED"
      );
    }

    await client.query("BEGIN");

    const target = await getUserForUpdate(client, req.params.userId);
    const nextStatus = req.body.is_active;
    const isSelf = String(target.id) === String(req.user.id);

    if (isSelf && !nextStatus) {
      throw createServiceError(
        "No puedes deshabilitar tu propia cuenta",
        409,
        "ADMIN_USER_SELF_DISABLE"
      );
    }

    if (!nextStatus) {
      await protectLastAdmin(client, target);
    }

    await client.query(
      `
        UPDATE users
        SET is_active = $1
        WHERE id = $2
          AND deleted_at IS NULL
      `,
      [nextStatus, target.id]
    );

    const user = await selectUserById(client, target.id);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: nextStatus
        ? "Usuario habilitado correctamente"
        : "Usuario deshabilitado correctamente",
      data: user,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    return sendError(res, error, "Error cambiando estado del usuario");
  } finally {
    client.release();
  }
};

export const deleteAdminUser = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const target = await getUserForUpdate(client, req.params.userId);
    const isSelf = String(target.id) === String(req.user.id);

    if (isSelf) {
      throw createServiceError(
        "No puedes eliminar tu propia cuenta",
        409,
        "ADMIN_USER_SELF_DELETE"
      );
    }

    await protectLastAdmin(client, target);

    await client.query(
      `
        UPDATE users
        SET
          is_active = FALSE,
          deleted_at = NOW(),
          deleted_by = $2
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [target.id, req.user.id]
    );

    await client.query(
      `
        UPDATE company_users
        SET
          is_active = FALSE,
          is_primary_contact = FALSE
        WHERE user_id = $1
          AND is_active = TRUE
      `,
      [target.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Usuario eliminado correctamente",
      data: {
        id: target.id,
        deletion_type: "SOFT_DELETE",
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    return sendError(res, error, "Error eliminando usuario");
  } finally {
    client.release();
  }
};
