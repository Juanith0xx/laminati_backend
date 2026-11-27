import pool from "../config/database.js";

const cleanText = (value) => String(value ?? "").trim();
const cleanEmail = (value) => cleanText(value).toLowerCase();
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));

const serviceError = (message, status = 400, code = "MAILING_ERROR") => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const clampLimit = (value, fallback = 50) => Math.min(Math.max(Number(value) || fallback, 1), 200);

export const getMailingSummary = async () => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM mailing_contacts WHERE status = 'SUBSCRIBED') AS subscribed_contacts,
      (SELECT COUNT(*)::int FROM mailing_segments WHERE status = 'ACTIVE') AS active_segments,
      (SELECT COUNT(*)::int FROM mailing_templates WHERE status <> 'ARCHIVED') AS templates,
      (SELECT COUNT(*)::int FROM mailing_campaigns WHERE status = 'DRAFT') AS draft_campaigns,
      (SELECT COUNT(*)::int FROM mailing_campaigns WHERE status = 'SCHEDULED') AS scheduled_campaigns,
      (SELECT COUNT(*)::int FROM mailing_suppressions) AS suppressions
  `);
  return rows[0];
};

export const listMailingContacts = async ({ q = "", status = "", limit = 50 } = {}) => {
  const params = [];
  const where = [];
  const search = cleanText(q);
  const normalizedStatus = cleanText(status).toUpperCase();
  if (search) {
    params.push(`%${search}%`);
    where.push(`(email ILIKE $${params.length} OR first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR company_name ILIKE $${params.length})`);
  }
  if (normalizedStatus) {
    params.push(normalizedStatus);
    where.push(`status = $${params.length}`);
  }
  params.push(clampLimit(limit));
  const { rows } = await pool.query(`
    SELECT id, email, first_name, last_name, company_name, phone, source, status, metadata,
           subscribed_at, unsubscribed_at, created_at, updated_at
    FROM mailing_contacts
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);
  return rows;
};

