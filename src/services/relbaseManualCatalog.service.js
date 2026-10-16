import {
  relbaseRequest,
} from "./relbase.service.js";

/*
 * Catálogo técnico para líneas manuales del Showroom.
 *
 * OBJETIVO:
 * - SERV-HPL: servicios manuales (instalación, garantía, etc.).
 * - INS-HPL: insumos/materiales manuales sin producto local.
 *
 * Estos registros se crean UNA SOLA VEZ en Relbase y luego se reutilizan.
 * La descripción real que verá el cliente sigue viajando en cada línea del DTE.
 */

const MANUAL_KIND_SERVICE = "SERVICE";
const MANUAL_KIND_SUPPLY = "SUPPLY";

const MANUAL_CONFIG = {
  [MANUAL_KIND_SERVICE]: {
    code: String(
      process.env.RELBASE_MANUAL_SERVICE_CODE ||
        process.env.POS_MANUAL_SERVICE_SKU ||
        "SERV-HPL"
    )
      .trim()
      .toUpperCase(),

    name: String(
      process.env.RELBASE_MANUAL_SERVICE_NAME ||
        "Servicio manual HPL"
    ).trim(),

    /*
     * La API oficial documenta product_type como entero.
     * Dejamos el valor configurable para no acoplar el sistema
     * a una convención de catálogo particular de la cuenta.
     */
    productType: Number(
      process.env
        .RELBASE_MANUAL_SERVICE_PRODUCT_TYPE ||
        1
    ),
  },

  [MANUAL_KIND_SUPPLY]: {
    code: String(
      process.env.RELBASE_MANUAL_SUPPLY_CODE ||
        process.env.POS_MANUAL_SUPPLY_SKU ||
        "INS-HPL"
    )
      .trim()
      .toUpperCase(),

    name: String(
      process.env.RELBASE_MANUAL_SUPPLY_NAME ||
        "Insumo manual HPL"
    ).trim(),

    productType: Number(
      process.env
        .RELBASE_MANUAL_SUPPLY_PRODUCT_TYPE ||
        1
    ),
  },
};

const runtimeCache = new Map();

const createServiceError = (
  message,
  status = 500,
  code = null,
  details = null
) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
};

const toPositiveId = (value) => {
  const number = Number(value);

  return (
    Number.isInteger(number) &&
    number > 0
  )
    ? number
    : null;
};

const normalizeKind = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase();

  if (
    [
      "SERVICE",
      "SERVICIO",
    ].includes(raw)
  ) {
    return MANUAL_KIND_SERVICE;
  }

  if (
    [
      "SUPPLY",
      "INSUMO",
      "PRODUCT",
      "MATERIAL",
    ].includes(raw)
  ) {
    return MANUAL_KIND_SUPPLY;
  }

  throw createServiceError(
    "El tipo de línea manual debe ser SERVICE o SUPPLY",
    400,
    "RELBASE_MANUAL_KIND_INVALID"
  );
};

const getConfig = (kind) => {
  const normalizedKind =
    normalizeKind(kind);

  const config =
    MANUAL_CONFIG[normalizedKind];

  if (!config?.code) {
    throw createServiceError(
      "No fue posible resolver el código técnico de la línea manual",
      500,
      "RELBASE_MANUAL_CODE_MISSING"
    );
  }

  if (
    !Number.isInteger(
      config.productType
    ) ||
    config.productType < 0
  ) {
    throw createServiceError(
      "El product_type configurado para la línea manual no es válido",
      500,
      "RELBASE_MANUAL_PRODUCT_TYPE_INVALID"
    );
  }

  return {
    kind: normalizedKind,
    ...config,
  };
};

/*
 * Relbase ha usado más de una forma de envelope a lo largo
 * de la integración. Este helper tolera:
 * - { data: [ ... ] }
 * - { data: { products: [ ... ] } }
 * - { products: [ ... ] }
 */
const extractProductArray = (
  payload
) => {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    Array.isArray(payload.products)
  ) {
    return payload.products;
  }

  if (
    Array.isArray(payload.data)
  ) {
    return payload.data;
  }

  if (
    payload.data &&
    typeof payload.data === "object"
  ) {
    const nested =
      extractProductArray(
        payload.data
      );

    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
};

