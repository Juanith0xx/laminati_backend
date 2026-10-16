import pool from "../config/database.js";

import {
  resolveCustomerProductPrice,
} from "../services/customerPricing.service.js";

import {
  resolveProductPrice,
} from "../services/productPricing.service.js";

import {
  getProductImageSignedUrl,
} from "../services/productImageStorage.service.js";

/* =========================================

   CONFIGURACIÓN

========================================= */

const DEFAULT_PAGE = 1;

const DEFAULT_LIMIT = 24;

const MAX_LIMIT = 100;

const DEFAULT_SUGGESTIONS_LIMIT = 6;

const MAX_SUGGESTIONS_LIMIT = 10;

const MIN_SEARCH_LENGTH = 2;

const SORT_OPTIONS = {

  featured: `

    is_featured DESC,

    sort_order ASC,

    name ASC

  `,

  name_asc: `

    name ASC

  `,

  name_desc: `

    name DESC

  `,

  price_asc: `

    final_price ASC NULLS LAST,

    name ASC

  `,

  price_desc: `

    final_price DESC NULLS LAST,

    name ASC

  `,

  newest: `

    created_at DESC,

    name ASC

  `,

};

/* =========================================

   PARSEAR BOOLEAN

========================================= */

const parseBoolean = (value) => {

  if (value === undefined) {

    return null;

  }

  if (value === "true") {

    return true;

  }

  if (value === "false") {

    return false;

  }

  return undefined;

};

/* =========================================

   BODEGA WEB / STOCK ÚNICO

========================================= */

const getWebWarehouseId = () => {

  const warehouseId = Number.parseInt(

    process.env.RELBASE_DEFAULT_WAREHOUSE_ID,

    10

  );

  if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) {

    const error = new Error(

      "RELBASE_DEFAULT_WAREHOUSE_ID no se encuentra configurado correctamente"

    );

    error.code = "WEB_WAREHOUSE_NOT_CONFIGURED";

    throw error;

  }

  return warehouseId;

};

/* =========================================

   NORMALIZAR TEXTO DE BÚSQUEDA

========================================= */

const normalizeSearchText = (value) => {

  return String(value || "")

    .trim()

    .replace(/\s+/g, " ");

};

/* =========================================
   RESOLVER IMAGEN PÚBLICA DE PRODUCTO
   - Railway Storage privado -> URL firmada
   - URL externa antigua -> compatibilidad
   - Nunca expone las keys privadas al frontend
========================================= */

const resolvePublicProductImage = async (image) => {

  const baseImage = {
    id: image.id,
    image_url: image.image_url || null,
    alt_text: image.alt_text || null,
    is_primary: image.is_primary === true,
    sort_order: image.sort_order,
    storage_provider:
      image.storage_provider || null,
    image_type:
      image.image_type || null,
  };

  /*
   * Compatibilidad con imágenes antiguas
   * almacenadas directamente mediante URL.
   */
  if (
    image.storage_provider !== "RAILWAY"
  ) {
    const legacyUrl =
      image.image_url || null;

    return {
      ...baseImage,
      thumbnail_url: legacyUrl,
      card_url: legacyUrl,
      detail_url: legacyUrl,
    };
  }

  try {
    const [
      thumbnailUrl,
      cardUrl,
      detailUrl,
    ] = await Promise.all([
      image.thumbnail_key
        ? getProductImageSignedUrl(
            image.thumbnail_key
          )
        : Promise.resolve(null),

      image.card_key
        ? getProductImageSignedUrl(
            image.card_key
          )
        : Promise.resolve(null),

      image.detail_key
        ? getProductImageSignedUrl(
            image.detail_key
          )
        : Promise.resolve(null),
    ]);

    return {
      ...baseImage,
      thumbnail_url:
        thumbnailUrl,
      card_url:
        cardUrl,
      detail_url:
        detailUrl,
    };
  } catch (error) {
    /*
     * Una falla generando la URL de una imagen
     * no debe botar todo el catálogo público.
     */
    console.error(
      "Error generando URLs públicas de imagen:",
      {
        image_id: image.id,
        product_id: image.product_id,
        error,
      }
    );

    return {
      ...baseImage,
      thumbnail_url: null,
      card_url: null,
      detail_url: null,
    };
  }

};

