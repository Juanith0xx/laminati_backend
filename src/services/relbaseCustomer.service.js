import pool from "../config/database.js";

import {

  relbaseRequest,

} from "./relbase.service.js";

import {

  normalizeRut as normalizeChileanRut,

} from "../utils/rut.utils.js";

/* =========================================*

*   ERROR CONTROLADO*

*========================================= */

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

/* =========================================*

*   NORMALIZAR RUT PARA RELBASE*

*   Mantiene compatibilidad con el formato*

*   previamente utilizado por este servicio:*

*   76.376.809-0*

*   ↓*

*   76376809-0*

*   IMPORTANTE:*

*   si el RUT es inválido devuelve "".*

*========================================= */

export const normalizeRut = (rut) => {

  const normalized =

    normalizeChileanRut(rut);

  if (!normalized.valid) {

    return "";

  }

  return `${normalized.body}-${normalized.dv}`;

};



/* =========================================*

*   OBTENER RUT RELBASE VALIDADO*

*   Diferencia:*

*   - RUT vacío       -> RUT_REQUIRED*

*   - RUT incorrecto  -> INVALID_RUT*

*========================================= */

const getValidatedRelbaseRut = (rut) => {

  const rawRut =

    String(rut ?? "").trim();

  if (!rawRut) {

    throw createServiceError(

      "El RUT es obligatorio",

      400,

      "RUT_REQUIRED"

    );

  }

  const normalized =

    normalizeChileanRut(rawRut);

  if (!normalized.valid) {

    throw createServiceError(

      "El RUT chileno no es válido",

      400,

      "INVALID_RUT"

    );

  }

  return `${normalized.body}-${normalized.dv}`;

};

/* =========================================*

*   BUSCAR CLIENTE RELBASE POR RUT*

*========================================= */

export const findRelbaseCustomerByRutService =

  async (rut) => {

    const normalizedRut =

      getValidatedRelbaseRut(rut);

    /**
     * Relbase V2 documenta el parámetro `query`
     * para GET /api/v2/clientes.
     *
     * Antes recorríamos TODO el padrón paginado
     * hasta encontrar el RUT, lo que podía tardar
     * bastante en cuentas con muchos clientes.
     *
     * Ahora limitamos la búsqueda desde Relbase y
     * mantenemos una comparación exacta por RUT
     * normalizado para evitar falsos positivos.
     */
    const queryCandidates =

      [

        normalizedRut,

        normalizedRut.replace(

          /[^0-9kK]/g,

          ""

        ),

      ].filter(

        (value, index, array) =>

          Boolean(value) &&

          array.indexOf(value) === index

      );

    for (const query of queryCandidates) {

      let page = 1;

      let totalPages = 1;

      do {

        const params =

          new URLSearchParams({

            query,

            page: String(page),

            customer_status_query:

              "all",

          });

        const result =

          await relbaseRequest(

            `/api/v2/clientes?${params.toString()}`

          );

        const payload =

          result?.data || null;

        const customers =

          payload?.data?.customers;

        const meta =

          payload?.meta || {};

        if (!Array.isArray(customers)) {

          throw new Error(

            "Relbase respondió con un formato de clientes inesperado"

          );

        }

        const customer =

          customers.find((item) => {

            return (

              normalizeRut(item?.rut) ===

              normalizedRut

            );

          });

        if (customer) {

          return {

            found: true,

            customer,

          };

        }

        totalPages =

          Math.max(

            Number(

              meta.total_pages || 1

            ),

            1

          );

        page += 1;

      } while (page <= totalPages);

    }

    return {

      found: false,

      customer: null,

    };

  };

/* =========================================*

*   BUSCAR CLIENTES RELBASE POR TEXTO*

*   Permite buscar por nombre, RUT u otro*

*   término soportado por `query` en Relbase.*

*   IMPORTANTE:*

*   - No reemplaza la búsqueda exacta por RUT.*

*   - Devuelve una lista para selección manual.*

*========================================= */

export const searchRelbaseCustomersService =

  async (searchQuery, options = {}) => {

    const query =

      String(searchQuery ?? "").trim();

    if (!query) {

      throw createServiceError(

        "Ingresa un nombre o RUT para buscar el cliente",

        400,

        "CUSTOMER_SEARCH_QUERY_REQUIRED"

      );

    }

    if (query.length < 2) {

      throw createServiceError(

        "La búsqueda debe contener al menos 2 caracteres",

        400,

        "CUSTOMER_SEARCH_QUERY_TOO_SHORT"

      );

    }

    const requestedLimit =

      Number(options?.limit);

    const limit =

      Number.isFinite(requestedLimit)

        ? Math.min(

            Math.max(

              Math.trunc(requestedLimit),

              1

            ),

            20

          )

        : 10;

    const params =

      new URLSearchParams({

        query,

        page: "1",

        per_page: String(limit),

        customer_status_query:

          "all",

      });

    const result =

      await relbaseRequest(

        `/api/v2/clientes?${params.toString()}`

      );

    const payload =

      result?.data || null;

    const customers =

      payload?.data?.customers;

    if (!Array.isArray(customers)) {

      throw new Error(

        "Relbase respondió con un formato de clientes inesperado"

      );

    }

    const uniqueCustomers = [];

    const seen = new Set();

    for (const customer of customers) {

      const id =

        customer?.id ??

        customer?.customer_id ??

        customer?.client_id ??

        null;

      const rut =

        String(

          customer?.rut || ""

        ).trim();

      const key =

        id != null

          ? `id:${String(id)}`

          : rut

            ? `rut:${rut.toUpperCase()}`

            : `row:${uniqueCustomers.length}`;

      if (seen.has(key)) {

        continue;

      }

      seen.add(key);

      uniqueCustomers.push(customer);

      if (uniqueCustomers.length >= limit) {

        break;

      }

    }

    return {

      query,

      count:

        uniqueCustomers.length,

      customers:

        uniqueCustomers,

      meta:

        payload?.meta || null,

      rate_limit:

        result?.rateLimit || null,

    };

  };

/* =========================================*

*   VINCULAR EMPRESA LOCAL CON RELBASE*

*========================================= */

