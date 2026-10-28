import { isIP } from "node:net";

import {
  ipKeyGenerator,
} from "express-rate-limit";

const normalizeClientIp = (
  value
) => {
  const rawValue =
    Array.isArray(value)
      ? value[0]
      : value;

  return String(
    rawValue || ""
  )
    .split(",")[0]
    .trim();
};

const isRunningOnRailway =
  Boolean(
    process.env
      .RAILWAY_ENVIRONMENT ||
    process.env
      .RAILWAY_ENVIRONMENT_ID ||
    process.env
      .RAILWAY_PROJECT_ID ||
    process.env
      .RAILWAY_SERVICE_ID
  );

export const getRateLimitClientIp = (
  req
) => {
  if (
    isRunningOnRailway
  ) {
    const railwayClientIp =
      normalizeClientIp(
        req.headers[
          "x-real-ip"
        ]
      );

    if (
      isIP(
        railwayClientIp
      )
    ) {
      return railwayClientIp;
    }
  }

  const socketIp =
    normalizeClientIp(
      req.socket
        ?.remoteAddress
    );

  if (
    isIP(
      socketIp
    )
  ) {
    return socketIp;
  }

  return "0.0.0.0";
};

export const rateLimitKeyGenerator = (
  req
) => {
  return ipKeyGenerator(
    getRateLimitClientIp(
      req
    ),
    56
  );
};
