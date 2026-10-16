import pool from "../config/database.js";

/* =========================================
   ERROR CONTROLADO
========================================= */
const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error = new Error(message);

  error.status = status;
  error.code = code;

  return error;
};

/* =========================================
   GENERAR SLUG
========================================= */
const slugify = (value = "") => {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

/* =========================================
   NORMALIZAR BOOLEAN
========================================= */
const normalizeBoolean = (
  value,
  defaultValue = false
) => {
  if (
    value === undefined ||
    value === null
  ) {
    return defaultValue;
  }

  return Boolean(value);
};

/* =========================================
   OBTENER SLUG ÚNICO
========================================= */
const getUniqueSlug = async (
  client,
  {
    name,
    code,
    relbaseProductId,
  }
) => {
  const baseSlug =
    slugify(name) ||
    `producto-${relbaseProductId}`;

  const candidates = [
    baseSlug,

    code
      ? `${baseSlug}-${slugify(code)}`
      : null,

    `${baseSlug}-${relbaseProductId}`,
  ].filter(Boolean);

  for (
    const candidate of candidates
  ) {
    const result =
      await client.query(
        `
          SELECT id
          FROM products
          WHERE slug = $1
          LIMIT 1
        `,
        [candidate]
      );

    if (result.rowCount === 0) {
      return candidate;
    }
  }

  /*
   * Último fallback prácticamente
   * imposible de repetir.
   */
  return `${baseSlug}-${relbaseProductId}-${Date.now()}`;
};

/* =========================================
   VALIDAR CATEGORÍA
========================================= */
const validateCategory = async (
  client,
  categoryId
) => {
  if (!categoryId) {
    throw createServiceError(
      "La categoría es obligatoria",
      400,
      "CATEGORY_REQUIRED"
    );
  }

  const result =
    await client.query(
      `
        SELECT
          id,
          name
        FROM categories
        WHERE id = $1
        LIMIT 1
      `,
      [categoryId]
    );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La categoría seleccionada no existe",
      400,
      "CATEGORY_NOT_FOUND"
    );
  }

  return result.rows[0];
};

/* =========================================
   VALIDAR MARCA
========================================= */
const validateBrand = async (
  client,
  brandId
) => {
  if (!brandId) {
    return null;
  }

  const result =
    await client.query(
      `
        SELECT
          id,
          name
        FROM brands
        WHERE id = $1
        LIMIT 1
      `,
      [brandId]
    );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La marca seleccionada no existe",
      400,
      "BRAND_NOT_FOUND"
    );
  }

  return result.rows[0];
};

/* =========================================
   VALIDAR COLECCIÓN
========================================= */
const validateCollection = async (
  client,
  collectionId,
  brandId
) => {
  if (!collectionId) {
    return null;
  }

  const result =
    await client.query(
      `
        SELECT
          id,
          name,
          brand_id
        FROM collections
        WHERE id = $1
        LIMIT 1
      `,
      [collectionId]
    );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La colección seleccionada no existe",
      400,
      "COLLECTION_NOT_FOUND"
    );
  }

  const collection =
    result.rows[0];

  /*
   * Si la colección pertenece
   * a una marca, debe coincidir
   * con la marca seleccionada.
   */
  if (
    collection.brand_id &&
    !brandId
  ) {
    throw createServiceError(
      "Debes seleccionar la marca correspondiente a la colección",
      400,
      "COLLECTION_BRAND_REQUIRED"
    );
  }

  if (
    collection.brand_id &&
    brandId &&
    String(collection.brand_id) !==
      String(brandId)
  ) {
    throw createServiceError(
      "La colección no pertenece a la marca seleccionada",
      400,
      "COLLECTION_BRAND_MISMATCH"
    );
  }

  return collection;
};

/* =========================================
   DETERMINAR PRECIO BASE WEB

   En los datos reales Relbase:
   price      = precio neto
   price_sale = precio final de venta

   Laminatiword utiliza base_price como
   precio comercial web antes de promociones.
========================================= */
const getBasePrice = (
  stagingProduct
) => {
  const priceSale =
    stagingProduct.price_sale !==
      null &&
    stagingProduct.price_sale !==
      undefined
      ? Number(
          stagingProduct.price_sale
        )
      : null;

  if (
    Number.isFinite(priceSale) &&
    priceSale >= 0
  ) {
    return priceSale;
  }

  const price =
    stagingProduct.price !== null &&
    stagingProduct.price !== undefined
      ? Number(
          stagingProduct.price
        )
      : null;

  if (
    Number.isFinite(price) &&
    price >= 0
  ) {
    return price;
  }

  return null;
};

