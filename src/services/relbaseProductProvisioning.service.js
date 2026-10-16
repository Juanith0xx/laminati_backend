import pool from "../config/database.js";

import {
  relbaseRequest,
} from "./relbase.service.js";

import {
  upsertStagingProduct,
} from "./relbaseSync.service.js";

import {
  syncRelbaseProductInventory,
} from "./relbaseInventory.service.js";

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
   NORMALIZAR TEXTO / SKU
========================================= */
const normalizeText = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const normalizeSku = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase();

/* =========================================
   PRODUCTO ESPECIAL: DESPACHO FEX
========================================= */
const FEX_SHIPPING_SKU = normalizeSku(
  process.env.FEX_SHIPPING_SKU ||
    "FEX-DESPACHO"
);

const isFexShippingProduct = (
  productOrSku
) => {
  const sku =
    typeof productOrSku === "object" &&
    productOrSku !== null
      ? productOrSku.sku
      : productOrSku;

  return (
    normalizeSku(sku) ===
    FEX_SHIPPING_SKU
  );
};

/* =========================================
   NÚMERO
========================================= */
const toFiniteNumber = (
  value,
  fallback = 0
) => {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
};

const roundMoney = (value) =>
  Math.round(
    (Number(value) + Number.EPSILON) * 100
  ) / 100;

/* =========================================
   EXTRAER PRODUCTOS RELBASE
========================================= */
const extractRelbaseProducts = (
  payload
) => {
  if (
    Array.isArray(
      payload?.data?.products
    )
  ) {
    return payload.data.products;
  }

  if (
    Array.isArray(
      payload?.data
    )
  ) {
    return payload.data;
  }

  if (
    Array.isArray(
      payload?.data?.resources
    )
  ) {
    return payload.data.resources;
  }

  if (
    Array.isArray(
      payload?.products
    )
  ) {
    return payload.products;
  }

  if (
    Array.isArray(
      payload?.resources
    )
  ) {
    return payload.resources;
  }

  return [];
};

const extractRelbaseCategories = (
  payload
) => {
  if (
    Array.isArray(
      payload?.data?.categories
    )
  ) {
    return payload.data.categories;
  }

  if (
    Array.isArray(
      payload?.data
    )
  ) {
    return payload.data;
  }

  if (
    Array.isArray(
      payload?.categories
    )
  ) {
    return payload.categories;
  }

  return [];
};

const extractSingleRelbaseProduct = (
  payload
) => {
  const candidate =
    payload?.data?.product ||
    payload?.data ||
    payload?.product ||
    null;

  if (
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
  ) {
    return candidate;
  }

  return null;
};

/* =========================================
   PRODUCTO LOCAL
========================================= */
const getLocalProduct = async (
  productId
) => {
  const result = await pool.query(
    `
      SELECT
        p.id,
        p.category_id,
        p.brand_id,
        p.collection_id,
        p.sku,
        p.internal_code,
        p.relbase_product_id,
        p.name,
        p.description,
        p.base_price,
        p.tax_rate,
        p.is_active,
        p.is_published,
        p.allow_sale,

        c.name AS category_name,
        c.slug AS category_slug,

        b.name AS brand_name,
        b.slug AS brand_slug

      FROM products p

      JOIN categories c
        ON c.id = p.category_id

      LEFT JOIN brands b
        ON b.id = p.brand_id

      WHERE p.id = $1
      LIMIT 1
    `,
    [productId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "El producto Laminatiword no existe",
      404,
      "PRODUCT_NOT_FOUND"
    );
  }

  return result.rows[0];
};

/* =========================================
   BUSCAR SKU EXACTO EN STAGING
========================================= */
const findExactStagingProductBySku =
  async (sku) => {
    const normalizedSku =
      normalizeSku(sku);

    const result = await pool.query(
      `
        SELECT
          id,
          relbase_product_id,
          code,
          name,
          sync_status,
          linked_product_id,
          raw_payload,
          last_seen_at

        FROM relbase_product_staging

        WHERE UPPER(TRIM(COALESCE(code, ''))) = $1

        ORDER BY
          last_seen_at DESC,
          updated_at DESC
      `,
      [normalizedSku]
    );

    const uniqueIds =
      new Set(
        result.rows.map(
          (row) =>
            String(
              row.relbase_product_id
            )
        )
      );

    if (uniqueIds.size > 1) {
      throw createServiceError(
        `Relbase staging contiene más de un producto con el SKU ${normalizedSku}`,
        409,
        "RELBASE_DUPLICATE_SKU"
      );
    }

    return result.rows[0] || null;
  };

