import { z } from "zod";

/* =========================================
   CREAR CATEGORÍA
========================================= */
export const createCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(255),

  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable(),

  parent_id: z
    .string()
    .uuid("El parent_id debe ser un UUID válido")
    .optional()
    .nullable(),

  is_active: z
    .boolean()
    .optional()
    .default(true),

  sort_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0),
});

/* =========================================
   ACTUALIZAR CATEGORÍA
========================================= */
export const updateCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(255)
      .optional(),

    description: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .nullable(),

    parent_id: z
      .string()
      .uuid("El parent_id debe ser un UUID válido")
      .optional()
      .nullable(),

    is_active: z
      .boolean()
      .optional(),

    sort_order: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message:
        "Debes enviar al menos un campo para actualizar",
    }
  );

  /* =========================================
   CREAR MARCA
========================================= */
export const createBrandSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(255),

  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable(),

  website_url: z
    .string()
    .trim()
    .url("La URL del sitio web no es válida")
    .optional()
    .nullable(),

  logo_url: z
    .string()
    .trim()
    .url("La URL del logo no es válida")
    .optional()
    .nullable(),

  is_active: z
    .boolean()
    .optional()
    .default(true),

  sort_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0),
});

/* =========================================
   ACTUALIZAR MARCA
========================================= */
export const updateBrandSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(255)
      .optional(),

    description: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .nullable(),

    website_url: z
      .string()
      .trim()
      .url("La URL del sitio web no es válida")
      .optional()
      .nullable(),

    logo_url: z
      .string()
      .trim()
      .url("La URL del logo no es válida")
      .optional()
      .nullable(),

    is_active: z
      .boolean()
      .optional(),

    sort_order: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message: "Debes enviar al menos un campo para actualizar",
    }
  );

  /* =========================================
   CREAR COLECCIÓN
========================================= */
export const createCollectionSchema = z.object({
  brand_id: z
    .string()
    .uuid("El brand_id debe ser un UUID válido"),

  name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(150),

  description: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .nullable(),

  image_url: z
    .string()
    .trim()
    .url("La URL de imagen no es válida")
    .optional()
    .nullable(),

  banner_url: z
    .string()
    .trim()
    .url("La URL del banner no es válida")
    .optional()
    .nullable(),

  is_featured: z
    .boolean()
    .optional()
    .default(false),

  is_active: z
    .boolean()
    .optional()
    .default(true),

  sort_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0),
});

/* =========================================
   ACTUALIZAR COLECCIÓN
========================================= */
export const updateCollectionSchema = z
  .object({
    brand_id: z
      .string()
      .uuid("El brand_id debe ser un UUID válido")
      .optional(),

    name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(150)
      .optional(),

    description: z
      .string()
      .trim()
      .max(3000)
      .optional()
      .nullable(),

    image_url: z
      .string()
      .trim()
      .url("La URL de imagen no es válida")
      .optional()
      .nullable(),

    banner_url: z
      .string()
      .trim()
      .url("La URL del banner no es válida")
      .optional()
      .nullable(),

    is_featured: z
      .boolean()
      .optional(),

    is_active: z
      .boolean()
      .optional(),

    sort_order: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message: "Debes enviar al menos un campo para actualizar",
    }
  );

  /* =========================================
   CREAR PRODUCTO
========================================= */
export const createProductSchema = z.object({
  category_id: z
    .string()
    .uuid("El category_id debe ser un UUID válido"),

  brand_id: z
    .string()
    .uuid("El brand_id debe ser un UUID válido")
    .optional()
    .nullable(),

  collection_id: z
    .string()
    .uuid("El collection_id debe ser un UUID válido")
    .optional()
    .nullable(),

  commercial_mode: z
    .enum(["WEB", "PROJECT_ONLY"])
    .optional()
    .default("WEB"),

  project_family_id: z
    .string()
    .uuid("El project_family_id debe ser un UUID válido")
    .optional()
    .nullable(),

  sku: z
    .string()
    .trim()
    .min(1, "El SKU es obligatorio")
    .max(120)
    .transform((value) => value.toUpperCase()),

  internal_code: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable(),

  relbase_product_id: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable(),

  name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(255),

  short_description: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .nullable(),

  description: z
    .string()
    .trim()
    .max(10000)
    .optional()
    .nullable(),

  base_price: z
    .number()
    .min(0)
    .optional()
    .nullable(),

  tax_rate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .default(19),

  width_mm: z
    .number()
    .min(0)
    .optional()
    .nullable(),

  height_mm: z
    .number()
    .min(0)
    .optional()
    .nullable(),

  thickness_mm: z
    .number()
    .min(0)
    .optional()
    .nullable(),

  weight_kg: z
    .number()
    .min(0)
    .optional()
    .nullable(),

  color: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable(),

  finish: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable(),

  texture: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable(),

  is_active: z
    .boolean()
    .optional()
    .default(true),

  is_published: z
    .boolean()
    .optional()
    .default(false),

  is_featured: z
    .boolean()
    .optional()
    .default(false),

  allow_sale: z
    .boolean()
    .optional()
    .default(true),

  sort_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0),
})
.superRefine((data, ctx) => {
  if (data.commercial_mode === "PROJECT_ONLY" && !data.project_family_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["project_family_id"],
      message: "Los productos de proyecto deben indicar una familia técnica",
    });
  }
});