/* =========================================
   IMPORTAR PRODUCTO DESDE STAGING
========================================= */
export const importRelbaseStagingProduct =
  async (
    stagingId,
    options = {}
  ) => {
    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      /* =====================================
         BLOQUEAR PRODUCTO STAGING
      ===================================== */
      const stagingResult =
        await client.query(
          `
            SELECT
              id,
              relbase_product_id,
              code,
              name,
              description,
              price,
              price_sale,
              barcode,
              product_type,
              is_tax_affected,
              image_url,
              raw_payload,
              sync_status,
              linked_product_id

            FROM relbase_product_staging

            WHERE id = $1

            LIMIT 1

            FOR UPDATE
          `,
          [stagingId]
        );

      if (
        stagingResult.rowCount === 0
      ) {
        throw createServiceError(
          "El producto de staging no existe",
          404,
          "STAGING_PRODUCT_NOT_FOUND"
        );
      }

      const stagingProduct =
        stagingResult.rows[0];

      /* =====================================
         SOLO PRODUCTOS
      ===================================== */
      if (
        String(
          stagingProduct.product_type ||
            ""
        ).toLowerCase() !==
        "product"
      ) {
        throw createServiceError(
          "El registro de Relbase no corresponde a un producto vendible",
          400,
          "INVALID_PRODUCT_TYPE"
        );
      }

      /* =====================================
         YA IMPORTADO
      ===================================== */
      if (
        stagingProduct.sync_status ===
          "IMPORTED" ||
        stagingProduct.linked_product_id
      ) {
        throw createServiceError(
          "El producto Relbase ya fue importado a Laminatiword",
          409,
          "ALREADY_IMPORTED"
        );
      }

      /* =====================================
         VALIDAR CLASIFICACIÓN WEB
      ===================================== */
      const category =
        await validateCategory(
          client,
          options.category_id
        );

      const brand =
        await validateBrand(
          client,
          options.brand_id
        );

      const collection =
        await validateCollection(
          client,
          options.collection_id,
          options.brand_id
        );

      /* =====================================
         SKU
      ===================================== */
      const sku =
        String(
          stagingProduct.code ||
            `RELBASE-${stagingProduct.relbase_product_id}`
        ).trim();

      if (!sku) {
        throw createServiceError(
          "No fue posible determinar el SKU del producto",
          400,
          "SKU_REQUIRED"
        );
      }

      /* =====================================
         VALIDAR RELBASE ID DUPLICADO
      ===================================== */
      const existingRelbaseProduct =
        await client.query(
          `
            SELECT
              id,
              sku,
              name
            FROM products
            WHERE relbase_product_id = $1
            LIMIT 1
          `,
          [
            stagingProduct
              .relbase_product_id,
          ]
        );

      if (
        existingRelbaseProduct.rowCount >
        0
      ) {
        throw createServiceError(
          "Ya existe un producto Laminatiword asociado a este producto Relbase",
          409,
          "RELBASE_PRODUCT_ALREADY_LINKED"
        );
      }

      /* =====================================
         VALIDAR SKU DUPLICADO
      ===================================== */
      const existingSku =
        await client.query(
          `
            SELECT
              id,
              relbase_product_id,
              name
            FROM products
            WHERE sku = $1
            LIMIT 1
          `,
          [sku]
        );

      if (
        existingSku.rowCount > 0
      ) {
        throw createServiceError(
          `Ya existe un producto Laminatiword con el SKU ${sku}`,
          409,
          "SKU_ALREADY_EXISTS"
        );
      }

      /* =====================================
         SLUG
      ===================================== */
      const slug =
        await getUniqueSlug(
          client,
          {
            name:
              stagingProduct.name,

            code: sku,

            relbaseProductId:
              stagingProduct
                .relbase_product_id,
          }
        );

      /* =====================================
         PRECIO BASE
      ===================================== */
      const basePrice =
        getBasePrice(
          stagingProduct
        );

      /* =====================================
         IVA
      ===================================== */
      const taxRate =
        stagingProduct
          .is_tax_affected === false
          ? 0
          : 19;

      /*
       * Seguridad:
       * por defecto NO publicamos
       * automáticamente.
       */
      const isPublished =
        normalizeBoolean(
          options.is_published,
          false
        );

      const isFeatured =
        normalizeBoolean(
          options.is_featured,
          false
        );

      const allowSale =
        normalizeBoolean(
          options.allow_sale,
          true
        );

      /* =====================================
         CREAR PRODUCTO
      ===================================== */
      const productResult =
        await client.query(
          `
            INSERT INTO products (
              category_id,
              brand_id,
              collection_id,

              sku,
              internal_code,
              relbase_product_id,

              name,
              slug,

              short_description,
              description,

              base_price,
              tax_rate,

              is_active,
              is_published,
              is_featured,
              allow_sale
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

              $9,
              $10,

              $11,
              $12,

              TRUE,
              $13,
              $14,
              $15
            )

            RETURNING
              id,
              category_id,
              brand_id,
              collection_id,

              sku,
              internal_code,
              relbase_product_id,

              name,
              slug,

              base_price,
              tax_rate,

              is_active,
              is_published,
              is_featured,
              allow_sale,

              created_at,
              updated_at
          `,
          [
            category.id,

            brand?.id || null,

            collection?.id ||
              null,

            sku,

            /*
             * No adivinamos todavía
             * un código interno distinto.
             */
            null,

            stagingProduct
              .relbase_product_id,

            stagingProduct.name,

            slug,

            /*
             * short_description:
             * lo dejamos disponible
             * para enriquecimiento web.
             */
            null,

            stagingProduct
              .description ||
              null,

            basePrice,

            taxRate,

            isPublished,

            isFeatured,

            allowSale,
          ]
        );

      const product =
        productResult.rows[0];

      /* =====================================
         VINCULAR STAGING
      ===================================== */
      await client.query(
        `
          UPDATE relbase_product_staging

          SET
            sync_status =
              'IMPORTED',

            linked_product_id =
              $1,

            imported_at =
              NOW()

          WHERE id = $2
        `,
        [
          product.id,
          stagingProduct.id,
        ]
      );

      await client.query("COMMIT");

      return {
        product,

        staging: {
          id:
            stagingProduct.id,

          relbase_product_id:
            stagingProduct
              .relbase_product_id,

          code:
            stagingProduct.code,

          sync_status:
            "IMPORTED",

          linked_product_id:
            product.id,
        },

        classification: {
          category,

          brand,

          collection,
        },

        relbase: {
          price:
            stagingProduct.price,

          price_sale:
            stagingProduct
              .price_sale,

          /*
           * Esta URL puede expirar.
           * No se copia todavía a
           * product_images.
           */
          temporary_image_url:
            stagingProduct
              .image_url,
        },
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // Transacción ya finalizada.
      }

      throw error;
    } finally {
      client.release();
    }
  };