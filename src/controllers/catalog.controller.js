import pool from "../config/database.js";

/* =========================================
   OBTENER FILTROS DEL CATÁLOGO
========================================= */
export const getCatalogFilters = async (req, res) => {
  try {
    const [
      categoriesResult,
      brandsResult,
      collectionsResult,
      finishesResult,
      colorsResult,
    ] = await Promise.all([
      pool.query(`
        SELECT DISTINCT
          category_id AS id,
          category AS name,
          category_slug AS slug
        FROM vw_product_catalog
        WHERE is_active = TRUE
          AND is_published = TRUE
          AND allow_sale = TRUE
          AND category_id IS NOT NULL
        ORDER BY category ASC
      `),

      pool.query(`
        SELECT DISTINCT
          brand_id AS id,
          brand AS name,
          brand_slug AS slug
        FROM vw_product_catalog
        WHERE is_active = TRUE
          AND is_published = TRUE
          AND allow_sale = TRUE
          AND brand_id IS NOT NULL
        ORDER BY brand ASC
      `),

      pool.query(`
        SELECT DISTINCT
          collection_id AS id,
          collection AS name,
          collection_slug AS slug,
          brand_id,
          brand
        FROM vw_product_catalog
        WHERE is_active = TRUE
          AND is_published = TRUE
          AND allow_sale = TRUE
          AND collection_id IS NOT NULL
        ORDER BY collection ASC
      `),

      pool.query(`
        SELECT DISTINCT
          finish
        FROM vw_product_catalog
        WHERE is_active = TRUE
          AND is_published = TRUE
          AND allow_sale = TRUE
          AND finish IS NOT NULL
          AND TRIM(finish) <> ''
        ORDER BY finish ASC
      `),

      pool.query(`
        SELECT DISTINCT
          color
        FROM vw_product_catalog
        WHERE is_active = TRUE
          AND is_published = TRUE
          AND allow_sale = TRUE
          AND color IS NOT NULL
          AND TRIM(color) <> ''
        ORDER BY color ASC
      `),
    ]);

    return res.status(200).json({
      success: true,

      filters: {
        categories: categoriesResult.rows,
        brands: brandsResult.rows,
        collections: collectionsResult.rows,
        finishes: finishesResult.rows.map(
          (item) => item.finish
        ),
        colors: colorsResult.rows.map(
          (item) => item.color
        ),
      },
    });
  } catch (error) {
    console.error(
      "Error obteniendo filtros del catálogo:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener los filtros del catálogo",
    });
  }
};

/* =========================================
   OBTENER NAVEGACIÓN DEL CATÁLOGO
   MARCAS + COLECCIONES VISIBLES EN MENÚ
========================================= */
export const getCatalogNavigation = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.id,
        b.name,
        b.slug,
        b.sort_order,

        COALESCE(
          json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name,
              'slug', c.slug,
              'image_url', c.image_url,
              'sort_order', c.sort_order
            )
            ORDER BY
              c.sort_order ASC,
              c.name ASC
          )
          FILTER (
            WHERE c.id IS NOT NULL
          ),
          '[]'::json
        ) AS collections

      FROM brands b

      LEFT JOIN collections c
        ON c.brand_id = b.id
        AND c.is_active = TRUE
        AND c.show_in_menu = TRUE
        AND EXISTS (
          SELECT 1
          FROM vw_product_catalog v
          WHERE v.collection_id = c.id
            AND v.is_active = TRUE
            AND v.is_published = TRUE
            AND v.allow_sale = TRUE
        )

      WHERE b.is_active = TRUE
        AND b.show_in_menu = TRUE

      GROUP BY
        b.id,
        b.name,
        b.slug,
        b.sort_order

      ORDER BY
        b.sort_order ASC,
        b.name ASC
    `);

    return res.status(200).json({
      success: true,
      brands: result.rows,
    });
  } catch (error) {
    console.error(
      "Error obteniendo navegación del catálogo:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener la navegación del catálogo",
    });
  }
};

