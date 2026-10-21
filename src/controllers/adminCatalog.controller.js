import pool from "../config/database.js";

import { randomUUID } from "node:crypto";

import {
  uploadProductImage,
  deleteProductImageVariants,
  getProductImageSignedUrl,
} from "../services/productImageStorage.service.js";

import {
  createCategorySchema,
  updateCategorySchema,
  createBrandSchema,
  updateBrandSchema,
  createCollectionSchema,
  updateCollectionSchema,
  createProductSchema,
  updateProductSchema,
  createProductImageSchema,
  updateProductImageSchema,
  productSeoSchema,
  createPromotionSchema,
  updatePromotionSchema,
  updateInventorySafetyStockSchema,
} from "../validators/adminCatalog.validator.js";

import {
  generateSlug,
} from "../utils/slug.js";


/* =========================================
   PRECIO ITALIA (USD)
   - Histórico independiente del precio Chile.
   - Sólo se usa desde endpoints administrativos.
========================================= */
const getCurrentItalyPriceUsd = async (
  db,
  productId
) => {
  const result = await db.query(
    `
      SELECT price_usd
      FROM product_italy_prices
      WHERE product_id = $1
        AND valid_until IS NULL
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    [productId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return Number(
    result.rows[0].price_usd
  );
};

const syncCurrentItalyPriceUsd = async ({
  client,
  productId,
  priceUsd,
  userId = null,
}) => {
  if (priceUsd === undefined) {
    return getCurrentItalyPriceUsd(
      client,
      productId
    );
  }

  const currentResult = await client.query(
    `
      SELECT
        id,
        price_usd
      FROM product_italy_prices
      WHERE product_id = $1
        AND valid_until IS NULL
      ORDER BY valid_from DESC
      LIMIT 1
      FOR UPDATE
    `,
    [productId]
  );

  const currentPrice =
    currentResult.rowCount > 0
      ? Number(
          currentResult.rows[0].price_usd
        )
      : null;

  if (priceUsd === null) {
    if (currentResult.rowCount > 0) {
      await client.query(
        `
          UPDATE product_italy_prices
          SET valid_until = NOW()
          WHERE id = $1
        `,
        [
          currentResult.rows[0].id,
        ]
      );
    }

    return null;
  }

  const nextPrice =
    Number(priceUsd);

  if (
    currentResult.rowCount > 0 &&
    currentPrice === nextPrice
  ) {
    return currentPrice;
  }

  if (currentResult.rowCount > 0) {
    await client.query(
      `
        UPDATE product_italy_prices
        SET valid_until = NOW()
        WHERE id = $1
      `,
      [
        currentResult.rows[0].id,
      ]
    );
  }

  const insertResult = await client.query(
    `
      INSERT INTO product_italy_prices (
        product_id,
        price_usd,
        valid_from,
        created_by
      )
      VALUES (
        $1,
        $2,
        NOW(),
        $3
      )
      RETURNING price_usd
    `,
    [
      productId,
      nextPrice,
      userId,
    ]
  );

  return Number(
    insertResult.rows[0].price_usd
  );
};

import {
  ensureRelbaseProductForLocalProduct,
  lookupRelbaseProductBySku,
} from "../services/relbaseProductProvisioning.service.js";

/* =========================================
   LISTAR CATEGORÍAS
========================================= */
export const getAdminCategories = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.parent_id,
        parent.name AS parent_name,

        c.name,
        c.slug,
        c.description,

        c.is_active,
        c.sort_order,

        c.created_at,
        c.updated_at

      FROM categories c

      LEFT JOIN categories parent
        ON parent.id = c.parent_id

      ORDER BY
        c.sort_order ASC,
        c.name ASC
    `);

    return res.status(200).json({
      success: true,
      count: result.rowCount,
      categories: result.rows,
    });
  } catch (error) {
    console.error(
      "Error obteniendo categorías administrativas:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "No fue posible obtener las categorías",
    });
  }
};

/* =========================================
   CREAR CATEGORÍA
========================================= */
export const createAdminCategory = async (req, res) => {
  const validation = createCategorySchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de categoría inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    name,
    description,
    parent_id,
    is_active,
    sort_order,
  } = validation.data;

  const slug = generateSlug(name);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR CATEGORÍA PADRE
    ========================================= */
    if (parent_id) {
      const parentResult = await client.query(
        `
          SELECT id
          FROM categories
          WHERE id = $1
          LIMIT 1
        `,
        [parent_id]
      );

      if (parentResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La categoría padre no existe",
        });
      }
    }

    /* =========================================
       VALIDAR SLUG
    ========================================= */
    const existingCategory = await client.query(
      `
        SELECT id
        FROM categories
        WHERE slug = $1
        LIMIT 1
      `,
      [slug]
    );

    if (existingCategory.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "Ya existe una categoría con este nombre o slug",
      });
    }

    /* =========================================
       INSERTAR
    ========================================= */
    const result = await client.query(
      `
        INSERT INTO categories (
          parent_id,
          name,
          slug,
          description,
          is_active,
          sort_order
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        RETURNING
          id,
          parent_id,
          name,
          slug,
          description,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        parent_id || null,
        name,
        slug,
        description || null,
        is_active,
        sort_order,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Categoría creada correctamente",
      category: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error creando categoría:",
      error
    );

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La categoría ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear la categoría",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ACTUALIZAR CATEGORÍA
========================================= */
export const updateAdminCategory = async (req, res) => {
  const { id } = req.params;

  const validation = updateCategorySchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de categoría inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    name,
    description,
    parent_id,
    is_active,
    sort_order,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR EXISTENCIA
    ========================================= */
    const categoryResult = await client.query(
      `
        SELECT
          id,
          parent_id,
          name,
          slug,
          description,
          is_active,
          sort_order
        FROM categories
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Categoría no encontrada",
      });
    }

    const currentCategory = categoryResult.rows[0];

    /* =========================================
       VALIDAR CATEGORÍA PADRE
    ========================================= */
    if (
      parent_id !== undefined &&
      parent_id !== null
    ) {
      if (parent_id === id) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Una categoría no puede ser su propia categoría padre",
        });
      }

      const parentResult = await client.query(
        `
          SELECT id
          FROM categories
          WHERE id = $1
          LIMIT 1
        `,
        [parent_id]
      );

      if (parentResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La categoría padre no existe",
        });
      }

      /* =========================================
         EVITAR CICLOS DE CATEGORÍAS
      ========================================= */
      const descendantResult = await client.query(
        `
          WITH RECURSIVE descendants AS (
            SELECT
              id
            FROM categories
            WHERE parent_id = $1

            UNION ALL

            SELECT
              c.id
            FROM categories c

            INNER JOIN descendants d
              ON c.parent_id = d.id
          )

          SELECT id
          FROM descendants
          WHERE id = $2
          LIMIT 1
        `,
        [
          id,
          parent_id,
        ]
      );

      if (descendantResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "No puedes asignar una subcategoría como categoría padre",
        });
      }
    }

    /* =========================================
       GENERAR SLUG SI CAMBIA EL NOMBRE
    ========================================= */
    let newSlug = currentCategory.slug;

    if (name !== undefined) {
      newSlug = generateSlug(name);

      const slugResult = await client.query(
        `
          SELECT id
          FROM categories
          WHERE slug = $1
            AND id <> $2
          LIMIT 1
        `,
        [
          newSlug,
          id,
        ]
      );

      if (slugResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Ya existe otra categoría con este nombre o slug",
        });
      }
    }

    /* =========================================
       DETECTAR CAMPOS ENVIADOS
    ========================================= */
    const hasDescription =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "description"
      );

    const hasParentId =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "parent_id"
      );

    /* =========================================
       ACTUALIZAR CATEGORÍA
    ========================================= */
    const result = await client.query(
      `
        UPDATE categories

        SET
          name = COALESCE(
            $1,
            name
          ),

          slug = $2,

          description = CASE
            WHEN $3::boolean = TRUE
              THEN $4
            ELSE description
          END,

          parent_id = CASE
            WHEN $5::boolean = TRUE
              THEN $6
            ELSE parent_id
          END,

          is_active = COALESCE(
            $7,
            is_active
          ),

          sort_order = COALESCE(
            $8,
            sort_order
          )

        WHERE id = $9

        RETURNING
          id,
          parent_id,
          name,
          slug,
          description,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        name ?? null,
        newSlug,

        hasDescription,
        description ?? null,

        hasParentId,
        parent_id ?? null,

        is_active ?? null,
        sort_order ?? null,

        id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Categoría actualizada correctamente",
      category: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error actualizando categoría:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de categoría inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La categoría ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar la categoría",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR CATEGORÍA
========================================= */
export const deleteAdminCategory = async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR EXISTENCIA
    ========================================= */
    const categoryResult = await client.query(
      `
        SELECT
          id,
          name,
          slug
        FROM categories
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Categoría no encontrada",
      });
    }

    /* =========================================
       VALIDAR PRODUCTOS ASOCIADOS
    ========================================= */
    const productsResult = await client.query(
      `
        SELECT
          COUNT(*) AS total
        FROM products
        WHERE category_id = $1
      `,
      [id]
    );

    const productsCount = Number(
      productsResult.rows[0].total
    );

    if (productsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar una categoría que tiene productos asociados",
        products_count: productsCount,
      });
    }

    /* =========================================
       VALIDAR SUBCATEGORÍAS
    ========================================= */
    const childrenResult = await client.query(
      `
        SELECT
          COUNT(*) AS total
        FROM categories
        WHERE parent_id = $1
      `,
      [id]
    );

    const childrenCount = Number(
      childrenResult.rows[0].total
    );

    if (childrenCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar una categoría que tiene subcategorías",
        subcategories_count: childrenCount,
      });
    }

    /* =========================================
       ELIMINAR
    ========================================= */
    const result = await client.query(
      `
        DELETE FROM categories
        WHERE id = $1

        RETURNING
          id,
          name,
          slug
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Categoría eliminada correctamente",
      category: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error eliminando categoría:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de categoría inválido",
      });
    }

    if (error.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "La categoría tiene relaciones asociadas y no puede eliminarse",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible eliminar la categoría",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   LISTAR MARCAS
========================================= */
export const getAdminBrands = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        slug,
        description,
        website_url,
        logo_url,
        is_active,
        sort_order,
        created_at,
        updated_at
      FROM brands
      ORDER BY
        sort_order ASC,
        name ASC
    `);

    return res.status(200).json({
      success: true,
      count: result.rowCount,
      brands: result.rows,
    });
  } catch (error) {
    console.error(
      "Error obteniendo marcas administrativas:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "No fue posible obtener las marcas",
    });
  }
};

