import pool from "../config/database.js";

import {
  createAdminNotification,
} from "./adminNotifications.service.js";


const STAGES = new Set([
  "DRAFT","SENT","REVIEW","NEGOTIATION","APPROVED","WON","LOST",
]);
const STAGE_LABELS = {
  DRAFT: "Borrador",
  SENT: "Enviada",
  REVIEW: "En revisión",
  NEGOTIATION: "Negociación",
  APPROVED: "Aprobada",
  WON: "Ganada",
  LOST: "Perdida",
};

const PRIORITIES = new Set(["LOW","MEDIUM","HIGH","URGENT"]);
const CHANNELS = new Set(["EMAIL","WHATSAPP","PHONE","SHOWROOM","WEB"]);
const CHANNEL_LABELS = {
  EMAIL: "Correo",
  WHATSAPP: "WhatsApp",
  PHONE: "Teléfono",
  SHOWROOM: "Showroom",
  WEB: "Página Web",
};
const FOLLOWUP_TYPES = new Set([
  "CALL","MEETING","EMAIL","FOLLOW_UP","TECHNICAL_MEETING","SAMPLE_DELIVERY","MILESTONE","OTHER",
]);

const clean = (value) => String(value ?? "").trim();
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
const serviceError = (message, status = 400, code = "PROJECT_BOARD_ERROR") => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};
const requireUuid = (value, label) => {
  if (!isUuid(value)) throw serviceError(`${label} no posee un UUID válido`, 400, "PROJECT_BOARD_INVALID_UUID");
  return clean(value);
};
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

const ensureProject = async (quotationId, client = pool) => {
  const id = requireUuid(quotationId, "quotationId");
  const result = await client.query(
    `SELECT * FROM quotations WHERE id = $1 AND quotation_type = 'PROJECT' LIMIT 1`,
    [id]
  );
  if (!result.rowCount) throw serviceError("La cotización de proyecto no existe", 404, "PROJECT_BOARD_NOT_FOUND");

  await client.query(
    `INSERT INTO quotation_project_management (quotation_id, stage, assigned_to, last_activity_at)
     VALUES (
       $1,
       CASE WHEN $2 = 'SENT' THEN 'SENT'
            WHEN $2 = 'ACCEPTED' THEN 'APPROVED'
            WHEN $2 IN ('REJECTED','CANCELLED') THEN 'LOST'
            ELSE 'DRAFT' END,
       $3,
       NOW()
     )
     ON CONFLICT (quotation_id) DO NOTHING`,
    [id, result.rows[0].status, result.rows[0].created_by]
  );

  return result.rows[0];
};

const filters = (query = {}) => {
  const values = [];
  const conditions = ["q.quotation_type = 'PROJECT'"];
  const add = (v) => { values.push(v); return `$${values.length}`; };

  const search = clean(query.search);
  if (search) {
    const p = add(`%${search}%`);
    conditions.push(`(
      q.quote_number ILIKE ${p}
      OR COALESCE(q.project_name,'') ILIKE ${p}
      OR COALESCE(q.project_reference,'') ILIKE ${p}
      OR COALESCE(q.customer_name,'') ILIKE ${p}
      OR COALESCE(q.legal_name,'') ILIKE ${p}
      OR q.rut ILIKE ${p}
      OR EXISTS (
        SELECT 1 FROM quotation_project_lines qpl
        WHERE qpl.quotation_id = q.id
        AND (COALESCE(qpl.code,'') ILIKE ${p} OR qpl.description ILIKE ${p})
      )
    )`);
  }

  const priority = clean(query.priority).toUpperCase();
  if (priority && priority !== "ALL") {
    if (!PRIORITIES.has(priority)) throw serviceError("Prioridad inválida");
    conditions.push(`qpm.priority = ${add(priority)}`);
  }

  if (query.assigned_to && clean(query.assigned_to) !== "ALL") {
    conditions.push(`qpm.assigned_to = ${add(requireUuid(query.assigned_to,"assigned_to"))}::uuid`);
  }

  return { values, where: conditions.join(" AND ") };
};

