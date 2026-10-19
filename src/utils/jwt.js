import jwt from "jsonwebtoken";

export const generateToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "2h",
      issuer: "laminatiword-api",
      audience: "laminatiword",
    }
  );
};

export const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET, {
    issuer: "laminatiword-api",
    audience: "laminatiword",
  });
};