const linkCompanyToRelbaseCustomer =

  async (

    companyId,

    relbaseCustomer

  ) => {

    if (!companyId) {

      return null;

    }

    const companyResult =

      await pool.query(

        `

          SELECT

            id,

            rut,

            relbase_customer_id

          FROM customer_companies

          WHERE id = $1

          LIMIT 1

        `,

        [companyId]

      );

    if (

      companyResult.rowCount === 0

    ) {

      throw createServiceError(

        "La empresa Laminatiword no existe",

        404,

        "COMPANY_NOT_FOUND"

      );

    }

    const company =

      companyResult.rows[0];

    /**

*     * Protección:*

*     * ambos RUT deben ser válidos y coincidir.*

*     */

    const companyRut =

      normalizeRut(

        company.rut

      );

    const relbaseRut =

      normalizeRut(

        relbaseCustomer?.rut

      );

    if (!companyRut) {

      throw createServiceError(

        "El RUT de la empresa Laminatiword no es válido",

        409,

        "COMPANY_RUT_INVALID"

      );

    }

    if (!relbaseRut) {

      throw createServiceError(

        "Relbase devolvió un cliente con RUT inválido",

        409,

        "RELBASE_CUSTOMER_RUT_INVALID"

      );

    }

    if (

      companyRut !==

      relbaseRut

    ) {

      throw createServiceError(

        "El RUT de la empresa Laminatiword no coincide con el cliente Relbase",

        409,

        "COMPANY_RUT_MISMATCH"

      );

    }

    const result =

      await pool.query(

        `

          UPDATE customer_companies

          SET

            relbase_customer_id =

              $1,

            updated_at =

              NOW()

          WHERE id = $2

          RETURNING

            id,

            legal_name,

            trade_name,

            rut,

            relbase_customer_id,

            updated_at

        `,

        [

          String(

            relbaseCustomer.id

          ),

          companyId,

        ]

      );

    return result.rows[0];

  };

/* =========================================
   CATÁLOGOS RELBASE: CIUDAD / COMUNA

   Se utilizan únicamente al CREAR un cliente
   que todavía no existe en Relbase.

   Relbase exige city_id y commune_id en
   POST /api/v2/clientes. Laminatiword conserva
   ciudad/comuna como texto en el snapshot, por
   lo que resolvemos los IDs contra los catálogos
   oficiales antes del POST.
========================================= */

const normalizeCatalogText = (value) => {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

const toPositiveCatalogId = (value) => {
  const number = Number(value);

  return (
    Number.isInteger(number) &&
    number > 0
  )
    ? number
    : null;
};

const extractCatalogItems = (
  result,
  collectionKeys = []
) => {
  const responseBody =
    result?.data || null;

  const data =
    responseBody?.data ??
    responseBody;

  const candidates = [
    data,
    ...collectionKeys.map(
      (key) => data?.[key]
    ),
    ...collectionKeys.map(
      (key) => responseBody?.[key]
    ),
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
};

const getCatalogItemId = (item) => {
  const candidates = [
    item?.id,
    item?.city_id,
    item?.commune_id,
  ];

  for (const candidate of candidates) {
    const id =
      toPositiveCatalogId(candidate);

    if (id) {
      return id;
    }
  }

  return null;
};

const getCatalogItemName = (item) => {
  const candidates = [
    item?.name,
    item?.description,
    item?.city,
    item?.commune,
    item?.city_name,
    item?.commune_name,
  ];

  for (const candidate of candidates) {
    const value =
      String(candidate || "").trim();

    if (value) {
      return value;
    }
  }

  return "";
};

const findCatalogItemByName = (
  items,
  expectedName
) => {
  const normalizedExpected =
    normalizeCatalogText(expectedName);

  if (!normalizedExpected) {
    return null;
  }

  return (
    items.find((item) => {
      return (
        normalizeCatalogText(
          getCatalogItemName(item)
        ) === normalizedExpected
      );
    }) || null
  );
};

const fetchRelbaseCatalog = async ({
  path,
  collectionKeys,
  params = {},
}) => {
  const allItems = [];
  let page = 1;
  let totalPages = 1;

  do {
    const searchParams =
      new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(params)
            .filter(([, value]) => {
              return (
                value !== undefined &&
                value !== null &&
                String(value).trim() !== ""
              );
            })
            .map(([key, value]) => [
              key,
              String(value),
            ])
        ),
        page: String(page),
      });

    const result =
      await relbaseRequest(
        `${path}?${searchParams.toString()}`
      );

    const items =
      extractCatalogItems(
        result,
        collectionKeys
      );

    allItems.push(...items);

    const responseBody =
      result?.data || null;

    const meta =
      responseBody?.meta || {};

    totalPages = Math.max(
      Number(meta.total_pages || 1),
      1
    );

    page += 1;
  } while (page <= totalPages);

  return allItems;
};

const resolveRelbaseLocationIds = async ({
  city,
  commune,
  city_id = null,
  commune_id = null,
}) => {
  let resolvedCityId =
    toPositiveCatalogId(city_id);

  let resolvedCommuneId =
    toPositiveCatalogId(commune_id);

  const cityName =
    String(city || "").trim();

  const communeName =
    String(commune || "").trim();

  if (!resolvedCityId) {
    if (!cityName) {
      throw createServiceError(
        "La ciudad del cliente es obligatoria para crearlo en Relbase",
        400,
        "RELBASE_CUSTOMER_CITY_REQUIRED"
      );
    }

    const cities =
      await fetchRelbaseCatalog({
        path: "/api/v2/ciudades",
        collectionKeys: [
          "cities",
          "ciudades",
        ],
      });

    const cityItem =
      findCatalogItemByName(
        cities,
        cityName
      );

    resolvedCityId =
      getCatalogItemId(cityItem);

    if (!resolvedCityId) {
      throw createServiceError(
        `No fue posible encontrar la ciudad "${cityName}" en el catálogo de Relbase`,
        409,
        "RELBASE_CUSTOMER_CITY_NOT_FOUND"
      );
    }
  }

  if (!resolvedCommuneId) {
    if (!communeName) {
      throw createServiceError(
        "La comuna del cliente es obligatoria para crearlo en Relbase",
        400,
        "RELBASE_CUSTOMER_COMMUNE_REQUIRED"
      );
    }

    let communes =
      await fetchRelbaseCatalog({
        path: "/api/v2/comunas",
        collectionKeys: [
          "communes",
          "comunas",
        ],
        params: {
          city_id: resolvedCityId,
        },
      });

    /*
     * Fallback defensivo: si la API no filtra con
     * city_id o responde una colección vacía,
     * intentamos el listado general y seguimos
     * exigiendo coincidencia exacta por nombre.
     */
    if (communes.length === 0) {
      communes =
        await fetchRelbaseCatalog({
          path: "/api/v2/comunas",
          collectionKeys: [
            "communes",
            "comunas",
          ],
        });
    }

    const communeItem =
      findCatalogItemByName(
        communes,
        communeName
      );

    resolvedCommuneId =
      getCatalogItemId(communeItem);

    if (!resolvedCommuneId) {
      throw createServiceError(
        `No fue posible encontrar la comuna "${communeName}" en el catálogo de Relbase`,
        409,
        "RELBASE_CUSTOMER_COMMUNE_NOT_FOUND"
      );
    }
  }

  return {
    city_id: resolvedCityId,
    commune_id: resolvedCommuneId,
  };
};