/* =========================================
   CREAR MARCA
========================================= */
export const createAdminBrand = async (req, res) => {
  const validation = createBrandSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de marca inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    name,
    description,
    website_url,
    logo_url,
    is_active,
    sort_order,
  } = validation.data;

  const slug = generateSlug(name);

  try {
    const existingBrand = await pool.query(
      `
        SELECT id
        FROM brands
        WHERE slug = $1
        LIMIT 1
      `,
      [slug]
    );

    if (existingBrand.rowCount > 0) {
      return res.status(409).json({
        success: false,
        message:
          "Ya existe una marca con este nombre o slug",
      });
    }

    const result = await pool.query(
      `
        INSERT INTO brands (
          name,
          slug,
          description,
          website_url,
          logo_url,
          is_active,
          sort_order
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING
          id,
          name,
          slug,
          description,
          website_url,
          logo_url,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        name,
        slug,
        description || null,
        website_url || null,
        logo_url || null,
        is_active,
        sort_order,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Marca creada correctamente",
      brand: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Error creando marca:",
      error
    );

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La marca ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear la marca",
    });
  }
};

/* =========================================
   ACTUALIZAR MARCA
========================================= */
export const updateAdminBrand = async (req, res) => {
  const { id } = req.params;

  const validation = updateBrandSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de marca inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    name,
    description,
    website_url,
    logo_url,
    is_active,
    sort_order,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const brandResult = await client.query(
      `
        SELECT
          id,
          name,
          slug,
          description,
          website_url,
          logo_url,
          is_active,
          sort_order
        FROM brands
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (brandResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Marca no encontrada",
      });
    }

    const currentBrand = brandResult.rows[0];

    let newSlug = currentBrand.slug;

    if (name !== undefined) {
      newSlug = generateSlug(name);

      const slugResult = await client.query(
        `
          SELECT id
          FROM brands
          WHERE slug = $1
            AND id <> $2
          LIMIT 1
        `,
        [newSlug, id]
      );

      if (slugResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "Ya existe otra marca con este nombre o slug",
        });
      }
    }

    const hasDescription =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "description"
      );

    const hasWebsiteUrl =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "website_url"
      );

    const hasLogoUrl =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "logo_url"
      );

    const result = await client.query(
      `
        UPDATE brands
        SET
          name = COALESCE($1, name),

          slug = $2,

          description = CASE
            WHEN $3::boolean = TRUE
              THEN $4
            ELSE description
          END,

          website_url = CASE
            WHEN $5::boolean = TRUE
              THEN $6
            ELSE website_url
          END,

          logo_url = CASE
            WHEN $7::boolean = TRUE
              THEN $8
            ELSE logo_url
          END,

          is_active = COALESCE($9, is_active),

          sort_order = COALESCE($10, sort_order)

        WHERE id = $11

        RETURNING
          id,
          name,
          slug,
          description,
          website_url,
          logo_url,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        name ?? null,
        newSlug,

        hasDescription,
        description ?? null,

        hasWebsiteUrl,
        website_url ?? null,

        hasLogoUrl,
        logo_url ?? null,

        is_active ?? null,
        sort_order ?? null,

        id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Marca actualizada correctamente",
      brand: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error actualizando marca:", error);

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de marca inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La marca ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible actualizar la marca",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR MARCA
========================================= */
export const deleteAdminBrand = async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const brandResult = await client.query(
      `
        SELECT
          id,
          name,
          slug
        FROM brands
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (brandResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Marca no encontrada",
      });
    }

    /* =========================================
       VALIDAR PRODUCTOS ASOCIADOS
    ========================================= */
    const productsResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM products
        WHERE brand_id = $1
      `,
      [id]
    );

    const productsCount = Number(
      productsResult.rows[0].total
    );

    if (productsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar una marca que tiene productos asociados",
        products_count: productsCount,
      });
    }

    /* =========================================
       VALIDAR COLECCIONES ASOCIADAS
    ========================================= */
    const collectionsResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM collections
        WHERE brand_id = $1
      `,
      [id]
    );

    const collectionsCount = Number(
      collectionsResult.rows[0].total
    );

    if (collectionsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar una marca que tiene colecciones asociadas",
        collections_count: collectionsCount,
      });
    }

    const result = await client.query(
      `
        DELETE FROM brands
        WHERE id = $1

        RETURNING
          id,
          name,
          slug
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Marca eliminada correctamente",
      brand: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error eliminando marca:", error);

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de marca inválido",
      });
    }

    if (error.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "La marca tiene relaciones asociadas y no puede eliminarse",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible eliminar la marca",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   LISTAR COLECCIONES
========================================= */
export const getAdminCollections = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.brand_id,
        b.name AS brand_name,
        b.slug AS brand_slug,

        c.name,
        c.slug,
        c.description,

        c.image_url,
        c.banner_url,

        c.is_featured,
        c.is_active,
        c.sort_order,

        (
          SELECT COUNT(*)
          FROM products p
          WHERE p.collection_id = c.id
        )::integer AS products_count,

        c.created_at,
        c.updated_at

      FROM collections c

      LEFT JOIN brands b
        ON b.id = c.brand_id

      ORDER BY
        c.sort_order ASC,
        c.name ASC
    `);

    return res.status(200).json({
      success: true,
      count: result.rowCount,
      collections: result.rows,
    });
  } catch (error) {
    console.error(
      "Error obteniendo colecciones administrativas:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "No fue posible obtener las colecciones",
    });
  }
};

/* =========================================
   CREAR COLECCIÓN
========================================= */
export const createAdminCollection = async (req, res) => {
  const validation = createCollectionSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de colección inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    brand_id,
    name,
    description,
    image_url,
    banner_url,
    is_featured,
    is_active,
    sort_order,
  } = validation.data;

  const slug = generateSlug(name);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR MARCA
    ========================================= */
    const brandResult = await client.query(
      `
        SELECT
          id,
          name
        FROM brands
        WHERE id = $1
        LIMIT 1
      `,
      [brand_id]
    );

    if (brandResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "La marca seleccionada no existe",
      });
    }

    /* =========================================
       VALIDAR SLUG
    ========================================= */
    const existingCollection = await client.query(
      `
        SELECT id
        FROM collections
        WHERE slug = $1
        LIMIT 1
      `,
      [slug]
    );

    if (existingCollection.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "Ya existe una colección con este nombre o slug",
      });
    }

    /* =========================================
       INSERTAR
    ========================================= */
    const result = await client.query(
      `
        INSERT INTO collections (
          brand_id,
          name,
          slug,
          description,
          image_url,
          banner_url,
          is_featured,
          is_active,
          sort_order
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING
          id,
          brand_id,
          name,
          slug,
          description,
          image_url,
          banner_url,
          is_featured,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        brand_id,
        name,
        slug,
        description || null,
        image_url || null,
        banner_url || null,
        is_featured,
        is_active,
        sort_order,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Colección creada correctamente",
      collection: {
        ...result.rows[0],
        brand_name: brandResult.rows[0].name,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error creando colección:",
      error
    );

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La colección ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear la colección",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ACTUALIZAR COLECCIÓN
========================================= */
export const updateAdminCollection = async (req, res) => {
  const { id } = req.params;

  const validation = updateCollectionSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de colección inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    brand_id,
    name,
    description,
    image_url,
    banner_url,
    is_featured,
    is_active,
    sort_order,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const collectionResult = await client.query(
      `
        SELECT
          id,
          brand_id,
          name,
          slug
        FROM collections
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (collectionResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Colección no encontrada",
      });
    }

    const currentCollection = collectionResult.rows[0];

    /* =========================================
       VALIDAR NUEVA MARCA
    ========================================= */
    if (brand_id !== undefined) {
      const brandResult = await client.query(
        `
          SELECT id
          FROM brands
          WHERE id = $1
          LIMIT 1
        `,
        [brand_id]
      );

      if (brandResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La marca seleccionada no existe",
        });
      }
    }

    /* =========================================
       GENERAR SLUG SI CAMBIA NOMBRE
    ========================================= */
    let newSlug = currentCollection.slug;

    if (name !== undefined) {
      newSlug = generateSlug(name);

      const slugResult = await client.query(
        `
          SELECT id
          FROM collections
          WHERE slug = $1
            AND id <> $2
          LIMIT 1
        `,
        [newSlug, id]
      );

      if (slugResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Ya existe otra colección con este nombre o slug",
        });
      }
    }

    const hasDescription =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "description"
      );

    const hasImageUrl =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "image_url"
      );

    const hasBannerUrl =
      Object.prototype.hasOwnProperty.call(
        validation.data,
        "banner_url"
      );

    const result = await client.query(
      `
        UPDATE collections
        SET
          brand_id = COALESCE($1, brand_id),

          name = COALESCE($2, name),

          slug = $3,

          description = CASE
            WHEN $4::boolean = TRUE
              THEN $5
            ELSE description
          END,

          image_url = CASE
            WHEN $6::boolean = TRUE
              THEN $7
            ELSE image_url
          END,

          banner_url = CASE
            WHEN $8::boolean = TRUE
              THEN $9
            ELSE banner_url
          END,

          is_featured = COALESCE(
            $10,
            is_featured
          ),

          is_active = COALESCE(
            $11,
            is_active
          ),

          sort_order = COALESCE(
            $12,
            sort_order
          )

        WHERE id = $13

        RETURNING
          id,
          brand_id,
          name,
          slug,
          description,
          image_url,
          banner_url,
          is_featured,
          is_active,
          sort_order,
          created_at,
          updated_at
      `,
      [
        brand_id ?? null,
        name ?? null,
        newSlug,

        hasDescription,
        description ?? null,

        hasImageUrl,
        image_url ?? null,

        hasBannerUrl,
        banner_url ?? null,

        is_featured ?? null,
        is_active ?? null,
        sort_order ?? null,

        id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Colección actualizada correctamente",
      collection: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error actualizando colección:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de colección inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "La colección ya existe",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible actualizar la colección",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR COLECCIÓN
========================================= */
export const deleteAdminCollection = async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const collectionResult = await client.query(
      `
        SELECT
          id,
          name,
          slug
        FROM collections
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    if (collectionResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Colección no encontrada",
      });
    }

    /* =========================================
       VALIDAR PRODUCTOS ASOCIADOS
    ========================================= */
    const productsResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM products
        WHERE collection_id = $1
      `,
      [id]
    );

    const productsCount = Number(
      productsResult.rows[0].total
    );

    if (productsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar una colección que tiene productos asociados",
        products_count: productsCount,
      });
    }

    const result = await client.query(
      `
        DELETE FROM collections
        WHERE id = $1
        RETURNING
          id,
          name,
          slug
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Colección eliminada correctamente",
      collection: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error eliminando colección:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de colección inválido",
      });
    }

    if (error.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "La colección tiene relaciones asociadas y no puede eliminarse",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible eliminar la colección",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   LISTAR FAMILIAS DE PRODUCTOS DE PROYECTO
========================================= */
export const getAdminProjectProductFamilies = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        family.id,
        family.code,
        family.name,
        family.application,
        family.default_core,
        family.description,
        family.is_active,
        family.category_id,
        category.name AS category_name,
        category.slug AS category_slug,
        parent_category.id AS parent_category_id,
        parent_category.name AS parent_category_name,
        parent_category.slug AS parent_category_slug,

        family.brand_id,
        brand.name AS brand_name,
        brand.slug AS brand_slug,

        family.collection_id,
        collection.name AS collection_name,
        collection.slug AS collection_slug,

        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item.id,'label',item.label,'length_cm',item.length_cm,'width_cm',item.width_cm,'sort_order',item.sort_order) ORDER BY item.sort_order,item.length_cm,item.width_cm) FROM project_family_formats item WHERE item.family_id=family.id AND item.is_active=TRUE),'[]'::jsonb) AS formats,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item.id,'name',item.name,'sort_order',item.sort_order) ORDER BY item.sort_order,item.name) FROM project_family_finishes item WHERE item.family_id=family.id AND item.is_active=TRUE),'[]'::jsonb) AS finishes,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item.id,'thickness_mm',item.thickness_mm,'sort_order',item.sort_order) ORDER BY item.sort_order,item.thickness_mm) FROM project_family_thicknesses item WHERE item.family_id=family.id AND item.is_active=TRUE),'[]'::jsonb) AS thicknesses,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item.id,'title',item.title,'document_type',item.document_type,'document_url',item.document_url,'sort_order',item.sort_order) ORDER BY item.sort_order,item.title) FROM project_family_documents item WHERE item.family_id=family.id AND item.is_active=TRUE),'[]'::jsonb) AS documents
      FROM project_product_families family
      LEFT JOIN categories category
        ON category.id = family.category_id
      LEFT JOIN categories parent_category
        ON parent_category.id = category.parent_id

      LEFT JOIN brands brand
        ON brand.id = family.brand_id

      LEFT JOIN collections collection
        ON collection.id = family.collection_id

      WHERE family.is_active=TRUE
      ORDER BY family.name ASC,family.code ASC
    `);
    return res.status(200).json({success:true,count:result.rows.length,families:result.rows});
  } catch (error) {
    console.error("Error obteniendo familias de productos de proyecto:", error);
    return res.status(500).json({success:false,message:"No fue posible obtener las familias de productos de proyecto"});
  }
};