/* =========================================
   ACTUALIZAR PRODUCTO
========================================= */
export const updateProductSchema = z
  .object({
    category_id: z
      .string()
      .uuid("El category_id debe ser un UUID válido")
      .optional(),

    brand_id: z
      .string()
      .uuid("El brand_id debe ser un UUID válido")
      .optional()
      .nullable(),

    collection_id: z
      .string()
      .uuid("El collection_id debe ser un UUID válido")
      .optional()
      .nullable(),

    commercial_mode: z.enum(["WEB", "PROJECT_ONLY"]).optional(),

    project_family_id: z
      .string()
      .uuid("El project_family_id debe ser un UUID válido")
      .optional()
      .nullable(),

    sku: z
      .string()
      .trim()
      .min(1, "El SKU no puede estar vacío")
      .max(120)
      .transform((value) => value.toUpperCase())
      .optional(),

    internal_code: z
      .string()
      .trim()
      .max(120)
      .optional()
      .nullable(),

    relbase_product_id: z
      .string()
      .trim()
      .max(120)
      .optional()
      .nullable(),

    name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(255)
      .optional(),

    short_description: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .nullable(),

    description: z
      .string()
      .trim()
      .max(10000)
      .optional()
      .nullable(),

    base_price: z
      .number()
      .min(0)
      .optional()
      .nullable(),

    tax_rate: z
      .number()
      .min(0)
      .max(100)
      .optional(),

    width_mm: z
      .number()
      .min(0)
      .optional()
      .nullable(),

    height_mm: z
      .number()
      .min(0)
      .optional()
      .nullable(),

    thickness_mm: z
      .number()
      .min(0)
      .optional()
      .nullable(),

    weight_kg: z
      .number()
      .min(0)
      .optional()
      .nullable(),

    color: z
      .string()
      .trim()
      .max(120)
      .optional()
      .nullable(),

    finish: z
      .string()
      .trim()
      .max(120)
      .optional()
      .nullable(),

    texture: z
      .string()
      .trim()
      .max(120)
      .optional()
      .nullable(),

    is_active: z
      .boolean()
      .optional(),

    is_published: z
      .boolean()
      .optional(),

    is_featured: z
      .boolean()
      .optional(),

    allow_sale: z
      .boolean()
      .optional(),

    sort_order: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message:
        "Debes enviar al menos un campo para actualizar",
    }
  );

  /* =========================================
   CREAR IMAGEN DE PRODUCTO
========================================= */
export const createProductImageSchema = z.object({
  image_url: z
    .string()
    .trim()
    .url("La URL de la imagen no es válida"),

  alt_text: z
    .string()
    .trim()
    .max(255)
    .optional()
    .nullable(),

  is_primary: z
    .boolean()
    .optional()
    .default(false),

  sort_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0),
});

