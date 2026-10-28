import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

import pool from "../config/database.js";
import {
  generateToken,
  verifyToken,
  generateRealtimeToken,
  getSessionDurationLabelForRole,
} from "../utils/jwt.js";
import {
  clearAuthCookie,
  setAuthCookie,
  getAuthTokenFromRequest,
} from "../utils/authCookie.js";
import {
  registerSchema,
  registerCompanySchema,
  loginSchema,
} from "../validators/auth.validator.js";
import {
  uploadUserAvatar,
  deleteUserAvatar,
  getUserAvatarSignedUrl,
} from "../services/productImageStorage.service.js";
import {
  recordAuthEventSafely,
} from "../services/authAudit.service.js";

const PUBLIC_ROLE_CLIENT = "CLIENTE";
const PUBLIC_ROLE_COMPANY = "USUARIO_EMPRESA";

const ROLE_LABELS = {
  ADMIN: "Administrador",
  VENDEDOR: "Vendedor",
  GERENCIA_ITALIA: "Gerencia Italia",
  CLIENTE: "Cliente",
  USUARIO_EMPRESA: "Empresa cliente",
};

const getRoleLabel = (role) =>
  ROLE_LABELS[String(role || "").trim().toUpperCase()] ||
  String(role || "");


const resolveAvatarUrl = async (
  avatarKey
) => {
  if (!avatarKey) {
    return null;
  }

  try {
    return await getUserAvatarSignedUrl(
      avatarKey
    );
  } catch (error) {
    console.error(
      "No fue posible generar la URL del avatar:",
      error
    );

    return null;
  }
};

const serializeUserWithAvatar =
  async (user) => {
    if (!user) {
      return null;
    }

    const {
      avatar_key: avatarKey,
      ...publicUser
    } = user;

    return {
      ...publicUser,
      avatar_url:
        await resolveAvatarUrl(
          avatarKey
        ),
    };
  };

const normalizeRutIdentity = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9K]/g, "");

const formatRutForStorage = (value) => {
  const normalized = normalizeRutIdentity(value);

  if (normalized.length < 2) {
    return String(value || "").trim() || null;
  }

  return `${normalized.slice(0, -1)}-${normalized.slice(-1)}`;
};

const getRoleId = async (client, roleName) => {
  const roleResult = await client.query(
    `
      SELECT id
      FROM roles
      WHERE name = $1
      LIMIT 1
    `,
    [roleName]
  );

  if (roleResult.rowCount === 0) {
    const error = new Error(
      `El rol ${roleName} no se encuentra configurado`
    );
    error.code = "AUTH_ROLE_NOT_CONFIGURED";
    throw error;
  }

  return roleResult.rows[0].id;
};