/* =========================================
   OBTENER IMÁGENES PÚBLICAS POR PRODUCTOS
========================================= */

const getPublicProductImagesMap = async (
  productIds
) => {

  if (
    !Array.isArray(productIds) ||
    productIds.length === 0
  ) {
    return new Map();
  }

  const result = await pool.query(
    `
      SELECT
        id,
        product_id,
        image_url,
        alt_text,
        is_primary,
        sort_order,
        storage_provider,
        image_type,
        thumbnail_key,
        card_key,
        detail_key,
        created_at
      FROM product_images
      WHERE product_id = ANY($1::uuid[])
      ORDER BY
        product_id ASC,
        is_primary DESC,
        sort_order ASC,
        created_at ASC
    `,
    [productIds]
  );

  const resolvedImages =
    await Promise.all(
      result.rows.map(
        (image) =>
          resolvePublicProductImage(
            image
          )
      )
    );

  const imagesMap =
    new Map();

  for (
    let index = 0;
    index < result.rows.length;
    index += 1
  ) {
    const productId =
      result.rows[index].product_id;

    if (
      !imagesMap.has(productId)
    ) {
      imagesMap.set(
        productId,
        []
      );
    }

    imagesMap
      .get(productId)
      .push(
        resolvedImages[index]
      );
  }

  return imagesMap;

};

/* =========================================
   ADJUNTAR IMÁGENES AL CATÁLOGO
========================================= */

const attachPublicImagesToProducts =
  async (products) => {

    if (
      !Array.isArray(products) ||
      products.length === 0
    ) {
      return [];
    }

    const productIds =
      products.map(
        (product) => product.id
      );

    const imagesMap =
      await getPublicProductImagesMap(
        productIds
      );

    return products.map(
      (product) => {

        const images =
          imagesMap.get(product.id) ||
          [];

        const primaryImage =
          images.find(
            (image) =>
              image.is_primary
          ) ||
          images[0] ||
          null;

        const secondaryImage =
          images.find(
            (image) =>
              image.id !==
              primaryImage?.id
          ) ||
          null;

        /*
         * primary_image_url se conserva para
         * no romper el frontend existente.
         *
         * Si la imagen está en Railway,
         * utilizamos la variante CARD.
         */
        const primaryImageUrl =
          primaryImage?.card_url ||
          product.primary_image_url ||
          null;

        const primaryImageAlt =
          primaryImage?.alt_text ||
          product.primary_image_alt ||
          null;

        return {
          ...product,

          primary_image_url:
            primaryImageUrl,

          primary_image_alt:
            primaryImageAlt,

          secondary_image_url:
            secondaryImage?.card_url ||
            null,

          primary_image:
            primaryImage,

          secondary_image:
            secondaryImage,
        };

      }
    );

  };

/* =========================================

   LISTAR PRODUCTOS PÚBLICOS

========================================= */