export const listProjectBoard = async ({ query = {} } = {}) => {
  const { values, where } = filters(query);

  const result = await pool.query(
    `SELECT
       q.id, q.quote_number, q.status, q.project_name, q.project_reference,
       q.customer_name, q.legal_name, q.rut, q.email, q.total, q.currency,
       q.valid_until, q.sent_at, q.created_at, q.updated_at,
       qpm.stage, qpm.priority, qpm.assigned_to, qpm.channel, qpm.next_action,
       qpm.next_action_at, qpm.lost_reason, qpm.won_at, qpm.last_activity_at,
       CONCAT_WS(' ', assigned.first_name, assigned.last_name) AS assigned_name,
       CONCAT_WS(' ', creator.first_name, creator.last_name) AS created_by_name,
       COALESCE(mail.open_count,0)::int AS open_count,
       COALESCE(views.view_count,0)::int AS view_count,
       views.last_viewed_at,
       nf.id AS next_followup_id,
       nf.title AS next_followup_title,
       nf.followup_type AS next_followup_type,
       nf.scheduled_at AS next_followup_at,
       COALESCE(lines.codes,'') AS product_codes
     FROM quotations q
     INNER JOIN quotation_project_management qpm ON qpm.quotation_id = q.id
     LEFT JOIN users assigned ON assigned.id = qpm.assigned_to
     LEFT JOIN users creator ON creator.id = q.created_by
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(open_count),0)::int AS open_count
       FROM quotation_email_messages WHERE quotation_id = q.id
     ) mail ON TRUE
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(view_count),0)::int AS view_count, MAX(last_used_at) AS last_viewed_at
       FROM quotation_access_tokens WHERE quotation_id = q.id
     ) views ON TRUE
     LEFT JOIN LATERAL (
       SELECT id,title,followup_type,scheduled_at
       FROM quotation_project_followups
       WHERE quotation_id = q.id AND status = 'PENDING'
       ORDER BY scheduled_at ASC LIMIT 1
     ) nf ON TRUE
     LEFT JOIN LATERAL (
       SELECT STRING_AGG(DISTINCT NULLIF(BTRIM(code),''), ', ') AS codes
       FROM quotation_project_lines WHERE quotation_id = q.id
     ) lines ON TRUE
     WHERE ${where}
     ORDER BY qpm.updated_at DESC, q.created_at DESC
     LIMIT 500`,
    values
  );

  const projects = result.rows.map((row) => ({
    ...row,
    total: num(row.total),
    open_count: num(row.open_count),
    view_count: num(row.view_count),
  }));

  const count = (stage) => projects.filter((p) => p.stage === stage).length;

  return {
    projects,
    summary: {
      total_projects: projects.length,
      active_projects: projects.filter((p) => !["WON","LOST"].includes(p.stage)).length,
      in_review: projects.filter((p) => ["REVIEW","NEGOTIATION"].includes(p.stage)).length,
      won_projects: count("WON"),
      lost_projects: count("LOST"),
      total_quoted: projects.reduce((sum,p) => sum + num(p.total), 0),
    },
  };
};

export const getProjectBoardDetail = async ({ quotationId }) => {
  const quotation = await ensureProject(quotationId);
  const id = quotation.id;

  const [management, lines, followups, timeline] = await Promise.all([
    pool.query(
      `SELECT qpm.*, CONCAT_WS(' ',u.first_name,u.last_name) AS assigned_name
       FROM quotation_project_management qpm
       LEFT JOIN users u ON u.id = qpm.assigned_to
       WHERE qpm.quotation_id = $1`, [id]
    ),
    pool.query(
      `SELECT id,line_type,product_id,description,code,brand,collection,finish,
              thickness_mm,quantity,unit,format_label,width_cm,height_cm,
              unit_price_gross,line_total_gross,italy_price_usd,sort_order
       FROM quotation_project_lines
       WHERE quotation_id = $1
       ORDER BY sort_order, created_at`, [id]
    ),
    pool.query(
      `SELECT f.*,
              CONCAT_WS(' ',a.first_name,a.last_name) AS assigned_name,
              CONCAT_WS(' ',c.first_name,c.last_name) AS created_by_name
       FROM quotation_project_followups f
       LEFT JOIN users a ON a.id = f.assigned_to
       LEFT JOIN users c ON c.id = f.created_by
       WHERE f.quotation_id = $1
       ORDER BY f.scheduled_at ASC`, [id]
    ),
    pool.query(
      `SELECT * FROM (
         SELECT 'PROJECT'::text AS source,e.event_type,e.title,e.description,e.event_at,e.metadata,
                CONCAT_WS(' ',u.first_name,u.last_name) AS actor_name
         FROM quotation_project_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.quotation_id = $1
         UNION ALL
         SELECT 'EMAIL'::text,qee.event_type,qee.event_type,NULL::text,qee.event_at,qee.metadata,NULL::text
         FROM quotation_email_events qee
         JOIN quotation_email_messages qem ON qem.id = qee.email_message_id
         WHERE qem.quotation_id = $1
         UNION ALL
         SELECT 'VIEW'::text,qae.event_type,qae.event_type,NULL::text,qae.event_at,qae.metadata,NULL::text
         FROM quotation_access_events qae
         WHERE qae.quotation_id = $1
       ) x
       ORDER BY event_at DESC
       LIMIT 200`, [id]
    ),
  ]);

  return {
    quotation: { ...quotation, total: num(quotation.total) },
    management: management.rows[0] || null,
    lines: lines.rows.map((line) => ({
      ...line,
      quantity: num(line.quantity),
      unit_price_gross: num(line.unit_price_gross),
      line_total_gross: num(line.line_total_gross),
      italy_price_usd: line.italy_price_usd == null ? null : num(line.italy_price_usd),
    })),
    followups: followups.rows,
    timeline: timeline.rows,
  };
};

