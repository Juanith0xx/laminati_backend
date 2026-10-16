import pool from "../config/database.js";

import {
  getProjectImageSignedUrl,
} from "./projectImageStorage.service.js";


function createServiceError(
  message,
  status = 400,
  code = "PROJECT_ERROR"
) {
  const error =
    new Error(
      message
    );

  error.status =
    status;

  error.code =
    code;

  return error;
}


function slugify(
  value
) {
  return String(
    value || ""
  )
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .trim()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(
      0,
      200
    );
}


function normalizeNullable(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return value;
  }

  const normalized =
    String(
      value
    ).trim();

  return normalized ||
    null;
}


async function getUniqueSlug(
  client,
  requestedSlug,
  title,
  excludeProjectId =
    null
) {
  const base =
    slugify(
      requestedSlug ||
        title
    ) ||
    "proyecto";

  let candidate =
    base;

  let suffix =
    2;

  while (true) {
    const params = [
      candidate,
    ];

    let query = `
      SELECT id
      FROM projects
      WHERE slug = $1
    `;

    if (
      excludeProjectId
    ) {
      params.push(
        excludeProjectId
      );

      query += `
        AND id <> $2
      `;
    }

    query += `
      LIMIT 1
    `;

    const result =
      await client.query(
        query,
        params
      );

    if (
      result.rowCount ===
      0
    ) {
      return candidate;
    }

    candidate =
      `${base}-${suffix}`;

    suffix += 1;
  }
}


async function requireProject(
  client,
  projectId
) {
  const result =
    await client.query(
      `
        SELECT *
        FROM projects
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [
        projectId,
      ]
    );

  if (
    result.rowCount ===
    0
  ) {
    throw createServiceError(
      "Proyecto no encontrado",
      404,
      "PROJECT_NOT_FOUND"
    );
  }

  return result.rows[0];
}


async function requireProduct(
  client,
  productId
) {
  const result =
    await client.query(
      `
        SELECT
          id,
          sku,
          name,
          slug,
          internal_code
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [
        productId,
      ]
    );

  if (
    result.rowCount ===
    0
  ) {
    throw createServiceError(
      "Producto no encontrado",
      404,
      "PRODUCT_NOT_FOUND"
    );
  }

  return result.rows[0];
}


async function resolveProjectImage(
  image
) {
  if (!image) {
    return null;
  }

  if (
    image.storage_provider !==
    "RAILWAY"
  ) {
    const externalUrl =
      image.image_url ||
      image.instagram_media_url ||
      null;

    return {
      ...image,
      image_url:
        externalUrl,
      urls: {
        thumbnail:
          externalUrl,
        card:
          externalUrl,
        detail:
          externalUrl,
      },
    };
  }

  let urls = {
    thumbnail: null,
    card: null,
    detail: null,
  };

  try {
    const [
      thumbnail,
      card,
      detail,
    ] = await Promise.all([
      getProjectImageSignedUrl(
        image.thumbnail_key
      ),
      getProjectImageSignedUrl(
        image.card_key
      ),
      getProjectImageSignedUrl(
        image.detail_key
      ),
    ]);

    urls = {
      thumbnail,
      card,
      detail,
    };
  } catch (
    error
  ) {
    console.error(
      "Error generando URLs firmadas para proyecto:",
      {
        image_id:
          image.id,
        project_id:
          image.project_id,
        error,
      }
    );
  }

  return {
    ...image,
    image_url:
      image.image_url ||
      urls.detail ||
      urls.card ||
      urls.thumbnail ||
      null,
    urls,
  };
}


async function hydrateProjectCoverUrls(
  projects
) {
  if (
    !Array.isArray(
      projects
    ) ||
    projects.length === 0
  ) {
    return projects || [];
  }

  const projectIds =
    projects.map(
      (
        project
      ) =>
        project.id
    );

  const imagesResult =
    await pool.query(
      `
        SELECT DISTINCT ON (
          project_id
        )
          id,
          project_id,
          image_url,
          instagram_media_url,
          storage_provider,
          thumbnail_key,
          card_key,
          detail_key,
          is_primary,
          sort_order,
          created_at
        FROM project_images
        WHERE project_id =
          ANY($1::uuid[])
        ORDER BY
          project_id ASC,
          is_primary DESC,
          sort_order ASC,
          created_at ASC
      `,
      [
        projectIds,
      ]
    );

  const resolvedImages =
    await Promise.all(
      imagesResult.rows.map(
        resolveProjectImage
      )
    );

  const imageMap =
    new Map(
      resolvedImages.map(
        (
          image
        ) => [
          image.project_id,
          image,
        ]
      )
    );

  return projects.map(
    (
      project
    ) => {
      const image =
        imageMap.get(
          project.id
        );

      return {
        ...project,
        cover_image_url:
          image?.urls?.card ||
          image?.image_url ||
          project.cover_image_url ||
          null,
      };
    }
  );
}