export const getProducts = async (req, res) => {

  try {

    const warehouseId = getWebWarehouseId();

    const {

      category,

      brand,

      collection,

      finish,

      search,

      featured,

      in_stock,

      sort = "featured",

    } = req.query;

    /* =========================================*

*       PAGINACIÓN*

*    ========================================= */

    const page = Math.max(

      Number.parseInt(req.query.page, 10) || DEFAULT_PAGE,

      1

    );

    const requestedLimit =

      Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT;

    const limit = Math.min(

      Math.max(requestedLimit, 1),

      MAX_LIMIT

    );

    const offset = (page - 1) * limit;

  /* =========================================*

*       VALIDAR BOOLEANOS*

*    ========================================= */

    const featuredValue = parseBoolean(featured);

    const inStockValue = parseBoolean(in_stock);

    if (

      featured !== undefined &&

      featuredValue === undefined

    ) {

      return res.status(400).json({

        success: false,

        message:

          "El parámetro featured debe ser true o false",

      });

    }

    if (

      in_stock !== undefined &&

      inStockValue === undefined

    ) {

      return res.status(400).json({

        success: false,

        message:

          "El parámetro in_stock debe ser true o false",

      });

    }

    /* =========================================*

*       VALIDAR ORDENAMIENTO*

*    ========================================= */

    if (!SORT_OPTIONS[sort]) {

      return res.status(400).json({

        success: false,

        message: "Ordenamiento no válido",

        allowed_sort: Object.keys(SORT_OPTIONS),

      });

    }

/* =========================================*

*       FILTROS BASE*

*    ========================================= */

    const conditions = [

      "is_active = TRUE",

      "is_published = TRUE",

      `(
        allow_sale = TRUE
        OR commercial_mode = 'PROJECT_ONLY'
      )`,

    ];

    // $1 queda reservado para la bodega web configurada.*

    const values = [warehouseId];

    /* =========================================*

*       CATEGORÍA*

*    ========================================= */

    if (category) {

      values.push(category);

      conditions.push(

        `LOWER(category_slug) = LOWER($${values.length})`

      );

    }

    /* =========================================*

*       MARCA*

*    ========================================= */

    if (brand) {

      values.push(brand);

      conditions.push(

        `LOWER(brand_slug) = LOWER($${values.length})`

      );

    }

    /* =========================================*

*       COLECCIÓN*

*    ========================================= */

    if (collection) {

      values.push(collection);

      conditions.push(

        `LOWER(collection_slug) = LOWER($${values.length})`

      );

    }

    /* =========================================*

*       ACABADO*

*    ========================================= */

    if (finish) {

      values.push(finish);

      conditions.push(

        `LOWER(finish) = LOWER($${values.length})`

      );

    }

    /* =========================================*

*       PRODUCTOS DESTACADOS*

*    ========================================= */

    if (featuredValue !== null) {

      values.push(featuredValue);

      conditions.push(

        `is_featured = $${values.length}`

      );

    }

    /* =========================================*

*       STOCK DISPONIBLE*

*    ========================================= */

    if (inStockValue !== null) {

      if (inStockValue) {

        conditions.push(

          "warehouse_available_web > 0"

        );

      } else {

        conditions.push(

          "warehouse_available_web <= 0"

        );

      }

    }

    /* =========================================*

*       BÚSQUEDA*

*       - Nombre*

*       - SKU*

*       - Código interno*

*       - Categoría*

*       - Marca*

*       - Colección*

*       - Color*

*       - Acabado*

*       Ignora:*

*       - Mayúsculas/minúsculas*

*       - Tildes*

*    ========================================= */

    const normalizedSearch =

      normalizeSearchText(search);

    if (normalizedSearch) {

      values.push(normalizedSearch);

      const searchParameter =

        `$${values.length}`;

      conditions.push(`

        (

          unaccent(LOWER(COALESCE(name, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(sku, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(internal_code, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(category, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(brand, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(collection, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(color, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

          OR unaccent(LOWER(COALESCE(finish, '')))

            LIKE '%' || unaccent(LOWER(${searchParameter})) || '%'

        )

      `);

    }

    const whereClause =

      conditions.join(" AND ");

    /* =========================================*

*       CONTAR RESULTADOS*

*    ========================================= */

    const countResult = await pool.query(

      `

        WITH web_catalog AS (

          SELECT

            v.*,

            GREATEST(

              COALESCE(i.stock_quantity, 0)

              - COALESCE(i.reserved_quantity, 0)

              - COALESCE(i.safety_stock, 0)

              - COALESCE(ar.active_reserved, 0),

              0

            ) AS warehouse_available_web

          FROM vw_product_catalog v

          LEFT JOIN inventory i

            ON i.product_id = v.id

           AND i.relbase_warehouse_id = $1

          LEFT JOIN LATERAL (

            SELECT

              COALESCE(

                SUM(ir.quantity),

                0

              ) AS active_reserved

            FROM inventory_reservations ir

            WHERE ir.inventory_id = i.id

              AND ir.status = 'ACTIVE'

              AND (

                ir.expires_at IS NULL

                OR ir.expires_at > NOW()

              )

          ) ar ON TRUE

        )

        SELECT

          COUNT(*) AS total

        FROM web_catalog

        WHERE ${whereClause}

      `,

      values

    );

    const total =

      Number(countResult.rows[0].total);

    const totalPages =

      total === 0

        ? 0

        : Math.ceil(total / limit);

    /* =========================================*

*       CONSULTAR PRODUCTOS*

*    ========================================= */

    const queryValues = [...values];

    queryValues.push(limit);

    const limitParameter =

      `$${queryValues.length}`;

    queryValues.push(offset);

    const offsetParameter =

      `$${queryValues.length}`;

    const result = await pool.query(

      `

        WITH web_catalog AS (

          SELECT

            v.*,

            GREATEST(

              COALESCE(i.stock_quantity, 0)

              - COALESCE(i.reserved_quantity, 0)

              - COALESCE(i.safety_stock, 0)

              - COALESCE(ar.active_reserved, 0),

              0

            ) AS warehouse_available_web

          FROM vw_product_catalog v

          LEFT JOIN inventory i

            ON i.product_id = v.id

           AND i.relbase_warehouse_id = $1

          LEFT JOIN LATERAL (

            SELECT

              COALESCE(

                SUM(ir.quantity),

                0

              ) AS active_reserved

            FROM inventory_reservations ir

            WHERE ir.inventory_id = i.id

              AND ir.status = 'ACTIVE'

              AND (

                ir.expires_at IS NULL

                OR ir.expires_at > NOW()

              )

          ) ar ON TRUE

        )

        SELECT

          id,

          sku,

          internal_code,

          name,

          slug,

          short_description,

          category_id,

          category,

          category_slug,

          brand_id,

          brand,

          brand_slug,

          collection_id,

          collection,

          collection_slug,

          color,

          finish,

          texture,

          width_mm,

          height_mm,

          thickness_mm,

          weight_kg,

          base_price,

          promotional_price,

          final_price,

          has_promotion,

          has_quantity_promotion,

          quantity_tiers,

          active_promotions,

          COALESCE(
            jsonb_array_length(
              active_promotions
            ),
            0
          ) AS promotion_count,

          commercial_mode,
          project_family_id,
          project_family_code,
          project_family_name,
          project_application,
          project_default_core,
          project_family_description,
          project_formats,
          project_finishes,
          project_thicknesses,
          project_documents,

          warehouse_available_web

            AS available_web,

          CASE

            WHEN warehouse_available_web > 0

              THEN TRUE

            ELSE FALSE

          END AS in_stock,

          primary_image_url,

          primary_image_alt,

          is_featured

        FROM web_catalog

        WHERE ${whereClause}

        ORDER BY ${SORT_OPTIONS[sort]}

        LIMIT ${limitParameter}

        OFFSET ${offsetParameter}

      `,

      queryValues

    );

    const products =
      await attachPublicImagesToProducts(
        result.rows
      );

    return res.status(200).json({

      success: true,

      pagination: {

        page,

        limit,

        total,

        total_pages: totalPages,

        has_next_page:

          page < totalPages,

        has_previous_page:

          page > 1,

      },

      filters: {

        category: category || null,

        brand: brand || null,

        collection: collection || null,

        finish: finish || null,

        search:

          normalizedSearch || null,

        featured:

          featuredValue === null

            ? null

            : featuredValue,

        in_stock:

          inStockValue === null

            ? null

            : inStockValue,

        sort,

      },

      products,

    });

  } catch (error) {

    console.error(

      "Error obteniendo productos:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible obtener los productos",

    });

  }

};

