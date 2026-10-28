import jwt from "jsonwebtoken";

const normalizeRole = (role) =>
  String(role || "")
    .trim()
    .toUpperCase();

export const getTokenExpirationForRole = (role) => {
  switch (normalizeRole(role)) {
    case "ADMIN":
      return (
        process.env.JWT_EXPIRES_IN_ADMIN ||
        process.env.JWT_EXPIRES_IN ||
        "2h"
      );

    case "VENDEDOR":
      return (
        process.env.JWT_EXPIRES_IN_VENDEDOR ||
        process.env.JWT_EXPIRES_IN ||
        "4h"
      );

    case "CLIENTE":
      return (
        process.env.JWT_EXPIRES_IN_CLIENTE ||
        "7d"
      );

    case "USUARIO_EMPRESA":
      return (
        process.env.JWT_EXPIRES_IN_USUARIO_EMPRESA ||
        process.env.JWT_EXPIRES_IN_CLIENTE ||
        "7d"
      );

    default:
      return (
        process.env.JWT_EXPIRES_IN ||
        "2h"
      );
  }
};

export const getSessionDurationLabelForRole = (role) => {
  switch (normalizeRole(role)) {
    case "ADMIN":
      return "2 horas";

    case "VENDEDOR":
      return "4 horas";

    case "CLIENTE":
    case "USUARIO_EMPRESA":
      return "7 días";

    default:
      return "2 horas";
  }
};

export const generateToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: getTokenExpirationForRole(
        user.role
      ),
      algorithm: "HS256",
      issuer: "laminatiword-api",
      audience: "laminatiword",
    }
  );
};

export const verifyToken = (token) => {
  return jwt.verify(
    token,
    process.env.JWT_SECRET,
    {
      algorithms: ["HS256"],
      issuer: "laminatiword-api",
      audience: "laminatiword",
    }
  );
};

/* =========================================
   TOKEN EFÍMERO PARA SOCKET.IO

   - No reemplaza el JWT de sesión.
   - No se guarda en localStorage/sessionStorage.
   - Sólo autoriza el handshake realtime.
========================================= */

const REALTIME_TOKEN_AUDIENCE =
  "laminatiword-realtime";

const REALTIME_TOKEN_PURPOSE =
  "realtime";

export const generateRealtimeToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      purpose: REALTIME_TOKEN_PURPOSE,
    },
    process.env.JWT_SECRET,
    {
      expiresIn:
        process.env.JWT_REALTIME_EXPIRES_IN ||
        "2m",
      algorithm: "HS256",
      issuer: "laminatiword-api",
      audience: REALTIME_TOKEN_AUDIENCE,
    }
  );
};

export const verifyRealtimeToken = (token) => {
  const decoded = jwt.verify(
    token,
    process.env.JWT_SECRET,
    {
      algorithms: ["HS256"],
      issuer: "laminatiword-api",
      audience: REALTIME_TOKEN_AUDIENCE,
    }
  );

  if (
    String(decoded?.purpose || "") !==
    REALTIME_TOKEN_PURPOSE
  ) {
    const error = new Error(
      "Token realtime inválido"
    );
    error.code =
      "REALTIME_TOKEN_PURPOSE_INVALID";
    throw error;
  }

  return decoded;
};