/* =========================================
   LISTAR PRODUCTOS ADMINISTRATIVOS
========================================= */
export const getAdminProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        sku,
        internal_code,
        relbase_product_id,

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
        italy_price.italy_price_usd,
        tax_rate,

        promotional_price,
        final_price,
        has_promotion,
        promotion_type,
        has_quantity_promotion,
        quantity_tiers,
        active_promotions,
        COALESCE(
          jsonb_array_length(
            active_promotions
          ),
          0
        ) AS promotion_count,

        stock_quantity,
        reserved_quantity,
        safety_stock,
        available_web,
        warehouse_count,
        last_sync_at,

        primary_image_url,
        primary_image_alt,

        meta_title,
        meta_description,

        is_active,
        is_published,
        is_featured,
        allow_sale,
        sort_order,

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

        created_at,
        updated_at

      FROM vw_product_catalog

      LEFT JOIN LATERAL (
        SELECT
          pip.price_usd AS italy_price_usd
        FROM product_italy_prices pip
        WHERE pip.product_id = vw_product_catalog.id
          AND pip.valid_until IS NULL
        ORDER BY pip.valid_from DESC
        LIMIT 1
      ) italy_price
        ON TRUE

      ORDER BY
        sort_order ASC,
        name ASC
    `);

    const products =
      result.rows;

    if (
      products.length === 0
    ) {
      return res.status(200).json({
        success: true,
        count: 0,
        products: [],
      });
    }

    const productIds =
      products.map(
        (product) =>
          product.id
      );

    /*
     * vw_product_catalog mantiene compatibilidad
     * con imágenes antiguas mediante image_url,
     * pero las imágenes nuevas de Railway viven
     * en un bucket privado.
     *
     * Para que el administrador vea las imágenes
     * ya guardadas al entrar a la página, buscamos
     * la imagen principal real y generamos una URL
     * firmada temporal para cada producto.
     */
    const imagesResult =
      await pool.query(
        `
          SELECT DISTINCT ON (
            product_id
          )
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

          WHERE product_id =
            ANY($1::uuid[])

          ORDER BY
            product_id ASC,
            is_primary DESC,
            sort_order ASC,
            created_at ASC
        `,
        [
          productIds,
        ]
      );

    const signedPrimaryImages =
      await Promise.all(
        imagesResult.rows.map(
          async (image) => {
            let resolvedUrl =
              image.image_url ||
              null;

            if (
              image.storage_provider ===
              "RAILWAY"
            ) {
              const preferredKey =
                image.card_key ||
                image.detail_key ||
                image.thumbnail_key ||
                null;

              if (preferredKey) {
                try {
                  resolvedUrl =
                    await getProductImageSignedUrl(
                      preferredKey
                    );
                } catch (error) {
                  console.error(
                    "Error generando URL firmada para imagen administrativa:",
                    {
                      image_id:
                        image.id,

                      product_id:
                        image.product_id,

                      error,
                    }
                  );

                  resolvedUrl =
                    null;
                }
              }
            }

            return {
              product_id:
                image.product_id,

              image_id:
                image.id,

              url:
                resolvedUrl,

              alt_text:
                image.alt_text ||
                null,

              storage_provider:
                image.storage_provider ||
                null,

              image_type:
                image.image_type ||
                null,
            };
          }
        )
      );

    const imageMap =
      new Map(
        signedPrimaryImages.map(
          (image) => [
            image.product_id,
            image,
          ]
        )
      );

    const productsWithImages =
      products.map(
        (product) => {
          const storedImage =
            imageMap.get(
              product.id
            ) ||
            null;

          return {
            ...product,

            /*
             * Railway Storage:
             * URL firmada actual.
             *
             * Legacy:
             * conserva primary_image_url de la vista.
             */
            primary_image_url:
              storedImage?.url ||
              product.primary_image_url ||
              null,

            primary_image_alt:
              storedImage?.alt_text ||
              product.primary_image_alt ||
              null,

            primary_image_id:
              storedImage?.image_id ||
              null,

            primary_image_storage_provider:
              storedImage?.storage_provider ||
              null,

            primary_image_type:
              storedImage?.image_type ||
              null,

            has_image:
              Boolean(
                storedImage?.url ||
                product.primary_image_url
              ),
          };
        }
      );

    return res.status(200).json({
      success: true,
      count:
        productsWithImages.length,
      products:
        productsWithImages,
    });
  } catch (error) {
    console.error(
      "Error obteniendo productos administrativos:",
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
   LOOKUP PRODUCTO RELBASE POR SKU
   SOLO LECTURA PARA VALIDACIÓN DEL FRONTEND
========================================= */
export const lookupAdminRelbaseProduct =
  async (
    req,
    res
  ) => {
    const sku =
      String(
        req.query.sku ||
        req.query.q ||
        ""
      ).trim();

    if (
      sku.length <
      2
    ) {
      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "Ingresa al menos 2 caracteres para validar el SKU",
          code:
            "RELBASE_PRODUCT_LOOKUP_QUERY_TOO_SHORT",
        });
    }

    try {
      const result =
        await lookupRelbaseProductBySku(
          sku,
          {
            limit:
              8,
          }
        );

      return res
        .status(200)
        .json({
          success:
            true,
          ...result,
        });
    } catch (error) {
      console.error(
        "Error validando producto en Relbase:",
        {
          sku,
          message:
            error?.message ||
            null,
          code:
            error?.code ||
            null,
          status:
            error?.status ||
            null,
        }
      );

      return res
        .status(
          error?.status ||
          502
        )
        .json({
          success:
            false,
          message:
            error?.message ||
            "No fue posible validar el producto en Relbase",
          code:
            error?.code ||
            "RELBASE_PRODUCT_LOOKUP_ERROR",
        });
    }
  };

/* =========================================
   CREAR PRODUCTO
========================================= */
export const createAdminProduct = async (req, res) => {
  const validation = createProductSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de producto inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    category_id,
    brand_id,
    collection_id,

    commercial_mode,
    project_family_id,

    sku,
    internal_code,
    relbase_product_id,

    name,
    short_description,
    description,

    base_price,
    italy_price_usd,
    tax_rate,

    width_mm,
    height_mm,
    thickness_mm,
    weight_kg,

    color,
    finish,
    texture,

    is_active,
    is_published,
    is_featured,
    allow_sale,
    sort_order,
  } = validation.data;

  const slug = generateSlug(name);

  const client = await pool.connect();

  let localCommitted = false;

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR CATEGORÍA
    ========================================= */
    const categoryResult = await client.query(
      `
        SELECT
          id,
          name
        FROM categories
        WHERE id = $1
        LIMIT 1
      `,
      [category_id]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "La categoría seleccionada no existe",
      });
    }

    /* =========================================
       VALIDAR MARCA
    ========================================= */
    if (brand_id) {
      const brandResult = await client.query(
        `
          SELECT
            id,
            name
          FROM brands
          WHERE id = $1
          LIMIT 1
        `,
        [brand_id]
      );

      if (brandResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La marca seleccionada no existe",
        });
      }
    }

    /* =========================================
       VALIDAR COLECCIÓN
    ========================================= */
    let resolvedBrandId = brand_id || null;

    if (collection_id) {
      const collectionResult = await client.query(
        `
          SELECT
            id,
            name,
            brand_id
          FROM collections
          WHERE id = $1
          LIMIT 1
        `,
        [collection_id]
      );

      if (collectionResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La colección seleccionada no existe",
        });
      }

      const collection =
        collectionResult.rows[0];

      /*
       * Si la colección pertenece a una marca,
       * el producto debe usar esa misma marca.
       */
      if (
        resolvedBrandId &&
        collection.brand_id &&
        resolvedBrandId !== collection.brand_id
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La colección seleccionada no pertenece a la marca indicada",
        });
      }

      /*
       * Si no enviaron brand_id pero la colección
       * sí tiene marca, la asignamos automáticamente.
       */
      if (!resolvedBrandId && collection.brand_id) {
        resolvedBrandId = collection.brand_id;
      }
    }

    /* =========================================
       MODALIDAD COMERCIAL / FAMILIA TÉCNICA
    ========================================= */
    const resolvedCommercialMode = commercial_mode || "WEB";
    const isProjectOnly = resolvedCommercialMode === "PROJECT_ONLY";
    let resolvedProjectFamilyId = null;

    if (isProjectOnly) {
      const familyResult = await client.query(
        `SELECT id,code,name,category_id,brand_id,collection_id FROM project_product_families WHERE id=$1 AND is_active=TRUE LIMIT 1`,
        [project_family_id]
      );
      if (familyResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({success:false,message:"La familia técnica seleccionada no existe o está desactivada"});
      }
      const selectedFamily = familyResult.rows[0];
      resolvedProjectFamilyId = selectedFamily.id;

      if (
        selectedFamily.category_id &&
        selectedFamily.category_id !==
          category_id
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La categoría del producto no coincide con la familia técnica seleccionada",
        });
      }

      if (
        selectedFamily.brand_id &&
        selectedFamily.brand_id !==
          resolvedBrandId
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La marca del producto no coincide con la familia técnica seleccionada",
        });
      }

      if (
        selectedFamily.collection_id &&
        selectedFamily.collection_id !==
          collection_id
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La colección del producto no coincide con la familia técnica seleccionada",
        });
      }
    }

    const resolvedRelbaseProductId = isProjectOnly ? null : (relbase_product_id || null);
    const resolvedBasePrice = isProjectOnly ? null : (base_price ?? null);
    const resolvedAllowSale = isProjectOnly ? false : allow_sale;

    /* =========================================
       VALIDAR SKU
    ========================================= */
    const skuResult = await client.query(
      `
        SELECT id
        FROM products
        WHERE UPPER(sku) = UPPER($1)
        LIMIT 1
      `,
      [sku]
    );

    if (skuResult.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "Ya existe un producto con este SKU",
      });
    }

    /* =========================================
       VALIDAR SLUG
    ========================================= */
    const slugResult = await client.query(
      `
        SELECT id
        FROM products
        WHERE slug = $1
        LIMIT 1
      `,
      [slug]
    );

    if (slugResult.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "Ya existe un producto con este nombre o slug",
      });
    }

    /* =========================================
       INSERTAR PRODUCTO
    ========================================= */
    const result = await client.query(
      `
        INSERT INTO products (
          category_id,brand_id,collection_id,commercial_mode,project_family_id,
          sku,internal_code,relbase_product_id,name,slug,short_description,description,
          base_price,tax_rate,width_mm,height_mm,thickness_mm,weight_kg,color,finish,texture,
          is_active,is_published,is_featured,allow_sale,sort_order
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
        )
        RETURNING
          id,category_id,brand_id,collection_id,commercial_mode,project_family_id,
          sku,internal_code,relbase_product_id,name,slug,short_description,description,
          base_price,tax_rate,width_mm,height_mm,thickness_mm,weight_kg,color,finish,texture,
          is_active,is_published,is_featured,allow_sale,sort_order,created_at,updated_at
      `,
      [
        category_id,resolvedBrandId,collection_id || null,resolvedCommercialMode,resolvedProjectFamilyId,
        sku,internal_code || null,resolvedRelbaseProductId,name,slug,short_description || null,description || null,
        resolvedBasePrice,tax_rate,
        isProjectOnly ? null : (width_mm ?? null),
        isProjectOnly ? null : (height_mm ?? null),
        isProjectOnly ? null : (thickness_mm ?? null),
        isProjectOnly ? null : (weight_kg ?? null),isProjectOnly ? null : (color || null),isProjectOnly ? null : (finish || null),texture || null,
        is_active,is_published,is_featured,resolvedAllowSale,sort_order,
      ]
    );

    const createdItalyPriceUsd =
      await syncCurrentItalyPriceUsd({
        client,
        productId:
          result.rows[0].id,
        priceUsd:
          italy_price_usd,
        userId:
          req.user?.id ||
          null,
      });

    await client.query("COMMIT");

    localCommitted = true;

    const createdProduct = {
      ...result.rows[0],
      italy_price_usd:
        createdItalyPriceUsd,
    };

    /* =========================================
       VINCULAR / CREAR EN RELBASE

       La creación local NO se revierte si
       Relbase falla. De esa forma evitamos
       duplicar el SKU local en un reintento.
    ========================================= */
    let relbaseProvision =
      null;

    try {
      if (
        createdProduct.commercial_mode === "WEB" &&
        createdProduct.allow_sale === true
      ) {
        relbaseProvision =
          await ensureRelbaseProductForLocalProduct(
            createdProduct.id
          );
      }
    } catch (relbaseError) {
      console.error(
        "Producto creado localmente, pero la provisión Relbase quedó pendiente:",
        {
          product_id:
            createdProduct.id,
          sku:
            createdProduct.sku,
          message:
            relbaseError?.message ||
            null,
          code:
            relbaseError?.code ||
            null,
          status:
            relbaseError?.status ||
            null,
        }
      );

      relbaseProvision = {
        success:
          false,
        action:
          "PENDING",
        message:
          relbaseError?.message ||
          "La vinculación con Relbase quedó pendiente",
        code:
          relbaseError?.code ||
          null,
      };
    }

    let finalProduct =
      createdProduct;

    try {
      const refreshedProductResult =
        await pool.query(
          `
            SELECT
              id,
              category_id,
              brand_id,
              collection_id,
              commercial_mode,
              project_family_id,
              sku,
              internal_code,
              relbase_product_id,
              name,
              slug,
              short_description,
              description,
              base_price,
              (
                SELECT pip.price_usd
                FROM product_italy_prices pip
                WHERE pip.product_id = products.id
                  AND pip.valid_until IS NULL
                ORDER BY pip.valid_from DESC
                LIMIT 1
              ) AS italy_price_usd,
              tax_rate,
              width_mm,
              height_mm,
              thickness_mm,
              weight_kg,
              color,
              finish,
              texture,
              is_active,
              is_published,
              is_featured,
              allow_sale,
              sort_order,
              created_at,
              updated_at
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [createdProduct.id]
        );

      finalProduct =
        refreshedProductResult.rows[0] ||
        createdProduct;
    } catch (refreshError) {
      console.error(
        "Producto creado, pero no fue posible refrescar la respuesta final:",
        refreshError
      );
    }

    return res.status(201).json({
      success: true,
      message:
        finalProduct.commercial_mode === "PROJECT_ONLY"
          ? "Producto de proyecto creado correctamente"
          : relbaseProvision?.success
            ? relbaseProvision.action === "CREATED_IN_RELBASE"
              ? "Producto creado en Laminatiword y Relbase correctamente"
              : "Producto creado y vinculado con Relbase correctamente"
            : "Producto creado en Laminatiword. La vinculación con Relbase quedó pendiente.",
      product:
        finalProduct,
      relbase:
        relbaseProvision,
    });
  } catch (error) {
    if (!localCommitted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Transacción ya finalizada.
      }
    }

    console.error(
      "Error creando producto:",
      error
    );

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "Ya existe un producto con este SKU o slug",
      });
    }

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message:
          "Una de las relaciones del producto no es válida",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible crear el producto",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ACTUALIZAR PRODUCTO