/* =========================================
   ACTUALIZAR IMAGEN DE PRODUCTO
========================================= */
export const updateProductImageSchema = z
  .object({
    image_url: z
      .string()
      .trim()
      .url("La URL de la imagen no es válida")
      .optional(),

    alt_text: z
      .string()
      .trim()
      .max(255)
      .optional()
      .nullable(),

    is_primary: z
      .boolean()
      .optional(),

    sort_order: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message:
        "Debes enviar al menos un campo para actualizar",
    }
  );

  /* =========================================
   SEO DE PRODUCTO
========================================= */
export const productSeoSchema = z.object({
  meta_title: z
    .string()
    .trim()
    .max(255)
    .optional()
    .nullable(),

  meta_description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable(),

  canonical_url: z
    .string()
    .trim()
    .url("La URL canonical no es válida")
    .optional()
    .nullable(),

  og_title: z
    .string()
    .trim()
    .max(255)
    .optional()
    .nullable(),

  og_description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable(),

  og_image_url: z
    .string()
    .trim()
    .url("La URL de Open Graph no es válida")
    .optional()
    .nullable(),

  robots_index: z
    .boolean()
    .optional()
    .default(true),

  robots_follow: z
    .boolean()
    .optional()
    .default(true),
});

/* =========================================
   PROMOCIONES
========================================= */
export const PROMOTION_TYPES = {
  FIXED_PRICE: "FIXED_PRICE",
  QUANTITY_TIER: "QUANTITY_TIER",
};

const promotionTierSchema = z.object({
  min_quantity: z
    .number()
    .positive(
      "La cantidad mínima debe ser mayor que 0"
    ),

  unit_price: z
    .number()
    .min(
      0,
      "El precio por tramo no puede ser negativo"
    ),
});

const promotionTypeSchema = z.enum([
  PROMOTION_TYPES.FIXED_PRICE,
  PROMOTION_TYPES.QUANTITY_TIER,
]);

const validatePromotionTiers = (
  tiers,
  ctx
) => {
  if (
    !Array.isArray(tiers) ||
    tiers.length === 0
  ) {
    ctx.addIssue({
      code:
        z.ZodIssueCode.custom,
      path: [
        "tiers",
      ],
      message:
        "Una promoción por cantidad requiere al menos un tramo",
    });

    return;
  }

  const sorted =
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

  const seen =
    new Set();

  for (
    let index = 0;
    index <
    sorted.length;
    index += 1
  ) {
    const tier =
      sorted[index];

    const quantityKey =
      String(
        Number(
          tier.min_quantity
        )
      );

    if (
      seen.has(
        quantityKey
      )
    ) {
      ctx.addIssue({
        code:
          z.ZodIssueCode.custom,
        path: [
          "tiers",
        ],
        message:
          "No puedes repetir la misma cantidad mínima en dos tramos",
      });

      break;
    }

    seen.add(
      quantityKey
    );

    if (
      index > 0 &&
      Number(
        tier.unit_price
      ) >
        Number(
          sorted[
            index - 1
          ].unit_price
        )
    ) {
      ctx.addIssue({
        code:
          z.ZodIssueCode.custom,
        path: [
          "tiers",
        ],
        message:
          "El precio unitario no puede aumentar al subir de tramo",
      });

      break;
    }
  }
};

/* =========================================
   CREAR PROMOCIÓN
========================================= */
export const createPromotionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(
        2,
        "El nombre debe tener al menos 2 caracteres"
      )
      .max(255),

    promotion_type:
      promotionTypeSchema
        .optional()
        .default(
          PROMOTION_TYPES.FIXED_PRICE
        ),

    promotional_price: z
      .number()
      .min(
        0,
        "El precio promocional no puede ser negativo"
      )
      .optional()
      .nullable(),

    tiers: z
      .array(
        promotionTierSchema
      )
      .max(
        50,
        "Una promoción no puede tener más de 50 tramos"
      )
      .optional(),

    starts_at: z
      .string()
      .datetime({
        offset: true,
        message:
          "La fecha de inicio no es válida",
      })
      .optional()
      .nullable(),

    ends_at: z
      .string()
      .datetime({
        offset: true,
        message:
          "La fecha de término no es válida",
      })
      .optional()
      .nullable(),

    is_active: z
      .boolean()
      .optional()
      .default(true),
  })
  .superRefine(
    (
      data,
      ctx
    ) => {
      if (
        data.starts_at &&
        data.ends_at &&
        new Date(
          data.ends_at
        ) <=
          new Date(
            data.starts_at
          )
      ) {
        ctx.addIssue({
          code:
            z.ZodIssueCode.custom,
          path: [
            "ends_at",
          ],
          message:
            "La fecha de término debe ser posterior a la fecha de inicio",
        });
      }

      if (
        data.promotion_type ===
        PROMOTION_TYPES.FIXED_PRICE
      ) {
        if (
          data.promotional_price ===
            undefined ||
          data.promotional_price ===
            null
        ) {
          ctx.addIssue({
            code:
              z.ZodIssueCode.custom,
            path: [
              "promotional_price",
            ],
            message:
              "La promoción de precio fijo requiere un precio promocional",
          });
        }

        if (
          Array.isArray(
            data.tiers
          ) &&
          data.tiers.length >
            0
        ) {
          ctx.addIssue({
            code:
              z.ZodIssueCode.custom,
            path: [
              "tiers",
            ],
            message:
              "Una promoción de precio fijo no debe incluir tramos por cantidad",
          });
        }

        return;
      }

      if (
        data.promotional_price !==
          undefined &&
        data.promotional_price !==
          null
      ) {
        ctx.addIssue({
          code:
            z.ZodIssueCode.custom,
          path: [
            "promotional_price",
          ],
          message:
            "Una promoción por cantidad no utiliza promotional_price",
        });
      }

      validatePromotionTiers(
        data.tiers,
        ctx
      );
    }
  );