/* =========================================

   AUTOCOMPLETADO / SUGERENCIAS DE BÚSQUEDA

   GET:

   /api/products/search/suggestions?q=ac&limit=6

   BUSCA POR:

   - Nombre

   - SKU

   - Código interno

   CARACTERÍSTICAS:

   - Ignora tildes

   - Ignora mayúsculas/minúsculas

   - Prioriza coincidencias exactas

   - Prioriza coincidencias al inicio

   - Solo productos públicos

   - Respeta bodega web

   - Devuelve máximo 10 resultados

========================================= */

export const getProductSearchSuggestions = async (

  req,

  res

) => {

  try {

    const warehouseId =

      getWebWarehouseId();

    const query =

      normalizeSearchText(req.query.q);

    const requestedLimit =

      Number.parseInt(

        req.query.limit,

        10

      ) || DEFAULT_SUGGESTIONS_LIMIT;

    const limit = Math.min(

      Math.max(requestedLimit, 1),

      MAX_SUGGESTIONS_LIMIT

    );

    /* =========================================*

*       MÍNIMO DE CARACTERES*

*    ========================================= */

    if (

      query.length <

      MIN_SEARCH_LENGTH

    ) {

      return res.status(200).json({

        success: true,

        query,

        minimum_characters:

          MIN_SEARCH_LENGTH,

        suggestions: [],

      });

    }

   /* =========================================*

*       BUSCAR SUGERENCIAS*

*    ========================================= */

    const result = await pool.query(

      `

        WITH web_catalog AS (

          SELECT

            v.*,

            GREATEST(

              COALESCE(i.stock_quantity, 0)

              - COALESCE(i.reserved_quantity, 0)

              - COALESCE(i.safety_stock, 0)

              - COALESCE(ar.active_reserved, 0),

              0

            ) AS warehouse_available_web

          FROM vw_product_catalog v

          LEFT JOIN inventory i

            ON i.product_id = v.id

           AND i.relbase_warehouse_id = $1

          LEFT JOIN LATERAL (

            SELECT

              COALESCE(

                SUM(ir.quantity),

                0

              ) AS active_reserved

            FROM inventory_reservations ir

            WHERE ir.inventory_id = i.id

              AND ir.status = 'ACTIVE'

              AND (

                ir.expires_at IS NULL

                OR ir.expires_at > NOW()

              )

          ) ar ON TRUE

          WHERE v.is_active = TRUE

            AND v.is_published = TRUE

            AND v.allow_sale = TRUE

        ),

        ranked_products AS (

          SELECT

            id,

            sku,

            internal_code,

            name,

            slug,

            category,

            brand,

            collection,

            base_price,

            promotional_price,

            final_price,

            has_promotion,

            warehouse_available_web

              AS available_web,

            CASE

              WHEN warehouse_available_web > 0

                THEN TRUE

              ELSE FALSE

            END AS in_stock,

            primary_image_url,

            primary_image_alt,

            CASE

              /*

                Coincidencia exacta SKU

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(sku, '')

                  )

                )

                =

                unaccent(

                  LOWER($2)

                )

              THEN 0

              /*

                Coincidencia exacta código interno

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(

                      internal_code,

                      ''

                    )

                  )

                )

                =

                unaccent(

                  LOWER($2)

                )

              THEN 1

              /*

                Nombre comienza por la búsqueda

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(name, '')

                  )

                )

                LIKE

                unaccent(

                  LOWER($2)

                ) || '%'

              THEN 2

              /*

                SKU comienza por la búsqueda

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(sku, '')

                  )

                )

                LIKE

                unaccent(

                  LOWER($2)

                ) || '%'

              THEN 3

              /*

                Código interno comienza por búsqueda

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(

                      internal_code,

                      ''

                    )

                  )

                )

                LIKE

                unaccent(

                  LOWER($2)

                ) || '%'

              THEN 4

              /*

                Nombre contiene la búsqueda

              */

              WHEN

                unaccent(

                  LOWER(

                    COALESCE(name, '')

                  )

                )

                LIKE

                '%' ||

                unaccent(

                  LOWER($2)

                ) ||

                '%'

              THEN 5

              ELSE 6

            END AS search_rank

          FROM web_catalog

          WHERE

            (

              unaccent(

                LOWER(

                  COALESCE(name, '')

                )

              )

              LIKE

              '%' ||

              unaccent(

                LOWER($2)

              ) ||

              '%'

              OR

              unaccent(

                LOWER(

                  COALESCE(sku, '')

                )

              )

              LIKE

              '%' ||

              unaccent(

                LOWER($2)

              ) ||

              '%'

              OR

              unaccent(

                LOWER(

                  COALESCE(

                    internal_code,

                    ''

                  )

                )

              )

              LIKE

              '%' ||

              unaccent(

                LOWER($2)

              ) ||

              '%'

            )

        )

        SELECT

          id,

          sku,

          internal_code,

          name,

          slug,

          category,

          brand,

          collection,

          base_price,

          promotional_price,

          final_price,

          has_promotion,

          available_web,

          in_stock,

          primary_image_url,

          primary_image_alt

        FROM ranked_products

        ORDER BY

          search_rank ASC,

          in_stock DESC,

          name ASC

        LIMIT $3

      `,

      [

        warehouseId,

        query,

        limit,

      ]

    );

    const suggestions =
      await attachPublicImagesToProducts(
        result.rows
      );

    return res.status(200).json({

      success: true,

      query,

      minimum_characters:

        MIN_SEARCH_LENGTH,

      count: result.rows.length,

      suggestions,

    });

  } catch (error) {

    console.error(

      "Error obteniendo sugerencias de productos:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible buscar productos",

      code:

        "PRODUCT_SEARCH_SUGGESTIONS_ERROR",

    });

  }

};