const emailAlreadyExists = async (client, email) => {
  const result = await client.query(
    `
      SELECT id
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rowCount > 0;
};

const getUserCompanies = async (db, userId) => {
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
        cu.position_name,
        cu.is_primary_contact
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

/* =========================================
   REGISTRO CLIENTE PERSONA NATURAL
========================================= */
export const register = async (req, res) => {
  const validation = registerSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de registro inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    first_name,
    last_name,
    email,
    password,
    phone,
    rut,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (await emailAlreadyExists(client, email)) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta asociada a este correo electrónico",
        code: "AUTH_EMAIL_ALREADY_EXISTS",
      });
    }

    const roleId = await getRoleId(
      client,
      PUBLIC_ROLE_CLIENT
    );

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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          TRUE
        )
        RETURNING
          id,
          first_name,
          last_name,
          email,
          phone,
          rut,
          is_active,
          email_verified,
          created_at
      `,
      [
        roleId,
        first_name,
        last_name,
        email,
        passwordHash,
        phone || null,
        rut ? formatRutForStorage(rut) : null,
      ]
    );

    const user = result.rows[0];

    await client.query("COMMIT");

    const token = generateToken({
      id: user.id,
      role: PUBLIC_ROLE_CLIENT,
    });

    setAuthCookie(res, token);

    return res.status(201).json({
      success: true,
      message: "Cuenta creada correctamente",
      token,
      user: {
        ...user,
        role: PUBLIC_ROLE_CLIENT,
        role_label: "Cliente",
        companies: [],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);

    console.error("Error registrando usuario:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta asociada a estos datos",
        code: "AUTH_REGISTER_CONFLICT",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear la cuenta",
      code: error.code || "AUTH_REGISTER_ERROR",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   REGISTRO EMPRESA CLIENTE

   IMPORTANTE:
   - El rol interno continúa siendo
     USUARIO_EMPRESA para no romper el sistema.
   - Una empresa que ya existe NO se enlaza
     mediante registro público. Esto evita que
     una persona se asocie por sí misma a una
     empresa previamente registrada.
========================================= */
export const registerCompany = async (req, res) => {
  const validation = registerCompanySchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de registro de empresa inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    first_name,
    last_name,
    email,
    password,
    phone,
    rut,
    company,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (await emailAlreadyExists(client, email)) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta asociada a este correo electrónico",
        code: "AUTH_EMAIL_ALREADY_EXISTS",
      });
    }

    const normalizedCompanyRut = normalizeRutIdentity(
      company.rut
    );

    const existingCompany = await client.query(
      `
        SELECT
          id,
          legal_name,
          rut
        FROM customer_companies
        WHERE REGEXP_REPLACE(
          UPPER(COALESCE(rut, '')),
          '[^0-9K]',
          '',
          'g'
        ) = $1
        LIMIT 1
      `,
      [normalizedCompanyRut]
    );

    if (existingCompany.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "La empresa ya se encuentra registrada. Solicita a un administrador que asocie tu usuario a la empresa existente.",
        code: "AUTH_COMPANY_ALREADY_EXISTS",
        data: {
          company_id: existingCompany.rows[0].id,
          legal_name: existingCompany.rows[0].legal_name,
        },
      });
    }

    const roleId = await getRoleId(
      client,
      PUBLIC_ROLE_COMPANY
    );

    const passwordHash = await bcrypt.hash(password, 12);

    const userResult = await client.query(
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          TRUE
        )
        RETURNING
          id,
          first_name,
          last_name,
          email,
          phone,
          rut,
          is_active,
          email_verified,
          created_at
      `,
      [
        roleId,
        first_name,
        last_name,
        email,
        passwordHash,
        phone || null,
        rut ? formatRutForStorage(rut) : null,
      ]
    );

    const user = userResult.rows[0];

    const companyResult = await client.query(
      `
        INSERT INTO customer_companies (
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
          is_active
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
          TRUE
        )
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
          created_at
      `,
      [
        company.legal_name,
        company.trade_name || null,
        formatRutForStorage(company.rut),
        company.business_activity,
        company.billing_email || email,
        company.phone || phone || null,
        company.address_line,
        company.commune,
        company.city,
        company.region,
        company.country || "Chile",
      ]
    );

    const customerCompany = companyResult.rows[0];

    await client.query(
      `
        INSERT INTO company_users (
          company_id,
          user_id,
          position_name,
          is_primary_contact,
          is_active
        )
        VALUES (
          $1,
          $2,
          $3,
          TRUE,
          TRUE
        )
      `,
      [
        customerCompany.id,
        user.id,
        company.position_name || "Contacto principal",
      ]
    );

    const companies = await getUserCompanies(
      client,
      user.id
    );

    await client.query("COMMIT");

    const token = generateToken({
      id: user.id,
      role: PUBLIC_ROLE_COMPANY,
    });

    setAuthCookie(res, token);

    return res.status(201).json({
      success: true,
      message: "Cuenta empresa creada correctamente",
      token,
      user: {
        ...user,
        role: PUBLIC_ROLE_COMPANY,
        role_label: "Empresa cliente",
        companies,
      },
      company: customerCompany,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);

    console.error("Error registrando empresa cliente:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "Ya existe una cuenta o empresa asociada a los datos ingresados",
        code: "AUTH_COMPANY_REGISTER_CONFLICT",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear la cuenta empresa",
      code: error.code || "AUTH_COMPANY_REGISTER_ERROR",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   INICIO DE SESIÓN
========================================= */
export const login = async (req, res) => {
  const validation = loginSchema.safeParse(req.body);

  if (!validation.success) {
    await recordAuthEventSafely({
      email: req.body?.email || null,
      eventType: "LOGIN_FAILED",
      success: false,
      req,
      failureReason: "INVALID_LOGIN_PAYLOAD",
    });

    return res.status(400).json({
      success: false,
      message: "Credenciales inválidas",
    });
  }

  const { email, password } = validation.data;

  try {
    const result = await pool.query(
      `
        SELECT
          u.id,
          u.first_name,
          u.last_name,
          u.email,
          u.password_hash,
          u.phone,
          u.rut,
          u.is_active,
          u.email_verified,
          u.avatar_key,
          r.name AS role
        FROM users u
        INNER JOIN roles r
          ON r.id = u.role_id
        WHERE LOWER(u.email) = LOWER($1)
          AND u.deleted_at IS NULL
        LIMIT 1
      `,
      [email]
    );

    if (result.rowCount === 0) {
      await recordAuthEventSafely({
        email,
        eventType: "LOGIN_FAILED",
        success: false,
        req,
        failureReason: "USER_NOT_FOUND",
      });

      return res.status(401).json({
        success: false,
        message: "Correo electrónico o contraseña incorrectos",
      });
    }

    const user = result.rows[0];

    const passwordValid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordValid) {
      await recordAuthEventSafely({
        userId: user.id,
        email: user.email,
        eventType: "LOGIN_FAILED",
        success: false,
        req,
        failureReason: "INVALID_PASSWORD",
      });

      return res.status(401).json({
        success: false,
        message: "Correo electrónico o contraseña incorrectos",
      });
    }

    if (!user.is_active) {
      await recordAuthEventSafely({
        userId: user.id,
        email: user.email,
        eventType: "LOGIN_FAILED",
        success: false,
        req,
        failureReason: "ACCOUNT_DISABLED",
      });

      return res.status(403).json({
        success: false,
        message: "La cuenta se encuentra deshabilitada",
      });
    }

    await pool.query(
      `
        UPDATE users
        SET last_login_at = NOW()
        WHERE id = $1
      `,
      [user.id]
    );

    const companies = await getUserCompanies(
      pool,
      user.id
    );

    const token = generateToken({
      id: user.id,
      role: user.role,
    });

    setAuthCookie(res, token);

    await recordAuthEventSafely({
      userId: user.id,
      email: user.email,
      eventType: "LOGIN_SUCCESS",
      success: true,
      req,
    });

    delete user.password_hash;

    const publicUser =
      await serializeUserWithAvatar(
        user
      );

    return res.status(200).json({
      success: true,
      message: "Inicio de sesión correcto",
      token,
      user: {
        ...publicUser,
        role_label: getRoleLabel(user.role),
        companies,
      },
    });
  } catch (error) {
    console.error("Error iniciando sesión:", error);

    await recordAuthEventSafely({
      email,
      eventType: "LOGIN_FAILED",
      success: false,
      req,
      failureReason: "LOGIN_PROCESS_ERROR",
    });

    return res.status(500).json({
      success: false,
      message: "No fue posible iniciar sesión",
    });
  }
};

/* =========================================
   USUARIO AUTENTICADO
========================================= */
export const logout = async (req, res) => {
  let userId = null;

  try {
    const token = getAuthTokenFromRequest(req);

    if (token) {
      const decoded = verifyToken(token);
      userId = decoded?.sub || null;
    }
  } catch {
    /*
     * Un token expirado o inválido no debe impedir limpiar la cookie.
     * En ese caso simplemente no asociamos el LOGOUT a un user_id.
     */
  }

  clearAuthCookie(res);

  if (userId) {
    await recordAuthEventSafely({
      userId,
      eventType: "LOGOUT",
      success: true,
      req,
    });
  }

  return res.status(200).json({
    success: true,
    message: "Sesión cerrada correctamente",
  });
};

export const me = async (req, res) => {
  try {
    const result =
      await pool.query(
        `
          SELECT avatar_key
          FROM users
          WHERE id = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [req.user.id]
      );

    const avatarKey =
      result.rows[0]?.avatar_key ||
      null;

    return res.status(200).json({
      success: true,
      user: {
        ...req.user,
        avatar_url:
          await resolveAvatarUrl(
            avatarKey
          ),
        role_label:
          getRoleLabel(
            req.user.role
          ),
      },
    });
  } catch (error) {
    console.error(
      "Error obteniendo perfil autenticado:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener el perfil",
      code:
        "PROFILE_READ_ERROR",
    });
  }
};