async function syncProjectCover(
  client,
  projectId
) {
  const images =
    await client.query(
      `
        SELECT
          id,
          image_url,
          storage_provider,
          thumbnail_key,
          card_key,
          detail_key,
          is_primary,
          sort_order,
          created_at
        FROM project_images
        WHERE project_id = $1
        ORDER BY
          is_primary DESC,
          sort_order ASC,
          created_at ASC
      `,
      [
        projectId,
      ]
    );

  if (
    images.rowCount ===
    0
  ) {
    await client.query(
      `
        UPDATE projects
        SET cover_image_url = NULL
        WHERE id = $1
      `,
      [
        projectId,
      ]
    );

    return null;
  }

  let primary =
    images.rows.find(
      (
        image
      ) =>
        image.is_primary
    );

  if (!primary) {
    primary =
      images.rows[0];

    await client.query(
      `
        UPDATE project_images
        SET is_primary = (
          id = $2
        )
        WHERE project_id = $1
      `,
      [
        projectId,
        primary.id,
      ]
    );
  }

  const persistentCoverUrl =
    primary.storage_provider ===
    "RAILWAY"
      ? null
      : primary.image_url ||
        null;

  await client.query(
    `
      UPDATE projects
      SET cover_image_url = $2
      WHERE id = $1
    `,
    [
      projectId,
      persistentCoverUrl,
    ]
  );

  return persistentCoverUrl;
}