const notifyStageChange = async ({
  quotationId,
  actorUserId,
  previousStage,
  nextStage,
}) => {
  try {
    const contextResult =
      await pool.query(
        `SELECT
           q.quote_number,
           q.project_name,
           q.customer_name,
           q.legal_name,
           CONCAT_WS(' ', u.first_name, u.last_name) AS actor_name
         FROM quotations q
         LEFT JOIN users u
           ON u.id = $2
         WHERE q.id = $1
         LIMIT 1`,
        [quotationId, actorUserId]
      );

    const context =
      contextResult.rows[0] || {};

    const previousLabel =
      STAGE_LABELS[previousStage] ||
      previousStage;

    const nextLabel =
      STAGE_LABELS[nextStage] ||
      nextStage;

    const projectLabel =
      clean(context.project_name) ||
      clean(context.legal_name) ||
      clean(context.customer_name) ||
      clean(context.quote_number) ||
      "Cotización de proyecto";

    const actorName =
      clean(context.actor_name) ||
      "Un usuario";

    const realtimePayload = {
      id:
        `project-stage-${quotationId}-${Date.now()}`,
      type:
        "PROJECT_STAGE_CHANGED",
      title:
        `${clean(context.quote_number) || "Cotización"} · ${nextLabel}`,
      message:
        `${actorName} cambió ${projectLabel} de ${previousLabel} a ${nextLabel}.`,
      entity_type:
        "QUOTATION",
      entity_id:
        quotationId,
      action_url:
        `/admin/proyectos-cotizados?quotation=${encodeURIComponent(quotationId)}`,
      quotation_id:
        quotationId,
      previous_stage:
        previousStage,
      previous_stage_label:
        previousLabel,
      stage:
        nextStage,
      stage_label:
        nextLabel,
      actor_user_id:
        actorUserId,
      actor_name:
        actorName,
      occurred_at:
        new Date().toISOString(),
      is_read:
        false,
    };

    try {
      /*
       * Laminatiword ya centraliza la entrega realtime de las
       * notificaciones administrativas. El frontend del Board
       * escucha ADMIN_NOTIFICATION_RECEIVED_EVENT, por lo que
       * aquí solo debemos crear la notificación mediante el
       * servicio existente.
       *
       * Importante: un fallo de notificación no debe revertir
       * el cambio comercial que ya fue guardado en el Board.
       */
      await createAdminNotification({
        type:
          realtimePayload.type,
        title:
          realtimePayload.title,
        message:
          realtimePayload.message,
        entity_type:
          realtimePayload.entity_type,
        entity_id:
          realtimePayload.entity_id,
        action_url:
          realtimePayload.action_url,
      });
    } catch (notificationError) {
      console.error(
        "No fue posible crear la notificación del Board:",
        notificationError
      );
    }
  } catch (error) {
    console.error(
      "No fue posible emitir el cambio realtime del Board:",
      error
    );
  }
};