/* =========================================
   BUSCAR SKU EXACTO DIRECTAMENTE EN RELBASE
========================================= */
const findExactRelbaseProductBySku =
  async (sku) => {
    const normalizedSku =
      normalizeSku(sku);

    const params =
      new URLSearchParams({
        query:
          normalizedSku,
        page:
          "1",
        per_page:
          "100",
      });

    const result =
      await relbaseRequest(
        `/api/v2/productos?${params.toString()}`
      );

    const products =
      extractRelbaseProducts(
        result?.data || null
      );

    const exact =
      products.filter(
        (product) =>
          normalizeSku(
            product?.code
          ) ===
          normalizedSku
      );

    const uniqueIds =
      new Set(
        exact
          .map(
            (product) =>
              product?.id
          )
          .filter(
            (id) =>
              id !== null &&
              id !== undefined
          )
          .map(String)
      );

    if (uniqueIds.size > 1) {
      throw createServiceError(
        `Relbase devolvió más de un producto con el SKU ${normalizedSku}`,
        409,
        "RELBASE_DUPLICATE_SKU"
      );
    }

    return exact[0] || null;
  };


/* =========================================
   NORMALIZAR RESULTADO PARA LOOKUP ADMIN
========================================= */
const normalizeLookupProduct = (
  product,
  source = "RELBASE"
) => {
  const id =
    product?.id ??
    product?.relbase_product_id ??
    null;

  return {
    id:
      id === null ||
      id === undefined
        ? null
        : String(id),

    code:
      String(
        product?.code ||
        ""
      ).trim(),

    name:
      String(
        product?.name ||
        ""
      ).trim(),

    source,

    category:
      product?.category?.name ||
      null,

    category_id:
      product?.category?.id ??
      null,

    linked_product_id:
      product?.linked_product_id ||
      null,

    sync_status:
      product?.sync_status ||
      null,
  };
};

/* =========================================
   BUSCAR COINCIDENCIAS EN STAGING
========================================= */
const searchStagingProducts =
  async (
    query,
    limit = 8
  ) => {
    const normalized =
      String(query ?? "")
        .trim();

    if (!normalized) {
      return [];
    }

    const result =
      await pool.query(
        `
          SELECT
            id,
            relbase_product_id,
            code,
            name,
            sync_status,
            linked_product_id,
            raw_payload

          FROM relbase_product_staging

          WHERE
            COALESCE(code, '')
              ILIKE $1
            OR
            COALESCE(name, '')
              ILIKE $1

          ORDER BY
            CASE
              WHEN UPPER(TRIM(COALESCE(code, ''))) =
                   UPPER(TRIM($2))
                THEN 0
              WHEN UPPER(TRIM(COALESCE(code, ''))) LIKE
                   UPPER(TRIM($2)) || '%'
                THEN 1
              ELSE 2
            END,
            name ASC,
            relbase_product_id ASC

          LIMIT $3
        `,
        [
          `%${normalized}%`,
          normalized,
          limit,
        ]
      );

    return result.rows.map(
      (row) => {
        const raw =
          row.raw_payload &&
          typeof row.raw_payload ===
            "object"
            ? row.raw_payload
            : {};

        return normalizeLookupProduct(
          {
            ...raw,
            id:
              row.relbase_product_id,
            code:
              row.code ||
              raw?.code,
            name:
              row.name ||
              raw?.name,
            linked_product_id:
              row.linked_product_id,
            sync_status:
              row.sync_status,
          },
          "STAGING"
        );
      }
    );
  };