export const createMailingContact = async (payload = {}) => {
  const email = cleanEmail(payload.email);
  if (!isEmail(email)) throw serviceError("Correo inválido", 400, "MAILING_CONTACT_EMAIL_INVALID");
  const status = cleanText(payload.status || "SUBSCRIBED").toUpperCase();
  const { rows } = await pool.query(`
    INSERT INTO mailing_contacts (email, first_name, last_name, company_name, phone, source, status, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT (email) DO UPDATE SET
      first_name = COALESCE(EXCLUDED.first_name, mailing_contacts.first_name),
      last_name = COALESCE(EXCLUDED.last_name, mailing_contacts.last_name),
      company_name = COALESCE(EXCLUDED.company_name, mailing_contacts.company_name),
      phone = COALESCE(EXCLUDED.phone, mailing_contacts.phone),
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      metadata = mailing_contacts.metadata || EXCLUDED.metadata,
      unsubscribed_at = CASE WHEN EXCLUDED.status = 'UNSUBSCRIBED' THEN now() ELSE NULL END,
      updated_at = now()
    RETURNING *
  `, [
    email,
    cleanText(payload.first_name) || null,
    cleanText(payload.last_name) || null,
    cleanText(payload.company_name) || null,
    cleanText(payload.phone) || null,
    cleanText(payload.source || "MANUAL").toUpperCase(),
    status,
    JSON.stringify(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
  ]);
  return rows[0];
};

export const updateMailingContact = async (id, payload = {}) => {
  const fields = [];
  const params = [];
  const add = (column, value) => { params.push(value); fields.push(`${column} = $${params.length}`); };
  for (const key of ["first_name","last_name","company_name","phone"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) add(key, cleanText(payload[key]) || null);
  }
  if (payload.email !== undefined) {
    const email = cleanEmail(payload.email);
    if (!isEmail(email)) throw serviceError("Correo inválido", 400, "MAILING_CONTACT_EMAIL_INVALID");
    add("email", email);
  }
  if (payload.status !== undefined) {
    const status = cleanText(payload.status).toUpperCase();
    add("status", status);
    fields.push(`unsubscribed_at = ${status === "UNSUBSCRIBED" ? "now()" : "NULL"}`);
  }
  if (!fields.length) throw serviceError("No hay cambios para guardar");
  fields.push("updated_at = now()");
  params.push(id);
  const { rows } = await pool.query(`UPDATE mailing_contacts SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw serviceError("Contacto no encontrado", 404, "MAILING_CONTACT_NOT_FOUND");
  return rows[0];
};

export const listMailingSegments = async () => {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.description, s.status, s.created_at, s.updated_at,
           COUNT(r.id)::int AS rule_count
    FROM mailing_segments s
    LEFT JOIN mailing_segment_rules r ON r.segment_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);
  return rows;
};

export const createMailingSegment = async (payload = {}) => {
  const name = cleanText(payload.name);
  if (!name) throw serviceError("El nombre del segmento es obligatorio");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`INSERT INTO mailing_segments (name, description) VALUES ($1,$2) RETURNING *`, [name, cleanText(payload.description) || null]);
    const segment = rows[0];
    const rules = Array.isArray(payload.rules) ? payload.rules : [];
    for (const rule of rules) {
      if (!cleanText(rule.field) || !cleanText(rule.operator)) continue;
      await client.query(`INSERT INTO mailing_segment_rules (segment_id, field, operator, value) VALUES ($1,$2,$3,$4::jsonb)`, [segment.id, cleanText(rule.field), cleanText(rule.operator), JSON.stringify(rule.value ?? null)]);
    }
    await client.query("COMMIT");
    return segment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
};

export const listMailingTemplates = async () => {
  const { rows } = await pool.query(`SELECT id, name, subject, preview_text, html_content, text_content, status, created_at, updated_at FROM mailing_templates ORDER BY created_at DESC`);
  return rows;
};

export const createMailingTemplate = async (payload = {}) => {
  const name = cleanText(payload.name);
  const subject = cleanText(payload.subject);
  if (!name || !subject) throw serviceError("Nombre y asunto son obligatorios");
  const { rows } = await pool.query(`
    INSERT INTO mailing_templates (name, subject, preview_text, html_content, text_content, status)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [name, subject, cleanText(payload.preview_text) || null, String(payload.html_content ?? ""), String(payload.text_content ?? "") || null, cleanText(payload.status || "DRAFT").toUpperCase()]);
  return rows[0];
};

export const listMailingCampaigns = async () => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.subject, c.preview_text, c.template_id, c.segment_id,
           c.sender_name, c.sender_email, c.reply_to, c.status, c.scheduled_at, c.sent_at,
           c.created_at, c.updated_at,
           t.name AS template_name, s.name AS segment_name
    FROM mailing_campaigns c
    LEFT JOIN mailing_templates t ON t.id = c.template_id
    LEFT JOIN mailing_segments s ON s.id = c.segment_id
    ORDER BY c.created_at DESC
  `);
  return rows;
};

export const createMailingCampaign = async (payload = {}, userId = null) => {
  const name = cleanText(payload.name);
  const subject = cleanText(payload.subject);
  if (!name || !subject) throw serviceError("Nombre y asunto son obligatorios");
  const { rows } = await pool.query(`
    INSERT INTO mailing_campaigns
      (name, subject, preview_text, template_id, segment_id, sender_name, sender_email, reply_to, status, scheduled_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    name, subject, cleanText(payload.preview_text) || null,
    payload.template_id || null, payload.segment_id || null,
    cleanText(payload.sender_name) || null, cleanEmail(payload.sender_email) || null,
    cleanEmail(payload.reply_to) || null,
    cleanText(payload.status || "DRAFT").toUpperCase(), payload.scheduled_at || null, userId,
  ]);
  return rows[0];
};

export const listMailingSuppressions = async () => {
  const { rows } = await pool.query(`SELECT id, email, reason, source, notes, created_at FROM mailing_suppressions ORDER BY created_at DESC`);
  return rows;
};

export const createMailingSuppression = async (payload = {}) => {
  const email = cleanEmail(payload.email);
  if (!isEmail(email)) throw serviceError("Correo inválido");
  const reason = cleanText(payload.reason || "MANUAL").toUpperCase();
  const { rows } = await pool.query(`
    INSERT INTO mailing_suppressions (email, reason, source, notes)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, notes = EXCLUDED.notes
    RETURNING *
  `, [email, reason, cleanText(payload.source || "MANUAL").toUpperCase(), cleanText(payload.notes) || null]);
  await pool.query(`UPDATE mailing_contacts SET status = 'SUPPRESSED', updated_at = now() WHERE email = $1`, [email]);
  return rows[0];
};
