import { z } from "zod";

const optionalNullableText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable();

export const updateAccountProfileSchema = z
  .object({
    first_name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(100)
      .optional(),

    last_name: z
      .string()
      .trim()
      .min(2, "El apellido debe tener al menos 2 caracteres")
      .max(100)
      .optional(),

    phone: optionalNullableText(30),
    rut: optionalNullableText(20),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    "Debes informar al menos un campo para actualizar"
  );

const addressFields = {
  label: optionalNullableText(100),

  recipient_name: z
    .string()
    .trim()
    .min(2, "El nombre del destinatario es obligatorio")
    .max(255),

  rut: optionalNullableText(20),
  phone: optionalNullableText(30),

  street: z
    .string()
    .trim()
    .min(2, "La calle es obligatoria")
    .max(255),

  street_number: z
    .string()
    .trim()
    .min(1, "El número es obligatorio")
    .max(50),

  apartment: optionalNullableText(100),

  commune: z
    .string()
    .trim()
    .min(2, "La comuna es obligatoria")
    .max(150),

  city: optionalNullableText(150),

  region: z
    .string()
    .trim()
    .min(2, "La región es obligatoria")
    .max(150),

  country: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .default("Chile"),

  postal_code: optionalNullableText(20),
  delivery_notes: optionalNullableText(2000),
  is_default: z.boolean().optional(),
};

export const createAddressSchema = z.object(addressFields);

export const updateAddressSchema = z
  .object({
    label: optionalNullableText(100),
    recipient_name: z
      .string()
      .trim()
      .min(2)
      .max(255)
      .optional(),
    rut: optionalNullableText(20),
    phone: optionalNullableText(30),
    street: z
      .string()
      .trim()
      .min(2)
      .max(255)
      .optional(),
    street_number: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional(),
    apartment: optionalNullableText(100),
    commune: z
      .string()
      .trim()
      .min(2)
      .max(150)
      .optional(),
    city: optionalNullableText(150),
    region: z
      .string()
      .trim()
      .min(2)
      .max(150)
      .optional(),
    country: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional(),
    postal_code: optionalNullableText(20),
    delivery_notes: optionalNullableText(2000),
    is_default: z.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    "Debes informar al menos un campo para actualizar"
  );

export const updateCompanySchema = z
  .object({
    trade_name: optionalNullableText(255),
    business_activity: optionalNullableText(255),
    billing_email: z
      .string()
      .trim()
      .email("Correo de facturación inválido")
      .max(255)
      .optional()
      .nullable(),
    phone: optionalNullableText(30),
    address_line: optionalNullableText(255),
    commune: optionalNullableText(150),
    city: optionalNullableText(150),
    region: optionalNullableText(150),
    country: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    "Debes informar al menos un campo para actualizar"
  );