/* =========================================
   BUSCAR COINCIDENCIAS DIRECTAMENTE RELBASE
========================================= */
const searchRelbaseProducts =
  async (
    query,
    limit = 8
  ) => {
    const params =
      new URLSearchParams({
        query:
          String(
            query ?? ""
          ).trim(),
        page:
          "1",
        per_page:
          String(
            Math.min(
              Math.max(
                Number(limit) || 8,
                1
              ),
              20
            )
          ),
      });

    const result =
      await relbaseRequest(
        `/api/v2/productos?${params.toString()}`
      );

    return extractRelbaseProducts(
      result?.data ||
      null
    )
      .map(
        (product) =>
          normalizeLookupProduct(
            product,
            "RELBASE"
          )
      )
      .filter(
        (product) =>
          Boolean(
            product.id
          )
      )
      .slice(
        0,
        limit
      );
  };

/* =========================================
   STOCK PREVIEW RELBASE
========================================= */
const getRelbaseStockPreview =
  async (
    relbaseProductId
  ) => {
    if (!relbaseProductId) {
      return null;
    }

    const result =
      await relbaseRequest(
        `/api/v2/productos/${relbaseProductId}/stock_por_bodegas`
      );

    const payload =
      result?.data ||
      null;

    const stocks =
      Array.isArray(
        payload?.data?.stocks
      )
        ? payload.data.stocks
        : [];

    const preferredWarehouseId =
      Number(
        process.env
          .RELBASE_DEFAULT_WAREHOUSE_ID ||
        0
      );

    const warehouses =
      stocks.map(
        (stock) => ({
          warehouse_id:
            Number(
              stock?.ware_house_id
            ) || null,

          warehouse_name:
            String(
              stock?.name ||
              ""
            ).trim() ||
            null,

          stock:
            Number.isFinite(
              Number(
                stock?.current_stock
              )
            )
              ? Number(
                  stock.current_stock
                )
              : 0,

          average_cost:
            Number.isFinite(
              Number(
                stock?.average_cost
              )
            )
              ? Number(
                  stock.average_cost
                )
              : null,
        })
      );

    const preferred =
      (
        Number.isFinite(
          preferredWarehouseId
        ) &&
        preferredWarehouseId >
          0
      )
        ? warehouses.find(
            (warehouse) =>
              Number(
                warehouse.warehouse_id
              ) ===
              preferredWarehouseId
          )
        : null;

    const selected =
      preferred ||
      warehouses[0] ||
      null;

    return {
      preferred_warehouse_id:
        Number.isFinite(
          preferredWarehouseId
        ) &&
        preferredWarehouseId >
          0
          ? preferredWarehouseId
          : null,

      warehouse:
        selected,

      warehouses,

      total_stock:
        warehouses.reduce(
          (
            total,
            warehouse
          ) =>
            total +
            Number(
              warehouse.stock ||
              0
            ),
          0
        ),
    };
  };