========================================= */
export const updateAdminProduct = async (req, res) => {
  const { id } = req.params;

  const validation = updateProductSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de producto inválidos",
      errors: validation.error.issues,
    });
  }

  const data = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       OBTENER PRODUCTO ACTUAL
    ========================================= */
    const currentResult = await client.query(
      `
        SELECT *
        FROM products
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [id]
    );

    if (currentResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    const currentProduct = currentResult.rows[0];

    /* =========================================
       RESOLVER VALORES FINALES
    ========================================= */
    let finalCategoryId =
      data.category_id !== undefined
        ? data.category_id
        : currentProduct.category_id;

    let finalBrandId =
      Object.prototype.hasOwnProperty.call(
        data,
        "brand_id"
      )
        ? data.brand_id
        : currentProduct.brand_id;

    let finalCollectionId =
      Object.prototype.hasOwnProperty.call(
        data,
        "collection_id"
      )
        ? data.collection_id
        : currentProduct.collection_id;

    /* =========================================
       VALIDAR CATEGORÍA
    ========================================= */
    const categoryResult = await client.query(
      `
        SELECT id
        FROM categories
        WHERE id = $1
        LIMIT 1
      `,
      [finalCategoryId]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "La categoría seleccionada no existe",
      });
    }

    /* =========================================
       VALIDAR MARCA
    ========================================= */
    if (finalBrandId) {
      const brandResult = await client.query(
        `
          SELECT id
          FROM brands
          WHERE id = $1
          LIMIT 1
        `,
        [finalBrandId]
      );

      if (brandResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La marca seleccionada no existe",
        });
      }
    }

    /* =========================================
       VALIDAR COLECCIÓN Y MARCA
    ========================================= */
    if (finalCollectionId) {
      const collectionResult = await client.query(
        `
          SELECT
            id,
            brand_id
          FROM collections
          WHERE id = $1
          LIMIT 1
        `,
        [finalCollectionId]
      );

      if (collectionResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "La colección seleccionada no existe",
        });
      }

      const collection = collectionResult.rows[0];

      if (collection.brand_id) {
        if (
          finalBrandId &&
          finalBrandId !== collection.brand_id
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              "La colección seleccionada no pertenece a la marca indicada",
          });
        }

        if (!finalBrandId) {
          finalBrandId = collection.brand_id;
        }
      }
    }

    /* =========================================
       VALIDAR SKU
    ========================================= */
    const finalSku =
      data.sku !== undefined
        ? data.sku
        : currentProduct.sku;

    if (data.sku !== undefined) {
      const skuResult = await client.query(
        `
          SELECT id
          FROM products
          WHERE UPPER(sku) = UPPER($1)
            AND id <> $2
          LIMIT 1
        `,
        [finalSku, id]
      );

      if (skuResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "Ya existe otro producto con este SKU",
        });
      }
    }

    /* =========================================
       GENERAR SLUG SI CAMBIA NOMBRE
    ========================================= */
    let finalSlug = currentProduct.slug;

    if (data.name !== undefined) {
      finalSlug = generateSlug(data.name);

      const slugResult = await client.query(
        `
          SELECT id
          FROM products
          WHERE slug = $1
            AND id <> $2
          LIMIT 1
        `,
        [finalSlug, id]
      );

      if (slugResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Ya existe otro producto con este nombre o slug",
        });
      }
    }

    /* =========================================
       MODALIDAD COMERCIAL / FAMILIA TÉCNICA
    ========================================= */
    const finalCommercialMode = data.commercial_mode !== undefined ? data.commercial_mode : (currentProduct.commercial_mode || "WEB");
    const finalIsProjectOnly = finalCommercialMode === "PROJECT_ONLY";
    let finalProjectFamilyId = Object.prototype.hasOwnProperty.call(data,"project_family_id") ? data.project_family_id : currentProduct.project_family_id;

    if (finalIsProjectOnly) {
      if (!finalProjectFamilyId) {
        await client.query("ROLLBACK");
        return res.status(400).json({success:false,message:"Los productos de proyecto deben indicar una familia técnica"});
      }
      const familyResult = await client.query(
        `SELECT id,category_id,brand_id,collection_id FROM project_product_families WHERE id=$1 AND is_active=TRUE LIMIT 1`,
        [finalProjectFamilyId]
      );
      if (familyResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({success:false,message:"La familia técnica seleccionada no existe o está desactivada"});
      }

      const selectedFamily = familyResult.rows[0];

      if (
        selectedFamily.category_id &&
        selectedFamily.category_id !==
          finalCategoryId
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La categoría del producto no coincide con la familia técnica seleccionada",
        });
      }

      if (
        selectedFamily.brand_id &&
        selectedFamily.brand_id !==
          finalBrandId
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La marca del producto no coincide con la familia técnica seleccionada",
        });
      }

      if (
        selectedFamily.collection_id &&
        selectedFamily.collection_id !==
          finalCollectionId
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "La colección del producto no coincide con la familia técnica seleccionada",
        });
      }
    } else {
      finalProjectFamilyId = null;
    }

    /* =========================================
       CONSTRUIR UPDATE DE FORMA SEGURA
    ========================================= */
    const updateData = {
      category_id: finalCategoryId,
      brand_id: finalBrandId,
      collection_id: finalCollectionId,
      commercial_mode: finalCommercialMode,
      project_family_id: finalProjectFamilyId,
      sku: finalSku,
      slug: finalSlug,
    };

    if (finalIsProjectOnly) {
      updateData.relbase_product_id = null;
      updateData.base_price = null;
      updateData.width_mm = null;
      updateData.height_mm = null;
      updateData.thickness_mm = null;
      updateData.weight_kg = null;
      updateData.color = null;
      updateData.finish = null;
      updateData.allow_sale = false;
    }

    const optionalFields = [
      "internal_code",
      "relbase_product_id",
      "name",
      "short_description",
      "description",
      "base_price",
      "tax_rate",
      "width_mm",
      "height_mm",
      "thickness_mm",
      "weight_kg",
      "color",
      "finish",
      "texture",
      "is_active",
      "is_published",
      "is_featured",
      "allow_sale",
      "sort_order",
    ];

    for (const field of optionalFields) {
      if (
        finalIsProjectOnly &&
        ["relbase_product_id","base_price","width_mm","height_mm","thickness_mm","weight_kg","color","finish","allow_sale"].includes(field)
      ) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        updateData[field] = data[field];
      }
    }

    const fields = Object.keys(updateData);

    const values = Object.values(updateData);

    const setClause = fields
      .map(
        (field, index) =>
          `${field} = $${index + 1}`
      )
      .join(", ");

    values.push(id);

    const result = await client.query(
      `
        UPDATE products
        SET ${setClause}
        WHERE id = $${values.length}

        RETURNING
          id,
          category_id,
          brand_id,
          collection_id,

          commercial_mode,
          project_family_id,

          sku,
          internal_code,
          relbase_product_id,

          name,
          slug,
          short_description,
          description,

          base_price,
          tax_rate,

          width_mm,
          height_mm,
          thickness_mm,
          weight_kg,

          color,
          finish,
          texture,

          is_active,
          is_published,
          is_featured,
          allow_sale,
          sort_order,

          created_at,
          updated_at
      `,
      values
    );

    const updatedItalyPriceUsd =
      await syncCurrentItalyPriceUsd({
        client,
        productId:
          id,
        priceUsd:
          Object.prototype.hasOwnProperty.call(
            data,
            "italy_price_usd"
          )
            ? data.italy_price_usd
            : undefined,
        userId:
          req.user?.id ||
          null,
      });

    await client.query("COMMIT");

    let finalProduct = {
      ...result.rows[0],
      italy_price_usd:
        updatedItalyPriceUsd,
    };

    let relbaseProvision =
      null;

    /*
     * Reintento seguro de provisión:
     * si un producto vendible quedó localmente creado
     * pero sin ID Relbase, guardar una edición vuelve
     * a intentar buscarlo / crearlo / vincularlo.
     */
    if (
      finalProduct.commercial_mode === "WEB" &&
      finalProduct.allow_sale === true &&
      !finalProduct.relbase_product_id
    ) {
      try {
        relbaseProvision =
          await ensureRelbaseProductForLocalProduct(
            finalProduct.id
          );

        const refreshed =
          await pool.query(
            `
              SELECT
                id,
                category_id,
                brand_id,
                collection_id,
                commercial_mode,
                project_family_id,
                sku,
                internal_code,
                relbase_product_id,
                name,
                slug,
                short_description,
                description,
                base_price,
                (
                  SELECT pip.price_usd
                  FROM product_italy_prices pip
                  WHERE pip.product_id = products.id
                    AND pip.valid_until IS NULL
                  ORDER BY pip.valid_from DESC
                  LIMIT 1
                ) AS italy_price_usd,
                tax_rate,
                width_mm,
                height_mm,
                thickness_mm,
                weight_kg,
                color,
                finish,
                texture,
                is_active,
                is_published,
                is_featured,
                allow_sale,
                sort_order,
                created_at,
                updated_at
              FROM products
              WHERE id = $1
              LIMIT 1
            `,
            [
              finalProduct.id,
            ]
          );

        finalProduct =
          refreshed.rows[0] ||
          finalProduct;
      } catch (relbaseError) {
        console.error(
          "Producto actualizado localmente, pero la provisión Relbase continúa pendiente:",
          {
            product_id:
              finalProduct.id,
            sku:
              finalProduct.sku,
            message:
              relbaseError?.message ||
              null,
            code:
              relbaseError?.code ||
              null,
            status:
              relbaseError?.status ||
              null,
          }
        );

        relbaseProvision = {
          success:
            false,
          action:
            "PENDING",
          message:
            relbaseError?.message ||
            "La vinculación con Relbase continúa pendiente",
          code:
            relbaseError?.code ||
            null,
        };
      }
    }

    return res.status(200).json({
      success: true,
      message:
        finalProduct.commercial_mode === "PROJECT_ONLY"
          ? "Producto de proyecto actualizado correctamente"
          : relbaseProvision?.success
            ? relbaseProvision.action === "CREATED_IN_RELBASE"
              ? "Producto actualizado y creado en Relbase correctamente"
              : "Producto actualizado y vinculado con Relbase correctamente"
            : relbaseProvision
              ? "Producto actualizado. La vinculación con Relbase continúa pendiente."
              : "Producto actualizado correctamente",
      product:
        finalProduct,
      relbase:
        relbaseProvision,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error actualizando producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "Ya existe un producto con este SKU o slug",
      });
    }

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message:
          "Una de las relaciones del producto no es válida",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible actualizar el producto",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR / ARCHIVAR PRODUCTO
========================================= */
export const deleteAdminProduct = async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       OBTENER PRODUCTO
    ========================================= */
    const productResult = await client.query(
      `
        SELECT
          id,
          sku,
          name,
          slug,
          relbase_product_id,
          is_active,
          is_published,
          allow_sale
        FROM products
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [id]
    );

    if (productResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    const product = productResult.rows[0];

    /* =========================================
       VALIDAR RESERVAS ACTIVAS
    ========================================= */
    const reservationsResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM inventory_reservations ir

        JOIN inventory i
          ON i.id = ir.inventory_id

        WHERE i.product_id = $1
          AND (
            ir.status = 'CONFIRMED'
            OR (
              ir.status = 'ACTIVE'
              AND (
                ir.expires_at IS NULL
                OR ir.expires_at > NOW()
              )
            )
          )
      `,
      [id]
    );

    const reservationsCount = Number(
      reservationsResult.rows[0].total
    );

    if (reservationsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar este producto porque tiene reservas de stock activas",
        active_reservations: reservationsCount,
      });
    }

    /* =========================================
       VALIDAR CARRITOS ACTIVOS
    ========================================= */
    const cartsResult = await client.query(
      `
        SELECT COUNT(*) AS total

        FROM cart_items ci

        JOIN carts c
          ON c.id = ci.cart_id

        WHERE ci.product_id = $1
          AND c.status = 'ACTIVE'
      `,
      [id]
    );

    const activeCartsCount = Number(
      cartsResult.rows[0].total
    );

    if (activeCartsCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "No puedes eliminar este producto porque se encuentra en carritos activos",
        active_carts: activeCartsCount,
      });
    }

    /* =========================================
       VALIDAR HISTORIAL DE PEDIDOS
    ========================================= */
    const ordersResult = await client.query(
      `
        SELECT COUNT(*) AS total
        FROM order_items
        WHERE product_id = $1
      `,
      [id]
    );

    const ordersCount = Number(
      ordersResult.rows[0].total
    );

    /* =========================================
       SI TIENE HISTORIAL O RELBASE:
       ARCHIVAR, NO ELIMINAR
    ========================================= */
    if (
      ordersCount > 0 ||
      product.relbase_product_id
    ) {
      const archivedResult = await client.query(
        `
          UPDATE products
          SET
            is_active = FALSE,
            is_published = FALSE,
            is_featured = FALSE,
            allow_sale = FALSE
          WHERE id = $1

          RETURNING
            id,
            sku,
            name,
            slug,
            relbase_product_id,
            is_active,
            is_published,
            is_featured,
            allow_sale,
            updated_at
        `,
        [id]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        action: "ARCHIVED",
        message:
          "El producto tiene historial comercial o está asociado a Relbase, por lo que fue archivado en lugar de eliminarse",
        order_items_count: ordersCount,
        product: archivedResult.rows[0],
      });
    }

    /* =========================================
       PRODUCTO SIN HISTORIAL:
       ELIMINACIÓN FÍSICA
    ========================================= */
    const deletedResult = await client.query(
      `
        DELETE FROM products
        WHERE id = $1

        RETURNING
          id,
          sku,
          name,
          slug
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      action: "DELETED",
      message: "Producto eliminado correctamente",
      product: deletedResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error eliminando producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    if (error.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "El producto mantiene relaciones que impiden su eliminación",
      });
    }

    return res.status(500).json({
      success: false,
      message: "No fue posible eliminar el producto",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   LISTAR IMÁGENES DE UN PRODUCTO
========================================= */
export const getAdminProductImages = async (req, res) => {
  const { productId } = req.params;

  try {
    const productResult = await pool.query(
      `
        SELECT
          id,
          sku,
          name
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
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
          original_filename,
          source_width,
          source_height,
          source_bytes,

          created_at
        FROM product_images
        WHERE product_id = $1
        ORDER BY
          is_primary DESC,
          sort_order ASC,
          created_at ASC
      `,
      [productId]
    );

    const images = await Promise.all(
      result.rows.map(async (image) => {
        const baseImage = {
          id: image.id,
          product_id: image.product_id,
          image_url: image.image_url || null,
          alt_text: image.alt_text || null,
          is_primary: image.is_primary === true,
          sort_order: image.sort_order,

          storage_provider:
            image.storage_provider || null,

          image_type:
            image.image_type || null,

          original_filename:
            image.original_filename || null,

          source_width:
            image.source_width || null,

          source_height:
            image.source_height || null,

          source_bytes:
            image.source_bytes || null,

          created_at: image.created_at,
        };

        /* =====================================
           URL EXTERNA / LEGACY
        ===================================== */
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

        /* =====================================
           RAILWAY STORAGE PRIVADO
           GENERAR URLS FIRMADAS
        ===================================== */
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
           * Una falla generando una URL temporal
           * no debe impedir administrar el resto
           * de las imágenes del producto.
           */
          console.error(
            "Error generando URLs administrativas de imagen:",
            {
              image_id: image.id,
              product_id:
                image.product_id,
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
      })
    );

    return res.status(200).json({
      success: true,
      product:
        productResult.rows[0],

      count:
        images.length,

      images,
    });
  } catch (error) {
    console.error(
      "Error obteniendo imágenes del producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message:
          "ID de producto inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener las imágenes del producto",
    });
  }
};

/* =========================================
   AGREGAR IMAGEN A PRODUCTO
   - Compatible con URL externa anterior
   - Compatible con Railway Storage
========================================= */
export const createAdminProductImage = async (req, res) => {
  const { productId } = req.params;

  const hasUploadedFile =
    Boolean(req.file?.buffer);

  /* =========================================
     MODO ANTERIOR
     JSON + image_url
  ========================================= */
  if (!hasUploadedFile) {
    const validation =
      createProductImageSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Datos de imagen inválidos",
        errors: validation.error.issues,
      });
    }

    const {
      image_url,
      alt_text,
      is_primary,
      sort_order,
    } = validation.data;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      /* =========================================
         VALIDAR PRODUCTO
      ========================================= */
      const productResult = await client.query(
        `
          SELECT
            id,
            sku,
            name
          FROM products
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [productId]
      );

      if (productResult.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Producto no encontrado",
        });
      }

      /* =========================================
         EVITAR MISMA URL EN EL MISMO PRODUCTO
      ========================================= */
      const duplicateResult = await client.query(
        `
          SELECT id
          FROM product_images
          WHERE product_id = $1
            AND image_url = $2
          LIMIT 1
        `,
        [productId, image_url]
      );

      if (duplicateResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Esta imagen ya está asociada al producto",
        });
      }

      /* =========================================
         DETERMINAR SI SERÁ PRINCIPAL
      ========================================= */
      const countResult = await client.query(
        `
          SELECT COUNT(*) AS total
          FROM product_images
          WHERE product_id = $1
        `,
        [productId]
      );

      const imagesCount = Number(
        countResult.rows[0].total
      );

      /*
       * La primera imagen siempre será principal.
       * En las siguientes se respeta is_primary.
       */
      const shouldBePrimary =
        imagesCount === 0 || is_primary === true;

      /* =========================================
         SI ES PRINCIPAL, QUITAR PRINCIPAL ANTERIOR
      ========================================= */
      if (shouldBePrimary) {
        await client.query(
          `
            UPDATE product_images
            SET is_primary = FALSE
            WHERE product_id = $1
              AND is_primary = TRUE
          `,
          [productId]
        );
      }

      /* =========================================
         INSERTAR IMAGEN EXTERNA
      ========================================= */
      const result = await client.query(
        `
          INSERT INTO product_images (
            product_id,
            image_url,
            alt_text,
            is_primary,
            sort_order
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )

          RETURNING
            id,
            product_id,
            image_url,
            alt_text,
            is_primary,
            sort_order,
            created_at
        `,
        [
          productId,
          image_url,
          alt_text || null,
          shouldBePrimary,
          sort_order,
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Imagen agregada correctamente",
        storage: "EXTERNAL_URL",
        image: result.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error(
        "Error agregando imagen al producto:",
        error
      );

      if (error.code === "22P02") {
        return res.status(400).json({
          success: false,
          message: "ID de producto inválido",
        });
      }

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message:
            "No fue posible establecer la imagen principal",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          "No fue posible agregar la imagen al producto",
      });
    } finally {
      client.release();
    }
  }

  /* =========================================
     MODO NUEVO
     ARCHIVO + RAILWAY STORAGE
  ========================================= */
  const imageType = String(
    req.body.image_type || "gallery"
  )
    .trim()
    .toLowerCase();

  const altText = req.body.alt_text
    ? String(req.body.alt_text).trim()
    : null;

  const originalFilename = String(
    req.file.originalname || "image"
  ).trim();

  /* =========================================
     VALIDAR IMAGE TYPE
  ========================================= */
  if (
    !imageType ||
    imageType.length > 50 ||
    !/^[a-z0-9_-]+$/.test(imageType)
  ) {
    return res.status(400).json({
      success: false,
      message: "image_type no es válido",
    });
  }

  /* =========================================
     VALIDAR ALT TEXT
  ========================================= */
  if (
    altText &&
    altText.length > 255
  ) {
    return res.status(400).json({
      success: false,
      message:
        "alt_text no puede superar 255 caracteres",
    });
  }

  /* =========================================
     VALIDAR NOMBRE ORIGINAL
  ========================================= */
  if (originalFilename.length > 255) {
    return res.status(400).json({
      success: false,
      message:
        "El nombre del archivo no puede superar 255 caracteres",
    });
  }

  /* =========================================
     PARSEAR IS PRIMARY
  ========================================= */
  let isPrimary = false;

  if (
    req.body.is_primary !== undefined
  ) {
    const value = String(
      req.body.is_primary
    )
      .trim()
      .toLowerCase();

    if (
      value === "true" ||
      value === "1"
    ) {
      isPrimary = true;
    } else if (
      value === "false" ||
      value === "0"
    ) {
      isPrimary = false;
    } else {
      return res.status(400).json({
        success: false,
        message:
          "is_primary debe ser true o false",
      });
    }
  }

  /* =========================================
     PARSEAR SORT ORDER
  ========================================= */
  let sortOrder = 0;

  if (
    req.body.sort_order !== undefined &&
    req.body.sort_order !== ""
  ) {
    sortOrder = Number(
      req.body.sort_order
    );

    if (
      !Number.isInteger(sortOrder) ||
      sortOrder < 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "sort_order debe ser un entero mayor o igual a 0",
      });
    }
  }

  /* =========================================
     VALIDAR PRODUCTO
  ========================================= */
  let product;

  try {
    const productResult =
      await pool.query(
        `
          SELECT
            id,
            sku,
            name
          FROM products
          WHERE id = $1
          LIMIT 1
        `,
        [productId]
      );

    if (
      productResult.rowCount === 0
    ) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    product = productResult.rows[0];
  } catch (error) {
    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    console.error(
      "Error validando producto:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible validar el producto",
    });
  }

  /* =========================================
     ID DEFINITIVO DE LA IMAGEN
  ========================================= */
  const imageId = randomUUID();

  let storageResult = null;

  /* =========================================
     SHARP + RAILWAY STORAGE
  ========================================= */
  try {
    storageResult =
      await uploadProductImage({
        buffer: req.file.buffer,
        sku: product.sku,
        imageType,
        imageId,
      });
  } catch (error) {
    console.error(
      "Error procesando imagen de producto:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible procesar o almacenar la imagen",
    });
  }

  const uploadedKeys = [
    storageResult?.variants?.thumbnail?.key,
    storageResult?.variants?.card?.key,
    storageResult?.variants?.detail?.key,
  ].filter(Boolean);

  /* =========================================
     GUARDAR EN POSTGRESQL
  ========================================= */
  const client = await pool.connect();

  let persisted = false;
  let insertedImage = null;

  try {
    await client.query("BEGIN");

    /*
     * Volvemos a bloquear el producto para evitar
     * inconsistencias con imágenes principales
     * concurrentes.
     */
    const lockedProduct =
      await client.query(
        `
          SELECT id
          FROM products
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [productId]
      );

    if (
      lockedProduct.rowCount === 0
    ) {
      const notFoundError = new Error(
        "Producto no encontrado"
      );

      notFoundError.status = 404;

      throw notFoundError;
    }

    const countResult =
      await client.query(
        `
          SELECT COUNT(*) AS total
          FROM product_images
          WHERE product_id = $1
        `,
        [productId]
      );

    const imagesCount = Number(
      countResult.rows[0].total
    );

    /*
     * La primera imagen siempre queda
     * como principal.
     */
    const shouldBePrimary =
      imagesCount === 0 ||
      isPrimary === true;

    if (shouldBePrimary) {
      await client.query(
        `
          UPDATE product_images
          SET is_primary = FALSE
          WHERE product_id = $1
            AND is_primary = TRUE
        `,
        [productId]
      );
    }

    const result =
      await client.query(
        `
          INSERT INTO product_images (
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
            original_filename,
            source_width,
            source_height,
            source_bytes
          )
          VALUES (
            $1,
            $2,
            NULL,
            $3,
            $4,
            $5,
            'RAILWAY',
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13
          )

          RETURNING
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
            original_filename,
            source_width,
            source_height,
            source_bytes,
            created_at
        `,
        [
          imageId,
          productId,
          altText,
          shouldBePrimary,
          sortOrder,
          imageType,
          storageResult.variants.thumbnail.key,
          storageResult.variants.card.key,
          storageResult.variants.detail.key,
          originalFilename,
          storageResult.source.width,
          storageResult.source.height,
          storageResult.source.bytes,
        ]
      );

    insertedImage = result.rows[0];

    await client.query("COMMIT");

    persisted = true;
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error guardando imagen Railway:",
      error
    );

    /*
     * Si PostgreSQL falla, eliminamos
     * automáticamente los objetos que
     * ya se habían subido a Railway.
     */
    if (
      !persisted &&
      uploadedKeys.length > 0
    ) {
      try {
        await deleteProductImageVariants(
          uploadedKeys
        );
      } catch (cleanupError) {
        console.error(
          "Error limpiando archivos de Railway:",
          cleanupError
        );
      }
    }

    if (error.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "No fue posible establecer la imagen principal",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "La imagen fue procesada, pero no pudo registrarse",
    });
  } finally {
    client.release();
  }

  /* =========================================
     URLS TEMPORALES PARA RESPUESTA
     Si fallan, NO deshacemos el INSERT.
  ========================================= */
  let urls = {
    thumbnail: null,
    card: null,
    detail: null,
  };

  try {
    const [
      thumbnailUrl,
      cardUrl,
      detailUrl,
    ] = await Promise.all([
      getProductImageSignedUrl(
        insertedImage.thumbnail_key
      ),
      getProductImageSignedUrl(
        insertedImage.card_key
      ),
      getProductImageSignedUrl(
        insertedImage.detail_key
      ),
    ]);

    urls = {
      thumbnail: thumbnailUrl,
      card: cardUrl,
      detail: detailUrl,
    };
  } catch (error) {
    console.error(
      "No fue posible generar URLs firmadas:",
      error
    );
  }

  return res.status(201).json({
    success: true,
    message: "Imagen subida correctamente",
    storage: "RAILWAY",

    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
    },

    image: insertedImage,

    variants: {
      thumbnail:
        storageResult.variants.thumbnail,
      card:
        storageResult.variants.card,
      detail:
        storageResult.variants.detail,
    },

    urls,
  });
};