/* =========================================*

*   CREAR CLIENTE EN RELBASE*

*   IMPORTANTE:*

*   POST /api/v2/clientes recibe*

*   type_customer como entero.*

*   GET puede devolver la etiqueta*

*   descriptiva "person" / "company".*

*========================================= */

export const createRelbaseCustomer =

  async (customerData) => {

    const {

      type_customer,

      rut,

      name,

      name_fantasy = "",

      address = "",

      business_activity = "",

      city = "",

      commune = "",

      city_id = null,

      commune_id = null,

      active = true,

      code = "",

      name_payment = "",

      phone_payment = "",

      email = "",

      business_contact = "",

      email_commercial = "",

      phone = "",

      mobile = "",

      reference = "",

      discount = 0,

      credit = 0,

      type_payment_id = null,

      credit_amount = 0,

      is_overdue_invoice = false,

      days_overdue = 0,

    } = customerData || {};

    const normalizedRut =

      getValidatedRelbaseRut(rut);

    if (!name) {

      throw createServiceError(

        "El nombre o razón social es obligatorio",

        400,

        "CUSTOMER_NAME_REQUIRED"

      );

    }

    /**
     * El contrato de creación de Relbase V2
     * exige un entero en type_customer.
     * La equivalencia concreta se mantiene
     * fuera del código mediante variables de
     * entorno para no acoplar la integración.
     */

    if (

      type_customer ===

        undefined ||

      type_customer === null ||

      !Number.isInteger(

        Number(type_customer)

      )

    ) {

      throw createServiceError(

        "type_customer debe ser informado con un valor válido de Relbase",

        400,

        "TYPE_CUSTOMER_REQUIRED"

      );

    }

    const normalizedName =
      String(name).trim();

    const normalizedNameFantasy =
      String(
        name_fantasy ||
          normalizedName
      ).trim();

    const normalizedAddress =
      String(address || "").trim();

    const normalizedBusinessActivity =
      String(
        business_activity || ""
      ).trim();

    if (!normalizedNameFantasy) {
      throw createServiceError(
        "El nombre de fantasía es obligatorio para crear el cliente en Relbase",
        400,
        "RELBASE_CUSTOMER_FANTASY_NAME_REQUIRED"
      );
    }

    if (!normalizedBusinessActivity) {
      throw createServiceError(
        "El giro es obligatorio para crear el cliente en Relbase",
        400,
        "RELBASE_CUSTOMER_BUSINESS_ACTIVITY_REQUIRED"
      );
    }

    if (!normalizedAddress) {
      throw createServiceError(
        "La dirección es obligatoria para crear el cliente en Relbase",
        400,
        "RELBASE_CUSTOMER_ADDRESS_REQUIRED"
      );
    }

    const location =
      await resolveRelbaseLocationIds({
        city,
        commune,
        city_id,
        commune_id,
      });

    /*
     * Payload mínimo confirmado por Relbase V2.
     * Evitamos enviar campos opcionales vacíos,
     * null o montos en 0 cuando el contrato de
     * Relbase los valida sólo si están presentes.
     */
    const body = {
      type_customer:
        Number(type_customer),
      rut:
        normalizedRut,
      name:
        normalizedName,
      name_fantasy:
        normalizedNameFantasy,
      address:
        normalizedAddress,
      business_activity:
        normalizedBusinessActivity,
      city_id:
        location.city_id,
      commune_id:
        location.commune_id,
      active:
        Boolean(active),
    };

    const assignTextIfPresent = (
      key,
      value
    ) => {
      const normalizedValue =
        String(value || "").trim();

      if (normalizedValue) {
        body[key] = normalizedValue;
      }
    };

    assignTextIfPresent(
      "code",
      code
    );

    assignTextIfPresent(
      "name_payment",
      name_payment
    );

    assignTextIfPresent(
      "phone_payment",
      phone_payment
    );

    assignTextIfPresent(
      "email",
      email
    );

    assignTextIfPresent(
      "business_contact",
      business_contact
    );

    assignTextIfPresent(
      "email_commercial",
      email_commercial
    );

    assignTextIfPresent(
      "phone",
      phone
    );

    assignTextIfPresent(
      "mobile",
      mobile
    );

    assignTextIfPresent(
      "reference",
      reference
    );

    const normalizedDiscount =
      Number(discount || 0);

    if (
      Number.isFinite(normalizedDiscount) &&
      normalizedDiscount > 0
    ) {
      body.discount =
        normalizedDiscount;
    }

    const normalizedCredit =
      Number(credit || 0);

    if (
      Number.isFinite(normalizedCredit) &&
      normalizedCredit > 0
    ) {
      body.credit =
        normalizedCredit;
    }

    const normalizedTypePaymentId =
      toPositiveCatalogId(
        type_payment_id
      );

    if (normalizedTypePaymentId) {
      body.type_payment_id =
        normalizedTypePaymentId;
    }

    const normalizedCreditAmount =
      Number(credit_amount || 0);

    if (
      Number.isFinite(
        normalizedCreditAmount
      ) &&
      normalizedCreditAmount > 0
    ) {
      body.credit_amount =
        normalizedCreditAmount;
    }

    if (is_overdue_invoice === true) {
      body.is_overdue_invoice = true;
    }

    const normalizedDaysOverdue =
      Number(days_overdue || 0);

    if (
      Number.isFinite(
        normalizedDaysOverdue
      ) &&
      normalizedDaysOverdue > 0
    ) {
      body.days_overdue =
        normalizedDaysOverdue;
    }

    const result =

      await relbaseRequest(

        "/api/v2/clientes",

        {

          method: "POST",

          headers: {

            "Content-Type":

              "application/json",

          },

          body:

            JSON.stringify(body),

        }

      );

    return {

      customer:

        result?.data?.data ||

        result?.data ||

        null,

      meta:

        result?.data?.meta ||

        null,

    };

  };