export const updateProjectBoard = async ({ quotationId, actorUserId, body = {} }) => {
  const id = requireUuid(quotationId,"quotationId");
  const actorId = requireUuid(actorUserId,"actorUserId");
  await ensureProject(id);

  const current = (await pool.query(
    `SELECT * FROM quotation_project_management WHERE quotation_id = $1`, [id]
  )).rows[0];

  const stage = body.stage === undefined ? current.stage : clean(body.stage).toUpperCase();
  const priority = body.priority === undefined ? current.priority : clean(body.priority).toUpperCase();
  if (!STAGES.has(stage)) throw serviceError("Etapa inválida");
  if (!PRIORITIES.has(priority)) throw serviceError("Prioridad inválida");

  const assignedTo = body.assigned_to === undefined
    ? current.assigned_to
    : body.assigned_to ? requireUuid(body.assigned_to,"assigned_to") : null;

  const channel = body.channel === undefined
    ? (clean(current.channel).toUpperCase() || null)
    : (clean(body.channel).toUpperCase() || null);

  if (channel && !CHANNELS.has(channel)) {
    throw serviceError("Canal comercial inválido", 400, "PROJECT_BOARD_INVALID_CHANNEL");
  }

  const nextAction = body.next_action === undefined ? current.next_action : (clean(body.next_action) || null);
  const nextActionAt = body.next_action_at === undefined ? current.next_action_at : (clean(body.next_action_at) || null);
  const lostReason = stage === "LOST" ? (clean(body.lost_reason ?? current.lost_reason) || null) : null;

  const isWon = stage === "WON";

  const result = await pool.query(
    `UPDATE quotation_project_management
     SET stage=$2, priority=$3, assigned_to=$4, channel=$5, next_action=$6, next_action_at=$7,
         lost_reason=$8,
         won_at=CASE WHEN $9::boolean THEN COALESCE(won_at,NOW()) ELSE NULL END,
         last_activity_at=NOW()
     WHERE quotation_id=$1 RETURNING *`,
    [id,stage,priority,assignedTo,channel,nextAction,nextActionAt,lostReason,isWon]
  );

  const changes = [];
  if (stage !== current.stage) changes.push(`Etapa: ${current.stage} → ${stage}`);
  if (priority !== current.priority) changes.push(`Prioridad: ${current.priority} → ${priority}`);
  if (String(assignedTo||"") !== String(current.assigned_to||"")) changes.push("Responsable actualizado");
  if (String(channel||"") !== String(current.channel||"")) {
    const previousChannel = CHANNEL_LABELS[clean(current.channel).toUpperCase()] || "Sin canal";
    const nextChannel = CHANNEL_LABELS[channel] || "Sin canal";
    changes.push(`Canal: ${previousChannel} → ${nextChannel}`);
  }
  if (nextAction !== current.next_action || String(nextActionAt||"") !== String(current.next_action_at||"")) changes.push("Próxima acción actualizada");

  if (changes.length) {
    await pool.query(
      `INSERT INTO quotation_project_events
       (quotation_id,event_type,title,description,actor_user_id,metadata)
       VALUES ($1,'PROJECT_UPDATED','Proyecto actualizado',$2,$3,$4::jsonb)`,
      [id,changes.join(" · "),actorId,JSON.stringify({stage,priority,channel})]
    );
  }

  if (stage !== current.stage) {
    await notifyStageChange({
      quotationId: id,
      actorUserId: actorId,
      previousStage: current.stage,
      nextStage: stage,
    });
  }

  return result.rows[0];
};

export const addProjectNote = async ({ quotationId, actorUserId, note }) => {
  const id=requireUuid(quotationId,"quotationId");
  const actor=requireUuid(actorUserId,"actorUserId");
  await ensureProject(id);
  const description=clean(note);
  if (!description) throw serviceError("La nota es obligatoria");
  const result=await pool.query(
    `INSERT INTO quotation_project_events
     (quotation_id,event_type,title,description,actor_user_id)
     VALUES ($1,'NOTE','Nota agregada',$2,$3) RETURNING *`,
    [id,description,actor]
  );
  await pool.query(`UPDATE quotation_project_management SET last_activity_at=NOW() WHERE quotation_id=$1`,[id]);
  return result.rows[0];
};