/* =========================================
   ACTUALIZAR IMAGEN DE PRODUCTO
========================================= */
export const updateAdminProductImage = async (req, res) => {
  const {
    productId,
    imageId,
  } = req.params;

  const validation =
    updateProductImageSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de imagen inválidos",
      errors: validation.error.issues,
    });
  }

  const data = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR PRODUCTO
    ========================================= */
    const productResult = await client.query(
      `
        SELECT id
        FROM products
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    /* =========================================
       OBTENER IMAGEN
    ========================================= */
    const imageResult = await client.query(
      `
        SELECT
          id,
          product_id,
          image_url,
          alt_text,
          is_primary,
          sort_order
        FROM product_images
        WHERE id = $1
          AND product_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [
        imageId,
        productId,
      ]
    );

    if (imageResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Imagen no encontrada",
      });
    }

    const currentImage =
      imageResult.rows[0];

    /* =========================================
       VALIDAR URL DUPLICADA
    ========================================= */
    if (data.image_url !== undefined) {
      const duplicateResult =
        await client.query(
          `
            SELECT id
            FROM product_images
            WHERE product_id = $1
              AND image_url = $2
              AND id <> $3
            LIMIT 1
          `,
          [
            productId,
            data.image_url,
            imageId,
          ]
        );

      if (duplicateResult.rowCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Esta imagen ya está asociada al producto",
        });
      }
    }

    /* =========================================
       ESTABLECER COMO PRINCIPAL
    ========================================= */
    if (data.is_primary === true) {
      await client.query(
        `
          UPDATE product_images
          SET is_primary = FALSE
          WHERE product_id = $1
            AND id <> $2
            AND is_primary = TRUE
        `,
        [
          productId,
          imageId,
        ]
      );
    }

    /* =========================================
       EVITAR QUEDAR SIN IMAGEN PRINCIPAL
    ========================================= */
    let finalIsPrimary =
      data.is_primary !== undefined
        ? data.is_primary
        : currentImage.is_primary;

    if (
      currentImage.is_primary === true &&
      data.is_primary === false
    ) {
      const nextImageResult =
        await client.query(
          `
            SELECT id
            FROM product_images
            WHERE product_id = $1
              AND id <> $2
            ORDER BY
              sort_order ASC,
              created_at ASC
            LIMIT 1
          `,
          [
            productId,
            imageId,
          ]
        );

      if (nextImageResult.rowCount === 0) {
        /*
         * Si es la única imagen,
         * debe continuar siendo principal.
         */
        finalIsPrimary = true;
      } else {
        await client.query(
          `
            UPDATE product_images
            SET is_primary = TRUE
            WHERE id = $1
          `,
          [
            nextImageResult.rows[0].id,
          ]
        );
      }
    }

    /* =========================================
       ACTUALIZAR
    ========================================= */
    const hasImageUrl =
      Object.prototype.hasOwnProperty.call(
        data,
        "image_url"
      );

    const hasAltText =
      Object.prototype.hasOwnProperty.call(
        data,
        "alt_text"
      );

    const hasSortOrder =
      Object.prototype.hasOwnProperty.call(
        data,
        "sort_order"
      );

    const result = await client.query(
      `
        UPDATE product_images
        SET
          image_url = CASE
            WHEN $1::boolean = TRUE
              THEN $2
            ELSE image_url
          END,

          alt_text = CASE
            WHEN $3::boolean = TRUE
              THEN $4
            ELSE alt_text
          END,

          is_primary = $5,

          sort_order = CASE
            WHEN $6::boolean = TRUE
              THEN $7
            ELSE sort_order
          END

        WHERE id = $8
          AND product_id = $9

        RETURNING
          id,
          product_id,
          image_url,
          alt_text,
          is_primary,
          sort_order,
          created_at
      `,
      [
        hasImageUrl,
        data.image_url ?? null,

        hasAltText,
        data.alt_text ?? null,

        finalIsPrimary,

        hasSortOrder,
        data.sort_order ?? null,

        imageId,
        productId,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Imagen actualizada correctamente",
      image: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error actualizando imagen:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID inválido",
      });
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "Ya existe una imagen principal para este producto",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar la imagen",
    });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR IMAGEN DE PRODUCTO
