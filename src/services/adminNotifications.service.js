import pool from "../config/database.js";

const normalizeText = (
  value,
  maxLength
) =>
  String(value ?? "")
    .trim()
    .slice(
      0,
      maxLength
    );

const normalizePositiveInteger = (
  value,
  fallback,
  max
) => {
  const parsed =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed < 1
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    max
  );
};

const normalizeData = (
  value
) => {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value;
  }

  return {};
};

export const createAdminNotification =
  async (
    notification = {}
  ) => {
    const type =
      normalizeText(
        notification.type,
        50
      ).toUpperCase();

    const title =
      normalizeText(
        notification.title,
        160
      );

    const message =
      normalizeText(
        notification.message,
        500
      );

    const entityId =
      normalizeText(
        notification.entity_id,
        120
      ) || null;

    const href =
      normalizeText(
        notification.href,
        500
      ) || null;

    const data =
      normalizeData(
        notification.data
      );

    if (
      !type ||
      !title ||
      !message
    ) {
      return null;
    }

    const result =
      await pool.query(
        `
          INSERT INTO public.admin_notifications (
            type,
            title,
            message,
            entity_id,
            href,
            data,
            created_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            COALESCE(
              $7::timestamptz,
              NOW()
            )
          )
          RETURNING
            id,
            type,
            title,
            message,
            entity_id,
            href,
            data,
            created_at
        `,
        [
          type,
          title,
          message,
          entityId,
          href,
          JSON.stringify(data),
          notification.created_at ||
            null,
        ]
      );

    return {
      ...result.rows[0],
      is_read: false,
      read_at: null,
    };
  };

export const listAdminNotifications =
  async ({
    userId,
    page = 1,
    limit = 15,
    search = "",
    type = "ALL",
    readStatus = "ALL",
  }) => {
    const safePage =
      normalizePositiveInteger(
        page,
        1,
        100000
      );

    const safeLimit =
      normalizePositiveInteger(
        limit,
        15,
        50
      );

    const safeSearch =
      normalizeText(
        search,
        120
      ).toLowerCase();

    const safeType =
      normalizeText(
        type,
        50
      ).toUpperCase();

    const safeReadStatus =
      normalizeText(
        readStatus,
        20
      ).toUpperCase();

    const allowedTypes =
      new Set([
        "ALL",
        "CONTACT_NEW",
        "ORDER_NEW",
        "QUOTATION_VIEWED",
      ]);

    const allowedReadStatuses =
      new Set([
        "ALL",
        "UNREAD",
        "READ",
      ]);

    const resolvedType =
      allowedTypes.has(
        safeType
      )
        ? safeType
        : "ALL";

    const resolvedReadStatus =
      allowedReadStatuses.has(
        safeReadStatus
      )
        ? safeReadStatus
        : "ALL";

    const offset =
      (safePage - 1) *
      safeLimit;

    const values = [
      userId,
    ];

    const where = [
      "1 = 1",
    ];

    if (
      safeSearch
    ) {
      values.push(
        `%${safeSearch}%`
      );

      where.push(
        `
          LOWER(
            CONCAT_WS(
              ' ',
              n.title,
              n.message,
              COALESCE(
                n.entity_id,
                ''
              )
            )
          ) LIKE $${values.length}
        `
      );
    }

    if (
      resolvedType !==
      "ALL"
    ) {
      values.push(
        resolvedType
      );

      where.push(
        `n.type = $${values.length}`
      );
    }

    if (
      resolvedReadStatus ===
      "UNREAD"
    ) {
      where.push(
        "r.notification_id IS NULL"
      );
    }

    if (
      resolvedReadStatus ===
      "READ"
    ) {
      where.push(
        "r.notification_id IS NOT NULL"
      );
    }

    const whereSql =
      where.join(
        "\nAND "
      );

    const listValues = [
      ...values,
      safeLimit,
      offset,
    ];

    const limitParam =
      listValues.length -
      1;

    const offsetParam =
      listValues.length;

    const [
      listResult,
      filteredCountResult,
      summaryResult,
    ] =
      await Promise.all([
        pool.query(
          `
            SELECT
              n.id,
              n.type,
              n.title,
              n.message,
              n.entity_id,
              n.href,
              n.data,
              n.created_at,

              CASE
                WHEN r.notification_id IS NULL
                  THEN FALSE
                ELSE TRUE
              END AS is_read,

              r.read_at

            FROM public.admin_notifications n

            LEFT JOIN public.admin_notification_reads r
              ON r.notification_id = n.id
             AND r.user_id = $1::uuid

            WHERE
              ${whereSql}

            ORDER BY
              n.created_at DESC,
              n.id DESC

            LIMIT $${limitParam}
            OFFSET $${offsetParam}
          `,
          listValues
        ),

        pool.query(
          `
            SELECT
              COUNT(*)::int AS total

            FROM public.admin_notifications n

            LEFT JOIN public.admin_notification_reads r
              ON r.notification_id = n.id
             AND r.user_id = $1::uuid

            WHERE
              ${whereSql}
          `,
          values
        ),

        pool.query(
          `
            SELECT
              COUNT(*)::int AS total_count,

              COUNT(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM public.admin_notification_reads r
                  WHERE
                    r.notification_id = n.id
                    AND r.user_id = $1::uuid
                )
              )::int AS unread_count

            FROM public.admin_notifications n
          `,
          [
            userId,
          ]
        ),
      ]);

    const filteredTotal =
      Number(
        filteredCountResult
          .rows[0]
          ?.total || 0
      );

    const totalCount =
      Number(
        summaryResult
          .rows[0]
          ?.total_count || 0
      );

    const unreadCount =
      Number(
        summaryResult
          .rows[0]
          ?.unread_count || 0
      );

    return {
      notifications:
        listResult.rows,

      /*
       * Se conserva por compatibilidad con
       * Navbar / centro rápido existente.
       */
      unread_count:
        unreadCount,

      summary: {
        total_count:
          totalCount,

        unread_count:
          unreadCount,

        read_count:
          Math.max(
            0,
            totalCount -
              unreadCount
          ),
      },

      filters: {
        search:
          safeSearch,

        type:
          resolvedType,

        read_status:
          resolvedReadStatus,
      },

      pagination: {
        page:
          safePage,

        limit:
          safeLimit,

        total:
          filteredTotal,

        total_pages:
          filteredTotal === 0
            ? 0
            : Math.ceil(
                filteredTotal /
                safeLimit
              ),

        has_next_page:
          safePage *
            safeLimit <
          filteredTotal,

        has_previous_page:
          safePage >
          1,
      },
    };
  };