export const createProjectFollowup = async ({ quotationId, actorUserId, body = {} }) => {
  const id=requireUuid(quotationId,"quotationId");
  const actor=requireUuid(actorUserId,"actorUserId");
  await ensureProject(id);

  const title=clean(body.title);
  const type=clean(body.followup_type||"FOLLOW_UP").toUpperCase();
  const scheduledAt=clean(body.scheduled_at);
  if (!title) throw serviceError("El título del seguimiento es obligatorio");
  if (!FOLLOWUP_TYPES.has(type)) throw serviceError("Tipo de seguimiento inválido");
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) throw serviceError("Fecha de seguimiento inválida");

  const assigned=body.assigned_to ? requireUuid(body.assigned_to,"assigned_to") : actor;
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const result=await client.query(
      `INSERT INTO quotation_project_followups
       (quotation_id,title,description,followup_type,scheduled_at,end_at,assigned_to,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id,title,clean(body.description)||null,type,scheduledAt,clean(body.end_at)||null,assigned,actor]
    );
    await client.query(
      `INSERT INTO quotation_project_events
       (quotation_id,event_type,title,description,actor_user_id,metadata)
       VALUES ($1,'FOLLOWUP_CREATED','Seguimiento agendado',$2,$3,$4::jsonb)`,
      [id,title,actor,JSON.stringify({followup_id:result.rows[0].id,followup_type:type,scheduled_at:scheduledAt})]
    );
    await client.query(
      `UPDATE quotation_project_management
       SET next_action=$2,next_action_at=$3,last_activity_at=NOW()
       WHERE quotation_id=$1`, [id,title,scheduledAt]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
};

export const updateProjectFollowup = async ({ quotationId, followupId, actorUserId, body = {} }) => {
  const qid=requireUuid(quotationId,"quotationId");
  const fid=requireUuid(followupId,"followupId");
  const actor=requireUuid(actorUserId,"actorUserId");
  await ensureProject(qid);

  const currentResult=await pool.query(
    `SELECT * FROM quotation_project_followups WHERE id=$1 AND quotation_id=$2`, [fid,qid]
  );
  if (!currentResult.rowCount) throw serviceError("El seguimiento no existe",404);
  const current=currentResult.rows[0];
  const status=clean(body.status||current.status).toUpperCase();
  if (!["PENDING","COMPLETED","CANCELLED"].includes(status)) throw serviceError("Estado de seguimiento inválido");

  const isCompleted = status === "COMPLETED";

  const result=await pool.query(
    `UPDATE quotation_project_followups
     SET title=COALESCE($3,title),
         description=COALESCE($4,description),
         scheduled_at=COALESCE($5,scheduled_at),
         status=$6,
         completed_at=CASE WHEN $8::boolean THEN COALESCE(completed_at,NOW()) ELSE NULL END,
         completed_by=CASE WHEN $8::boolean THEN $7 ELSE NULL END
     WHERE id=$1 AND quotation_id=$2 RETURNING *`,
    [fid,qid,clean(body.title)||null,clean(body.description)||null,clean(body.scheduled_at)||null,status,actor,isCompleted]
  );

  if (status !== current.status) {
    await pool.query(
      `INSERT INTO quotation_project_events
       (quotation_id,event_type,title,description,actor_user_id,metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        qid,
        status==="COMPLETED" ? "FOLLOWUP_COMPLETED" : "FOLLOWUP_UPDATED",
        status==="COMPLETED" ? "Seguimiento completado" : "Seguimiento actualizado",
        result.rows[0].title,
        actor,
        JSON.stringify({followup_id:fid,status}),
      ]
    );
  }
  return result.rows[0];
};

export const getProjectCalendar = async ({ query = {} } = {}) => {
  const from=clean(query.from), to=clean(query.to);
  if (!from || !to) throw serviceError("from y to son obligatorios");
  const result=await pool.query(
    `SELECT 'FOLLOWUP'::text AS source,f.id,f.quotation_id,q.quote_number,q.project_name,
            f.followup_type AS event_type,f.title,f.description,f.scheduled_at AS event_at,
            f.end_at,f.status
     FROM quotation_project_followups f
     JOIN quotations q ON q.id=f.quotation_id
     WHERE q.quotation_type='PROJECT'
       AND f.scheduled_at >= $1::timestamptz
       AND f.scheduled_at < $2::timestamptz
       AND f.status <> 'CANCELLED'
     UNION ALL
     SELECT 'EXPIRY'::text,q.id,q.id,q.quote_number,q.project_name,
            'QUOTE_EXPIRY','Vence cotización',NULL::text,q.valid_until::timestamp,
            NULL::timestamptz,q.status
     FROM quotations q
     WHERE q.quotation_type='PROJECT'
       AND q.valid_until >= $1::date
       AND q.valid_until < $2::date
     ORDER BY event_at ASC`, [from,to]
  );
  return { items: result.rows };
};

export const listProjectBoardUsers = async () => {
  const result=await pool.query(
    `SELECT u.id,u.first_name,u.last_name,u.email,r.name AS role
     FROM users u
     LEFT JOIN roles r ON r.id=u.role_id
     WHERE r.name IN ('ADMIN','VENDEDOR')
     ORDER BY u.first_name,u.last_name,u.email`
  );
  return { users: result.rows };
};