const extractSingleProduct = (
  payload
) => {
  if (!payload) {
    return null;
  }

  if (
    payload.id &&
    (
      payload.code ||
      payload.name
    )
  ) {
    return payload;
  }

  if (
    payload.product &&
    typeof payload.product === "object"
  ) {
    return payload.product;
  }

  if (
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
  ) {
    return (
      extractSingleProduct(
        payload.data
      ) ||
      null
    );
  }

  const products =
    extractProductArray(payload);

  return products[0] || null;
};

const getCategoryIdFromProduct = (
  product
) => {
  return (
    toPositiveId(
      product?.category?.id
    ) ||
    toPositiveId(
      product?.category_id
    ) ||
    null
  );
};

const searchRelbaseProductByCode =
  async (code) => {
    const normalizedCode =
      String(code || "")
        .trim()
        .toUpperCase();

    const params =
      new URLSearchParams({
        query:
          normalizedCode,
        page: "1",
        per_page: "100",
      });

    const result =
      await relbaseRequest(
        `/api/v2/productos?${params.toString()}`,
        {
          method: "GET",
        }
      );

    const products =
      extractProductArray(
        result?.data
      );

    return (
      products.find(
        (product) =>
          String(
            product?.code || ""
          )
            .trim()
            .toUpperCase() ===
          normalizedCode
      ) ||
      null
    );
  };

const getRelbaseProductById =
  async (id) => {
    const productId =
      toPositiveId(id);

    if (!productId) {
      return null;
    }

    const result =
      await relbaseRequest(
        `/api/v2/productos/${productId}`,
        {
          method: "GET",
        }
      );

    return (
      extractSingleProduct(
        result?.data
      ) ||
      null
    );
  };

/*
 * Para crear un producto Relbase necesitamos category_id.
 *
 * Prioridad:
 * 1. RELBASE_MANUAL_CATEGORY_ID explícito.
 * 2. La categoría del producto FEX-DESPACHO, que ya forma
 *    parte de esta integración.
 * 3. La categoría de cualquier producto existente.
 *
 * De esta forma no obligamos a crear una migración ni a
 * mantener un ID de producto técnico fijo.
 */
const resolveRelbaseManualCategoryId =
  async () => {
    const configured =
      toPositiveId(
        process.env
          .RELBASE_MANUAL_CATEGORY_ID
      );

    if (configured) {
      return configured;
    }

    const fexCode =
      String(
        process.env
          .FEX_SHIPPING_SKU ||
        "FEX-DESPACHO"
      )
        .trim()
        .toUpperCase();

    try {
      const fexProduct =
        await searchRelbaseProductByCode(
          fexCode
        );

      if (fexProduct) {
        let categoryId =
          getCategoryIdFromProduct(
            fexProduct
          );

        if (
          !categoryId &&
          fexProduct.id
        ) {
          const detail =
            await getRelbaseProductById(
              fexProduct.id
            );

          categoryId =
            getCategoryIdFromProduct(
              detail
            );
        }

        if (categoryId) {
          return categoryId;
        }
      }
    } catch {
      /*
       * La búsqueda de FEX es sólo fallback.
       * Seguimos intentando con el catálogo general.
       */
    }

    try {
      const result =
        await relbaseRequest(
          "/api/v2/productos?page=1&per_page=20",
          {
            method: "GET",
          }
        );

      const products =
        extractProductArray(
          result?.data
        );

      for (
        const product of products
      ) {
        let categoryId =
          getCategoryIdFromProduct(
            product
          );

        if (
          !categoryId &&
          product?.id
        ) {
          const detail =
            await getRelbaseProductById(
              product.id
            );

          categoryId =
            getCategoryIdFromProduct(
              detail
            );
        }

        if (categoryId) {
          return categoryId;
        }
      }
    } catch {
      // El error final se normaliza abajo.
    }

    throw createServiceError(
      "No fue posible resolver una categoría Relbase para crear las líneas manuales. Configura RELBASE_MANUAL_CATEGORY_ID con una categoría válida.",
      500,
      "RELBASE_MANUAL_CATEGORY_ID_MISSING"
    );
  };

