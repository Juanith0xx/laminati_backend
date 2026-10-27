const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error =
    new Error(message);

  error.status =
    status;

  error.code =
    code;

  return error;
};

const cleanText = (
  value
) =>
  String(
    value ?? ""
  ).trim();

const isValidEmail = (
  value
) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    cleanText(
      value
    )
  );

/* =========================================
   COTIZACIÓN PROJECT · GERENCIA ITALIA
   - Un evento por cotización + destinatario.
   - No contiene datos personales del cliente.
   - Guarda snapshot USD para que el correo sea histórico.
========================================= */
const PROJECT_QUOTATION_ITALY_EVENT =
  "PROJECT_QUOTATION_CREATED_ITALY";

const roundUsd = (value) => {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(
    (number + Number.EPSILON) *
      10000
  ) / 10000;
};

export const ensureProjectQuotationItalyEmailArtifacts =
  async ({
    client,
    quotationId,
  }) => {
    if (
      !client ||
      typeof client.query !==
        "function"
    ) {
      throw createServiceError(
        "Se requiere un cliente PostgreSQL transaccional para preparar la notificación de Gerencia Italia",
        500,
        "EMAIL_OUTBOX_TRANSACTION_CLIENT_REQUIRED"
      );
    }

    const normalizedQuotationId =
      cleanText(
        quotationId
      );

    if (
      !normalizedQuotationId
    ) {
      throw createServiceError(
        "quotationId es obligatorio",
        400,
        "EMAIL_OUTBOX_QUOTATION_ID_REQUIRED"
      );
    }

    const quotationResult =
      await client.query(
        `
          SELECT
            q.id,
            q.quote_number,
            q.quotation_type,
            q.project_name,
            q.status,
            q.created_at,
            q.valid_until,
            q.visible_to_italy
          FROM quotations q
          WHERE q.id = $1::uuid
          LIMIT 1
        `,
        [
          normalizedQuotationId,
        ]
      );

    if (
      quotationResult.rowCount ===
      0
    ) {
      throw createServiceError(
        "La cotización de proyecto no existe",
        404,
        "EMAIL_OUTBOX_PROJECT_QUOTATION_NOT_FOUND"
      );
    }

    const quotation =
      quotationResult.rows[0];

    if (
      cleanText(
        quotation
          .quotation_type
      ).toUpperCase() !==
      "PROJECT"
    ) {
      return {
        skipped: true,
        reason:
          "QUOTATION_NOT_PROJECT",
        queued: 0,
      };
    }

    if (
      quotation
        .visible_to_italy !==
      true
    ) {
      return {
        skipped: true,
        reason:
          "NOT_VISIBLE_TO_ITALY",
        queued: 0,
      };
    }

    const linesResult =
      await client.query(
        `
          SELECT
            qpl.id,
            qpl.line_type,
            qpl.description,
            qpl.code,
            qpl.brand,
            qpl.collection,
            qpl.finish,
            qpl.thickness_mm,
            qpl.quantity,
            qpl.unit,
            qpl.format_label,
            qpl.width_cm,
            qpl.height_cm,
            qpl.italy_price_usd,
            qpl.italy_price_source,
            qpl.sort_order
          FROM quotation_project_lines qpl
          WHERE qpl.quotation_id = $1::uuid
            AND (
              (
                qpl.line_type = 'PRODUCT'
                AND UPPER(
                  BTRIM(
                    COALESCE(
                      qpl.brand,
                      ''
                    )
                  )
                ) = 'ABET LAMINATI'
              )
              OR
              qpl.line_type IN (
                'SERVICE',
                'OTHER'
              )
            )
          ORDER BY
            qpl.sort_order ASC,
            qpl.created_at ASC,
            qpl.id ASC
        `,
        [
          normalizedQuotationId,
        ]
      );

    const lines =
      linesResult.rows.map(
        (line) => {
          const quantity =
            Number(
              line.quantity
            );

          const unitPriceUsd =
            line
              .italy_price_usd ===
            null
              ? null
              : Number(
                  line
                    .italy_price_usd
                );

          const totalUsd =
            Number.isFinite(
              quantity
            ) &&
            Number.isFinite(
              unitPriceUsd
            )
              ? roundUsd(
                  quantity *
                    unitPriceUsd
                )
              : null;

          return {
            project_line_id:
              line.id,

            line_type:
              line.line_type,

            description:
              line.description ||
              null,

            code:
              line.code ||
              null,

            brand:
              line.brand ||
              null,

            collection:
              line.collection ||
              null,

            finish:
              line.finish ||
              null,

            thickness_mm:
              line
                .thickness_mm ===
              null
                ? null
                : Number(
                    line
                      .thickness_mm
                  ),

            quantity:
              Number.isFinite(
                quantity
              )
                ? quantity
                : 0,

            unit:
              line.unit ||
              null,

            format_label:
              line
                .format_label ||
              null,

            width_cm:
              line.width_cm ===
              null
                ? null
                : Number(
                    line.width_cm
                  ),

            height_cm:
              line.height_cm ===
              null
                ? null
                : Number(
                    line.height_cm
                  ),

            italy_unit_price_usd:
              Number.isFinite(
                unitPriceUsd
              )
                ? unitPriceUsd
                : null,

            italy_total_usd:
              totalUsd,

            italy_price_source:
              line
                .italy_price_source ||
              null,
          };
        }
      );

    let productTotalUsd =
      0;

    let freightTotalUsd =
      0;

    let unpricedItems =
      0;

    for (
      const line
      of lines
    ) {
      if (
        line
          .italy_total_usd ===
        null
      ) {
        unpricedItems +=
          1;

        continue;
      }

      if (
        line.line_type ===
        "PRODUCT"
      ) {
        productTotalUsd =
          roundUsd(
            productTotalUsd +
              line
                .italy_total_usd
          );
      } else {
        freightTotalUsd =
          roundUsd(
            freightTotalUsd +
              line
                .italy_total_usd
          );
      }
    }

    const totalValueUsd =
      roundUsd(
        productTotalUsd +
          freightTotalUsd
      );

    const recipientsResult =
      await client.query(
        `
          SELECT DISTINCT
            LOWER(
              BTRIM(
                u.email
              )
            ) AS email
          FROM users u
          INNER JOIN roles r
            ON r.id =
              u.role_id
          WHERE u.is_active =
              TRUE
            AND u.deleted_at
              IS NULL
            AND NULLIF(
              BTRIM(
                u.email
              ),
              ''
            ) IS NOT NULL
            AND UPPER(
              BTRIM(
                r.name
              )
            ) IN (
              'GERENCIA_ITALIA',
              'GERENCIA'
            )
          ORDER BY
            email ASC
        `
      );

    const recipientEmails =
      recipientsResult.rows
        .map(
          (row) =>
            cleanText(
              row.email
            ).toLowerCase()
        )
        .filter(
          (email) =>
            isValidEmail(
              email
            )
        );

    if (
      recipientEmails.length ===
      0
    ) {
      return {
        skipped: true,
        reason:
          "NO_ACTIVE_GERENCIA_RECIPIENTS",
        queued: 0,
      };
    }

    const payload = {
      schema:
        "LAMINATIWORD_PROJECT_QUOTATION_ITALY_V1",

      quotation_id:
        quotation.id,

      quote_number:
        quotation
          .quote_number,

      project_name:
        quotation
          .project_name,

      status:
        quotation.status,

      created_at:
        quotation
          .created_at,

      valid_until:
        quotation
          .valid_until,

      currency:
        "USD",

      product_total_usd:
        productTotalUsd,

      freight_total_usd:
        freightTotalUsd,

      total_value_usd:
        totalValueUsd,

      unpriced_items:
        unpricedItems,

      lines,
    };

    const events = [];

    for (
      const recipientEmail
      of recipientEmails
    ) {
      const insertResult =
        await client.query(
          `
            INSERT INTO email_outbox (
              order_id,
              quotation_id,
              tax_document_id,
              pickup_id,
              event_type,
              recipient_email,
              status,
              attempts,
              max_attempts,
              scheduled_at,
              payload
            )
            VALUES (
              NULL,
              $1::uuid,
              NULL,
              NULL,
              $2,
              $3,
              'PENDING',
              0,
              5,
              NOW(),
              $4::jsonb
            )
            ON CONFLICT
            DO NOTHING
            RETURNING
              id,
              quotation_id,
              event_type,
              recipient_email,
              status,
              attempts,
              max_attempts,
              scheduled_at,
              created_at
          `,
          [
            normalizedQuotationId,
            PROJECT_QUOTATION_ITALY_EVENT,
            recipientEmail,
            JSON.stringify(
              payload
            ),
          ]
        );

      events.push({
        recipient_email:
          recipientEmail,

        created:
          insertResult
            .rowCount ===
          1,

        outbox:
          insertResult
            .rows[0] ||
          null,
      });
    }

    return {
      skipped: false,
      recipients:
        recipientEmails.length,
      queued:
        events.filter(
          (event) =>
            event.created
        ).length,
      already_queued:
        events.filter(
          (event) =>
            !event.created
        ).length,
      events,
    };
  };

