/* =========================================
   UTILIDADES RUT CHILE
========================================= */


/* =========================================
   LIMPIAR RUT

   Ejemplos:
   76.376.809-0 -> 763768090
   763768090    -> 763768090
   12.345.678-K -> 12345678K
========================================= */
export const cleanRut = (value) => {
  return String(
    value ?? ""
  )
    .trim()
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/-/g, "")
    .replace(/\s+/g, "");
};


/* =========================================
   CALCULAR DÍGITO VERIFICADOR
========================================= */
export const calculateRutDv = (
  rutBody
) => {
  const normalizedBody =
    String(
      rutBody ?? ""
    )
      .trim()
      .replace(/\D/g, "");

  if (!normalizedBody) {
    return null;
  }

  let sum = 0;
  let multiplier = 2;

  for (
    let index =
      normalizedBody.length - 1;
    index >= 0;
    index -= 1
  ) {
    sum +=
      Number(
        normalizedBody[index]
      ) *
      multiplier;

    multiplier += 1;

    if (multiplier > 7) {
      multiplier = 2;
    }
  }

  const remainder =
    11 - (sum % 11);

  if (remainder === 11) {
    return "0";
  }

  if (remainder === 10) {
    return "K";
  }

  return String(
    remainder
  );
};


/* =========================================
   FORMATEAR RUT

   Entrada:
   763768090

   Salida:
   76.376.809-0
========================================= */
export const formatRut = (value) => {
  const cleaned =
    cleanRut(value);

  if (
    cleaned.length < 2
  ) {
    return null;
  }

  const body =
    cleaned.slice(0, -1);

  const dv =
    cleaned.slice(-1);

  if (
    !/^\d+$/.test(body) ||
    !/^[0-9K]$/.test(dv)
  ) {
    return null;
  }

  const formattedBody =
    body.replace(
      /\B(?=(\d{3})+(?!\d))/g,
      "."
    );

  return `${formattedBody}-${dv}`;
};


/* =========================================
   VALIDAR RUT
========================================= */
export const isValidRut = (value) => {
  const cleaned =
    cleanRut(value);

  /*
   * RUT mínimo:
   * cuerpo numérico + DV.
   */
  if (
    cleaned.length < 2
  ) {
    return false;
  }

  const body =
    cleaned.slice(0, -1);

  const receivedDv =
    cleaned.slice(-1);

  if (
    !/^\d+$/.test(body) ||
    !/^[0-9K]$/.test(
      receivedDv
    )
  ) {
    return false;
  }

  /*
   * Evita cuerpos completamente
   * formados por ceros.
   */
  if (
    Number(body) === 0
  ) {
    return false;
  }

  const expectedDv =
    calculateRutDv(body);

  return (
    expectedDv ===
    receivedDv
  );
};


/* =========================================
   NORMALIZAR RUT

   Devuelve estructura canónica.

   Si es inválido:
   {
     valid: false,
     ...
   }

   Si es válido:
   {
     valid: true,
     normalized: "763768090",
     formatted: "76.376.809-0",
     body: "76376809",
     dv: "0"
   }
========================================= */
export const normalizeRut = (value) => {
  const cleaned =
    cleanRut(value);

  if (
    cleaned.length < 2
  ) {
    return {
      valid: false,
      normalized: null,
      formatted: null,
      body: null,
      dv: null,
    };
  }

  const body =
    cleaned.slice(0, -1);

  const dv =
    cleaned.slice(-1);

  if (
    !/^\d+$/.test(body) ||
    !/^[0-9K]$/.test(dv)
  ) {
    return {
      valid: false,
      normalized: null,
      formatted: null,
      body: null,
      dv: null,
    };
  }

  const valid =
    isValidRut(cleaned);

  return {
    valid,

    normalized:
      valid
        ? `${body}${dv}`
        : null,

    formatted:
      valid
        ? formatRut(
            `${body}${dv}`
          )
        : null,

    body:
      valid
        ? body
        : null,

    dv:
      valid
        ? dv
        : null,
  };
};


/* =========================================
   VALIDAR RUT O LANZAR ERROR
========================================= */
export const assertValidRut = (
  value,
  {
    fieldName = "rut",
    status = 400,
    code = "INVALID_RUT",
  } = {}
) => {
  const normalized =
    normalizeRut(value);

  if (!normalized.valid) {
    const error =
      new Error(
        `${fieldName} no es un RUT chileno válido`
      );

    error.status =
      status;

    error.code =
      code;

    throw error;
  }

  return normalized;
};