/* =========================================
   LOOKUP ADMINISTRATIVO DE PRODUCTO RELBASE

   - Sólo lectura.
   - No crea producto.
   - No vincula producto.
   - Busca coincidencias para UX del modal.
   - Confirma coincidencia exacta por SKU.
========================================= */
export const lookupRelbaseProductBySku =
  async (
    query,
    {
      limit = 8,
    } = {}
  ) => {
    const normalizedQuery =
      String(
        query ?? ""
      )
        .trim();

    if (
      normalizedQuery.length <
      2
    ) {
      throw createServiceError(
        "Ingresa al menos 2 caracteres para buscar el producto",
        400,
        "RELBASE_PRODUCT_LOOKUP_QUERY_TOO_SHORT"
      );
    }

    const normalizedSku =
      normalizeSku(
        normalizedQuery
      );

    const localResult =
      await pool.query(
        `
          SELECT
            id,
            sku,
            name,
            relbase_product_id
          FROM products
          WHERE
            UPPER(
              TRIM(sku)
            ) = $1
          LIMIT 1
        `,
        [
          normalizedSku,
        ]
      );

    const stagingMatches =
      await searchStagingProducts(
        normalizedQuery,
        limit
      );

    let relbaseMatches =
      [];

    let directLookupError =
      null;

    try {
      relbaseMatches =
        await searchRelbaseProducts(
          normalizedQuery,
          limit
        );
    } catch (error) {
      directLookupError = {
        status:
          error?.status ||
          null,
        code:
          error?.code ||
          null,
        message:
          error?.message ||
          "No fue posible consultar Relbase",
      };
    }

    const mergedById =
      new Map();

    for (
      const product of
      stagingMatches
    ) {
      const key =
        product.id ||
        `sku:${normalizeSku(product.code)}`;

      mergedById.set(
        key,
        product
      );
    }

    for (
      const product of
      relbaseMatches
    ) {
      const key =
        product.id ||
        `sku:${normalizeSku(product.code)}`;

      const previous =
        mergedById.get(
          key
        );

      mergedById.set(
        key,
        {
          ...previous,
          ...product,
          source:
            previous
              ? "RELBASE+STAGING"
              : "RELBASE",
          linked_product_id:
            previous?.linked_product_id ||
            product.linked_product_id ||
            null,
          sync_status:
            previous?.sync_status ||
            product.sync_status ||
            null,
        }
      );
    }

    const matches =
      Array.from(
        mergedById.values()
      )
        .filter(
          (product) =>
            Boolean(
              product.code ||
              product.name
            )
        )
        .sort(
          (
            a,
            b
          ) => {
            const aExact =
              normalizeSku(
                a.code
              ) ===
              normalizedSku
                ? 0
                : 1;

            const bExact =
              normalizeSku(
                b.code
              ) ===
              normalizedSku
                ? 0
                : 1;

            if (
              aExact !==
              bExact
            ) {
              return (
                aExact -
                bExact
              );
            }

            return String(
              a.name ||
              a.code ||
              ""
            ).localeCompare(
              String(
                b.name ||
                b.code ||
                ""
              ),
              "es"
            );
          }
        )
        .slice(
          0,
          limit
        );

    const exactMatches =
      matches.filter(
        (product) =>
          normalizeSku(
            product.code
          ) ===
          normalizedSku
      );

    const uniqueExactIds =
      new Set(
        exactMatches
          .map(
            (product) =>
              product.id
          )
          .filter(Boolean)
      );

    if (
      uniqueExactIds.size >
      1
    ) {
      throw createServiceError(
        `Relbase devolvió más de un producto con el SKU ${normalizedSku}`,
        409,
        "RELBASE_DUPLICATE_SKU"
      );
    }

    const exactMatch =
      exactMatches[0] ||
      null;

    let stock =
      null;

    let stockError =
      null;

    if (
      exactMatch?.id &&
      !isFexShippingProduct(
        normalizedSku
      )
    ) {
      try {
        stock =
          await getRelbaseStockPreview(
            exactMatch.id
          );
      } catch (error) {
        stockError = {
          status:
            error?.status ||
            null,
          message:
            error?.message ||
            "No fue posible consultar el stock Relbase",
        };
      }
    }

    const verifiedAgainstRelbase =
      !directLookupError;

    return {
      query:
        normalizedQuery,

      normalized_sku:
        normalizedSku,

      found:
        Boolean(
          exactMatch
        ),

      verified_against_relbase:
        verifiedAgainstRelbase,

      will_create_if_saved:
        verifiedAgainstRelbase &&
        !exactMatch,

      exact_match:
        exactMatch,

      matches,

      local_product:
        localResult.rows[0] ||
        null,

      stock,

      warning:
        directLookupError
          ? {
              type:
                "RELBASE_LOOKUP_UNAVAILABLE",
              ...directLookupError,
            }
          : stockError
            ? {
                type:
                  "RELBASE_STOCK_UNAVAILABLE",
                ...stockError,
              }
            : null,
    };
  };

/* =========================================
   BUSCAR CATEGORÍA RELBASE POR NOMBRE

   Usa users:read.
   Permite resolver "Despacho" automáticamente
   cuando la categoría ya existe en Relbase.
========================================= */
const findRelbaseCategoryByName =
  async (categoryName) => {
    const normalizedName =
      normalizeText(
        categoryName
      );

    if (!normalizedName) {
      return null;
    }

    let page = 1;
    let hasNextPage = true;

    while (
      hasNextPage &&
      page <= 100
    ) {
      const params =
        new URLSearchParams({
          page:
            String(page),
        });

      const result =
        await relbaseRequest(
          `/api/v2/categorias?${params.toString()}`
        );

      const payload =
        result?.data ||
        null;

      const categories =
        extractRelbaseCategories(
          payload
        );

      const exact =
        categories.find(
          (category) =>
            normalizeText(
              category?.name
            ) ===
            normalizedName
        );

      if (exact?.id) {
        return {
          id:
            Number(
              exact.id
            ),
          name:
            String(
              exact.name ||
              ""
            ).trim(),
        };
      }

      const meta =
        payload?.meta ||
        {};

      const nextPage =
        Number(
          meta?.next_page
        );

      if (
        Number.isFinite(
          nextPage
        ) &&
        nextPage > page
      ) {
        page =
          nextPage;
        continue;
      }

      const totalPages =
        Number(
          meta?.total_pages
        );

      if (
        Number.isFinite(
          totalPages
        ) &&
        page < totalPages
      ) {
        page += 1;
        continue;
      }

      hasNextPage =
        false;
    }

    return null;
  };