/* =========================================

   OBTENER PRODUCTO POR SLUG

========================================= */

export const getProductBySlug = async (

  req,

  res

) => {

  try {

    const warehouseId =

      getWebWarehouseId();

    const { slug } = req.params;

    const result = await pool.query(

      `

        WITH web_catalog AS (

          SELECT

            v.*,

            GREATEST(

              COALESCE(i.stock_quantity, 0)

              - COALESCE(i.reserved_quantity, 0)

              - COALESCE(i.safety_stock, 0)

              - COALESCE(ar.active_reserved, 0),

              0

            ) AS warehouse_available_web

          FROM vw_product_catalog v

          LEFT JOIN inventory i

            ON i.product_id = v.id

           AND i.relbase_warehouse_id = $2

          LEFT JOIN LATERAL (

            SELECT

              COALESCE(

                SUM(ir.quantity),

                0

              ) AS active_reserved

            FROM inventory_reservations ir

            WHERE ir.inventory_id = i.id

              AND ir.status = 'ACTIVE'

              AND (

                ir.expires_at IS NULL

                OR ir.expires_at > NOW()

              )

          ) ar ON TRUE

        )

        SELECT

          id,

          sku,

          internal_code,

          name,

          slug,

          short_description,

          description,

          category_id,

          category,

          category_slug,

          brand_id,

          brand,

          brand_slug,

          collection_id,

          collection,

          collection_slug,

          color,

          finish,

          texture,

          width_mm,

          height_mm,

          thickness_mm,

          weight_kg,

          base_price,

          tax_rate,

          promotion_id,

          promotion_name,

          promotion_type,

          promotional_price,

          promotion_starts_at,

          promotion_ends_at,

          final_price,

          has_promotion,

          has_quantity_promotion,

          quantity_tiers,

          active_promotions,

          commercial_mode,
          project_family_id,
          project_family_code,
          project_family_name,
          project_application,
          project_default_core,
          project_family_description,
          project_formats,
          project_finishes,
          project_thicknesses,
          project_documents,

          warehouse_available_web

            AS available_web,

          CASE

            WHEN warehouse_available_web > 0

              THEN TRUE

            ELSE FALSE

          END AS in_stock,

          primary_image_url,

          primary_image_alt,

          meta_title,

          meta_description,

          canonical_url,

          og_title,

          og_description,

          og_image_url,

          robots_index,

          robots_follow,

          is_featured,

          created_at,

          updated_at

        FROM web_catalog

        WHERE LOWER(slug) = LOWER($1)

          AND is_active = TRUE

          AND is_published = TRUE

          AND (
            allow_sale = TRUE
            OR commercial_mode = 'PROJECT_ONLY'
          )

        LIMIT 1

      `,

      [

        slug,

        warehouseId,

      ]

    );

    if (result.rowCount === 0) {

      return res.status(404).json({

        success: false,

        message:

          "Producto no encontrado",

      });

    }

    const product =

      result.rows[0];

    /*
     * FASE 2 · MULTIPLES PROMOCIONES
     *
     * `active_promotions` contiene todas las promociones
     * públicas activas/vigentes del producto.
     *
     * `public_pricing` entrega además la resolución real
     * del motor para cantidad 1, sin reemplazar todavía
     * los campos legacy de promoción que consume el
     * frontend actual. En la Fase 3 el detalle público
     * pasará a usar estas nuevas estructuras.
     */
    const publicPricing =
      product.commercial_mode ===
        "PROJECT_ONLY"
        ? null
        : await resolveProductPrice({
            productId:
              product.id,
            quantity:
              1,
          });

    const imagesResult =

      await pool.query(

        `

          SELECT

            id,

            product_id,

            image_url,

            alt_text,

            is_primary,

            sort_order,

            storage_provider,

            image_type,

            thumbnail_key,

            card_key,

            detail_key,

            created_at

          FROM product_images

          WHERE product_id = $1

          ORDER BY

            is_primary DESC,

            sort_order ASC,

            created_at ASC

        `,

        [product.id]

      );

    const images =
      await Promise.all(
        imagesResult.rows.map(
          (image) =>
            resolvePublicProductImage(
              image
            )
        )
      );

    const primaryImage =
      images.find(
        (image) =>
          image.is_primary
      ) ||
      images[0] ||
      null;

    const secondaryImage =
      images.find(
        (image) =>
          image.id !==
          primaryImage?.id
      ) ||
      null;

    return res.status(200).json({

      success: true,

      product: {

        ...product,

        /*
         * Nuevas estructuras para soportar varias
         * promociones simultáneas sin romper el
         * contrato anterior.
         */
        active_promotions:
          Array.isArray(
            product.active_promotions
          )
            ? product.active_promotions
            : [],

        promotion_count:
          Array.isArray(
            product.active_promotions
          )
            ? product.active_promotions.length
            : 0,

        public_pricing:
          publicPricing,

        /*
         * Compatibilidad inmediata con
         * el frontend existente.
         */
        primary_image_url:
          primaryImage?.card_url ||
          product.primary_image_url ||
          null,

        primary_image_alt:
          primaryImage?.alt_text ||
          product.primary_image_alt ||
          null,

        secondary_image_url:
          secondaryImage?.card_url ||
          null,

        primary_image:
          primaryImage,

        secondary_image:
          secondaryImage,

        images,

      },

    });

  } catch (error) {

    console.error(

      "Error obteniendo producto:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible obtener el producto",

    });

  }

};

