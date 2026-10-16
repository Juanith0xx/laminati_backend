import {
  registerQuotationEmailOpen,
  registerQuotationView,
} from "../services/quotationTracking.service.js";

import {
  getQuotationPdf,
} from "../services/quotation.service.js";

const TRANSPARENT_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const getRequestIp = (req) => {
  const forwarded = String(
    req.headers["x-forwarded-for"] || ""
  )
    .split(",")[0]
    .trim();

  return (
    forwarded ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
};

export const quotationEmailOpenController = async (
  req,
  res
) => {
  try {
    await registerQuotationEmailOpen({
      token: req.params.token,
      userAgent: req.get("user-agent"),
      ipAddress: getRequestIp(req),
    });
  } catch (error) {
    console.error(
      "Error registrando apertura de cotización:",
      {
        message: error?.message,
        code: error?.code || null,
      }
    );
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Content-Length",
    TRANSPARENT_PIXEL.length
  );
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  return res.status(200).send(TRANSPARENT_PIXEL);
};

export const quotationViewController = async (
  req,
  res
) => {
  try {
    const tracking = await registerQuotationView({
      token: req.params.token,
      userAgent: req.get("user-agent"),
      ipAddress: getRequestIp(req),
    });

    if (!tracking.found) {
      return res
        .status(404)
        .send(
          "La cotización no está disponible o el enlace ha expirado."
        );
    }

    const quotation = await getQuotationPdf({
      quotationId: tracking.quotation_id,
    });

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${quotation.filename}"`
    );
    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    return res
      .status(200)
      .send(quotation.buffer);
  } catch (error) {
    console.error(
      "Error accediendo a cotización pública:",
      {
        message: error?.message,
        code: error?.code || null,
      }
    );

    return res
      .status(500)
      .send(
        "No fue posible abrir la cotización."
      );
  }
};