export async function listAdminProjects(
  filters = {}
) {
  const {
    search,
    status,
    category,
    is_active,
    is_featured,
    include_deleted = false,
    limit = 50,
    offset = 0,
  } =
    filters;

  const params = [];

  const conditions = [
    "1 = 1",
  ];

  if (
    !include_deleted
  ) {
    conditions.push(
      "p.deleted_at IS NULL"
    );
  }

  if (
    search
  ) {
    params.push(
      `%${search}%`
    );

    conditions.push(
      `(p.title ILIKE $${params.length}
        OR p.slug ILIKE $${params.length}
        OR p.location ILIKE $${params.length})`
    );
  }

  if (
    status
  ) {
    params.push(
      status
    );

    conditions.push(
      `p.status = $${params.length}`
    );
  }

  if (
    category
  ) {
    params.push(
      category.toLowerCase()
    );

    conditions.push(
      `LOWER(p.category) = $${params.length}`
    );
  }

  if (
    typeof is_active ===
    "boolean"
  ) {
    params.push(
      is_active
    );

    conditions.push(
      `p.is_active = $${params.length}`
    );
  }

  if (
    typeof is_featured ===
    "boolean"
  ) {
    params.push(
      is_featured
    );

    conditions.push(
      `p.is_featured = $${params.length}`
    );
  }

  params.push(
    limit
  );

  const limitParam =
    params.length;

  params.push(
    offset
  );

  const offsetParam =
    params.length;

  const result =
    await pool.query(
      `
        SELECT
          p.*,

          (
            SELECT COUNT(*)::int
            FROM project_images pi
            WHERE pi.project_id = p.id
          ) AS images_count,

          (
            SELECT COUNT(*)::int
            FROM project_products pp
            WHERE pp.project_id = p.id
          ) AS products_count,

          COUNT(*) OVER()::int
            AS total_count

        FROM projects p

        WHERE
          ${conditions.join(
            "\n AND "
          )}

        ORDER BY
          p.is_featured DESC,
          p.sort_order ASC,
          p.updated_at DESC

        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      params
    );

  const total =
    result.rows[0]
      ?.total_count ||
    0;

  const projects =
    result.rows.map(
      (
        row
      ) => {
        const {
          total_count,
          ...project
        } =
          row;

        return project;
      }
    );

  const projectsWithCovers =
    await hydrateProjectCoverUrls(
      projects
    );

  return {
    projects:
      projectsWithCovers,
    total,
    limit,
    offset,
  };
}


export async function getAdminProjectById(
  projectId
) {
  const projectResult =
    await pool.query(
      `
        SELECT *
        FROM projects
        WHERE id = $1
        LIMIT 1
      `,
      [
        projectId,
      ]
    );

  if (
    projectResult.rowCount ===
    0
  ) {
    throw createServiceError(
      "Proyecto no encontrado",
      404,
      "PROJECT_NOT_FOUND"
    );
  }

  const [
    imagesResult,
    productsResult,
  ] =
    await Promise.all([
      pool.query(
        `
          SELECT *
          FROM project_images
          WHERE project_id = $1
          ORDER BY
            is_primary DESC,
            sort_order ASC,
            created_at ASC
        `,
        [
          projectId,
        ]
      ),

      pool.query(
        `
          SELECT
            pp.id,
            pp.product_id,
            pp.application_note,
            pp.sort_order,
            pp.created_at,
            pp.updated_at,

            p.sku,
            p.internal_code,
            p.name,
            p.slug

          FROM project_products pp

          JOIN products p
            ON p.id = pp.product_id

          WHERE pp.project_id = $1

          ORDER BY
            pp.sort_order ASC,
            pp.created_at ASC
        `,
        [
          projectId,
        ]
      ),
    ]);

  const resolvedImages =
    await Promise.all(
      imagesResult.rows.map(
        resolveProjectImage
      )
    );

  const primaryImage =
    resolvedImages.find(
      (
        image
      ) =>
        image.is_primary
    ) ||
    resolvedImages[0] ||
    null;

  return {
    ...projectResult.rows[0],
    cover_image_url:
      primaryImage?.urls?.card ||
      primaryImage?.image_url ||
      projectResult.rows[0]
        .cover_image_url ||
      null,
    images:
      resolvedImages,
    products:
      productsResult.rows,
  };
}


export async function createProject(
  data,
  actorUserId
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const slug =
      await getUniqueSlug(
        client,
        data.slug,
        data.title
      );

    const result =
      await client.query(
        `
          INSERT INTO projects (
            title,
            slug,
            category,
            location,
            project_year,
            short_description,
            description,
            cover_image_url,
            is_featured,
            is_active,
            sort_order,
            meta_title,
            meta_description,
            created_by,
            updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $14
          )
          RETURNING *
        `,
        [
          data.title,
          slug,
          data.category,
          normalizeNullable(
            data.location
          ),
          data.project_year ??
            null,
          normalizeNullable(
            data.short_description
          ),
          normalizeNullable(
            data.description
          ),
          normalizeNullable(
            data.cover_image_url
          ),
          data.is_featured ??
            false,
          data.is_active ??
            true,
          data.sort_order ??
            0,
          normalizeNullable(
            data.meta_title
          ),
          normalizeNullable(
            data.meta_description
          ),
          actorUserId,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function updateProject(
  projectId,
  data,
  actorUserId
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const normalized =
      {
        ...data,
      };

    if (
      data.slug !==
      undefined
    ) {
      normalized.slug =
        await getUniqueSlug(
          client,
          data.slug,
          data.title ||
            "proyecto",
          projectId
        );
    }

    const allowedFields = [
      "title",
      "slug",
      "category",
      "location",
      "project_year",
      "short_description",
      "description",
      "cover_image_url",
      "is_featured",
      "is_active",
      "sort_order",
      "meta_title",
      "meta_description",
    ];

    const nullableFields =
      new Set([
        "location",
        "short_description",
        "description",
        "cover_image_url",
        "meta_title",
        "meta_description",
      ]);

    const values = [];

    const sets = [];

    for (
      const field
      of allowedFields
    ) {
      if (
        normalized[field] ===
        undefined
      ) {
        continue;
      }

      let value =
        normalized[field];

      if (
        nullableFields.has(
          field
        )
      ) {
        value =
          normalizeNullable(
            value
          );
      }

      values.push(
        value
      );

      sets.push(
        `${field} = $${values.length}`
      );
    }

    if (
      sets.length ===
      0
    ) {
      throw createServiceError(
        "No hay campos válidos para actualizar",
        400,
        "PROJECT_UPDATE_EMPTY"
      );
    }

    values.push(
      actorUserId
    );

    sets.push(
      `updated_by = $${values.length}`
    );

    values.push(
      projectId
    );

    const result =
      await client.query(
        `
          UPDATE projects
          SET
            ${sets.join(
              ",\n"
            )}
          WHERE id = $${values.length}
            AND deleted_at IS NULL
          RETURNING *
        `,
        values
      );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function setProjectStatus(
  projectId,
  statusData,
  actorUserId
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    let isActive =
      statusData.is_active;

    if (
      statusData.status ===
      "ARCHIVED"
    ) {
      isActive =
        false;
    }

    const result =
      await client.query(
        `
          UPDATE projects
          SET
            status =
              $2::varchar,

            is_active =
              COALESCE(
                $3::boolean,
                is_active
              ),

            published_at =
              CASE
                WHEN
                  $2::varchar =
                  'PUBLISHED'
                THEN
                  COALESCE(
                    published_at,
                    NOW()
                  )
                ELSE
                  published_at
              END,

            updated_by =
              $4::uuid

          WHERE
            id =
              $1::uuid
            AND deleted_at
              IS NULL

          RETURNING *
        `,
        [
          projectId,
          statusData.status,
          isActive ??
            null,
          actorUserId,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function archiveProject(
  projectId,
  actorUserId
) {
  const result =
    await pool.query(
      `
        UPDATE projects
        SET
          status = 'ARCHIVED',
          is_active = FALSE,
          deleted_at = NOW(),
          updated_by = $2
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING *
      `,
      [
        projectId,
        actorUserId,
      ]
    );

  if (
    result.rowCount ===
    0
  ) {
    throw createServiceError(
      "Proyecto no encontrado",
      404,
      "PROJECT_NOT_FOUND"
    );
  }

  return result.rows[0];
}


export async function deleteProjectPermanently(
  projectId
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const projectResult =
      await client.query(
        `
          SELECT
            id,
            title,
            slug
          FROM projects
          WHERE id = $1::uuid
          LIMIT 1
          FOR UPDATE
        `,
        [
          projectId,
        ]
      );

    if (
      projectResult.rowCount ===
      0
    ) {
      throw createServiceError(
        "Proyecto no encontrado",
        404,
        "PROJECT_NOT_FOUND"
      );
    }

    const imagesResult =
      await client.query(
        `
          SELECT
            thumbnail_key,
            card_key,
            detail_key
          FROM project_images
          WHERE project_id = $1::uuid
        `,
        [
          projectId,
        ]
      );

    const storageKeys =
      imagesResult.rows.flatMap(
        (
          image
        ) => [
          image.thumbnail_key,
          image.card_key,
          image.detail_key,
        ]
      )
        .filter(
          Boolean
        );

    const deleteResult =
      await client.query(
        `
          DELETE FROM projects
          WHERE id = $1::uuid
          RETURNING
            id,
            title,
            slug
        `,
        [
          projectId,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return {
      project:
        deleteResult.rows[0],
      storageKeys,
    };
  } catch (
    error
  ) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function getProjectStorageIdentity(
  projectId
) {
  const result =
    await pool.query(
      `
        SELECT
          id,
          title,
          slug
        FROM projects
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [
        projectId,
      ]
    );

  if (
    result.rowCount ===
    0
  ) {
    throw createServiceError(
      "Proyecto no encontrado",
      404,
      "PROJECT_NOT_FOUND"
    );
  }

  return result.rows[0];
}