========================================= */
export const deleteAdminProductImage = async (req, res) => {
  const {
    productId,
    imageId,
  } = req.params;

  const client = await pool.connect();

  let image = null;
  let newPrimaryImage = null;

  try {
    await client.query("BEGIN");

    const imageResult =
      await client.query(
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
            original_filename,

            created_at
          FROM product_images
          WHERE id = $1
            AND product_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [
          imageId,
          productId,
        ]
      );

    if (
      imageResult.rowCount === 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res.status(404).json({
        success: false,
        message:
          "Imagen no encontrada",
      });
    }

    image =
      imageResult.rows[0];

    /* =========================================
       ELIMINAR REFERENCIA DE POSTGRESQL
    ========================================= */
    await client.query(
      `
        DELETE FROM product_images
        WHERE id = $1
          AND product_id = $2
      `,
      [
        imageId,
        productId,
      ]
    );

    /* =========================================
       SI ERA PRINCIPAL:
       PROMOVER OTRA IMAGEN
    ========================================= */
    if (image.is_primary) {
      const nextImageResult =
        await client.query(
          `
            SELECT id
            FROM product_images
            WHERE product_id = $1
            ORDER BY
              sort_order ASC,
              created_at ASC
            LIMIT 1
          `,
          [productId]
        );

      if (
        nextImageResult.rowCount >
        0
      ) {
        const promotedResult =
          await client.query(
            `
              UPDATE product_images
              SET is_primary = TRUE
              WHERE id = $1

              RETURNING
                id,
                product_id,
                image_url,
                alt_text,
                is_primary,
                sort_order,
                storage_provider,
                image_type,
                original_filename,
                created_at
            `,
            [
              nextImageResult
                .rows[0]
                .id,
            ]
          );

        newPrimaryImage =
          promotedResult.rows[0];
      }
    }

    await client.query(
      "COMMIT"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Error eliminando imagen:",
      error
    );

    if (
      error.code === "22P02"
    ) {
      return res.status(400).json({
        success: false,
        message: "ID inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible eliminar la imagen",
    });
  } finally {
    client.release();
  }

  /* =========================================
     LIMPIAR VARIANTES DE RAILWAY STORAGE

     Primero confirmamos PostgreSQL para evitar
     dejar una referencia activa apuntando a
     archivos que ya no existen.

     Si Railway falla, la imagen igualmente
     desaparece del catálogo y se informa la
     limpieza pendiente.
  ========================================= */
  const storageKeys = [
    image?.thumbnail_key,
    image?.card_key,
    image?.detail_key,
  ].filter(Boolean);

  const storageCleanup = {
    attempted: false,
    success: true,
    keys_count:
      storageKeys.length,
  };

  let warning = null;

  if (
    image?.storage_provider ===
      "RAILWAY" &&
    storageKeys.length > 0
  ) {
    storageCleanup.attempted =
      true;

    try {
      await deleteProductImageVariants(
        storageKeys
      );
    } catch (storageError) {
      storageCleanup.success =
        false;

      warning =
        "La imagen fue eliminada del catálogo, pero no fue posible limpiar todas sus variantes de Railway Storage.";

      console.error(
        "Error eliminando variantes de Railway Storage:",
        {
          image_id:
            image.id,

          product_id:
            image.product_id,

          keys:
            storageKeys,

          error:
            storageError,
        }
      );
    }
  }

  return res.status(200).json({
    success: true,

    message:
      warning ||
      "Imagen eliminada correctamente",

    warning,

    deleted_image: {
      id:
        image.id,

      product_id:
        image.product_id,

      image_url:
        image.image_url ||
        null,

      alt_text:
        image.alt_text ||
        null,

      is_primary:
        image.is_primary ===
        true,

      sort_order:
        image.sort_order,

      storage_provider:
        image.storage_provider ||
        null,

      image_type:
        image.image_type ||
        null,

      original_filename:
        image.original_filename ||
        null,

      created_at:
        image.created_at,
    },

    new_primary_image:
      newPrimaryImage,

    storage_cleanup:
      storageCleanup,
  });
};

/* =========================================
   OBTENER SEO DE PRODUCTO
========================================= */
export const getAdminProductSeo = async (req, res) => {
  const { productId } = req.params;

  try {
    /* =========================================
       VALIDAR PRODUCTO
    ========================================= */
    const productResult = await pool.query(
      `
        SELECT
          id,
          sku,
          name,
          slug
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    /* =========================================
       OBTENER SEO
    ========================================= */
    const seoResult = await pool.query(
      `
        SELECT
          id,
          product_id,
          meta_title,
          meta_description,
          canonical_url,
          og_title,
          og_description,
          og_image_url,
          robots_index,
          robots_follow,
          created_at,
          updated_at
        FROM product_seo
        WHERE product_id = $1
        LIMIT 1
      `,
      [productId]
    );

    return res.status(200).json({
      success: true,
      product: productResult.rows[0],
      seo:
        seoResult.rowCount > 0
          ? seoResult.rows[0]
          : null,
    });
  } catch (error) {
    console.error(
      "Error obteniendo SEO del producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener el SEO del producto",
    });
  }
};

/* =========================================
   CREAR / ACTUALIZAR SEO DE PRODUCTO
========================================= */
export const upsertAdminProductSeo = async (req, res) => {
  const { productId } = req.params;

  const validation =
    productSeoSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos SEO inválidos",
      errors: validation.error.issues,
    });
  }

  const {
    meta_title,
    meta_description,
    canonical_url,
    og_title,
    og_description,
    og_image_url,
    robots_index,
    robots_follow,
  } = validation.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* =========================================
       VALIDAR PRODUCTO
    ========================================= */
    const productResult = await client.query(
      `
        SELECT
          id,
          sku,
          name,
          slug
        FROM products
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    /* =========================================
       UPSERT SEO
    ========================================= */
    const seoResult = await client.query(
      `
        INSERT INTO product_seo (
          product_id,
          meta_title,
          meta_description,
          canonical_url,
          og_title,
          og_description,
          og_image_url,
          robots_index,
          robots_follow
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )

        ON CONFLICT (product_id)

        DO UPDATE SET
          meta_title = EXCLUDED.meta_title,
          meta_description = EXCLUDED.meta_description,
          canonical_url = EXCLUDED.canonical_url,
          og_title = EXCLUDED.og_title,
          og_description = EXCLUDED.og_description,
          og_image_url = EXCLUDED.og_image_url,
          robots_index = EXCLUDED.robots_index,
          robots_follow = EXCLUDED.robots_follow

        RETURNING
          id,
          product_id,
          meta_title,
          meta_description,
          canonical_url,
          og_title,
          og_description,
          og_image_url,
          robots_index,
          robots_follow,
          created_at,
          updated_at
      `,
      [
        productId,
        meta_title ?? null,
        meta_description ?? null,
        canonical_url ?? null,
        og_title ?? null,
        og_description ?? null,
        og_image_url ?? null,
        robots_index,
        robots_follow,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "SEO del producto guardado correctamente",
      product: productResult.rows[0],
      seo: seoResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error guardando SEO del producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible guardar el SEO del producto",
    });
  } finally {
    client.release();
  }
};

const PROMOTION_TYPE_FIXED =
  "FIXED_PRICE";

const PROMOTION_TYPE_QUANTITY =
  "QUANTITY_TIER";

const normalizePromotionType = (
  value
) =>
  String(
    value ||
      PROMOTION_TYPE_FIXED
  )
    .trim()
    .toUpperCase();

const sortPromotionTiers = (
  tiers = []
) =>
  [...tiers].sort(
    (
      left,
      right
    ) =>
      Number(
        left.min_quantity
      ) -
      Number(
        right.min_quantity
      )
  );

const validatePromotionPricing = ({
  promotionType,
  promotionalPrice,
  tiers,
  basePrice,
}) => {
  const normalizedType =
    normalizePromotionType(
      promotionType
    );

  const numericBasePrice =
    Number(
      basePrice
    );

  if (
    !Number.isFinite(
      numericBasePrice
    )
  ) {
    return {
      valid:
        false,
      message:
        "El producto no tiene un precio base válido",
    };
  }

  if (
    normalizedType ===
    PROMOTION_TYPE_FIXED
  ) {
    const numericPrice =
      Number(
        promotionalPrice
      );

    if (
      !Number.isFinite(
        numericPrice
      ) ||
      numericPrice < 0
    ) {
      return {
        valid:
          false,
        message:
          "El precio promocional no es válido",
      };
    }

    if (
      numericPrice >=
      numericBasePrice
    ) {
      return {
        valid:
          false,
        message:
          "El precio promocional debe ser menor que el precio base",
      };
    }

    return {
      valid:
        true,
      promotionalPrice:
        numericPrice,
      tiers:
        [],
    };
  }

  const sortedTiers =
    sortPromotionTiers(
      tiers
    );

  if (
    sortedTiers.length ===
    0
  ) {
    return {
      valid:
        false,
      message:
        "La promoción por cantidad requiere al menos un tramo",
    };
  }

  let previousPrice =
    null;

  const seenQuantities =
    new Set();

  for (
    const tier of
    sortedTiers
  ) {
    const minQuantity =
      Number(
        tier.min_quantity
      );

    const unitPrice =
      Number(
        tier.unit_price
      );

    if (
      !Number.isFinite(
        minQuantity
      ) ||
      minQuantity <= 0
    ) {
      return {
        valid:
          false,
        message:
          "Cada tramo debe tener una cantidad mínima mayor que 0",
      };
    }

    if (
      !Number.isFinite(
        unitPrice
      ) ||
      unitPrice < 0
    ) {
      return {
        valid:
          false,
        message:
          "Cada tramo debe tener un precio unitario válido",
      };
    }

    const quantityKey =
      String(
        minQuantity
      );

    if (
      seenQuantities.has(
        quantityKey
      )
    ) {
      return {
        valid:
          false,
        message:
          "No puedes repetir una cantidad mínima en dos tramos",
      };
    }

    seenQuantities.add(
      quantityKey
    );

    if (
      unitPrice >=
      numericBasePrice
    ) {
      return {
        valid:
          false,
        message:
          "Cada precio por volumen debe ser menor que el precio base",
      };
    }

    if (
      previousPrice !==
        null &&
      unitPrice >
        previousPrice
    ) {
      return {
        valid:
          false,
        message:
          "El precio unitario no puede aumentar al subir de tramo",
      };
    }

    previousPrice =
      unitPrice;
  }

  return {
    valid:
      true,
    promotionalPrice:
      null,
    tiers:
      sortedTiers.map(
        (
          tier
        ) => ({
          min_quantity:
            Number(
              tier.min_quantity
            ),
          unit_price:
            Number(
              tier.unit_price
            ),
        })
      ),
  };
};

const replacePromotionTiers = async (
  client,
  promotionId,
  tiers = []
) => {
  await client.query(
    `
      DELETE FROM promotion_price_tiers
      WHERE promotion_id = $1
    `,
    [
      promotionId,
    ]
  );

  if (
    tiers.length === 0
  ) {
    return;
  }

  for (
    const tier of tiers
  ) {
    await client.query(
      `
        INSERT INTO promotion_price_tiers (
          promotion_id,
          min_quantity,
          unit_price
        )
        VALUES (
          $1,
          $2,
          $3
        )
      `,
      [
        promotionId,
        tier.min_quantity,
        tier.unit_price,
      ]
    );
  }
};

const getPromotionTiers = async (
  queryable,
  promotionId
) => {
  const result =
    await queryable.query(
      `
        SELECT
          id,
          promotion_id,
          min_quantity,
          unit_price,
          created_at,
          updated_at
        FROM promotion_price_tiers
        WHERE promotion_id = $1
        ORDER BY
          min_quantity ASC,
          created_at ASC
      `,
      [
        promotionId,
      ]
    );

  return result.rows;
};

/* =========================================
   LISTAR PROMOCIONES DE PRODUCTO
========================================= */
export const getAdminProductPromotions = async (
  req,
  res
) => {
  const {
    productId,
  } = req.params;

  try {
    const productResult =
      await pool.query(
        `
          SELECT
            id,
            sku,
            name,
            base_price
          FROM products
          WHERE id = $1
          LIMIT 1
        `,
        [
          productId,
        ]
      );

    if (
      productResult.rowCount ===
      0
    ) {
      return res
        .status(404)
        .json({
          success:
            false,
          message:
            "Producto no encontrado",
        });
    }

    const result =
      await pool.query(
        `
          SELECT
            pr.id,
            pr.product_id,
            pr.name,
            pr.promotion_type,
            pr.promotional_price,
            pr.starts_at,
            pr.ends_at,
            pr.is_active,

            CASE
              WHEN pr.is_active = TRUE
                AND (
                  pr.starts_at IS NULL
                  OR pr.starts_at <= NOW()
                )
                AND (
                  pr.ends_at IS NULL
                  OR pr.ends_at > NOW()
                )
              THEN TRUE
              ELSE FALSE
            END AS is_current,

            COALESCE(
              (
                SELECT
                  jsonb_agg(
                    jsonb_build_object(
                      'id',
                      tier.id,
                      'min_quantity',
                      tier.min_quantity,
                      'unit_price',
                      tier.unit_price
                    )
                    ORDER BY
                      tier.min_quantity ASC
                  )
                FROM promotion_price_tiers tier
                WHERE tier.promotion_id = pr.id
              ),
              '[]'::jsonb
            ) AS tiers,

            pr.created_at,
            pr.updated_at

          FROM promotions pr

          WHERE pr.product_id = $1

          ORDER BY
            pr.starts_at DESC NULLS LAST,
            pr.created_at DESC
        `,
        [
          productId,
        ]
      );

    return res
      .status(200)
      .json({
        success:
          true,
        product:
          productResult.rows[0],
        count:
          result.rowCount,
        promotions:
          result.rows,
      });
  } catch (error) {
    console.error(
      "Error obteniendo promociones:",
      error
    );

    if (
      error.code ===
      "22P02"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "ID de producto inválido",
        });
    }

    return res
      .status(500)
      .json({
        success:
          false,
        message:
          "No fue posible obtener las promociones",
      });
  }
};