/* =========================================
   OBTENER CLIENTE RELBASE POR ID

   Se usa para sincronización segura de clientes
   existentes antes de preparar un DTE.
========================================= */

export const getRelbaseCustomerByIdService =
  async (customerId) => {
    const normalizedId =
      Number(customerId);

    if (
      !Number.isInteger(normalizedId) ||
      normalizedId <= 0
    ) {
      throw createServiceError(
        "El identificador del cliente Relbase no es válido",
        400,
        "RELBASE_CUSTOMER_ID_INVALID"
      );
    }

    const result =
      await relbaseRequest(
        `/api/v2/clientes/${normalizedId}`
      );

    const data =
      result?.data?.data ??
      result?.data ??
      null;

    const customer =
      data?.customer ||
      data?.client ||
      data;

    return {
      customer:
        customer &&
        typeof customer === "object"
          ? customer
          : null,
      meta:
        result?.data?.meta ||
        null,
    };
  };

/* =========================================
   VALIDAR TIPO DE CLIENTE RELBASE

   GET /clientes devuelve:
   - person
   - company

   Nunca continuamos hacia el DTE cuando el
   tipo real no coincide con el snapshot local.
========================================= */

const getExpectedRelbaseCustomerType = (
  customerType
) => {
  const normalized = String(
    customerType || ""
  )
    .trim()
    .toUpperCase();

  if (normalized === "PERSON") {
    return "person";
  }

  if (normalized === "COMPANY") {
    return "company";
  }

  throw createServiceError(
    "El tipo de cliente no es válido para verificar el cliente Relbase",
    400,
    "RELBASE_CUSTOMER_TYPE_NOT_SUPPORTED"
  );
};

const assertRelbaseCustomerTypeMatches = ({
  customer,
  customerType,
}) => {
  const expectedType =
    getExpectedRelbaseCustomerType(
      customerType
    );

  const actualType = String(
    customer?.type_customer || ""
  )
    .trim()
    .toLowerCase();

  if (!actualType) {
    throw createServiceError(
      "Relbase no informó el type_customer del cliente. Se detuvo la preparación del DTE.",
      409,
      "RELBASE_CUSTOMER_TYPE_NOT_AVAILABLE"
    );
  }

  if (actualType !== expectedType) {
    throw createServiceError(
      `El cliente existe en Relbase con type_customer=${actualType || "UNKNOWN"}, pero Laminatiword esperaba ${expectedType}. Se detuvo la preparación del DTE.`,
      409,
      "RELBASE_CUSTOMER_TYPE_MISMATCH"
    );
  }

  return {
    expected_type: expectedType,
    actual_type: actualType,
  };
};

/* =========================================
   NORMALIZACIÓN PARA COMPARAR DATOS
========================================= */

const normalizeComparableText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const normalizeComparableEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeComparablePhone = (value) =>
  String(value || "")
    .replace(/[^0-9+]/g, "")
    .trim();

const getFirstTextValue = (value) => {
  if (Array.isArray(value)) {
    return String(
      value.find((item) =>
        String(item || "").trim()
      ) || ""
    ).trim();
  }

  return String(value || "").trim();
};

/* =========================================
   SINCRONIZAR CLIENTE EXISTENTE EN RELBASE

   REGLAS:
   - El RUT nunca puede cambiar.
   - El tipo PERSON / COMPANY debe coincidir.
   - Sólo ejecutamos PUT si cambió algún dato
     relevante del snapshot tributario.
   - No tocamos descuentos, crédito, listas de
     precio, vendedores ni configuraciones que
     no pertenecen al checkout.
========================================= */

