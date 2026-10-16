import { z } from "zod";

const nullableOptionalString = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => {
      if (value === null || value === undefined) {
        return null;
      }

      const normalized = String(value).trim();
      return normalized || null;
    });

const emailSchema = z
  .string()
  .trim()
  .email("Correo electrónico inválido")
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(8, "La contraseña debe tener al menos 8 caracteres")
  .max(72, "La contraseña es demasiado larga");

const personBaseSchema = {
  first_name: z
    .string()
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(100),

  last_name: z
    .string()
    .trim()
    .min(2, "El apellido debe tener al menos 2 caracteres")
    .max(100),

  email: emailSchema,

  password: passwordSchema,

  phone: nullableOptionalString(30),

  rut: nullableOptionalString(20),
};

export const registerSchema = z.object({
  ...personBaseSchema,
});

export const registerCompanySchema = z.object({
  ...personBaseSchema,

  company: z.object({
    legal_name: z
      .string()
      .trim()
      .min(2, "La razón social es obligatoria")
      .max(255),

    trade_name: nullableOptionalString(255),

    rut: z
      .string()
      .trim()
      .min(3, "El RUT de la empresa es obligatorio")
      .max(20),

    business_activity: z
      .string()
      .trim()
      .min(2, "El giro de la empresa es obligatorio")
      .max(255),

    billing_email: emailSchema.optional().nullable(),

    phone: nullableOptionalString(30),

    address_line: z
      .string()
      .trim()
      .min(3, "La dirección comercial es obligatoria")
      .max(255),

    commune: z
      .string()
      .trim()
      .min(2, "La comuna es obligatoria")
      .max(120),

    city: z
      .string()
      .trim()
      .min(2, "La ciudad es obligatoria")
      .max(120),

    region: z
      .string()
      .trim()
      .min(2, "La región es obligatoria")
      .max(120),

    country: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .default("Chile"),

    position_name: nullableOptionalString(120),
  }),
});

export const loginSchema = z.object({
  email: emailSchema,

  password: z
    .string()
    .min(1, "La contraseña es obligatoria"),
});