export async function createStoredProjectImage(
  projectId,
  data
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const countResult =
      await client.query(
        `
          SELECT COUNT(*)::int
            AS count
          FROM project_images
          WHERE project_id = $1
        `,
        [
          projectId,
        ]
      );

    const shouldBePrimary =
      data.is_primary ===
        true ||
      countResult.rows[0]
        .count === 0;

    if (
      shouldBePrimary
    ) {
      await client.query(
        `
          UPDATE project_images
          SET is_primary = FALSE
          WHERE project_id = $1
        `,
        [
          projectId,
        ]
      );
    }

    const result =
      await client.query(
        `
          INSERT INTO project_images (
            id,
            project_id,
            image_source,
            storage_provider,
            thumbnail_key,
            card_key,
            detail_key,
            original_filename,
            image_url,
            alt_text,
            caption,
            is_primary,
            sort_order
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            'MANUAL',
            'RAILWAY',
            $3,
            $4,
            $5,
            $6,
            NULL,
            $7,
            $8,
            $9,
            $10
          )
          RETURNING *
        `,
        [
          data.id,
          projectId,
          data.thumbnail_key,
          data.card_key,
          data.detail_key,
          data.original_filename,
          normalizeNullable(
            data.alt_text
          ),
          normalizeNullable(
            data.caption
          ),
          shouldBePrimary,
          data.sort_order ??
            0,
        ]
      );

    await syncProjectCover(
      client,
      projectId
    );

    await client.query(
      "COMMIT"
    );

    return resolveProjectImage(
      result.rows[0]
    );
  } catch (
    error
  ) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function createProjectImage(
  projectId,
  data
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const countResult =
      await client.query(
        `
          SELECT COUNT(*)::int
            AS count
          FROM project_images
          WHERE project_id = $1
        `,
        [
          projectId,
        ]
      );

    const shouldBePrimary =
      data.is_primary ===
        true ||
      countResult.rows[0]
        .count === 0;

    if (
      shouldBePrimary
    ) {
      await client.query(
        `
          UPDATE project_images
          SET is_primary = FALSE
          WHERE project_id = $1
        `,
        [
          projectId,
        ]
      );
    }

    const result =
      await client.query(
        `
          INSERT INTO project_images (
            project_id,
            image_url,
            alt_text,
            caption,
            sort_order,
            is_primary
          )
          VALUES (
            $1, $2, $3, $4, $5, $6
          )
          RETURNING *
        `,
        [
          projectId,
          data.image_url,
          normalizeNullable(
            data.alt_text
          ),
          normalizeNullable(
            data.caption
          ),
          data.sort_order ??
            0,
          shouldBePrimary,
        ]
      );

    await syncProjectCover(
      client,
      projectId
    );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function updateProjectImage(
  projectId,
  imageId,
  data
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const currentResult =
      await client.query(
        `
          SELECT *
          FROM project_images
          WHERE id = $1
            AND project_id = $2
          LIMIT 1
        `,
        [
          imageId,
          projectId,
        ]
      );

    if (
      currentResult.rowCount ===
      0
    ) {
      throw createServiceError(
        "Imagen no encontrada",
        404,
        "PROJECT_IMAGE_NOT_FOUND"
      );
    }

    if (
      data.is_primary ===
      true
    ) {
      await client.query(
        `
          UPDATE project_images
          SET is_primary = FALSE
          WHERE project_id = $1
            AND id <> $2
        `,
        [
          projectId,
          imageId,
        ]
      );
    }

    const allowedFields = [
      "image_url",
      "alt_text",
      "caption",
      "sort_order",
      "is_primary",
    ];

    const nullableFields =
      new Set([
        "alt_text",
        "caption",
      ]);

    const values = [];

    const sets = [];

    for (
      const field
      of allowedFields
    ) {
      if (
        data[field] ===
        undefined
      ) {
        continue;
      }

      let value =
        data[field];

      if (
        nullableFields.has(
          field
        )
      ) {
        value =
          normalizeNullable(
            value
          );
      }

      values.push(
        value
      );

      sets.push(
        `${field} = $${values.length}`
      );
    }

    values.push(
      imageId
    );

    const imageIdParam =
      values.length;

    values.push(
      projectId
    );

    const projectIdParam =
      values.length;

    const result =
      await client.query(
        `
          UPDATE project_images
          SET
            ${sets.join(
              ",\n"
            )}
          WHERE id = $${imageIdParam}
            AND project_id = $${projectIdParam}
          RETURNING *
        `,
        values
      );

    await syncProjectCover(
      client,
      projectId
    );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function deleteProjectImage(
  projectId,
  imageId
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const result =
      await client.query(
        `
          DELETE FROM project_images
          WHERE id = $1
            AND project_id = $2
          RETURNING *
        `,
        [
          imageId,
          projectId,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      throw createServiceError(
        "Imagen no encontrada",
        404,
        "PROJECT_IMAGE_NOT_FOUND"
      );
    }

    await syncProjectCover(
      client,
      projectId
    );

    await client.query(
      "COMMIT"
    );

    return result.rows[0];
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function attachProjectProduct(
  projectId,
  data
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requireProject(
      client,
      projectId
    );

    const product =
      await requireProduct(
        client,
        data.product_id
      );

    const result =
      await client.query(
        `
          INSERT INTO project_products (
            project_id,
            product_id,
            application_note,
            sort_order
          )
          VALUES (
            $1, $2, $3, $4
          )

          ON CONFLICT (
            project_id,
            product_id
          )

          DO UPDATE SET
            application_note =
              EXCLUDED.application_note,
            sort_order =
              EXCLUDED.sort_order

          RETURNING *
        `,
        [
          projectId,
          data.product_id,
          normalizeNullable(
            data.application_note
          ),
          data.sort_order ??
            0,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return {
      ...result.rows[0],
      product,
    };
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


export async function removeProjectProduct(
  projectId,
  productId
) {
  const result =
    await pool.query(
      `
        DELETE FROM project_products
        WHERE project_id = $1
          AND product_id = $2
        RETURNING *
      `,
      [
        projectId,
        productId,
      ]
    );

  if (
    result.rowCount ===
    0
  ) {
    throw createServiceError(
      "El producto no está asociado al proyecto",
      404,
      "PROJECT_PRODUCT_NOT_FOUND"
    );
  }

  return result.rows[0];
}


export async function listPublicProjects(
  filters = {}
) {
  const {
    category,
    featured,
    limit = 24,
    offset = 0,
  } =
    filters;

  const params = [];

  const conditions = [
    "p.status = 'PUBLISHED'",
    "p.is_active = TRUE",
    "p.deleted_at IS NULL",
  ];

  if (
    category
  ) {
    params.push(
      category.toLowerCase()
    );

    conditions.push(
      `LOWER(p.category) = $${params.length}`
    );
  }

  if (
    typeof featured ===
    "boolean"
  ) {
    params.push(
      featured
    );

    conditions.push(
      `p.is_featured = $${params.length}`
    );
  }

  params.push(
    limit
  );

  const limitParam =
    params.length;

  params.push(
    offset
  );

  const offsetParam =
    params.length;

  const result =
    await pool.query(
      `
        SELECT
          p.id,
          p.title,
          p.slug,
          p.category,
          p.location,
          p.project_year,
          p.short_description,
          p.cover_image_url,
          p.is_featured,
          p.sort_order,
          p.published_at,
          p.updated_at,

          COUNT(*) OVER()::int
            AS total_count

        FROM projects p

        WHERE
          ${conditions.join(
            "\n AND "
          )}

        ORDER BY
          p.is_featured DESC,
          p.sort_order ASC,
          p.published_at DESC,
          p.created_at DESC

        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      params
    );

  const total =
    result.rows[0]
      ?.total_count ||
    0;

  const projects =
    result.rows.map(
      (
        row
      ) => {
        const {
          total_count,
          ...project
        } =
          row;

        return project;
      }
    );

  const projectsWithCovers =
    await hydrateProjectCoverUrls(
      projects
    );

  return {
    projects:
      projectsWithCovers,
    total,
    limit,
    offset,
  };
}


export async function getPublicProjectBySlug(
  slug
) {
  const projectResult =
    await pool.query(
      `
        SELECT
          id,
          title,
          slug,
          category,
          location,
          project_year,
          short_description,
          description,
          cover_image_url,
          is_featured,
          sort_order,
          meta_title,
          meta_description,
          published_at,
          updated_at

        FROM projects

        WHERE slug = $1
          AND status = 'PUBLISHED'
          AND is_active = TRUE
          AND deleted_at IS NULL

        LIMIT 1
      `,
      [
        slug,
      ]
    );

  if (
    projectResult.rowCount ===
    0
  ) {
    throw createServiceError(
      "Proyecto no encontrado",
      404,
      "PROJECT_NOT_FOUND"
    );
  }

  const project =
    projectResult.rows[0];

  const [
    imagesResult,
    productsResult,
  ] =
    await Promise.all([
      pool.query(
        `
          SELECT
            id,
            project_id,
            image_source,
            storage_provider,
            thumbnail_key,
            card_key,
            detail_key,
            original_filename,
            instagram_media_url,
            image_url,
            alt_text,
            caption,
            sort_order,
            is_primary,
            created_at,
            updated_at
          FROM project_images
          WHERE project_id = $1
          ORDER BY
            is_primary DESC,
            sort_order ASC,
            created_at ASC
        `,
        [
          project.id,
        ]
      ),

      pool.query(
        `
          SELECT
            pp.product_id,
            pp.application_note,
            pp.sort_order,

            p.sku,
            p.internal_code,
            p.name,
            p.slug

          FROM project_products pp

          JOIN products p
            ON p.id = pp.product_id

          WHERE pp.project_id = $1

          ORDER BY
            pp.sort_order ASC,
            pp.created_at ASC
        `,
        [
          project.id,
        ]
      ),
    ]);

  const resolvedImages =
    await Promise.all(
      imagesResult.rows.map(
        resolveProjectImage
      )
    );

  const primaryImage =
    resolvedImages.find(
      (
        image
      ) =>
        image.is_primary
    ) ||
    resolvedImages[0] ||
    null;

  return {
    ...project,
    cover_image_url:
      primaryImage?.urls?.detail ||
      primaryImage?.urls?.card ||
      primaryImage?.image_url ||
      project.cover_image_url ||
      null,
    images:
      resolvedImages,
    products:
      productsResult.rows,
  };
}
