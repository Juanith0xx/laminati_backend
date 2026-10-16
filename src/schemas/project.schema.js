import {
  z,
} from "zod";


const optionalNullableText = (
  max
) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max),
      z.null(),
    ])
    .optional();


const optionalNullableYear =
  z
    .union([
      z.coerce
        .number()
        .int()
        .min(1900)
        .max(2200),
      z.null(),
    ])
    .optional();


const optionalSortOrder =
  z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .optional();


export const projectCreateSchema =
  z.object({
    title:
      z
        .string()
        .trim()
        .min(2)
        .max(180),

    slug:
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional(),

    category:
      z
        .string()
        .trim()
        .min(2)
        .max(80),

    location:
      optionalNullableText(
        180
      ),

    project_year:
      optionalNullableYear,

    short_description:
      optionalNullableText(
        500
      ),

    description:
      z
        .union([
          z
            .string()
            .trim()
            .max(20000),
          z.null(),
        ])
        .optional(),

    cover_image_url:
      optionalNullableText(
        2048
      ),

    is_featured:
      z
        .boolean()
        .optional(),

    is_active:
      z
        .boolean()
        .optional(),

    sort_order:
      optionalSortOrder,

    meta_title:
      optionalNullableText(
        180
      ),

    meta_description:
      optionalNullableText(
        320
      ),
  })
  .strict();


export const projectUpdateSchema =
  projectCreateSchema
    .partial()
    .refine(
      (
        value
      ) =>
        Object.keys(
          value
        ).length > 0,
      {
        message:
          "Debe enviar al menos un campo para actualizar",
      }
    );


export const projectStatusSchema =
  z
    .object({
      status:
        z.enum([
          "DRAFT",
          "PUBLISHED",
          "ARCHIVED",
        ]),

      is_active:
        z
          .boolean()
          .optional(),
    })
    .strict();


export const projectImageCreateSchema =
  z
    .object({
      image_url:
        z
          .string()
          .trim()
          .min(1)
          .max(2048),

      alt_text:
        optionalNullableText(
          240
        ),

      caption:
        optionalNullableText(
          500
        ),

      sort_order:
        optionalSortOrder,

      is_primary:
        z
          .boolean()
          .optional(),
    })
    .strict();


export const projectImageUpdateSchema =
  projectImageCreateSchema
    .partial()
    .refine(
      (
        value
      ) =>
        Object.keys(
          value
        ).length > 0,
      {
        message:
          "Debe enviar al menos un campo para actualizar",
      }
    );


export const projectProductSchema =
  z
    .object({
      product_id:
        z
          .string()
          .uuid(),

      application_note:
        optionalNullableText(
          500
        ),

      sort_order:
        optionalSortOrder,
    })
    .strict();