/* =========================================
   MAPA EXPLÍCITO DE CATEGORÍAS RELBASE

   ENV opcional:

   RELBASE_PRODUCT_CATEGORY_MAP_JSON=
   {
     "abet-laminati|laminados":15676,
     "karikal|laminados":12345
   }
========================================= */
const getConfiguredCategoryId = (
  product
) => {
  const raw =
    String(
      process.env
        .RELBASE_PRODUCT_CATEGORY_MAP_JSON ||
        ""
    ).trim();

  if (!raw) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createServiceError(
      "RELBASE_PRODUCT_CATEGORY_MAP_JSON no contiene JSON válido",
      500,
      "RELBASE_CATEGORY_MAP_INVALID"
    );
  }

  const key = [
    normalizeText(
      product.brand_slug ||
      product.brand_name
    ),
    normalizeText(
      product.category_slug ||
      product.category_name
    ),
  ].join("|");

  const value =
    parsed?.[key];

  const categoryId =
    Number(value);

  return Number.isFinite(
    categoryId
  ) && categoryId > 0
    ? categoryId
    : null;
};

/* =========================================
   INFERIR CATEGORÍA RELBASE DESDE OTRO
   PRODUCTO YA VINCULADO DE LA MISMA
   CATEGORÍA + MARCA LOCAL.
========================================= */
const inferRelbaseCategoryId =
  async (product) => {
    const result = await pool.query(
      `
        SELECT
          NULLIF(
            s.raw_payload #>> '{category,id}',
            ''
          ) AS relbase_category_id,
          COUNT(*)::INTEGER AS uses_count,
          MAX(s.last_seen_at) AS last_seen_at

        FROM products p

        JOIN relbase_product_staging s
          ON s.relbase_product_id =
             p.relbase_product_id

        WHERE p.category_id = $1

          AND p.brand_id
            IS NOT DISTINCT FROM $2::uuid

          AND p.id <> $3

          AND NULLIF(
            s.raw_payload #>> '{category,id}',
            ''
          ) IS NOT NULL

        GROUP BY
          s.raw_payload #>> '{category,id}'

        ORDER BY
          uses_count DESC,
          last_seen_at DESC

        LIMIT 2
      `,
      [
        product.category_id,
        product.brand_id,
        product.id,
      ]
    );

    if (result.rowCount === 0) {
      return null;
    }

    if (
      result.rowCount > 1 &&
      Number(
        result.rows[0]
          .uses_count
      ) ===
      Number(
        result.rows[1]
          .uses_count
      )
    ) {
      return null;
    }

    const categoryId =
      Number(
        result.rows[0]
          .relbase_category_id
      );

    return Number.isFinite(
      categoryId
    ) && categoryId > 0
      ? categoryId
      : null;
  };