export const syncExistingRelbaseCustomer =
  async ({
    customer,
    customer_type,
    customer_data,
  }) => {
    const customerId =
      Number(
        customer?.id ||
        customer?.customer_id ||
        customer?.client_id
      );

    if (
      !Number.isInteger(customerId) ||
      customerId <= 0
    ) {
      throw createServiceError(
        "Relbase devolvió un cliente sin identificador válido",
        409,
        "RELBASE_CUSTOMER_ID_INVALID"
      );
    }

    const detailResult =
      await getRelbaseCustomerByIdService(
        customerId
      );

    const currentCustomer =
      detailResult.customer ||
      customer;

    const expectedRut =
      getValidatedRelbaseRut(
        customer_data?.rut
      );

    const currentRut =
      normalizeRut(
        currentCustomer?.rut
      );

    if (!currentRut) {
      throw createServiceError(
        "Relbase devolvió un cliente con RUT inválido",
        409,
        "RELBASE_CUSTOMER_RUT_INVALID"
      );
    }

    if (currentRut !== expectedRut) {
      throw createServiceError(
        "El RUT del cliente Relbase no coincide con el receptor del pedido",
        409,
        "RELBASE_CUSTOMER_RUT_MISMATCH"
      );
    }

    assertRelbaseCustomerTypeMatches({
      customer: currentCustomer,
      customerType: customer_type,
    });

    if (!customer_data) {
      return {
        updated: false,
        customer: currentCustomer,
        changed_fields: [],
      };
    }

    const normalizedName =
      String(
        customer_data.name || ""
      ).trim();

    const normalizedNameFantasy =
      String(
        customer_data.name_fantasy ||
        normalizedName
      ).trim();

    const normalizedAddress =
      String(
        customer_data.address || ""
      ).trim();

    const normalizedBusinessActivity =
      String(
        customer_data.business_activity ||
        ""
      ).trim();

    if (!normalizedName) {
      throw createServiceError(
        "El nombre o razón social es obligatorio para sincronizar el cliente Relbase",
        400,
        "CUSTOMER_NAME_REQUIRED"
      );
    }

    if (!normalizedNameFantasy) {
      throw createServiceError(
        "El nombre de fantasía es obligatorio para sincronizar el cliente Relbase",
        400,
        "RELBASE_CUSTOMER_FANTASY_NAME_REQUIRED"
      );
    }

    if (!normalizedBusinessActivity) {
      throw createServiceError(
        "El giro es obligatorio para sincronizar el cliente Relbase",
        400,
        "RELBASE_CUSTOMER_BUSINESS_ACTIVITY_REQUIRED"
      );
    }

    if (!normalizedAddress) {
      throw createServiceError(
        "La dirección es obligatoria para sincronizar el cliente Relbase",
        400,
        "RELBASE_CUSTOMER_ADDRESS_REQUIRED"
      );
    }

    const location =
      await resolveRelbaseLocationIds({
        city: customer_data.city,
        commune: customer_data.commune,
        city_id: customer_data.city_id,
        commune_id:
          customer_data.commune_id,
      });

    const desiredEmail =
      String(
        customer_data.email || ""
      ).trim();

    const desiredCommercialEmail =
      String(
        customer_data.email_commercial ||
        desiredEmail
      ).trim();

    const desiredPhone =
      String(
        customer_data.phone || ""
      ).trim();

    const desiredMobile =
      String(
        customer_data.mobile ||
        desiredPhone
      ).trim();

    const changedFields = [];

    const compareTextField = (
      field,
      currentValue,
      desiredValue
    ) => {
      if (
        normalizeComparableText(
          currentValue
        ) !==
        normalizeComparableText(
          desiredValue
        )
      ) {
        changedFields.push(field);
      }
    };

    compareTextField(
      "name",
      currentCustomer?.name,
      normalizedName
    );

    compareTextField(
      "name_fantasy",
      currentCustomer?.name_fantasy,
      normalizedNameFantasy
    );

    compareTextField(
      "address",
      currentCustomer?.address,
      normalizedAddress
    );

    compareTextField(
      "business_activity",
      currentCustomer?.business_activity,
      normalizedBusinessActivity
    );

    if (
      Number(currentCustomer?.city_id) !==
      Number(location.city_id)
    ) {
      changedFields.push("city_id");
    }

    if (
      Number(currentCustomer?.commune_id) !==
      Number(location.commune_id)
    ) {
      changedFields.push("commune_id");
    }

    const currentEmail =
      getFirstTextValue(
        currentCustomer?.email
      );

    if (
      normalizeComparableEmail(
        currentEmail
      ) !==
      normalizeComparableEmail(
        desiredEmail
      )
    ) {
      changedFields.push("email");
    }

    const currentCommercialEmail =
      getFirstTextValue(
        currentCustomer?.email_commercial
      );

    if (
      normalizeComparableEmail(
        currentCommercialEmail
      ) !==
      normalizeComparableEmail(
        desiredCommercialEmail
      )
    ) {
      changedFields.push(
        "email_commercial"
      );
    }

    if (
      normalizeComparablePhone(
        currentCustomer?.phone
      ) !==
      normalizeComparablePhone(
        desiredPhone
      )
    ) {
      changedFields.push("phone");
    }

    if (
      normalizeComparablePhone(
        currentCustomer?.mobile
      ) !==
      normalizeComparablePhone(
        desiredMobile
      )
    ) {
      changedFields.push("mobile");
    }

    if (changedFields.length === 0) {
      return {
        updated: false,
        customer: currentCustomer,
        changed_fields: [],
      };
    }

    const body = {
      type_customer:
        Number(
          customer_data.type_customer
        ),
      rut: expectedRut,
      name: normalizedName,
      name_fantasy:
        normalizedNameFantasy,
      address:
        normalizedAddress,
      business_activity:
        normalizedBusinessActivity,
      city_id:
        location.city_id,
      commune_id:
        location.commune_id,
      active:
        currentCustomer?.active !== false,
    };

    if (desiredEmail) {
      body.email =
        desiredEmail;
    }

    if (desiredCommercialEmail) {
      body.email_commercial =
        desiredCommercialEmail;
    }

    if (desiredPhone) {
      body.phone =
        desiredPhone;
    }

    if (desiredMobile) {
      body.mobile =
        desiredMobile;
    }

    const existingReference =
      String(
        currentCustomer?.reference ||
        ""
      ).trim();

    if (existingReference) {
      body.reference =
        existingReference;
    }

    const result =
      await relbaseRequest(
        `/api/v2/clientes/${customerId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify(body),
        }
      );

    const verification =
      await getRelbaseCustomerByIdService(
        customerId
      );

    const updatedCustomer =
      verification.customer ||
      result?.data?.data ||
      result?.data ||
      null;

    if (!updatedCustomer) {
      throw createServiceError(
        "Relbase actualizó el cliente, pero no fue posible verificarlo nuevamente",
        502,
        "RELBASE_CUSTOMER_POST_UPDATE_VERIFICATION_FAILED"
      );
    }

    const verifiedRut =
      normalizeRut(
        updatedCustomer?.rut
      );

    if (verifiedRut !== expectedRut) {
      throw createServiceError(
        "El cliente actualizado en Relbase no conserva el RUT esperado",
        409,
        "RELBASE_CUSTOMER_POST_UPDATE_RUT_MISMATCH"
      );
    }

    assertRelbaseCustomerTypeMatches({
      customer: updatedCustomer,
      customerType: customer_type,
    });

    return {
      updated: true,
      customer: updatedCustomer,
      changed_fields:
        changedFields,
    };
  };

/* =========================================*

*   ASEGURAR CLIENTE RELBASE*

*   1. Buscar*

*   2. Reutilizar si existe*

*   3. Crear solamente si se solicita*

*   4. Vincular empresa local opcionalmente*

*========================================= */

export const ensureRelbaseCustomer =

  async ({

    rut,

    company_id = null,

    create_if_missing = false,

    customer_data = null,

    sync_existing = false,

    customer_type = null,

  }) => {

    const normalizedRut =

      getValidatedRelbaseRut(rut);

    /* =====================================*

*       BUSCAR EXISTENTE*

*    ===================================== */

    const existing =

      await findRelbaseCustomerByRutService(

        normalizedRut

      );

    if (existing.found) {

      let resolvedCustomer =
        existing.customer;

      let updated = false;

      let changedFields = [];

      if (
        sync_existing === true &&
        customer_data
      ) {
        const synchronization =
          await syncExistingRelbaseCustomer({
            customer:
              existing.customer,
            customer_type,
            customer_data: {
              ...customer_data,
              rut: normalizedRut,
            },
          });

        resolvedCustomer =
          synchronization.customer ||
          existing.customer;

        updated =
          synchronization.updated ===
          true;

        changedFields =
          synchronization.changed_fields ||
          [];
      }

      const company =

        await linkCompanyToRelbaseCustomer(

          company_id,

          resolvedCustomer

        );

      return {

        found: true,

        created: false,

        updated,

        changed_fields:
          changedFields,

        source: "RELBASE",

        customer:

          resolvedCustomer,

        company,

      };

    }

    /* =====================================*

*       NO CREAR TODAVÍA*

*    ===================================== */

    if (!create_if_missing) {

      return {

        found: false,

        created: false,

        updated: false,

        source: "RELBASE",

        customer: null,

        company: null,

      };

    }

    /* =====================================*

*       VALIDAR DATOS DE CREACIÓN*

*    ===================================== */

    if (!customer_data) {

      throw createServiceError(

        "Faltan los datos necesarios para crear el cliente en Relbase",

        400,

        "CUSTOMER_DATA_REQUIRED"

      );

    }

    /* =====================================*

*       CREAR*

*    ===================================== */

    const creation =

      await createRelbaseCustomer({

        ...customer_data,

        rut: normalizedRut,

      });

    /**

*     * La forma exacta del response*

*     * la confirmaremos con la primera*

*     * creación controlada.*

*     */

    const createdCustomer =

      creation.customer;

    if (!createdCustomer) {

      throw new Error(

        "Relbase no devolvió el cliente creado"

      );

    }

    const company =

      await linkCompanyToRelbaseCustomer(

        company_id,

        createdCustomer

      );

    return {

      found: false,

      created: true,

      updated: false,

      source: "RELBASE",

      customer:

        createdCustomer,

      company,

    };

  };

/* =========================================
   CUSTOMER TYPE RELBASE PARA DTE

   IMPORTANTE:
   - GET /api/v2/clientes devuelve etiquetas como
     "person" y "company".
   - POST /api/v2/clientes recibe type_customer
     como entero según el contrato oficial V2.

   Por eso mantenemos IDs numéricos configurables:
   - RELBASE_PERSON_CUSTOMER_TYPE_ID
   - RELBASE_COMPANY_CUSTOMER_TYPE_ID

   El valor 0 es válido para type_customer, por lo
   que NO debemos exigir un entero estrictamente
   positivo.
========================================= */

const getOptionalNonNegativeEnvInteger = (name) => {
  const raw = process.env[name];

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return null;
  }

  const value = Number(raw);

  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw createServiceError(
      `La configuración ${name} debe ser un entero mayor o igual a 0`,
      500,
      "RELBASE_CUSTOMER_TYPE_CONFIG_INVALID"
    );
  }

  return value;
};

const resolveRelbaseCustomerTypeId = (
  customerType
) => {
  const normalized = String(
    customerType || ""
  )
    .trim()
    .toUpperCase();

  if (normalized === "PERSON") {
    return {
      env_name:
        "RELBASE_PERSON_CUSTOMER_TYPE_ID",
      value:
        getOptionalNonNegativeEnvInteger(
          "RELBASE_PERSON_CUSTOMER_TYPE_ID"
        ),
    };
  }

  if (normalized === "COMPANY") {
    return {
      env_name:
        "RELBASE_COMPANY_CUSTOMER_TYPE_ID",
      value:
        getOptionalNonNegativeEnvInteger(
          "RELBASE_COMPANY_CUSTOMER_TYPE_ID"
        ),
    };
  }

  throw createServiceError(
    "El tipo de cliente no es válido para resolver el cliente Relbase",
    400,
    "RELBASE_CUSTOMER_TYPE_NOT_SUPPORTED"
  );
};

const extractRelbaseCustomerId = (
  customer
) => {
  const candidates = [
    customer?.id,
    customer?.customer_id,
    customer?.client_id,
    customer?.data?.id,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);

    if (
      Number.isInteger(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return null;
};


/* =========================================
   PERSISTIR EMPRESA LOCAL DESDE RELBASE

   Objetivo:
   - Mantener customer_companies como maestro local.
   - Persistir datos completados manualmente en cotización.
   - Vincular definitivamente relbase_customer_id.
   - No crear registros locales para PERSON.
========================================= */
const upsertLocalCompanyFromResolvedCustomer =
  async ({
    customer_type,
    rut,
    legal_name,
    trade_name = "",
    business_activity = "",
    email = "",
    phone = "",
    address = "",
    commune = "",
    city = "",
    region = "",
    country = "Chile",
    relbase_customer_id,
  }) => {
    const normalizedCustomerType =
      String(
        customer_type || ""
      )
        .trim()
        .toUpperCase();

    if (
      normalizedCustomerType !==
      "COMPANY"
    ) {
      return null;
    }

    const normalizedRut =
      getValidatedRelbaseRut(
        rut
      );

    const normalizedLegalName =
      String(
        legal_name || ""
      ).trim();

    const normalizedRelbaseCustomerId =
      String(
        relbase_customer_id ??
        ""
      ).trim();

    if (
      !normalizedLegalName
    ) {
      throw createServiceError(
        "La razón social es obligatoria para guardar la empresa local",
        400,
        "LOCAL_COMPANY_LEGAL_NAME_REQUIRED"
      );
    }

    if (
      !normalizedRelbaseCustomerId
    ) {
      throw createServiceError(
        "Falta el identificador Relbase para guardar la empresa local",
        409,
        "LOCAL_COMPANY_RELBASE_ID_REQUIRED"
      );
    }

    const values = {
      trade_name:
        String(
          trade_name || ""
        ).trim(),
      business_activity:
        String(
          business_activity || ""
        ).trim(),
      billing_email:
        String(
          email || ""
        ).trim(),
      phone:
        String(
          phone || ""
        ).trim(),
      address_line:
        String(
          address || ""
        ).trim(),
      commune:
        String(
          commune || ""
        ).trim(),
      city:
        String(
          city || ""
        ).trim(),
      region:
        String(
          region || ""
        ).trim(),
      country:
        String(
          country || "Chile"
        ).trim() ||
        "Chile",
    };

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      /*
       * Serializa el alta/actualización por RUT
       * para evitar duplicados si dos cotizaciones
       * intentan crear el mismo cliente a la vez.
       */
      await client.query(
        `
          SELECT
            pg_advisory_xact_lock(
              hashtext($1)
            )
        `,
        [
          normalizedRut,
        ]
      );

      const existingResult =
        await client.query(
          `
            SELECT
              id,
              rut,
              relbase_customer_id
            FROM customer_companies
            WHERE
              REGEXP_REPLACE(
                UPPER(
                  COALESCE(
                    rut,
                    ''
                  )
                ),
                '[^0-9K]',
                '',
                'g'
              ) =
              REGEXP_REPLACE(
                UPPER($1),
                '[^0-9K]',
                '',
                'g'
              )
            ORDER BY
              created_at ASC
            LIMIT 1
            FOR UPDATE
          `,
          [
            normalizedRut,
          ]
        );

      let localCompany =
        null;

      if (
        existingResult.rowCount >
        0
      ) {
        const existing =
          existingResult.rows[0];

        if (
          existing.relbase_customer_id &&
          String(
            existing.relbase_customer_id
          ) !==
            normalizedRelbaseCustomerId
        ) {
          throw createServiceError(
            "La empresa local ya está vinculada a un cliente Relbase diferente",
            409,
            "LOCAL_COMPANY_RELBASE_ID_MISMATCH"
          );
        }

        const updateResult =
          await client.query(
            `
              UPDATE customer_companies
              SET
                legal_name =
                  COALESCE(
                    NULLIF(
                      $2,
                      ''
                    ),
                    legal_name
                  ),
                trade_name =
                  COALESCE(
                    NULLIF(
                      $3,
                      ''
                    ),
                    trade_name
                  ),
                business_activity =
                  COALESCE(
                    NULLIF(
                      $4,
                      ''
                    ),
                    business_activity
                  ),
                billing_email =
                  COALESCE(
                    NULLIF(
                      $5,
                      ''
                    ),
                    billing_email
                  ),
                phone =
                  COALESCE(
                    NULLIF(
                      $6,
                      ''
                    ),
                    phone
                  ),
                address_line =
                  COALESCE(
                    NULLIF(
                      $7,
                      ''
                    ),
                    address_line
                  ),
                commune =
                  COALESCE(
                    NULLIF(
                      $8,
                      ''
                    ),
                    commune
                  ),
                city =
                  COALESCE(
                    NULLIF(
                      $9,
                      ''
                    ),
                    city
                  ),
                region =
                  COALESCE(
                    NULLIF(
                      $10,
                      ''
                    ),
                    region
                  ),
                country =
                  COALESCE(
                    NULLIF(
                      $11,
                      ''
                    ),
                    country,
                    'Chile'
                  ),
                relbase_customer_id =
                  $12,
                updated_at =
                  NOW()
              WHERE id =
                $1::uuid
              RETURNING
                id,
                legal_name,
                trade_name,
                rut,
                business_activity,
                billing_email,
                phone,
                address_line,
                commune,
                city,
                region,
                country,
                relbase_customer_id,
                is_active,
                created_at,
                updated_at
            `,
            [
              existing.id,
              normalizedLegalName,
              values.trade_name,
              values.business_activity,
              values.billing_email,
              values.phone,
              values.address_line,
              values.commune,
              values.city,
              values.region,
              values.country,
              normalizedRelbaseCustomerId,
            ]
          );

        localCompany =
          updateResult.rows[0] ||
          null;
      } else {
        const insertResult =
          await client.query(
            `
              INSERT INTO customer_companies (
                legal_name,
                trade_name,
                rut,
                business_activity,
                billing_email,
                phone,
                address_line,
                commune,
                city,
                region,
                country,
                relbase_customer_id,
                is_active
              )
              VALUES (
                $1,
                NULLIF(
                  $2,
                  ''
                ),
                $3,
                NULLIF(
                  $4,
                  ''
                ),
                NULLIF(
                  $5,
                  ''
                ),
                NULLIF(
                  $6,
                  ''
                ),
                NULLIF(
                  $7,
                  ''
                ),
                NULLIF(
                  $8,
                  ''
                ),
                NULLIF(
                  $9,
                  ''
                ),
                NULLIF(
                  $10,
                  ''
                ),
                $11,
                $12,
                TRUE
              )
              RETURNING
                id,
                legal_name,
                trade_name,
                rut,
                business_activity,
                billing_email,
                phone,
                address_line,
                commune,
                city,
                region,
                country,
                relbase_customer_id,
                is_active,
                created_at,
                updated_at
            `,
            [
              normalizedLegalName,
              values.trade_name,
              normalizedRut,
              values.business_activity,
              values.billing_email,
              values.phone,
              values.address_line,
              values.commune,
              values.city,
              values.region,
              values.country,
              normalizedRelbaseCustomerId,
            ]
          );

        localCompany =
          insertResult.rows[0] ||
          null;
      }

      await client.query(
        "COMMIT"
      );

      return localCompany;
    } catch (
      error
    ) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // La transacción podría haber terminado.
      }

      throw error;
    } finally {
      client.release();
    }
  };

/* =========================================
   RESOLVER CLIENTE PARA BOLETA / FACTURA

   REGLA:
   1. Si el RUT existe en Relbase, reutilizar.
   2. Si no existe y el tipo Relbase está
      configurado, crear el cliente.
   3. BOLETA sin RUT válido o sin configuración
      puede continuar con cliente genérico.
   4. FACTURA siempre exige cliente real.
========================================= */

export const resolveRelbaseCustomerForTaxDocument =
  async ({
    document_type,
    customer_type,
    rut,
    legal_name,
    trade_name = "",
    business_activity = "",
    email = "",
    phone = "",
    address = "",
    city = "",
    commune = "",
    region = "",
    country = "Chile",
    city_id = null,
    commune_id = null,
    order_number = null,
    allow_generic_boleta = true,
  }) => {
    const documentType = String(
      document_type || ""
    )
      .trim()
      .toUpperCase();

    if (
      ![
        "BOLETA",
        "FACTURA",
      ].includes(documentType)
    ) {
      throw createServiceError(
        "El tipo de documento no es válido para resolver el cliente Relbase",
        400,
        "RELBASE_TAX_DOCUMENT_TYPE_NOT_SUPPORTED"
      );
    }

    const rawRut = String(
      rut || ""
    ).trim();

    const normalizedRut =
      rawRut
        ? normalizeRut(rawRut)
        : "";

    if (!normalizedRut) {
      if (
        documentType === "BOLETA" &&
        allow_generic_boleta
      ) {
        return {
          resolved: false,
          found: false,
          created: false,
          generic_boleta: true,
          reason:
            rawRut
              ? "INVALID_OR_UNUSABLE_RUT"
              : "RUT_NOT_PROVIDED",
          customer_id: null,
          customer: null,
        };
      }

      throw createServiceError(
        rawRut
          ? "El RUT del receptor no es válido"
          : "La factura requiere RUT del receptor",
        400,
        rawRut
          ? "INVALID_RUT"
          : "RUT_REQUIRED"
      );
    }

    const customerTypeConfig =
      resolveRelbaseCustomerTypeId(
        customer_type
      );

    const canCreate =
      customerTypeConfig.value !== null &&
      customerTypeConfig.value !== undefined;

    const customerName = String(
      legal_name || ""
    ).trim();

    if (!customerName) {
      if (
        documentType === "BOLETA" &&
        allow_generic_boleta
      ) {
        return {
          resolved: false,
          found: false,
          created: false,
          generic_boleta: true,
          reason:
            "CUSTOMER_NAME_NOT_AVAILABLE",
          customer_id: null,
          customer: null,
        };
      }

      throw createServiceError(
        "Falta nombre o razón social del receptor",
        400,
        "RELBASE_CUSTOMER_NAME_REQUIRED"
      );
    }

    const result =
      await ensureRelbaseCustomer({
        rut:
          normalizedRut,
        company_id:
          null,
        create_if_missing:
          canCreate,
        sync_existing:
          canCreate,
        customer_type:
          customer_type,
        customer_data:
          canCreate
            ? {
                type_customer:
                  customerTypeConfig.value,
                name:
                  customerName,
                name_fantasy:
                  String(
                    trade_name ||
                      customerName
                  ).trim(),
                address:
                  String(
                    address || ""
                  ).trim(),
                city:
                  String(
                    city || ""
                  ).trim(),
                commune:
                  String(
                    commune || ""
                  ).trim(),
                city_id,
                commune_id,
                business_activity:
                  String(
                    business_activity ||
                      (
                        documentType ===
                          "BOLETA"
                          ? "Particular"
                          : ""
                      )
                  ).trim(),
                email:
                  String(
                    email || ""
                  ).trim(),
                email_commercial:
                  String(
                    email || ""
                  ).trim(),
                phone:
                  String(
                    phone || ""
                  ).trim(),
                mobile:
                  String(
                    phone || ""
                  ).trim(),
                reference:
                  order_number
                    ? `Laminatiword ${String(
                        order_number
                      ).trim()}`
                    : "Laminatiword",
              }
            : null,
      });

    /**
     * Si acabamos de CREAR el cliente, hacemos una
     * lectura de verificación antes de permitir que
     * el flujo tributario continúe.
     *
     * GET /clientes devuelve la etiqueta semántica
     * "person" / "company". Esto nos permite
     * comprobar que el entero enviado al POST creó
     * el tipo de receptor esperado.
     *
     * Si no coincide, NO continuamos hacia el DTE.
     */
    let verifiedCustomer =
      result?.customer || null;

    if (result?.created === true) {
      const verification =
        await findRelbaseCustomerByRutService(
          normalizedRut
        );

      if (
        !verification?.found ||
        !verification?.customer
      ) {
        throw createServiceError(
          "Relbase creó el cliente, pero no fue posible verificarlo nuevamente por RUT",
          502,
          "RELBASE_CUSTOMER_POST_CREATE_VERIFICATION_FAILED"
        );
      }

      verifiedCustomer =
        verification.customer;
    }

    if (verifiedCustomer) {
      assertRelbaseCustomerTypeMatches({
        customer:
          verifiedCustomer,
        customerType:
          customer_type,
      });
    }

    const customerId =
      extractRelbaseCustomerId(
        verifiedCustomer
      );

    if (customerId) {
      const localCompany =
        await upsertLocalCompanyFromResolvedCustomer({
          customer_type,
          rut:
            normalizedRut,
          legal_name:
            customerName,
          trade_name,
          business_activity,
          email,
          phone,
          address,
          commune,
          city,
          region,
          country,
          relbase_customer_id:
            customerId,
        });

      return {
        resolved: true,
        found:
          result?.found === true,
        created:
          result?.created === true,
        updated:
          result?.updated === true,
        changed_fields:
          result?.changed_fields ||
          [],
        generic_boleta: false,
        reason:
          result?.created === true
            ? "CUSTOMER_CREATED"
            : result?.updated === true
              ? "CUSTOMER_REUSED_AND_UPDATED"
              : "CUSTOMER_REUSED",
        customer_id:
          customerId,
        customer:
          verifiedCustomer,
        local_company:
          localCompany,
      };
    }

    if (
      documentType === "BOLETA" &&
      allow_generic_boleta
    ) {
      return {
        resolved: false,
        found: false,
        created: false,
        generic_boleta: true,
        reason:
          canCreate
            ? "RELBASE_CUSTOMER_NOT_RESOLVED"
            : `AUTO_CREATE_DISABLED_MISSING_${customerTypeConfig.env_name}`,
        customer_id: null,
        customer: null,
      };
    }

    if (!canCreate) {
      throw createServiceError(
        `El cliente no existe en Relbase y falta configurar ${customerTypeConfig.env_name} para permitir su creación automática`,
        409,
        "RELBASE_CUSTOMER_AUTO_CREATE_NOT_CONFIGURED"
      );
    }

    throw createServiceError(
      "No fue posible resolver el cliente Relbase para la factura",
      409,
      "RELBASE_CUSTOMER_REQUIRED"
    );
  };