const createRelbaseManualProduct =
  async ({
    code,
    name,
    productType,
  }) => {
    const categoryId =
      await resolveRelbaseManualCategoryId();

    const payload = {
      name,
      code,
      category_id:
        categoryId,
      product_type:
        productType,

      /*
       * Afecto a IVA.
       * No controlamos inventario en Relbase para estas
       * líneas manuales: el origen de la cantidad es el POS.
       */
      is_tax: true,
      is_inventory: false,

      /*
       * 1 = moneda base/pesos en el contrato actual usado
       * por la cuenta.
       *
       * El precio técnico es 1 porque el DTE siempre envía
       * el precio real de la operación.
       */
      currency: 1,
      unit_cost: 0,
      price: 1,
    };

    try {
      const result =
        await relbaseRequest(
          "/api/v2/productos",
          {
            method: "POST",
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
        extractSingleProduct(
          result?.data
        );

      const id =
        toPositiveId(
          created?.id
        );

      if (!id) {
        throw createServiceError(
          "Relbase creó la línea técnica pero no devolvió un ID de producto válido",
          502,
          "RELBASE_MANUAL_PRODUCT_ID_NOT_RETURNED",
          {
            code,
          }
        );
      }

      return {
        id:
          String(id),
        code:
          String(
            created?.code ||
              code
          )
            .trim()
            .toUpperCase(),
        name:
          created?.name ||
          name,
        created: true,
        category_id:
          categoryId,
      };
    } catch (error) {
      /*
       * Si dos ventas concurrentes intentan crear el mismo
       * SKU, una puede recibir conflicto/validación por código
       * duplicado. Reconsultamos y reutilizamos el registro.
       */
      if (
        [
          400,
          409,
          422,
        ].includes(
          Number(
            error?.status
          )
        )
      ) {
        const existing =
          await searchRelbaseProductByCode(
            code
          );

        const existingId =
          toPositiveId(
            existing?.id
          );

        if (existingId) {
          return {
            id:
              String(
                existingId
              ),
            code:
              String(
                existing?.code ||
                  code
              )
                .trim()
                .toUpperCase(),
            name:
              existing?.name ||
              name,
            created: false,
            category_id:
              getCategoryIdFromProduct(
                existing
              ),
          };
        }
      }

      if (
        Number(error?.status) ===
        403
      ) {
        throw createServiceError(
          "Relbase no permitió crear la línea manual. La conexión OAuth debe incluir products:write; luego debes reconectar Relbase para obtener un token con ese scope.",
          502,
          "RELBASE_PRODUCTS_WRITE_SCOPE_REQUIRED",
          error?.relbaseData ||
            null
        );
      }

      throw error;
    }
  };

/*
 * Garantiza que el SKU técnico exista en Relbase.
 *
 * Backward compatibility:
 * si todavía existe RELBASE_MANUAL_SERVICE_PRODUCT_ID
 * o RELBASE_MANUAL_SUPPLY_PRODUCT_ID, se respeta.
 */
export const ensureRelbaseManualCatalogItem =
  async (kind) => {
    const config =
      getConfig(kind);

    const cached =
      runtimeCache.get(
        config.kind
      );

    if (cached) {
      return cached;
    }

    const configuredId =
      config.kind ===
      MANUAL_KIND_SERVICE
        ? toPositiveId(
            process.env
              .RELBASE_MANUAL_SERVICE_PRODUCT_ID
          )
        : toPositiveId(
            process.env
              .RELBASE_MANUAL_SUPPLY_PRODUCT_ID
          );

    if (configuredId) {
      const resolved = {
        id:
          String(
            configuredId
          ),
        code:
          config.code,
        name:
          config.name,
        created: false,
        source:
          "ENV",
      };

      runtimeCache.set(
        config.kind,
        resolved
      );

      return resolved;
    }

    const existing =
      await searchRelbaseProductByCode(
        config.code
      );

    const existingId =
      toPositiveId(
        existing?.id
      );

    if (existingId) {
      const resolved = {
        id:
          String(
            existingId
          ),
        code:
          String(
            existing?.code ||
              config.code
          )
            .trim()
            .toUpperCase(),
        name:
          existing?.name ||
          config.name,
        created: false,
        source:
          "RELBASE",
      };

      runtimeCache.set(
        config.kind,
        resolved
      );

      return resolved;
    }

    const created =
      await createRelbaseManualProduct({
        code:
          config.code,
        name:
          config.name,
        productType:
          config.productType,
      });

    const resolved = {
      ...created,
      source:
        created.created
          ? "RELBASE_CREATED"
          : "RELBASE",
    };

    runtimeCache.set(
      config.kind,
      resolved
    );

    return resolved;
  };

export const getRelbaseManualCatalogCodes =
  () => ({
    service:
      MANUAL_CONFIG[
        MANUAL_KIND_SERVICE
      ].code,
    supply:
      MANUAL_CONFIG[
        MANUAL_KIND_SUPPLY
      ].code,
  });
