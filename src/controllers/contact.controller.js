import pool from "../config/database.js";
import {
  emitAdminNotification,
} from "../services/realtime.service.js";

const SUBJECTS = new Set([
  "QUOTE",
  "PRODUCT",
  "STOCK",
  "BUSINESS",
  "PROJECT",
  "OTHER",
]);

const SUBJECT_LABELS = {
  QUOTE: "Cotización",
  PRODUCT: "Consulta de producto",
  STOCK: "Disponibilidad y stock",
  BUSINESS: "Venta empresa",
  PROJECT: "Asesoría en proyecto",
  OTHER: "Otro",
};

const cleanText = (value, maxLength) => {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLength);
};

const normalizeEmail = (value) =>
  cleanText(value, 255).toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createContactMessage = async (req, res) => {
  try {
    const honeypot = cleanText(req.body?.website, 200);

    // Honeypot: respondemos éxito sin persistir para no dar feedback útil al bot.
    if (honeypot) {
      return res.status(201).json({
        success: true,
        message: "Consulta enviada correctamente",
      });
    }

    const firstName = cleanText(req.body?.first_name, 120);
    const lastName = cleanText(req.body?.last_name, 120);
    const companyName = cleanText(req.body?.company_name, 255);
    const email = normalizeEmail(req.body?.email);
    const phone = cleanText(req.body?.phone, 30);
    const subject = cleanText(req.body?.subject, 40).toUpperCase();
    const message = cleanText(req.body?.message, 1000);

    if (!firstName || !lastName || !email || !phone || !subject || !message) {
      return res.status(400).json({
        success: false,
        code: "CONTACT_REQUIRED_FIELDS",
        message: "Completa todos los campos obligatorios",
      });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({
        success: false,
        code: "CONTACT_INVALID_EMAIL",
        message: "Ingresa un correo electrónico válido",
      });
    }

    if (!SUBJECTS.has(subject)) {
      return res.status(400).json({
        success: false,
        code: "CONTACT_INVALID_SUBJECT",
        message: "Selecciona un motivo de contacto válido",
      });
    }

    if (message.length < 10) {
      return res.status(400).json({
        success: false,
        code: "CONTACT_MESSAGE_TOO_SHORT",
        message: "Cuéntanos un poco más sobre tu consulta",
      });
    }

    const result = await pool.query(
      `
        INSERT INTO public.contact_messages (
          first_name,
          last_name,
          company_name,
          email,
          phone,
          subject,
          message,
          status,
          source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', 'WEB')
        RETURNING id, status, created_at
      `,
      [
        firstName,
        lastName,
        companyName || null,
        email,
        phone,
        subject,
        message,
      ]
    );

    const savedContact =
      result.rows[0];

    emitAdminNotification({
      type:
        "CONTACT_NEW",

      title:
        "Nueva consulta",

      message:
        `${firstName} ${lastName} · ${
          SUBJECT_LABELS[
            subject
          ] || subject
        }`,

      entity_id:
        savedContact.id,

      href:
        "/admin/contactos",

      created_at:
        savedContact.created_at,

      data: {
        contact_id:
          savedContact.id,

        first_name:
          firstName,

        last_name:
          lastName,

        company_name:
          companyName ||
          null,

        subject,

        subject_label:
          SUBJECT_LABELS[
            subject
          ] || subject,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Consulta enviada correctamente",
      data: savedContact,
    });
  } catch (error) {
    console.error("Error creando mensaje de contacto:", error);

    return res.status(500).json({
      success: false,
      message: "No fue posible enviar tu consulta. Inténtalo nuevamente.",
    });
  }
};