/* =========================================
   RESOLVER CATEGORÍA RELBASE
========================================= */
const resolveRelbaseCategoryId =
  async (product) => {
    const isFex =
      isFexShippingProduct(
        product
      );

    if (isFex) {
      const fexCategoryId =
        Number(
          process.env
            .RELBASE_FEX_CATEGORY_ID ||
          0
        );

      if (
        Number.isFinite(
          fexCategoryId
        ) &&
        fexCategoryId > 0
      ) {
        return {
          id:
            fexCategoryId,
          source:
            "ENV_FEX_CATEGORY",
        };
      }
    }

    const configured =
      getConfiguredCategoryId(
        product
      );

    if (configured) {
      return {
        id:
          configured,
        source:
          "ENV_MAP",
      };
    }

    /*
     * Para FEX no usamos una categoría genérica:
     * buscamos exactamente "Despacho" (o el nombre
     * de la categoría local) dentro de Relbase.
     */
    if (isFex) {
      const exactCategory =
        await findRelbaseCategoryByName(
          product.category_name
        );

      if (
        exactCategory?.id
      ) {
        return {
          id:
            exactCategory.id,
          source:
            "RELBASE_CATEGORY_NAME",
        };
      }

      return null;
    }

    const inferred =
      await inferRelbaseCategoryId(
        product
      );

    if (inferred) {
      return {
        id:
          inferred,
        source:
          "EXISTING_LINKED_PRODUCT",
      };
    }

    /*
     * Para categorías simples intentamos también
     * una coincidencia exacta por nombre.
     */
    try {
      const exactCategory =
        await findRelbaseCategoryByName(
          product.category_name
        );

      if (
        exactCategory?.id
      ) {
        return {
          id:
            exactCategory.id,
          source:
            "RELBASE_CATEGORY_NAME",
        };
      }
    } catch (error) {
      console.warn(
        "No fue posible resolver la categoría Relbase por nombre:",
        {
          category:
            product.category_name ||
            null,
          message:
            error?.message ||
            null,
        }
      );
    }

    const defaultId =
      Number(
        process.env
          .RELBASE_DEFAULT_PRODUCT_CATEGORY_ID ||
          0
      );

    if (
      Number.isFinite(defaultId) &&
      defaultId > 0
    ) {
      return {
        id:
          defaultId,
        source:
          "ENV_DEFAULT",
      };
    }

    return null;
  };

/* =========================================
   PRECIO RELBASE

   Laminatiword maneja base_price como precio
   final web. Por defecto se considera IVA
   incluido y Relbase recibe el valor neto.

   Se puede cambiar con:
   RELBASE_PRODUCT_PRICE_MODE=NET
========================================= */
const getRelbasePrice = (
  product
) => {
  const basePrice =
    Math.max(
      toFiniteNumber(
        product.base_price,
        0
      ),
      0
    );

  const taxRate =
    Math.max(
      toFiniteNumber(
        product.tax_rate,
        0
      ),
      0
    );

  const mode =
    String(
      process.env
        .RELBASE_PRODUCT_PRICE_MODE ||
        "GROSS"
    )
      .trim()
      .toUpperCase();

  if (
    mode === "NET" ||
    taxRate <= 0
  ) {
    return roundMoney(
      basePrice
    );
  }

  return roundMoney(
    basePrice /
      (1 + taxRate / 100)
  );
};

/* =========================================
   CREAR PRODUCTO EN RELBASE
========================================= */
const createRelbaseProduct =
  async (product) => {
    const category =
      await resolveRelbaseCategoryId(
        product
      );

    if (!category) {
      const isFex =
        isFexShippingProduct(
          product
        );

      throw createServiceError(
        isFex
          ? `No existe la categoría "${product.category_name}" en Relbase. Créala una sola vez en Relbase o configura RELBASE_FEX_CATEGORY_ID.`
          : `No existe una equivalencia de categoría Relbase para ${product.brand_name || "Sin marca"} / ${product.category_name}`,
        409,
        "RELBASE_CATEGORY_MAPPING_MISSING"
      );
    }

    const taxRate =
      Math.max(
        toFiniteNumber(
          product.tax_rate,
          0
        ),
        0
      );

    const currencyId =
      Number(
        process.env
          .RELBASE_DEFAULT_CURRENCY_ID ||
          1
      );

    const payload = {
      name:
        String(
          product.name
        ).trim(),

      code:
        normalizeSku(
          product.sku
        ),

      category_id:
        category.id,

      product_type:
        1,

      is_tax:
        taxRate > 0,

      is_inventory:
        !isFexShippingProduct(
          product
        ),

      currency:
        Number.isFinite(
          currencyId
        ) && currencyId > 0
          ? currencyId
          : 1,

      unit_cost:
        0,

      price:
        getRelbasePrice(
          product
        ),
    };

    try {
      const result =
        await relbaseRequest(
          "/api/v2/productos",
          {
            method:
              "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body:
              JSON.stringify(
                payload
              ),
          }
        );

      const created =
        extractSingleRelbaseProduct(
          result?.data || null
        );

      if (!created?.id) {
        throw new Error(
          "Relbase creó el producto pero no devolvió su ID"
        );
      }

      let hydrated =
        created;

      try {
        const detail =
          await relbaseRequest(
            `/api/v2/productos/${created.id}`
          );

        hydrated =
          extractSingleRelbaseProduct(
            detail?.data || null
          ) || created;
      } catch (
        detailError
      ) {
        console.warn(
          "Producto Relbase creado, pero no fue posible obtener el detalle completo:",
          {
            relbase_product_id:
              created.id,
            message:
              detailError?.message ||
              null,
          }
        );
      }

      return {
        product:
          hydrated,
        request_payload:
          payload,
        category_source:
          category.source,
      };
    } catch (error) {
      /*
       * Si la respuesta del POST fue ambigua
       * (timeout/5xx/conflicto), buscamos el SKU
       * otra vez antes de declarar fallo. Esto
       * reduce el riesgo de crear duplicados al
       * reintentar desde Laminatiword.
       */
      try {
        const recovered =
          await findExactRelbaseProductBySku(
            product.sku
          );

        if (recovered?.id) {
          return {
            product:
              recovered,
            request_payload:
              payload,
            category_source:
              category.source,
            recovered_after_error:
              true,
          };
        }
      } catch {
        // Conservamos el error original.
      }

      throw error;
    }
  };