/* =========================================
   ACTUALIZAR PROMOCIÓN
========================================= */
export const updatePromotionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(
        2,
        "El nombre debe tener al menos 2 caracteres"
      )
      .max(255)
      .optional(),

    promotion_type:
      promotionTypeSchema
        .optional(),

    promotional_price: z
      .number()
      .min(
        0,
        "El precio promocional no puede ser negativo"
      )
      .optional()
      .nullable(),

    tiers: z
      .array(
        promotionTierSchema
      )
      .max(
        50,
        "Una promoción no puede tener más de 50 tramos"
      )
      .optional(),

    starts_at: z
      .string()
      .datetime({
        offset: true,
        message:
          "La fecha de inicio no es válida",
      })
      .optional()
      .nullable(),

    ends_at: z
      .string()
      .datetime({
        offset: true,
        message:
          "La fecha de término no es válida",
      })
      .optional()
      .nullable(),

    is_active: z
      .boolean()
      .optional(),
  })
  .superRefine(
    (
      data,
      ctx
    ) => {
      if (
        Object.keys(
          data
        ).length === 0
      ) {
        ctx.addIssue({
          code:
            z.ZodIssueCode.custom,
          message:
            "Debes enviar al menos un campo para actualizar",
        });

        return;
      }

      if (
        data.starts_at &&
        data.ends_at &&
        new Date(
          data.ends_at
        ) <=
          new Date(
            data.starts_at
          )
      ) {
        ctx.addIssue({
          code:
            z.ZodIssueCode.custom,
          path: [
            "ends_at",
          ],
          message:
            "La fecha de término debe ser posterior a la fecha de inicio",
        });
      }

      if (
        data.promotion_type ===
        PROMOTION_TYPES.FIXED_PRICE &&
        Array.isArray(
          data.tiers
        ) &&
        data.tiers.length >
          0
      ) {
        ctx.addIssue({
          code:
            z.ZodIssueCode.custom,
          path: [
            "tiers",
          ],
          message:
            "Una promoción de precio fijo no debe incluir tramos por cantidad",
        });
      }

      if (
        data.promotion_type ===
        PROMOTION_TYPES.QUANTITY_TIER
      ) {
        if (
          data.promotional_price !==
            undefined &&
          data.promotional_price !==
            null
        ) {
          ctx.addIssue({
            code:
              z.ZodIssueCode.custom,
            path: [
              "promotional_price",
            ],
            message:
              "Una promoción por cantidad no utiliza promotional_price",
          });
        }

        if (
          data.tiers !==
          undefined
        ) {
          validatePromotionTiers(
            data.tiers,
            ctx
          );
        }
      } else if (
        data.tiers !==
        undefined
      ) {
        validatePromotionTiers(
          data.tiers,
          ctx
        );
      }
    }
  );

/* =========================================
   ACTUALIZAR STOCK DE SEGURIDAD
========================================= */
export const updateInventorySafetyStockSchema = z.object({
  safety_stock: z
    .number()
    .min(0, "El stock de seguridad no puede ser negativo"),
});