export const markAdminNotificationRead =
  async ({
    notificationId,
    userId,
  }) => {
    const notificationResult =
      await pool.query(
        `
          SELECT
            id
          FROM public.admin_notifications
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [notificationId]
      );

    if (
      notificationResult.rowCount ===
      0
    ) {
      const error =
        new Error(
          "La notificación no existe"
        );

      error.status =
        404;

      error.code =
        "ADMIN_NOTIFICATION_NOT_FOUND";

      throw error;
    }

    const result =
      await pool.query(
        `
          INSERT INTO public.admin_notification_reads (
            notification_id,
            user_id,
            read_at
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            NOW()
          )
          ON CONFLICT (
            notification_id,
            user_id
          )
          DO UPDATE SET
            read_at =
              admin_notification_reads.read_at
          RETURNING
            notification_id,
            user_id,
            read_at
        `,
        [
          notificationId,
          userId,
        ]
      );

    return result.rows[0];
  };

export const markAllAdminNotificationsRead =
  async ({
    userId,
  }) => {
    const result =
      await pool.query(
        `
          INSERT INTO public.admin_notification_reads (
            notification_id,
            user_id,
            read_at
          )
          SELECT
            n.id,
            $1::uuid,
            NOW()
          FROM public.admin_notifications n
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.admin_notification_reads r
            WHERE
              r.notification_id = n.id
              AND r.user_id = $1::uuid
          )
          ON CONFLICT (
            notification_id,
            user_id
          )
          DO NOTHING
          RETURNING
            notification_id
        `,
        [userId]
      );

    return {
      marked_count:
        result.rowCount,
    };
  };
