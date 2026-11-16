import pool from "../config/database.js";
import { verifyToken } from "../utils/jwt.js";
import {
  getAuthTokenFromRequest,
} from "../utils/authCookie.js";

/* =========================================
   BÚSQUEDA TÉCNICA DE PRODUCTOS

   - Solo se resuelve autenticación cuando la búsqueda
     comienza por STRAT-, LAB- o MEG-.
   - Las búsquedas públicas normales no agregan consultas
     extra a la base de datos.
   - El rol se conserva unos segundos en memoria para que
     escribir un SKU técnico no consulte users en cada tecla.
========================================= */

const TECHNICAL_PRODUCT_SEARCH_PATTERN =
  /^(STRAT|LAB|MEG)-/i;

const TECHNICAL_PRODUCT_SEARCH_ROLES =
  new Set(["ADMIN", "VENDEDOR"]);

const TECHNICAL_ROLE_CACHE_TTL_MS = 15_000;
const TECHNICAL_ROLE_CACHE_MAX_ENTRIES = 200;

const technicalRoleCache = new Map();

const getTechnicalSearchTerm = (req) =>
  String(
    req?.query?.search ??
      req?.query?.q ??
      ""
  ).trim();

const readCachedTechnicalRole = (userId) => {
  const cached =
    technicalRoleCache.get(userId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    technicalRoleCache.delete(userId);
    return null;
  }

  return cached;
};

const cacheTechnicalRole = (
  userId,
  role,
  isActive
) => {
  if (
    technicalRoleCache.size >=
    TECHNICAL_ROLE_CACHE_MAX_ENTRIES
  ) {
    const oldestKey =
      technicalRoleCache.keys().next().value;

    if (oldestKey) {
      technicalRoleCache.delete(oldestKey);
    }
  }

  technicalRoleCache.set(userId, {
    role,
    isActive,
    expiresAt:
      Date.now() +
      TECHNICAL_ROLE_CACHE_TTL_MS,
  });
};

export const resolveTechnicalProductSearchAccess =
  async (req, _res, next) => {
    const searchTerm =
      getTechnicalSearchTerm(req);

    const isTechnical =
      TECHNICAL_PRODUCT_SEARCH_PATTERN.test(
        searchTerm
      );

    req.productSearchAccess = {
      isTechnical,
      allowed: false,
      role: null,
    };

    if (!isTechnical) {
      return next();
    }

    const token =
      getAuthTokenFromRequest(req);

    if (!token) {
      return next();
    }

    try {
      const decoded = verifyToken(token);
      const userId = decoded?.sub;

      if (!userId) {
        return next();
      }

      let userAccess =
        readCachedTechnicalRole(userId);

      if (!userAccess) {
        const result = await pool.query(
          `
            SELECT
              u.is_active,
              r.name AS role
            FROM users u
            JOIN roles r
              ON r.id = u.role_id
            WHERE u.id = $1
            LIMIT 1
          `,
          [userId]
        );

        if (result.rowCount === 0) {
          return next();
        }

        const row = result.rows[0];

        userAccess = {
          role: String(row.role || "")
            .trim()
            .toUpperCase(),
          isActive:
            row.is_active === true,
        };

        cacheTechnicalRole(
          userId,
          userAccess.role,
          userAccess.isActive
        );
      }

      req.productSearchAccess = {
        isTechnical: true,
        allowed:
          userAccess.isActive === true &&
          TECHNICAL_PRODUCT_SEARCH_ROLES.has(
            userAccess.role
          ),
        role: userAccess.role || null,
      };

      return next();
    } catch {
      /*
       * Esta ruta sigue siendo pública. Un JWT ausente,
       * vencido o inválido simplemente deja deshabilitada
       * la búsqueda técnica, sin convertir el catálogo en
       * una ruta protegida.
       */
      return next();
    }
  };

/* =========================================
   AUTENTICAR USUARIO MEDIANTE JWT
========================================= */
export const authenticate = async (req, res, next) => {
  try {
    const token =
      getAuthTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Autenticación requerida",
      });
    }

    const decoded = verifyToken(token);

    /* =========================================
       CONTEXTO DE AUTENTICACIÓN

       Se conserva el JWT decodificado únicamente
       dentro del request del servidor. Esto permite
       consultar su expiración sin exponer el token
       al frontend.
    ========================================= */
    req.auth = {
      token,
      decoded,
    };

    /* =========================================
       BUSCAR USUARIO
    ========================================= */
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
          r.name AS role
        FROM users u
        JOIN roles r
          ON r.id = u.role_id
        WHERE u.id = $1
        LIMIT 1
      `,
      [decoded.sub]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        success: false,
        message: "Usuario no válido",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "La cuenta se encuentra deshabilitada",
      });
    }

    /* =========================================
       EMPRESAS ASOCIADAS AL USUARIO
    ========================================= */
    const companiesResult = await pool.query(
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
        JOIN customer_companies cc
          ON cc.id = cu.company_id
        WHERE cu.user_id = $1
          AND cu.is_active = TRUE
          AND cc.is_active = TRUE
        ORDER BY
          cu.is_primary_contact DESC,
          cc.legal_name ASC
      `,
      [user.id]
    );

    user.companies = companiesResult.rows;

    req.user = user;

    next();
  } catch (error) {
    console.error("Error de autenticación:", error.message);

    return res.status(401).json({
      success: false,
      message: "Token inválido o expirado",
    });
  }
};