/* =========================================
   CREAR PROMOCIÓN DE PRODUCTO
========================================= */
export const createAdminProductPromotion = async (
  req,
  res
) => {
  const {
    productId,
  } = req.params;

  const validation =
    createPromotionSchema.safeParse(
      req.body
    );

  if (
    !validation.success
  ) {
    return res
      .status(400)
      .json({
        success:
          false,
        message:
          "Datos de promoción inválidos",
        errors:
          validation.error.issues,
      });
  }

  const {
    name,
    promotion_type,
    promotional_price,
    tiers = [],
    starts_at,
    ends_at,
    is_active,
  } = validation.data;

  const promotionType =
    normalizePromotionType(
      promotion_type
    );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const productResult =
      await client.query(
        `
          SELECT
            id,
            sku,
            name,
            base_price
          FROM products
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [
          productId,
        ]
      );

    if (
      productResult.rowCount ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(404)
        .json({
          success:
            false,
          message:
            "Producto no encontrado",
        });
    }

    const product =
      productResult.rows[0];

    if (
      product.base_price ===
      null
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(409)
        .json({
          success:
            false,
          message:
            "El producto no tiene precio base y no puede recibir una promoción",
        });
    }

    const pricingValidation =
      validatePromotionPricing({
        promotionType,
        promotionalPrice:
          promotional_price,
        tiers,
        basePrice:
          product.base_price,
      });

    if (
      !pricingValidation.valid
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(400)
        .json({
          success:
            false,
          message:
            pricingValidation.message,
          base_price:
            product.base_price,
        });
    }

    /*
     * Un producto puede mantener múltiples promociones
     * activas y con períodos superpuestos.
     *
     * La resolución del precio final no se hace aquí:
     * productPricing.service.js evalúa todas las promociones
     * vigentes y elige el menor precio aplicable según
     * la cantidad solicitada.
     */

    const result =
      await client.query(
        `
          INSERT INTO promotions (
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )

          RETURNING
            id,
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active,
            created_at,
            updated_at
        `,
        [
          productId,
          name,
          promotionType,
          pricingValidation.promotionalPrice,
          starts_at ||
            null,
          ends_at ||
            null,
          is_active,
        ]
      );

    const promotion =
      result.rows[0];

    if (
      promotionType ===
      PROMOTION_TYPE_QUANTITY
    ) {
      await replacePromotionTiers(
        client,
        promotion.id,
        pricingValidation.tiers
      );
    }

    const savedTiers =
      await getPromotionTiers(
        client,
        promotion.id
      );

    await client.query(
      "COMMIT"
    );

    return res
      .status(201)
      .json({
        success:
          true,
        message:
          "Promoción creada correctamente",
        promotion: {
          ...promotion,
          tiers:
            savedTiers,
        },
      });
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Error creando promoción:",
      error
    );

    if (
      error.code ===
      "22P02"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "ID de producto inválido",
        });
    }

    return res
      .status(500)
      .json({
        success:
          false,
        message:
          "No fue posible crear la promoción",
      });
  } finally {
    client.release();
  }
};

/* =========================================
   ACTUALIZAR PROMOCIÓN
========================================= */
export const updateAdminProductPromotion = async (
  req,
  res
) => {
  const {
    productId,
    promotionId,
  } = req.params;

  const validation =
    updatePromotionSchema.safeParse(
      req.body
    );

  if (
    !validation.success
  ) {
    return res
      .status(400)
      .json({
        success:
          false,
        message:
          "Datos de promoción inválidos",
        errors:
          validation.error.issues,
      });
  }

  const data =
    validation.data;

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const productResult =
      await client.query(
        `
          SELECT
            id,
            sku,
            name,
            base_price
          FROM products
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [
          productId,
        ]
      );

    if (
      productResult.rowCount ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(404)
        .json({
          success:
            false,
          message:
            "Producto no encontrado",
        });
    }

    const product =
      productResult.rows[0];

    const promotionResult =
      await client.query(
        `
          SELECT
            id,
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active
          FROM promotions
          WHERE id = $1
            AND product_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [
          promotionId,
          productId,
        ]
      );

    if (
      promotionResult.rowCount ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(404)
        .json({
          success:
            false,
          message:
            "Promoción no encontrada",
        });
    }

    const currentPromotion =
      promotionResult.rows[0];

    const currentTiers =
      await getPromotionTiers(
        client,
        promotionId
      );

    const finalName =
      data.name !==
      undefined
        ? data.name
        : currentPromotion.name;

    const finalType =
      normalizePromotionType(
        data.promotion_type !==
          undefined
          ? data.promotion_type
          : currentPromotion.promotion_type
      );

    const finalPrice =
      Object.prototype.hasOwnProperty.call(
        data,
        "promotional_price"
      )
        ? data.promotional_price
        : currentPromotion.promotional_price;

    const finalTiers =
      data.tiers !==
      undefined
        ? data.tiers
        : currentTiers.map(
            (
              tier
            ) => ({
              min_quantity:
                Number(
                  tier.min_quantity
                ),
              unit_price:
                Number(
                  tier.unit_price
                ),
            })
          );

    const finalStartsAt =
      Object.prototype.hasOwnProperty.call(
        data,
        "starts_at"
      )
        ? data.starts_at
        : currentPromotion.starts_at;

    const finalEndsAt =
      Object.prototype.hasOwnProperty.call(
        data,
        "ends_at"
      )
        ? data.ends_at
        : currentPromotion.ends_at;

    const finalIsActive =
      data.is_active !==
      undefined
        ? data.is_active
        : currentPromotion.is_active;

    if (
      finalStartsAt &&
      finalEndsAt &&
      new Date(
        finalEndsAt
      ) <=
        new Date(
          finalStartsAt
        )
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "La fecha de término debe ser posterior a la fecha de inicio",
        });
    }

    if (
      product.base_price ===
      null
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(409)
        .json({
          success:
            false,
          message:
            "El producto no tiene precio base y no puede mantener una promoción",
        });
    }

    const pricingValidation =
      validatePromotionPricing({
        promotionType:
          finalType,
        promotionalPrice:
          finalPrice,
        tiers:
          finalTiers,
        basePrice:
          product.base_price,
      });

    if (
      !pricingValidation.valid
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(400)
        .json({
          success:
            false,
          message:
            pricingValidation.message,
          base_price:
            product.base_price,
        });
    }

    /*
     * También se permiten solapamientos al editar/reactivar
     * una promoción. Cada promoción conserva su identidad,
     * fechas y tipo; el motor de precios determina cuál gana.
     */

    const result =
      await client.query(
        `
          UPDATE promotions

          SET
            name = $1,
            promotion_type = $2,
            promotional_price = $3,
            starts_at = $4,
            ends_at = $5,
            is_active = $6

          WHERE id = $7
            AND product_id = $8

          RETURNING
            id,
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active,
            created_at,
            updated_at
        `,
        [
          finalName,
          finalType,
          pricingValidation.promotionalPrice,
          finalStartsAt ||
            null,
          finalEndsAt ||
            null,
          finalIsActive,
          promotionId,
          productId,
        ]
      );

    const typeChanged =
      normalizePromotionType(
        currentPromotion.promotion_type
      ) !==
      finalType;

    if (
      finalType ===
      PROMOTION_TYPE_QUANTITY
    ) {
      if (
        typeChanged ||
        data.tiers !==
          undefined
      ) {
        await replacePromotionTiers(
          client,
          promotionId,
          pricingValidation.tiers
        );
      }
    } else if (
      currentTiers.length >
      0
    ) {
      await replacePromotionTiers(
        client,
        promotionId,
        []
      );
    }

    const savedTiers =
      await getPromotionTiers(
        client,
        promotionId
      );

    await client.query(
      "COMMIT"
    );

    return res
      .status(200)
      .json({
        success:
          true,
        message:
          "Promoción actualizada correctamente",
        promotion: {
          ...result.rows[0],
          tiers:
            savedTiers,
        },
      });
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Error actualizando promoción:",
      error
    );

    if (
      error.code ===
      "22P02"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "ID de producto o promoción inválido",
        });
    }

    return res
      .status(500)
      .json({
        success:
          false,
        message:
          "No fue posible actualizar la promoción",
      });
  } finally {
    client.release();
  }
};

/* =========================================
   ELIMINAR PROMOCIÓN
========================================= */
export const deleteAdminProductPromotion = async (
  req,
  res
) => {
  const {
    productId,
    promotionId,
  } = req.params;

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const promotionResult =
      await client.query(
        `
          SELECT
            id,
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active
          FROM promotions
          WHERE id = $1
            AND product_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [
          promotionId,
          productId,
        ]
      );

    if (
      promotionResult.rowCount ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return res
        .status(404)
        .json({
          success:
            false,
          message:
            "Promoción no encontrada",
        });
    }

    const result =
      await client.query(
        `
          DELETE FROM promotions
          WHERE id = $1
            AND product_id = $2

          RETURNING
            id,
            product_id,
            name,
            promotion_type,
            promotional_price,
            starts_at,
            ends_at,
            is_active
        `,
        [
          promotionId,
          productId,
        ]
      );

    await client.query(
      "COMMIT"
    );

    return res
      .status(200)
      .json({
        success:
          true,
        message:
          "Promoción eliminada correctamente",
        promotion:
          result.rows[0],
      });
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Error eliminando promoción:",
      error
    );

    if (
      error.code ===
      "22P02"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,
          message:
            "ID de producto o promoción inválido",
        });
    }

    return res
      .status(500)
      .json({
        success:
          false,
        message:
          "No fue posible eliminar la promoción",
      });
  } finally {
    client.release();
  }
};