/* =========================================
   PRECIO PERSONALIZADO DEL CLIENTE

   Ruta protegida. No modifica el catálogo
   público; sólo devuelve el precio comercial
   aplicable al usuario autenticado.
========================================= */
export const getCustomerProductPrice = async (
  req,
  res
) => {
  try {
    const userId =
      req.user?.id || null;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message:
          "Debes iniciar sesión para consultar tu precio personalizado",
        code:
          "CUSTOMER_PRICING_AUTH_REQUIRED",
      });
    }

    const productId =
      String(
        req.params?.productId ||
        ""
      ).trim();

    if (!productId) {
      return res.status(400).json({
        success: false,
        message:
          "El producto es obligatorio",
        code:
          "CUSTOMER_PRICING_PRODUCT_REQUIRED",
      });
    }

    const quantity =
      req.query?.quantity === undefined
        ? 1
        : Number(req.query.quantity);

    const productResult =
      await pool.query(
        `
          SELECT
            v.id AS product_id,
            v.sku,
            v.collection_id,
            v.base_price,
            v.promotional_price,
            v.final_price,
            v.has_promotion
          FROM vw_product_catalog v
          WHERE v.id::text = $1
            AND v.is_active = TRUE
            AND v.is_published = TRUE
            AND v.allow_sale = TRUE
          LIMIT 1
        `,
        [
          productId,
        ]
      );

    if (
      productResult.rowCount === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Producto no encontrado",
        code:
          "CUSTOMER_PRICING_PRODUCT_NOT_FOUND",
      });
    }

    const pricing =
      await resolveCustomerProductPrice({
        userId,
        product:
          productResult.rows[0],
        quantity,
      });

    return res.status(200).json({
      success: true,
      pricing,
    });
  } catch (error) {
    console.error(
      "Error obteniendo precio personalizado:",
      error
    );

    return res
      .status(
        Number(error?.status) ||
        500
      )
      .json({
        success: false,
        message:
          error?.message ||
          "No fue posible obtener el precio personalizado",
        code:
          error?.code ||
          "CUSTOMER_PRICING_ERROR",
      });
  }
};

