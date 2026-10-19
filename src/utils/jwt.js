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
      issuer: "laminatiword-api",
      audience: "laminatiword",
    }
  );
};