/* =========================================
   OBTENER INVENTARIO DE PRODUCTO
========================================= */
export const getAdminProductInventory = async (req, res) => {
  const { productId } = req.params;

  try {
    const productResult = await pool.query(
      `
        SELECT
          id,
          sku,
          internal_code,
          relbase_product_id,
          name
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      });
    }

    const inventoryResult = await pool.query(
      `
        SELECT
          i.id,
          i.product_id,

          i.warehouse_code,
          i.warehouse_name,
          i.relbase_warehouse_id,

          i.stock_quantity,

          COALESCE(
            SUM(
              CASE
                WHEN ir.status = 'CONFIRMED'
                  THEN ir.quantity

                WHEN ir.status = 'ACTIVE'
                  AND (
                    ir.expires_at IS NULL
                    OR ir.expires_at > NOW()
                  )
                  THEN ir.quantity

                ELSE 0
              END
            ),
            0
          ) AS reserved_quantity,

          i.safety_stock,

          GREATEST(
            i.stock_quantity
            -
            COALESCE(
              SUM(
                CASE
                  WHEN ir.status = 'CONFIRMED'
                    THEN ir.quantity

                  WHEN ir.status = 'ACTIVE'
                    AND (
                      ir.expires_at IS NULL
                      OR ir.expires_at > NOW()
                    )
                    THEN ir.quantity

                  ELSE 0
                END
              ),
              0
            )
            -
            i.safety_stock,
            0
          ) AS available_web,

          i.last_sync_at,
          i.created_at,
          i.updated_at

        FROM inventory i

        LEFT JOIN inventory_reservations ir
          ON ir.inventory_id = i.id

        WHERE i.product_id = $1

        GROUP BY
          i.id,
          i.product_id,
          i.warehouse_code,
          i.warehouse_name,
          i.relbase_warehouse_id,
          i.stock_quantity,
          i.safety_stock,
          i.last_sync_at,
          i.created_at,
          i.updated_at

        ORDER BY
          i.warehouse_name ASC NULLS LAST,
          i.warehouse_code ASC NULLS LAST
      `,
      [productId]
    );

    const totals = inventoryResult.rows.reduce(
      (accumulator, inventory) => {
        accumulator.stock_quantity += Number(
          inventory.stock_quantity
        );

        accumulator.reserved_quantity += Number(
          inventory.reserved_quantity
        );

        accumulator.safety_stock += Number(
          inventory.safety_stock
        );

        accumulator.available_web += Number(
          inventory.available_web
        );

        return accumulator;
      },
      {
        stock_quantity: 0,
        reserved_quantity: 0,
        safety_stock: 0,
        available_web: 0,
      }
    );

    return res.status(200).json({
      success: true,

      product: productResult.rows[0],

      totals,

      warehouses_count: inventoryResult.rowCount,

      inventory: inventoryResult.rows,
    });
  } catch (error) {
    console.error(
      "Error obteniendo inventario del producto:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener el inventario del producto",
    });
  }
};

/* =========================================
   ACTUALIZAR STOCK DE SEGURIDAD
========================================= */
export const updateAdminInventorySafetyStock = async (
  req,
  res
) => {
  const { inventoryId } = req.params;

  const validation =
    updateInventorySafetyStockSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Datos de inventario inválidos",
      errors: validation.error.issues,
    });
  }

  const { safety_stock } = validation.data;

  try {
    const result = await pool.query(
      `
        UPDATE inventory
        SET safety_stock = $1
        WHERE id = $2

        RETURNING
          id,
          product_id,
          warehouse_code,
          warehouse_name,
          stock_quantity,
          safety_stock,
          last_sync_at,
          created_at,
          updated_at
      `,
      [
        safety_stock,
        inventoryId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Registro de inventario no encontrado",
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Stock de seguridad actualizado correctamente",
      inventory: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Error actualizando stock de seguridad:",
      error
    );

    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "ID de inventario inválido",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "No fue posible actualizar el stock de seguridad",
    });
  }
};