/* =========================================
   ACTUALIZAR PERFIL AUTENTICADO

   Seguridad:
   - El usuario puede modificar únicamente
     nombre, apellido y teléfono.
   - Correo, RUT, rol y estado no se cambian
     desde esta ruta.
========================================= */
export const updateMe = async (req, res) => {
  const firstName = String(
    req.body?.first_name ?? ""
  ).trim();

  const lastName = String(
    req.body?.last_name ?? ""
  ).trim();

  const phoneRaw = req.body?.phone;

  const phone =
    phoneRaw === null ||
    phoneRaw === undefined ||
    String(phoneRaw).trim() === ""
      ? null
      : String(phoneRaw).trim();

  if (!firstName) {
    return res.status(400).json({
      success: false,
      message: "El nombre es obligatorio",
      code: "PROFILE_FIRST_NAME_REQUIRED",
    });
  }

  if (!lastName) {
    return res.status(400).json({
      success: false,
      message: "El apellido es obligatorio",
      code: "PROFILE_LAST_NAME_REQUIRED",
    });
  }

  if (firstName.length > 100) {
    return res.status(400).json({
      success: false,
      message: "El nombre es demasiado largo",
      code: "PROFILE_FIRST_NAME_TOO_LONG",
    });
  }

  if (lastName.length > 100) {
    return res.status(400).json({
      success: false,
      message: "El apellido es demasiado largo",
      code: "PROFILE_LAST_NAME_TOO_LONG",
    });
  }

  if (phone && phone.length > 30) {
    return res.status(400).json({
      success: false,
      message: "El teléfono es demasiado largo",
      code: "PROFILE_PHONE_TOO_LONG",
    });
  }

  try {
    const result = await pool.query(
      `
        UPDATE users
        SET
          first_name = $1,
          last_name = $2,
          phone = $3
        WHERE id = $4
          AND deleted_at IS NULL
        RETURNING
          id,
          first_name,
          last_name,
          email,
          phone,
          rut,
          is_active,
          email_verified,
          avatar_key,
          last_login_at,
          created_at
      `,
      [
        firstName,
        lastName,
        phone,
        req.user.id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code: "PROFILE_USER_NOT_FOUND",
      });
    }

    const updatedUser = result.rows[0];
    const companies = await getUserCompanies(
      pool,
      req.user.id
    );

    const publicUser =
      await serializeUserWithAvatar(
        updatedUser
      );

    return res.status(200).json({
      success: true,
      message: "Perfil actualizado correctamente",
      user: {
        ...publicUser,
        role: req.user.role,
        role_label: getRoleLabel(req.user.role),
        companies,
      },
    });
  } catch (error) {
    console.error(
      "Error actualizando perfil:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar el perfil",
      code: "PROFILE_UPDATE_ERROR",
    });
  }
};



