import pool from "../config/database.js";
import { verifyToken } from "../utils/jwt.js";

/* =========================================
   AUTENTICAR USUARIO MEDIANTE JWT
========================================= */
export const authenticate = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;

    if (
      !authorization ||
      !authorization.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        success: false,
        message: "Autenticación requerida",
      });
    }

    const token = authorization.substring(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token de autenticación no proporcionado",
      });
    }

    const decoded = verifyToken(token);

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