/* =========================================
   VINCULAR PRODUCTO LOCAL + STAGING
========================================= */
const linkRelbaseProduct =
  async ({
    localProduct,
    relbaseProduct,
  }) => {
    const relbaseProductId =
      String(
        relbaseProduct?.id ||
        ""
      ).trim();

    if (!relbaseProductId) {
      throw createServiceError(
        "No fue posible resolver el ID del producto Relbase",
        502,
        "RELBASE_PRODUCT_ID_MISSING"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const staging =
        await upsertStagingProduct(
          client,
          relbaseProduct
        );

      if (
        staging.linked_product_id &&
        String(
          staging.linked_product_id
        ) !==
        String(
          localProduct.id
        )
      ) {
        throw createServiceError(
          `El producto Relbase ${relbaseProductId} ya está vinculado a otro producto Laminatiword`,
          409,
          "RELBASE_PRODUCT_ALREADY_LINKED"
        );
      }

      const otherLocal =
        await client.query(
          `
            SELECT
              id,
              sku,
              name
            FROM products
            WHERE relbase_product_id = $1
              AND id <> $2
            LIMIT 1
          `,
          [
            relbaseProductId,
            localProduct.id,
          ]
        );

      if (
        otherLocal.rowCount > 0
      ) {
        throw createServiceError(
          `El ID Relbase ${relbaseProductId} ya está asociado al SKU ${otherLocal.rows[0].sku}`,
          409,
          "RELBASE_PRODUCT_ALREADY_LINKED"
        );
      }

      await client.query(
        `
          UPDATE products
          SET
            relbase_product_id = $1,
            updated_at = NOW()
          WHERE id = $2
        `,
        [
          relbaseProductId,
          localProduct.id,
        ]
      );

      await client.query(
        `
          UPDATE relbase_product_staging
          SET
            linked_product_id = $1,
            sync_status = 'IMPORTED',
            imported_at =
              COALESCE(
                imported_at,
                NOW()
              ),
            last_seen_at = NOW(),
            updated_at = NOW()
          WHERE relbase_product_id = $2
        `,
        [
          localProduct.id,
          relbaseProductId,
        ]
      );

      await client.query(
        "COMMIT"
      );

      return {
        relbase_product_id:
          relbaseProductId,
        staging_id:
          staging.id,
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

/* =========================================
   SINCRONIZAR INVENTARIO SIN INVALIDAR
   UNA VINCULACIÓN YA EXITOSA
========================================= */
const trySyncInventory =
  async (
    productId,
    {
      skip = false,
      reason = null,
    } = {}
  ) => {
    if (skip) {
      return {
        success:
          true,
        skipped:
          true,
        reason:
          reason ||
          "Inventario no aplica para este producto",
      };
    }
    try {
      const result =
        await syncRelbaseProductInventory(
          productId
        );

      return {
        success:
          true,
        data:
          result,
      };
    } catch (error) {
      console.error(
        "Producto Relbase vinculado, pero falló la sincronización inicial de inventario:",
        {
          product_id:
            productId,
          message:
            error?.message ||
            null,
          code:
            error?.code ||
            null,
        }
      );

      return {
        success:
          false,
        message:
          error?.message ||
          "No fue posible sincronizar el inventario inicial",
        code:
          error?.code ||
          null,
      };
    }
  };

/* =========================================
   ASEGURAR PRODUCTO RELBASE

   ORDEN:
   1. Si local ya tiene ID -> solo stock.
   2. Buscar SKU exacto en staging.
   3. Buscar SKU exacto en Relbase.
   4. Si no existe -> crear en Relbase.
   5. Vincular.
   6. Traer stock real a inventory.
========================================= */
export const ensureRelbaseProductForLocalProduct =
  async (productId) => {
    const localProduct =
      await getLocalProduct(
        productId
      );

    if (
      localProduct.relbase_product_id
    ) {
      return {
        success:
          true,
        action:
          "ALREADY_LINKED",
        product_id:
          localProduct.id,
        relbase_product_id:
          String(
            localProduct.relbase_product_id
          ),
        inventory_sync:
          await trySyncInventory(
            localProduct.id,
            {
              skip:
                isFexShippingProduct(
                  localProduct
                ),
              reason:
                "Despacho FEX no administra inventario",
            }
          ),
      };
    }

    const staging =
      await findExactStagingProductBySku(
        localProduct.sku
      );

    if (staging) {
      if (
        staging.linked_product_id &&
        String(
          staging.linked_product_id
        ) !==
        String(
          localProduct.id
        )
      ) {
        throw createServiceError(
          `El SKU ${localProduct.sku} ya está vinculado a otro producto Laminatiword`,
          409,
          "RELBASE_SKU_ALREADY_LINKED"
        );
      }

      const relbaseProduct =
        staging.raw_payload &&
        typeof staging.raw_payload ===
          "object"
          ? staging.raw_payload
          : {
              id:
                staging.relbase_product_id,
              code:
                staging.code,
              name:
                staging.name,
            };

      if (!relbaseProduct.id) {
        relbaseProduct.id =
          staging.relbase_product_id;
      }

      const link =
        await linkRelbaseProduct({
          localProduct,
          relbaseProduct,
        });

      return {
        success:
          true,
        action:
          "FOUND_IN_STAGING",
        product_id:
          localProduct.id,
        relbase_product_id:
          link.relbase_product_id,
        inventory_sync:
          await trySyncInventory(
            localProduct.id,
            {
              skip:
                isFexShippingProduct(
                  localProduct
                ),
              reason:
                "Despacho FEX no administra inventario",
            }
          ),
      };
    }

    const foundInRelbase =
      await findExactRelbaseProductBySku(
        localProduct.sku
      );

    if (foundInRelbase) {
      const link =
        await linkRelbaseProduct({
          localProduct,
          relbaseProduct:
            foundInRelbase,
        });

      return {
        success:
          true,
        action:
          "FOUND_IN_RELBASE",
        product_id:
          localProduct.id,
        relbase_product_id:
          link.relbase_product_id,
        inventory_sync:
          await trySyncInventory(
            localProduct.id,
            {
              skip:
                isFexShippingProduct(
                  localProduct
                ),
              reason:
                "Despacho FEX no administra inventario",
            }
          ),
      };
    }

    const creation =
      await createRelbaseProduct(
        localProduct
      );

    const link =
      await linkRelbaseProduct({
        localProduct,
        relbaseProduct:
          creation.product,
      });

    return {
      success:
        true,
      action:
        "CREATED_IN_RELBASE",
      product_id:
        localProduct.id,
      relbase_product_id:
        link.relbase_product_id,
      relbase_category_source:
        creation.category_source,
      recovered_after_error:
        Boolean(
          creation.recovered_after_error
        ),
      inventory_sync:
          await trySyncInventory(
            localProduct.id,
            {
              skip:
                isFexShippingProduct(
                  localProduct
                ),
              reason:
                "Despacho FEX no administra inventario",
            }
          ),
    };
  };