/* =========================================
   ACTUALIZAR AVATAR DEL USUARIO AUTENTICADO
========================================= */
export const updateAvatar = async (
  req,
  res
) => {
  if (!req.file?.buffer) {
    return res.status(400).json({
      success: false,
      message:
        "Debes seleccionar una foto de perfil",
      code:
        "PROFILE_AVATAR_FILE_REQUIRED",
    });
  }

  const avatarId =
    randomUUID();

  const client =
    await pool.connect();

  let newAvatarKey = null;
  let previousAvatarKey = null;

  try {
    await client.query(
      "BEGIN"
    );

    const currentResult =
      await client.query(
        `
          SELECT avatar_key
          FROM users
          WHERE id = $1
            AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `,
        [req.user.id]
      );

    if (
      currentResult.rowCount === 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res.status(404).json({
        success: false,
        message:
          "Usuario no encontrado",
        code:
          "PROFILE_USER_NOT_FOUND",
      });
    }

    previousAvatarKey =
      currentResult.rows[0]
        ?.avatar_key ||
      null;

    const storageResult =
      await uploadUserAvatar({
        buffer:
          req.file.buffer,
        userId:
          req.user.id,
        avatarId,
      });

    newAvatarKey =
      storageResult.key;

    const updateResult =
      await client.query(
        `
          UPDATE users
          SET avatar_key = $1
          WHERE id = $2
            AND deleted_at IS NULL
          RETURNING
            id,
            first_name,
            last_name,
            email,
            phone,
            rut,
            is_active,
            email_verified,
            avatar_key,
            last_login_at,
            created_at
        `,
        [
          newAvatarKey,
          req.user.id,
        ]
      );

    await client.query(
      "COMMIT"
    );

    if (
      previousAvatarKey &&
      previousAvatarKey !==
        newAvatarKey
    ) {
      try {
        await deleteUserAvatar(
          previousAvatarKey
        );
      } catch (cleanupError) {
        console.error(
          "No fue posible eliminar el avatar anterior:",
          cleanupError
        );
      }
    }

    const companies =
      Array.isArray(
        req.user?.companies
      )
        ? req.user.companies
        : [];

    const publicUser =
      await serializeUserWithAvatar(
        updateResult.rows[0]
      );

    return res.status(200).json({
      success: true,
      message:
        "Foto de perfil actualizada correctamente",
      user: {
        ...publicUser,
        role:
          req.user.role,
        role_label:
          getRoleLabel(
            req.user.role
          ),
        companies,
      },
    });
  } catch (error) {
    await client
      .query("ROLLBACK")
      .catch(() => null);

    if (newAvatarKey) {
      try {
        await deleteUserAvatar(
          newAvatarKey
        );
      } catch (cleanupError) {
        console.error(
          "No fue posible limpiar el avatar nuevo después del error:",
          cleanupError
        );
      }
    }

    console.error(
      "Error actualizando avatar:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar la foto de perfil",
      code:
        "PROFILE_AVATAR_UPDATE_ERROR",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR AVATAR DEL USUARIO AUTENTICADO
========================================= */
export const deleteAvatar = async (
  req,
  res
) => {
  const client =
    await pool.connect();

  let previousAvatarKey = null;

  try {
    await client.query(
      "BEGIN"
    );

    const currentResult =
      await client.query(
        `
          SELECT avatar_key
          FROM users
          WHERE id = $1
            AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `,
        [req.user.id]
      );

    if (
      currentResult.rowCount === 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res.status(404).json({
        success: false,
        message:
          "Usuario no encontrado",
        code:
          "PROFILE_USER_NOT_FOUND",
      });
    }

    previousAvatarKey =
      currentResult.rows[0]
        ?.avatar_key ||
      null;

    const result =
      await client.query(
        `
          UPDATE users
          SET avatar_key = NULL
          WHERE id = $1
            AND deleted_at IS NULL
          RETURNING
            id,
            first_name,
            last_name,
            email,
            phone,
            rut,
            is_active,
            email_verified,
            avatar_key,
            last_login_at,
            created_at
        `,
        [req.user.id]
      );

    await client.query(
      "COMMIT"
    );

    if (previousAvatarKey) {
      try {
        await deleteUserAvatar(
          previousAvatarKey
        );
      } catch (cleanupError) {
        console.error(
          "No fue posible eliminar el avatar de Railway:",
          cleanupError
        );
      }
    }

    const companies =
      Array.isArray(
        req.user?.companies
      )
        ? req.user.companies
        : [];

    const publicUser =
      await serializeUserWithAvatar(
        result.rows[0]
      );

    return res.status(200).json({
      success: true,
      message:
        "Foto de perfil eliminada correctamente",
      user: {
        ...publicUser,
        role:
          req.user.role,
        role_label:
          getRoleLabel(
            req.user.role
          ),
        companies,
      },
    });
  } catch (error) {
    await client
      .query("ROLLBACK")
      .catch(() => null);

    console.error(
      "Error eliminando avatar:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible eliminar la foto de perfil",
      code:
        "PROFILE_AVATAR_DELETE_ERROR",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   CAMBIAR CONTRASEÑA DEL USUARIO AUTENTICADO
========================================= */
export const changePassword = async (
  req,
  res
) => {
  const currentPassword = String(
    req.body?.current_password ?? ""
  );

  const newPassword = String(
    req.body?.new_password ?? ""
  );

  const confirmPassword = String(
    req.body?.confirm_password ?? ""
  );

  if (
    !currentPassword ||
    !newPassword ||
    !confirmPassword
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Debes completar todos los campos de contraseña",
      code: "PASSWORD_FIELDS_REQUIRED",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message:
        "La nueva contraseña debe tener al menos 8 caracteres",
      code: "PASSWORD_TOO_SHORT",
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      success: false,
      message:
        "La confirmación de contraseña no coincide",
      code: "PASSWORD_CONFIRMATION_MISMATCH",
    });
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({
      success: false,
      message:
        "La nueva contraseña debe ser distinta de la actual",
      code: "PASSWORD_MUST_CHANGE",
    });
  }

  try {
    const result = await pool.query(
      `
        SELECT
          password_hash
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code: "PASSWORD_USER_NOT_FOUND",
      });
    }

    const validCurrentPassword =
      await bcrypt.compare(
        currentPassword,
        result.rows[0].password_hash
      );

    if (!validCurrentPassword) {
      return res.status(401).json({
        success: false,
        message:
          "La contraseña actual no es correcta",
        code: "PASSWORD_CURRENT_INVALID",
      });
    }

    const passwordHash = await bcrypt.hash(
      newPassword,
      12
    );

    await pool.query(
      `
        UPDATE users
        SET password_hash = $1
        WHERE id = $2
      `,
      [
        passwordHash,
        req.user.id,
      ]
    );

    return res.status(200).json({
      success: true,
      message:
        "Contraseña actualizada correctamente",
    });
  } catch (error) {
    console.error(
      "Error cambiando contraseña:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar la contraseña",
      code: "PASSWORD_UPDATE_ERROR",
    });
  }
};

/* =========================================
   TOKEN EFÍMERO PARA SOCKET.IO

   La sesión principal ya fue validada por
   authenticate. Este token:
   - sólo sirve para el handshake realtime;
   - tiene una duración corta;
   - no reemplaza la cookie HttpOnly;
   - no se almacena en localStorage.
========================================= */
export const realtimeToken = async (
  req,
  res
) => {
  try {
    const token =
      generateRealtimeToken({
        id: req.user.id,
        role: req.user.role,
      });

    /*
     * La respuesta contiene una credencial.
     * Evitamos que navegadores, proxies o CDN
     * puedan almacenarla.
     */
    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(200).json({
      success: true,
      realtime_token: token,
    });
  } catch (error) {
    console.error(
      "Error generando token realtime:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible generar la credencial realtime",
      code:
        "REALTIME_TOKEN_GENERATION_ERROR",
    });
  }
};

/* =========================================
   ESTADO DE SESIÓN AUTENTICADA

   Devuelve solo metadatos de expiración.
   El JWT permanece exclusivamente en la cookie
   HttpOnly y nunca se expone al navegador.
========================================= */
export const session = async (req, res) => {
  const expiresAt =
    Number(req.auth?.decoded?.exp || 0) * 1000;

  if (!expiresAt) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message:
        "No fue posible determinar la expiración de la sesión",
    });
  }

  const serverTime = Date.now();
  const role = String(
    req.user?.role || ""
  )
    .trim()
    .toUpperCase();

  return res.status(200).json({
    success: true,
    authenticated: true,
    role,
    renewal_duration_label:
      getSessionDurationLabelForRole(role),
    expires_at: expiresAt,
    expires_in_ms: Math.max(
      expiresAt - serverTime,
      0
    ),
    server_time: serverTime,
  });
};

/* =========================================
   EXTENDER SESIÓN AUTENTICADA

   Genera un JWT nuevo y reemplaza la cookie
   HttpOnly actual. La nueva duración se resuelve
   automáticamente según el rol autenticado.
========================================= */
export const extendSession = async (req, res) => {
  try {
    const token = generateToken({
      id: req.user.id,
      role: req.user.role,
    });

    setAuthCookie(res, token);

    const decoded = verifyToken(token);
    const expiresAt =
      Number(decoded?.exp || 0) * 1000;
    const serverTime = Date.now();

    return res.status(200).json({
      success: true,
      message:
        "Sesión extendida correctamente",
      role: req.user.role,
      renewal_duration_label:
        getSessionDurationLabelForRole(
          req.user.role
        ),
      expires_at: expiresAt,
      expires_in_ms: Math.max(
        expiresAt - serverTime,
        0
      ),
      server_time: serverTime,
    });
  } catch (error) {
    console.error(
      "Error extendiendo sesión:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible extender la sesión",
    });
  }
};

