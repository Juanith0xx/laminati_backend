import crypto from "crypto";

import pool from "../config/database.js";

import {

  encryptValue,

} from "../utils/encryption.js";

import {

  relbaseRequest,

  probeRelbaseDteReadAccess,

  probeRelbaseDteV2ReadAccess,

  probeRelbaseDteV2WriteContract,

  probeRelbaseDteV2CorsControl,

} from "../services/relbase.service.js";

import {
  getRelbaseDteHistorySyncState,
  syncRelbaseDteHistory,
  getRelbaseDteHistoryCustomerSyncState,
  syncRelbaseDteHistoryCustomers,
  listRelbaseDteHistory,
  getRelbaseDteHistorySummary,
  getRelbaseDteHistoryDetail,
} from "../services/relbaseDteHistory.service.js";

import {

  normalizeRelbaseDteRecord,

  normalizeRelbaseHttpUrl,

  isRelbaseHttpUrlUsable,

  claimTaxDocumentForEmission,

  markTaxDocumentEmissionError,

  resetSimulatedTaxDocumentEmissionError,

  persistRelbaseDteResult,

} from "../services/relbaseDteSync.service.js";

import {

  previewTaxDocumentRelbaseReconciliation,

  previewTaxDocumentRelbaseEmissionPreflight,

} from "../services/relbaseDteReconciliation.service.js";

import {

  emitRelbaseDte,

} from "../services/relbaseDteEmission.service.js";

import {

  syncRelbaseProductsToStaging,

} from "../services/relbaseSync.service.js";

import {

  importRelbaseStagingProduct,

} from "../services/relbaseImport.service.js";

import {

  syncRelbaseProductInventory,

} from "../services/relbaseInventory.service.js";

import {

  syncAllImportedRelbaseProducts,

} from "../services/relbaseBulkSync.service.js";

import {

  getRelbaseMonitorStatus,

} from "../services/relbaseMonitor.service.js";

import {

  findRelbaseCustomerByRutService,

  searchRelbaseCustomersService,

  ensureRelbaseCustomer,

} from "../services/relbaseCustomer.service.js";

import {

  ensureDteAcceptedEmailArtifacts,

} from "../services/emailOutbox.service.js";

import {

  buildRelbaseDteLetterPdfBuffer,

} from "../services/relbaseDteLetterPdf.service.js";





/* =========================================*

*   CONFIGURACIÓN RELBASE*

*========================================= */

const getRelbaseConfig = () => {

  const clientId =

    process.env.RELBASE_CLIENT_ID;

  const clientSecret =

    process.env.RELBASE_CLIENT_SECRET;

  const redirectUri =

    process.env.RELBASE_REDIRECT_URI;

  const baseUrl =

    process.env.RELBASE_BASE_URL ||

    "https://api.relbase.cl";

  const scopes =

    process.env.RELBASE_SCOPES ||

    "products:read inventory:read warehouses:read";

  if (

    !clientId ||

    !clientSecret ||

    !redirectUri

  ) {

    throw new Error(

      "Configuración OAuth de Relbase incompleta"

    );

  }

  return {

    clientId,

    clientSecret,

    redirectUri,

    baseUrl,

    scopes,

  };

};

/* =========================================*

*   HASH SHA-256*

*========================================= */

const hashValue = (value) => {

  return crypto

    .createHash("sha256")

    .update(value)

    .digest("hex");

};

/* =========================================*

*   GENERAR URL DE AUTORIZACIÓN*

*========================================= */

export const connectRelbase = async (

  req,

  res

) => {

  try {

    const {

      clientId,

      redirectUri,

      baseUrl,

      scopes,

    } = getRelbaseConfig();

    const state =

      crypto.randomBytes(32)

        .toString("base64url");

    const stateHash =

      hashValue(state);

    await pool.query(

      `

        INSERT INTO relbase_oauth_states (

          state_hash,

          created_by,

          expires_at

        )

        VALUES (

          $1,

          $2,

          NOW() + INTERVAL '10 minutes'

        )

      `,

      [

        stateHash,

        req.user.id,

      ]

    );

    const params =

      new URLSearchParams({

        client_id: clientId,

        redirect_uri: redirectUri,

        response_type: "code",

        scope: scopes,

        state,

      });

    const authorizationUrl =

      `${baseUrl}/oauth/authorize?${params.toString()}`;

    return res.status(200).json({

      success: true,

      message:

        "URL de autorización de Relbase generada correctamente",

      authorization_url:

        authorizationUrl,

    });

  } catch (error) {

    console.error(

      "Error iniciando OAuth Relbase:",

      error.message

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible iniciar la conexión con Relbase",

    });

  }

};

/* =========================================*

*   CALLBACK OAUTH*

*========================================= */

export const relbaseCallback = async (

  req,

  res

) => {

  const {

    code,

    state,

    error: oauthError,

    error_description,

  } = req.query;

  if (oauthError) {

    return res.status(400).json({

      success: false,

      message:

        "Relbase rechazó la autorización",

      error: oauthError,

      description:

        error_description || null,

    });

  }

  if (!code || !state) {

    return res.status(400).json({

      success: false,

      message:

        "Callback OAuth incompleto",

    });

  }

  try {

    const {

      clientId,

      clientSecret,

      redirectUri,

      baseUrl,

    } = getRelbaseConfig();

    /* =========================================*

*       VALIDAR STATE*

*    ========================================= */

    const stateHash =

      hashValue(state);

    const stateResult =

      await pool.query(

        `

          UPDATE relbase_oauth_states

          SET used_at = NOW()

          WHERE state_hash = $1

            AND used_at IS NULL

            AND expires_at > NOW()

          RETURNING

            id,

            created_by

        `,

        [stateHash]

      );

    if (stateResult.rowCount === 0) {

      return res.status(400).json({

        success: false,

        message:

          "El state OAuth es inválido, expiró o ya fue utilizado",

      });

    }

    const createdBy =

      stateResult.rows[0].created_by;

    /* =========================================*

*       INTERCAMBIAR CODE POR TOKENS*

*    ========================================= */

    const tokenBody =

      new URLSearchParams({

        grant_type:

          "authorization_code",

        client_id:

          clientId,

        client_secret:

          clientSecret,

        code,

        redirect_uri:

          redirectUri,

      });

    const tokenResponse =

      await fetch(

        `${baseUrl}/oauth/token`,

        {

          method: "POST",

          headers: {

            "Content-Type":

              "application/x-www-form-urlencoded",

          },

          body:

            tokenBody.toString(),

        }

      );

    const tokenData =

      await tokenResponse.json();

    if (!tokenResponse.ok) {

  console.error(

    "Relbase OAuth token error:",

    {

      status: tokenResponse.status,

      error: tokenData?.error || null,

      error_description:

        tokenData?.error_description || null,

      message: tokenData?.message || null,

      debug_info: tokenData?.debug_info || null,

    }

  );

  return res.status(502).json({

    success: false,

    message:

      "Relbase no permitió obtener los tokens OAuth",

    relbase_error:

      tokenData?.error || null,

    relbase_error_description:

      tokenData?.error_description || null,

    relbase_message:

      tokenData?.message || null,

    relbase_debug_info:

      tokenData?.debug_info || null,

    relbase_status:

      tokenResponse.status,

  });

}

    if (

      !tokenData.access_token ||

      !tokenData.refresh_token

    ) {

      return res.status(502).json({

        success: false,

        message:

          "Relbase respondió sin los tokens esperados",

      });

    }

    /* =========================================*

*       CIFRAR TOKENS*

*    ========================================= */

    const accessTokenEncrypted =

      encryptValue(

        tokenData.access_token

      );

    const refreshTokenEncrypted =

      encryptValue(

        tokenData.refresh_token

      );

    const expiresIn =

      Number(

        tokenData.expires_in || 900

      );

    /* =========================================*

*       GUARDAR CONEXIÓN*

*    ========================================= */

    const connectionResult =

      await pool.query(

        `

          INSERT INTO relbase_oauth_connections (

            provider,

            access_token_encrypted,

            refresh_token_encrypted,

            token_type,

            scope,

            access_expires_at,

            connected_by,

            connected_at,

            is_active

          )

          VALUES (

            'RELBASE',

            $1,

            $2,

            $3,

            $4,

            NOW()

              + ($5 * INTERVAL '1 second'),

            $6,

            NOW(),

            TRUE

          )

          ON CONFLICT (provider)

          DO UPDATE SET

            access_token_encrypted =

              EXCLUDED.access_token_encrypted,

            refresh_token_encrypted =

              EXCLUDED.refresh_token_encrypted,

            token_type =

              EXCLUDED.token_type,

            scope =

              EXCLUDED.scope,

            access_expires_at =

              EXCLUDED.access_expires_at,

            connected_by =

              EXCLUDED.connected_by,

            connected_at =

              NOW(),

            last_refreshed_at =

              NULL,

            is_active =

              TRUE

          RETURNING

            id,

            provider,

            token_type,

            scope,

            access_expires_at,

            connected_at,

            is_active

        `,

        [

          accessTokenEncrypted,

          refreshTokenEncrypted,

          tokenData.token_type ||

            "Bearer",

          tokenData.scope ||

            null,

          expiresIn,

          createdBy,

        ]

      );

    return res.status(200).json({

      success: true,

      message:

        "Laminatiword fue conectado correctamente con Relbase",

      connection:

        connectionResult.rows[0],

    });

  } catch (error) {

    console.error(

      "Error procesando callback Relbase:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible completar la conexión con Relbase",

    });

  }

};

/* =========================================*

*   ESTADO DE CONEXIÓN*

*========================================= */

export const getRelbaseStatus = async (

  req,

  res

) => {

  try {

    const result =

      await pool.query(

        `

          SELECT

            id,

            provider,

            token_type,

            scope,

            access_expires_at,

            connected_at,

            last_refreshed_at,

            is_active,

            created_at,

            updated_at

          FROM relbase_oauth_connections

          WHERE provider = 'RELBASE'

          LIMIT 1

        `

      );

    if (result.rowCount === 0) {

      return res.status(200).json({

        success: true,

        connected: false,

      });

    }

    const connection =

      result.rows[0];

    return res.status(200).json({

      success: true,

      connected:

        connection.is_active,

      connection,

    });

  } catch (error) {

    console.error(

      "Error consultando estado Relbase:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible consultar la conexión con Relbase",

    });

  }

};

/* =========================================*

*   PRODUCTOS RELBASE*

*   PREVIEW ADMINISTRATIVO*

*========================================= */

export const getRelbaseProducts = async (

  req,

  res

) => {

  try {

    const page =

      Math.max(

        Number(req.query.page) || 1,

        1

      );

    const perPage =

      Math.min(

        Math.max(

          Number(req.query.per_page) || 20,

          1

        ),

        100

      );

    const params =

      new URLSearchParams({

        page:

          String(page),

        per_page:

          String(perPage),

      });

    const result =

      await relbaseRequest(

        `/api/v2/productos?${params.toString()}`

      );

    return res.status(200).json({

      success: true,

      source: "RELBASE",

      data:

        result.data?.data || null,

      meta:

        result.data?.meta || null,

      rate_limit:

        result.rateLimit,

    });

  } catch (error) {

    console.error(

      "Error obteniendo productos Relbase:",

      error

    );

    if (

      error.status === 401

    ) {

      return res.status(502).json({

        success: false,

        message:

          "Relbase rechazó la autenticación",

      });

    }

    if (

      error.status === 403

    ) {

      return res.status(502).json({

        success: false,

        message:

          "La conexión Relbase no posee permisos para consultar productos",

      });

    }

    if (

      error.status === 429

    ) {

      return res.status(429).json({

        success: false,

        message:

          "Relbase alcanzó el límite de solicitudes",

      });

    }

    return res.status(502).json({

      success: false,

      message:

        "No fue posible obtener los productos desde Relbase",

    });

  }

};

/* =========================================*

*   BODEGAS RELBASE*

*   PREVIEW ADMINISTRATIVO*

*========================================= */

export const getRelbaseWarehouses = async (

  req,

  res

) => {

  try {

    const result =

      await relbaseRequest(

        "/api/v2/bodegas"

      );

    return res.status(200).json({

      success: true,

      source: "RELBASE",

      data: result.data?.data || null,

      meta: result.data?.meta || null,

      rate_limit: result.rateLimit,

    });

  } catch (error) {

    console.error(

      "Error obteniendo bodegas Relbase:",

      {

        status: error.status || null,

        data: error.relbaseData || null,

        message: error.message,

      }

    );

    return res.status(

      error.status === 404

        ? 404

        : 502

    ).json({

      success: false,

      message:

        error.status === 404

          ? "La ruta /api/v2/bodegas no existe en Relbase"

          : "No fue posible obtener las bodegas desde Relbase",

      relbase_status:

        error.status || null,

      relbase_response:

        error.relbaseData || null,

    });

  }

};

/* =========================================*

*   STOCK RELBASE POR BODEGAS*

*   PREVIEW ADMINISTRATIVO*

*========================================= */

export const getRelbaseProductStock = async (

  req,

  res

) => {

  const { relbaseProductId } = req.params;

  if (

    !relbaseProductId ||

    !/^\d+$/.test(relbaseProductId)

  ) {

    return res.status(400).json({

      success: false,

      message:

        "El ID de producto Relbase no es válido",

    });

  }

  try {

    const result =

      await relbaseRequest(

        `/api/v2/productos/${relbaseProductId}/stock_por_bodegas`

      );

    return res.status(200).json({

      success: true,

      source: "RELBASE",

      relbase_product_id:

        relbaseProductId,

      data:

        result.data?.data || null,

      meta:

        result.data?.meta || null,

      rate_limit:

        result.rateLimit,

    });

  } catch (error) {

    console.error(

      "Error obteniendo stock Relbase:",

      {

        status:

          error.status || null,

        message:

          error.message,

        data:

          error.relbaseData || null,

      }

    );

    if (error.status === 404) {

      return res.status(404).json({

        success: false,

        message:

          "La ruta de stock por bodegas no existe con esta estructura en API v2",

        relbase_status: 404,

        relbase_response:

          error.relbaseData || null,

      });

    }

    if (error.status === 403) {

      return res.status(502).json({

        success: false,

        message:

          "La conexión Relbase no posee permisos suficientes para consultar inventario",

      });

    }

    return res.status(502).json({

      success: false,

      message:

        "No fue posible obtener el stock desde Relbase",

      relbase_status:

        error.status || null,

      relbase_response:

        error.relbaseData || null,

    });

  }

};

/* =========================================*

*   SINCRONIZAR PRODUCTOS RELBASE A STAGING*

*========================================= */

export const syncRelbaseProducts = async (

  req,

  res

) => {

  try {

    const result =

      await syncRelbaseProductsToStaging();

    return res.status(200).json({

      success: true,

      message:

        "Productos Relbase sincronizados correctamente hacia staging",

      sync: result,

    });

  } catch (error) {

    console.error(

      "Error sincronizando productos Relbase:",

      error

    );

    return res.status(502).json({

      success: false,

      message:

        "No fue posible sincronizar los productos desde Relbase",

    });

  }

};

/* =========================================*

*   LISTAR PRODUCTOS RELBASE EN STAGING*

*========================================= */

export const getRelbaseStagingProducts = async (

  req,

  res

) => {

  try {

    const page = Math.max(

      Number(req.query.page) || 1,

      1

    );

    const limit = Math.min(

      Math.max(

        Number(req.query.limit) || 20,

        1

      ),

      100

    );

    const offset =

      (page - 1) * limit;

    const search =

      String(

        req.query.search || ""

      ).trim();

    const status =

      String(

        req.query.status || ""

      )

        .trim()

        .toUpperCase();

    const productType =

      String(

        req.query.product_type || ""

      )

        .trim()

        .toLowerCase();

    const conditions = [];

    const values = [];

    /* =====================================*

*       BÚSQUEDA*

*    ===================================== */

    if (search) {

      values.push(

        `%${search}%`

      );

      const param =

        `$${values.length}`;

      conditions.push(`

        (

          relbase_product_id

            ILIKE ${param}

          OR

          COALESCE(code, '')

            ILIKE ${param}

          OR

          name

            ILIKE ${param}

          OR

          COALESCE(barcode, '')

            ILIKE ${param}

        )

      `);

    }

    /* =====================================*

*       FILTRO ESTADO*

*    ===================================== */

    if (status) {

      const validStatuses = [

        "PENDING",

        "IMPORTED",

        "IGNORED",

        "ERROR",

      ];

      if (

        !validStatuses.includes(

          status

        )

      ) {

        return res.status(400).json({

          success: false,

          message:

            "Estado de staging inválido",

        });

      }

      values.push(status);

      conditions.push(

        `sync_status = $${values.length}`

      );

    }

    /* =====================================*

*       FILTRO TIPO RELBASE*

*    ===================================== */

    if (productType) {

      values.push(productType);

      conditions.push(

        `LOWER(product_type) = $${values.length}`

      );

    }

    const whereClause =

      conditions.length > 0

        ? `WHERE ${conditions.join(

            " AND "

          )}`

        : "";

    /* =====================================*

*       TOTAL*

*    ===================================== */

    const countResult =

      await pool.query(

        `

          SELECT

            COUNT(*)::INTEGER

              AS total

          FROM relbase_product_staging

          ${whereClause}

        `,

        values

      );

    const total =

      countResult.rows[0]?.total ||

      0;

    /* =====================================*

*       RESULTADOS*

*    ===================================== */

    const queryValues = [

      ...values,

      limit,

      offset,

    ];

    const limitParam =

      `$${values.length + 1}`;

    const offsetParam =

      `$${values.length + 2}`;

    const result =

      await pool.query(

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

            sync_status,

            linked_product_id,

            last_seen_at,

            imported_at,

            created_at,

            updated_at

          FROM relbase_product_staging

          ${whereClause}

          ORDER BY

            name ASC,

            relbase_product_id ASC

          LIMIT ${limitParam}

          OFFSET ${offsetParam}

        `,

        queryValues

      );

    const totalPages =

      Math.ceil(

        total / limit

      );

    return res.status(200).json({

      success: true,

      data: {

        products:

          result.rows,

      },

      meta: {

        page,

        limit,

        total,

        total_pages:

          totalPages,

        has_next_page:

          page < totalPages,

        has_previous_page:

          page > 1,

      },

      filters: {

        search:

          search || null,

        status:

          status || null,

        product_type:

          productType || null,

      },

    });

  } catch (error) {

    console.error(

      "Error listando staging Relbase:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible obtener los productos Relbase del staging",

    });

  }

};

/* =========================================*

*   IMPORTAR PRODUCTO STAGING*

*   HACIA CATÁLOGO LAMINATIWORD*

*========================================= */

export const importRelbaseProduct = async (

  req,

  res

) => {

  try {

    const { id } =

      req.params;

    const {

      category_id,

      brand_id = null,

      collection_id = null,

      is_published = false,

      is_featured = false,

      allow_sale = true,

    } = req.body || {};

    if (!id) {

      return res.status(400).json({

        success: false,

        message:

          "El ID de staging es obligatorio",

      });

    }

    const result =

      await importRelbaseStagingProduct(

        id,

        {

          category_id,

          brand_id,

          collection_id,

          is_published,

          is_featured,

          allow_sale,

        }

      );

    return res.status(201).json({

      success: true,

      message:

        "Producto Relbase importado correctamente a Laminatiword",

      data: result,

    });

  } catch (error) {

    console.error(

      "Error importando producto Relbase:",

      {

        message:

          error.message,

        code:

          error.code || null,

      }

    );

    return res

      .status(

        error.status || 500

      )

      .json({

        success: false,

        message:

          error.message ||

          "No fue posible importar el producto Relbase",

        code:

          error.code || null,

      });

  }

};

/* =========================================*

*   SINCRONIZAR INVENTARIO PRODUCTO RELBASE*

*========================================= */

export const syncRelbaseInventory = async (

  req,

  res

) => {

  try {

    const { productId } =

      req.params;

    const result =

      await syncRelbaseProductInventory(

        productId

      );

    return res.status(200).json({

      success: true,

      message:

        "Inventario sincronizado correctamente desde Relbase",

      data: result,

    });

  } catch (error) {

    console.error(

      "Error sincronizando inventario Relbase:",

      {

        message:

          error.message,

        code:

          error.code || null,

        status:

          error.status || null,

      }

    );

    return res

      .status(

        error.status || 502

      )

      .json({

        success: false,

        message:

          error.message ||

          "No fue posible sincronizar el inventario desde Relbase",

        code:

          error.code || null,

      });

  }

};

/* =========================================*

*   SINCRONIZACIÓN GENERAL RELBASE*

*========================================= */

export const syncAllRelbase = async (

  req,

  res

) => {

  try {

    const result =

      await syncAllImportedRelbaseProducts();

    return res.status(200).json({

      success: true,

      message:

        "Sincronización general de Relbase completada correctamente",

      sync: result,

    });

  } catch (error) {

    console.error(

      "Error sincronización general Relbase:",

      {

        message:

          error.message,

        code:

          error.code || null,

        status:

          error.status || null,

      }

    );

    return res

      .status(

        error.status || 502

      )

      .json({

        success: false,

        message:

          error.message ||

          "No fue posible completar la sincronización general con Relbase",

        code:

          error.code || null,

      });

  }

};

/* =========================================*

*   MONITOR ESTADO RELBASE*

*========================================= */

export const getRelbaseMonitor = async (

  req,

  res

) => {

  try {

    const result =

      await getRelbaseMonitorStatus();

    return res.status(200).json({

      success: true,

      data: result,

    });

  } catch (error) {

    console.error(

      "Error obteniendo monitor Relbase:",

      error

    );

    return res.status(500).json({

      success: false,

      message:

        "No fue posible obtener el estado de la integración con Relbase",

    });

  }

};

/* =========================================*

*   CLIENTES RELBASE*

*   PREVIEW ADMINISTRATIVO*

*========================================= */

export const getRelbaseCustomers = async (

  req,

  res

) => {

  try {

    const page =

      Math.max(

        Number(req.query.page) || 1,

        1

      );

    const perPage =

      Math.min(

        Math.max(

          Number(req.query.per_page) || 20,

          1

        ),

        100

      );

    const params =

      new URLSearchParams({

        page: String(page),

        per_page: String(perPage),

      });

    const result =

      await relbaseRequest(

        `/api/v2/clientes?${params.toString()}`

      );

    return res.status(200).json({

      success: true,

      source: "RELBASE",

      data:

        result.data?.data || null,

      meta:

        result.data?.meta || null,

      rate_limit:

        result.rateLimit,

    });

  } catch (error) {

    console.error(

      "Error obteniendo clientes Relbase:",

      {

        status:

          error.status || null,

        message:

          error.message,

        data:

          error.relbaseData || null,

      }

    );

    if (error.status === 404) {

      return res.status(404).json({

        success: false,

        message:

          "La ruta /api/v2/clientes no existe en Relbase",

        relbase_response:

          error.relbaseData || null,

      });

    }

    if (error.status === 403) {

      return res.status(502).json({

        success: false,

        message:

          "La conexión Relbase no posee permiso customers:read",

      });

    }

    return res.status(502).json({

      success: false,

      message:

        "No fue posible obtener los clientes desde Relbase",

      relbase_status:

        error.status || null,

      relbase_response:

        error.relbaseData || null,

    });

  }

};

/* =========================================*

*   BUSCAR CLIENTE RELBASE POR RUT*

*   IMPORTANTE:*

*   La validación y normalización del RUT se*

*   delega al service para mantener una sola*

*   fuente de verdad.*

*   - RUT vacío       -> RUT_REQUIRED*

*   - RUT inválido    -> INVALID_RUT*

*   - RUT válido      -> búsqueda GET en Relbase*

*========================================= */

export const findRelbaseCustomerByRut = async (

  req,

  res

) => {

  try {

    const rut =

      String(

        req.query.rut || ""

      ).trim();

    const result =

      await findRelbaseCustomerByRutService(

        rut

      );

    return res

      .status(200)

      .json({

        success: true,

        found:

          result.found,

        source:

          "RELBASE",

        customer:

          result.customer,

        searched_rut:

          rut || null,

      });

  } catch (error) {

    console.error(

      "Error buscando cliente Relbase por RUT:",

      {

        message:

          error.message,

        code:

          error.code ||

          null,

        status:

          error.status ||

          null,

        relbase:

          error.relbaseData ||

          null,

      }

    );

    if (

      error.code ===

        "RUT_REQUIRED" ||

      error.code ===

        "INVALID_RUT"

    ) {

      return res

        .status(

          error.status ||

          400

        )

        .json({

          success:

            false,

          message:

            error.message,

          code:

            error.code,

        });

    }

    if (

      error.status ===

      403

    ) {

      return res

        .status(502)

        .json({

          success:

            false,

          message:

            "La conexión Relbase no posee permiso customers:read",

          code:

            "RELBASE_CUSTOMERS_READ_FORBIDDEN",

        });

    }

    if (

      error.status ===

      429

    ) {

      return res

        .status(429)

        .json({

          success:

            false,

          message:

            "Relbase alcanzó el límite de solicitudes",

          code:

            "RELBASE_RATE_LIMIT",

        });

    }

    return res

      .status(

        error.status &&

        error.status >= 400 &&

        error.status < 500

          ? error.status

          : 502

      )

      .json({

        success:

          false,

        message:

          error.message ||

          "No fue posible buscar el cliente en Relbase",

        code:

          error.code ||

          "RELBASE_CUSTOMER_SEARCH_ERROR",

      });

  }

};



/* =========================================*

*   BUSCAR CLIENTES RELBASE POR NOMBRE / RUT*

*========================================= */

export const searchRelbaseCustomers = async (

  req,

  res

) => {

  try {

    const query =

      String(

        req.query.q || ""

      ).trim();

    const limit =

      Number(req.query.limit) || 10;

    const result =

      await searchRelbaseCustomersService(

        query,

        { limit }

      );

    return res

      .status(200)

      .json({

        success: true,

        source:

          "RELBASE",

        query:

          result.query,

        count:

          result.count,

        customers:

          result.customers,

        meta:

          result.meta,

        rate_limit:

          result.rate_limit,

      });

  } catch (error) {

    console.error(

      "Error buscando clientes Relbase por nombre/RUT:",

      {

        message:

          error.message,

        code:

          error.code ||

          null,

        status:

          error.status ||

          null,

        relbase:

          error.relbaseData ||

          null,

      }

    );

    if (

      error.code ===

        "CUSTOMER_SEARCH_QUERY_REQUIRED" ||

      error.code ===

        "CUSTOMER_SEARCH_QUERY_TOO_SHORT"

    ) {

      return res

        .status(

          error.status ||

          400

        )

        .json({

          success:

            false,

          message:

            error.message,

          code:

            error.code,

        });

    }

    if (

      error.status ===

      403

    ) {

      return res

        .status(502)

        .json({

          success:

            false,

          message:

            "La conexión Relbase no posee permiso customers:read",

          code:

            "RELBASE_CUSTOMERS_READ_FORBIDDEN",

        });

    }

    if (

      error.status ===

      429

    ) {

      return res

        .status(429)

        .json({

          success:

            false,

          message:

            "Relbase alcanzó el límite de solicitudes",

          code:

            "RELBASE_RATE_LIMIT",

        });

    }

    return res

      .status(

        error.status &&

        error.status >= 400 &&

        error.status < 500

          ? error.status

          : 502

      )

      .json({

        success:

          false,

        message:

          error.message ||

          "No fue posible buscar clientes en Relbase",

        code:

          error.code ||

          "RELBASE_CUSTOMER_LOOKUP_ERROR",

      });

  }

};



/* =========================================*

*   ASEGURAR CLIENTE RELBASE*

*========================================= */

export const ensureRelbaseCustomerController =

  async (req, res) => {

    try {

      const {

        rut,

        company_id = null,

        create_if_missing = false,

        customer_data = null,

      } = req.body || {};

      const result =

        await ensureRelbaseCustomer({

          rut,

          company_id,

          create_if_missing,

          customer_data,

        });

      return res.status(

        result.created

          ? 201

          : 200

      ).json({

        success: true,

        message:

          result.created

            ? "Cliente creado correctamente en Relbase"

            : result.found

              ? "Cliente encontrado en Relbase"

              : "Cliente no encontrado en Relbase",

        data: result,

      });

    } catch (error) {

      console.error(

        "Error asegurando cliente Relbase:",

        {

          message:

            error.message,

          code:

            error.code || null,

          status:

            error.status || null,

          relbase:

            error.relbaseData ||

            null,

        }

      );

      return res

        .status(

          error.status || 500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible procesar el cliente Relbase",

          code:

            error.code || null,

        });

    }

  };

  /* =========================================*

*   CIUDADES RELBASE*

*========================================= */

export const getRelbaseCities = async (

  req,

  res

) => {

  try {

    const result =

      await relbaseRequest(

        "/api/v2/ciudades"

      );

    return res.status(200).json({

      success: true,

      source: "RELBASE",

      data:

        result.data?.data || null,

      meta:

        result.data?.meta || null,

    });

  } catch (error) {

    console.error(

      "Error obteniendo ciudades Relbase:",

      {

        status:

          error.status || null,

        message:

          error.message,

        data:

          error.relbaseData || null,

      }

    );

    return res.status(

      error.status === 404

        ? 404

        : 502

    ).json({

      success: false,

      message:

        error.status === 404

          ? "La ruta /api/v2/ciudades no existe en Relbase"

          : "No fue posible obtener las ciudades desde Relbase",

      relbase_status:

        error.status || null,

      relbase_response:

        error.relbaseData || null,

    });

  }

};

/* =========================================*

*   PROBE AUTENTICACIÓN DTE RELBASE V1*

*   SOLO LECTURA*

*========================================= */

export const probeRelbaseDteAuth =

  async (req, res) => {

    try {

      const result =

        await probeRelbaseDteReadAccess();

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Probe de autenticación DTE ejecutado correctamente",

          data: result,

        });

    } catch (error) {

      console.error(

        "Error ejecutando probe DTE Relbase:",

        {

          message:

            error.message,

          status:

            error.status || null,

          relbaseData:

            error.relbaseData || null,

        }

      );

      return res

        .status(

          error.status || 500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible ejecutar el probe DTE Relbase",

          data:

            error.relbaseData ||

            null,

        });

    }

  };

  /* =========================================*

*   PROBE DTE RELBASE API V2*

*========================================= */

export const probeRelbaseDteV2Auth =

  async (req, res) => {

    try {

      const result =

        await probeRelbaseDteV2ReadAccess();

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Probe DTE API v2 ejecutado correctamente",

          data:

            result,

        });

    } catch (error) {

      console.error(

        "Error probe DTE Relbase v2:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          relbaseData:

            error.relbaseData ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible ejecutar el probe DTE v2",

          data:

            error.relbaseData ||

            null,

        });

    }

  };

/* =========================================*

*   PREVIEW SINCRONIZACIÓN DTE RELBASE V2*

*   SOLO LECTURA:*

*   - Consulta GET /api/v2/dtes.*

*   - Busca un DTE específico por id.*

*   - Normaliza la respuesta real de Relbase.*

*   - NO hace INSERT.*

*   - NO hace UPDATE.*

*   - NO emite documentos.*

*========================================= */


/* =========================================
   PREVIEW HISTÓRICO DTE RELBASE
   FASE 2 - SOLO LECTURA

   - Consulta Facturas (33) y/o Boletas (39).
   - Clasifica origen LAMINATIWORD / RELBASE.
   - NO hace INSERT.
   - NO hace UPDATE.
   - NO hace DELETE.
   - NO emite documentos.
========================================= */
export const previewRelbaseDteHistory =
  async (req, res) => {
    try {
      const rawType = String(
        req.query.type_document || "ALL"
      )
        .trim()
        .toUpperCase();

      const page = Number(
        req.query.page || 1
      );

      if (
        !Number.isInteger(page) ||
        page < 1
      ) {
        return res.status(400).json({
          success: false,
          message:
            "page debe ser un entero mayor o igual a 1",
          code:
            "INVALID_DTE_HISTORY_PAGE",
        });
      }

      let typeDocuments = [];

      if (rawType === "ALL") {
        typeDocuments = [33, 39];
      } else {
        const parsedType = Number(rawType);

        if (![33, 39].includes(parsedType)) {
          return res.status(400).json({
            success: false,
            message:
              "type_document debe ser ALL, 33 (FACTURA) o 39 (BOLETA)",
            code:
              "INVALID_DTE_HISTORY_TYPE",
          });
        }

        typeDocuments = [parsedType];
      }

      const pages = [];
      const allRecords = [];

      /*
       * Consultamos secuencialmente para ser
       * conservadores con el rate limit de Relbase.
       */
      for (const typeDocument of typeDocuments) {
        const endpoint =
          `/api/v2/dtes?type_document=${encodeURIComponent(
            typeDocument
          )}&page=${encodeURIComponent(page)}`;

        const result = await relbaseRequest(
          endpoint,
          {
            method: "GET",
          }
        );

        const payload =
          result?.data || null;

        const dataContainer =
          payload?.data || null;

        let collectionPath = null;
        let records = [];

        if (Array.isArray(dataContainer)) {
          collectionPath = "data";
          records = dataContainer;
        } else if (
          Array.isArray(
            dataContainer?.dtes
          )
        ) {
          collectionPath = "data.dtes";
          records = dataContainer.dtes;
        } else if (
          Array.isArray(
            dataContainer?.documents
          )
        ) {
          collectionPath =
            "data.documents";
          records =
            dataContainer.documents;
        } else if (
          Array.isArray(
            dataContainer?.resources
          )
        ) {
          collectionPath =
            "data.resources";
          records =
            dataContainer.resources;
        } else {
          return res.status(502).json({
            success: false,
            message:
              "Relbase respondió con una estructura DTE v2 no reconocida",
            code:
              "RELBASE_DTE_HISTORY_LIST_INVALID",
            data: {
              read_only: true,
              type_document:
                typeDocument,
              page,
              endpoint:
                `GET ${endpoint}`,
            },
          });
        }

        pages.push({
          type_document:
            typeDocument,
          document_type:
            typeDocument === 33
              ? "FACTURA"
              : "BOLETA",
          endpoint:
            `GET ${endpoint}`,
          page,
          collection_path:
            collectionPath,
          records_on_page:
            records.length,
          rate_limit:
            result?.rateLimit || null,
          meta:
            payload?.meta || null,
        });

        for (const record of records) {
          allRecords.push({
            typeDocument,
            record,
          });
        }
      }

      const relbaseIds = [
        ...new Set(
          allRecords
            .map(({ record }) =>
              String(
                record?.id ?? ""
              ).trim()
            )
            .filter(Boolean)
        ),
      ];

      let localDocuments = [];

      if (relbaseIds.length > 0) {
        const localResult =
          await pool.query(
            `
              SELECT
                td.id AS laminatiword_tax_document_id,
                td.order_id,
                td.relbase_document_id,
                td.document_type AS local_document_type,
                td.folio AS local_folio,
                td.status AS local_status,
                o.order_number
              FROM tax_documents td
              LEFT JOIN orders o
                ON o.id = td.order_id
              WHERE td.relbase_document_id = ANY($1::text[])
            `,
            [relbaseIds]
          );

        localDocuments =
          localResult.rows || [];
      }

      const localByRelbaseId =
        new Map(
          localDocuments.map(
            (item) => [
              String(
                item.relbase_document_id
              ),
              item,
            ]
          )
        );

      const toOptionalString =
        (value) => {
          if (
            value === undefined ||
            value === null
          ) {
            return null;
          }

          const normalized =
            String(value).trim();

          return normalized || null;
        };

      const toOptionalNumber =
        (value) => {
          if (
            value === undefined ||
            value === null ||
            value === ""
          ) {
            return null;
          }

          const normalized =
            Number(value);

          return Number.isFinite(
            normalized
          )
            ? normalized
            : null;
        };

      const resolveAmount =
        (record, realKey, baseKey) => {
          const realValue =
            toOptionalNumber(
              record?.[realKey]
            );

          if (realValue !== null) {
            return realValue;
          }

          return toOptionalNumber(
            record?.[baseKey]
          );
        };

      const documents =
        allRecords.map(
          ({
            typeDocument,
            record,
          }) => {
            const relbaseDocumentId =
              toOptionalString(
                record?.id
              );

            const localDocument =
              relbaseDocumentId
                ? localByRelbaseId.get(
                    relbaseDocumentId
                  ) || null
                : null;

            const comment =
              toOptionalString(
                record?.comment
              );

            const hasLaminatiMarker =
              /^laminatiword(?:\s|$)/i.test(
                comment || ""
              );

            const sourceSystem =
              localDocument ||
              hasLaminatiMarker
                ? "LAMINATIWORD"
                : "RELBASE";

            const sourceDetection =
              localDocument
                ? "LOCAL_RELBASE_DOCUMENT_ID"
                : hasLaminatiMarker
                  ? "COMMENT_MARKER"
                  : "EXTERNAL_ONLY";

            return {
              relbase_document_id:
                relbaseDocumentId,

              document_type:
                typeDocument === 33
                  ? "FACTURA"
                  : "BOLETA",

              sii_code:
                typeDocument,

              type_document_name:
                toOptionalString(
                  record?.type_document_name
                ),

              folio:
                toOptionalString(
                  record?.folio
                ),

              track_id:
                toOptionalString(
                  record?.track_id
                ),

              relbase_status:
                toOptionalString(
                  record?.status
                ),

              sii_status:
                toOptionalString(
                  record?.sii_status
                ),

              sii_status_name:
                toOptionalString(
                  record?.sii_status_name
                ),

              amounts: {
                net:
                  resolveAmount(
                    record,
                    "real_amount_neto",
                    "amount_neto"
                  ),

                iva:
                  resolveAmount(
                    record,
                    "real_amount_iva",
                    "amount_iva"
                  ),

                tax:
                  resolveAmount(
                    record,
                    "real_amount_tax",
                    "amount_tax"
                  ),

                exempt:
                  resolveAmount(
                    record,
                    "real_amount_exempt",
                    "amount_exempt"
                  ),

                total:
                  resolveAmount(
                    record,
                    "real_amount_total",
                    "amount_total"
                  ),
              },

              dates: {
                start_date:
                  toOptionalString(
                    record?.start_date
                  ),

                end_date:
                  toOptionalString(
                    record?.end_date
                  ),

                created_at:
                  toOptionalString(
                    record?.created_at
                  ),

                updated_at:
                  toOptionalString(
                    record?.updated_at
                  ),
              },

              comment,

              source_system:
                sourceSystem,

              source_detection:
                sourceDetection,

              laminatiword: {
                matched:
                  Boolean(localDocument),

                tax_document_id:
                  localDocument
                    ?.laminatiword_tax_document_id ||
                  null,

                order_id:
                  localDocument
                    ?.order_id || null,

                order_number:
                  localDocument
                    ?.order_number || null,

                local_status:
                  localDocument
                    ?.local_status || null,
              },
            };
          }
        );

      const firstRawRecord =
        allRecords[0]?.record || null;

      const recordKeys =
        firstRawRecord &&
        typeof firstRawRecord === "object"
          ? Object.keys(
              firstRawRecord
            ).slice(0, 100)
          : [];

      const possibleCustomerKeys =
        recordKeys.filter(
          (key) =>
            /(customer|client|cliente|rut|receiver|receptor|razon|name|nombre)/i.test(
              key
            )
        );

      return res.status(200).json({
        success: true,
        message:
          "Preview histórico DTE Relbase generado correctamente",
        data: {
          read_only: true,
          persistence_executed:
            false,
          emission_executed:
            false,
          relbase_requests:
            pages.length,
          page,
          requested_type_document:
            rawType,
          pages,
          summary: {
            total_documents:
              documents.length,
            laminatiword:
              documents.filter(
                (item) =>
                  item.source_system ===
                  "LAMINATIWORD"
              ).length,
            relbase:
              documents.filter(
                (item) =>
                  item.source_system ===
                  "RELBASE"
              ).length,
            facturas:
              documents.filter(
                (item) =>
                  item.sii_code === 33
              ).length,
            boletas:
              documents.filter(
                (item) =>
                  item.sii_code === 39
              ).length,
          },
          schema_probe: {
            first_record_keys:
              recordKeys,
            possible_customer_keys:
              possibleCustomerKeys,
          },
          documents,
        },
      });
    } catch (error) {
      console.error(
        "Error preview histórico DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible generar el preview histórico DTE de Relbase",
        code:
          error.code ||
          "RELBASE_DTE_HISTORY_PREVIEW_ERROR",
        relbase_status:
          error.status || null,
        relbase_response:
          error.relbaseData || null,
      });
    }
  };

/* =========================================
   ESTADO SINCRONIZACIÓN HISTÓRICA DTE
   FASE 3
========================================= */
export const getRelbaseDteHistorySyncStateController =
  async (req, res) => {
    try {
      const state =
        await getRelbaseDteHistorySyncState();

      return res.status(200).json({
        success: true,
        message:
          "Estado de sincronización histórica DTE obtenido correctamente",
        data: {
          emission_executed: false,
          relbase_write_executed: false,
          state,
        },
      });
    } catch (error) {
      console.error(
        "Error obteniendo estado histórico DTE:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible obtener el estado de sincronización histórica DTE",
        code:
          error.code ||
          "RELBASE_DTE_HISTORY_STATE_ERROR",
      });
    }
  };

/* =========================================
   SINCRONIZAR HISTÓRICO DTE RELBASE
   FASE 3

   IMPORTANTE:
   - Sólo GET hacia Relbase.
   - Persiste únicamente el espejo histórico local.
   - NO emite documentos.
   - NO modifica DTE en Relbase.
   - Usa checkpoint por tipo 33 / 39.
========================================= */
export const syncRelbaseDteHistoryController =
  async (req, res) => {
    try {
      const typeDocument =
        Number(
          req.body?.type_document
        );

      const maxPages =
        req.body?.max_pages ?? 25;

      const data =
        await syncRelbaseDteHistory({
          typeDocument,
          maxPages,
        });

      return res.status(200).json({
        success: true,
        message:
          data.already_completed
            ? "El histórico DTE para este tipo ya se encuentra completo"
            : "Lote histórico DTE sincronizado correctamente",
        data: {
          ...data,
          persistence_executed: true,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error sincronizando histórico DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible sincronizar el histórico DTE de Relbase",
        code:
          error.code ||
          "RELBASE_DTE_HISTORY_SYNC_ERROR",
        relbase_status:
          error.status || null,
        relbase_response:
          error.relbaseData || null,
      });
    }
  };



/* =========================================
   ESTADO ENRIQUECIMIENTO CLIENTES DTE
   FASE 5.1
========================================= */
export const getRelbaseDteHistoryCustomerSyncStateController =
  async (req, res) => {
    try {
      const state =
        await getRelbaseDteHistoryCustomerSyncState();

      return res.status(200).json({
        success: true,
        message:
          "Estado de enriquecimiento de clientes DTE obtenido correctamente",
        data: {
          state,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error obteniendo estado de enriquecimiento de clientes DTE:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible obtener el estado de enriquecimiento de clientes DTE",
        code:
          error.code ||
          "RELBASE_DTE_CUSTOMER_HISTORY_STATE_ERROR",
      });
    }
  };

/* =========================================
   ENRIQUECER CLIENTES HISTÓRICO DTE
   FASE 5.1

   - GET /api/v2/clientes hacia Relbase.
   - UPDATE sólo en PostgreSQL local.
   - NO emite DTE.
   - NO escribe en Relbase.
========================================= */
export const syncRelbaseDteHistoryCustomersController =
  async (req, res) => {
    try {
      const data =
        await syncRelbaseDteHistoryCustomers({
          maxPages:
            req.body?.max_pages ?? 25,
        });

      return res.status(200).json({
        success: true,
        message:
          data.already_completed
            ? "El enriquecimiento de clientes DTE ya se encuentra completo"
            : "Lote de clientes DTE enriquecido correctamente",
        data: {
          ...data,
          persistence_executed: true,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error enriqueciendo clientes del histórico DTE:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible enriquecer los clientes del histórico DTE",
        code:
          error.code ||
          "RELBASE_DTE_CUSTOMER_HISTORY_SYNC_ERROR",
        relbase_status:
          error.status || null,
        relbase_response:
          error.relbaseData || null,
      });
    }
  };


/* =========================================
   CONSULTAR HISTÓRICO DTE LOCAL
   FASE 4

   - Lee PostgreSQL.
   - NO consulta Relbase.
   - NO emite documentos.
========================================= */
export const listRelbaseDteHistoryController =
  async (req, res) => {
    try {
      const data =
        await listRelbaseDteHistory({
          page:
            req.query.page ?? 1,
          limit:
            req.query.limit ?? 50,
          documentType:
            req.query.document_type,
          sourceSystem:
            req.query.source_system,
          siiStatus:
            req.query.sii_status,
          relbaseStatus:
            req.query.relbase_status,
          from:
            req.query.from,
          to:
            req.query.to,
          search:
            req.query.search,
        });

      return res.status(200).json({
        success: true,
        message:
          "Histórico DTE obtenido correctamente",
        data: {
          ...data,
          source: "POSTGRESQL",
          relbase_requests: 0,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error listando histórico DTE:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible obtener el histórico DTE",
        code:
          error.code ||
          "DTE_HISTORY_LIST_ERROR",
      });
    }
  };

/* =========================================
   RESUMEN HISTÓRICO DTE LOCAL
   FASE 4
========================================= */
export const getRelbaseDteHistorySummaryController =
  async (req, res) => {
    try {
      const summary =
        await getRelbaseDteHistorySummary({
          documentType:
            req.query.document_type,
          sourceSystem:
            req.query.source_system,
          siiStatus:
            req.query.sii_status,
          relbaseStatus:
            req.query.relbase_status,
          from:
            req.query.from,
          to:
            req.query.to,
          search:
            req.query.search,
        });

      return res.status(200).json({
        success: true,
        message:
          "Resumen histórico DTE obtenido correctamente",
        data: {
          summary,
          source: "POSTGRESQL",
          relbase_requests: 0,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error obteniendo resumen histórico DTE:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible obtener el resumen histórico DTE",
        code:
          error.code ||
          "DTE_HISTORY_SUMMARY_ERROR",
      });
    }
  };

/* =========================================
   DETALLE HISTÓRICO DTE LOCAL
   FASE 4

   Acepta UUID local del histórico o
   relbase_document_id.
========================================= */
export const getRelbaseDteHistoryDetailController =
  async (req, res) => {
    try {
      const document =
        await getRelbaseDteHistoryDetail(
          req.params.id
        );

      return res.status(200).json({
        success: true,
        message:
          "Detalle histórico DTE obtenido correctamente",
        data: {
          document,
          source: "POSTGRESQL",
          relbase_requests: 0,
          emission_executed: false,
          relbase_write_executed: false,
        },
      });
    } catch (error) {
      console.error(
        "Error obteniendo detalle histórico DTE:",
        {
          message:
            error.message,
          status:
            error.status || null,
          code:
            error.code || null,
        }
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        message:
          error.message ||
          "No fue posible obtener el detalle histórico DTE",
        code:
          error.code ||
          "DTE_HISTORY_DETAIL_ERROR",
      });
    }
  };

export const previewRelbaseDteSync =

  async (req, res) => {

    try {

      const typeDocument =

        Number(

          req.query.type_document

        );

      const relbaseDocumentId =

        String(

          req.query.relbase_document_id ||

          ""

        ).trim();

      const page =

        Number(

          req.query.page ||

          1

        );

      if (

        ![

          33,

          39,

        ].includes(

          typeDocument

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "type_document debe ser 33 (FACTURA) o 39 (BOLETA)",

            code:

              "INVALID_DTE_TYPE_DOCUMENT",

          });

      }

      if (!relbaseDocumentId) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "relbase_document_id es obligatorio",

            code:

              "RELBASE_DTE_ID_REQUIRED",

          });

      }

      if (

        !Number.isInteger(page) ||

        page < 1

      ) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "page debe ser un entero mayor o igual a 1",

            code:

              "INVALID_DTE_PAGE",

          });

      }

      const endpoint =

        `/api/v2/dtes?type_document=${encodeURIComponent(

          typeDocument

        )}&page=${encodeURIComponent(

          page

        )}`;

      const result =

        await relbaseRequest(

          endpoint,

          {

            method: "GET",

          }

        );

      const payload =

        result?.data ||

        null;

      const records =

        payload?.data?.dtes;

      if (!Array.isArray(records)) {

        return res

          .status(502)

          .json({

            success: false,

            message:

              "Relbase respondió con una estructura DTE v2 no reconocida",

            code:

              "RELBASE_DTE_LIST_INVALID",

          });

      }

      const record =

        records.find(

          (item) =>

            String(

              item?.id ??

              ""

            ).trim() ===

            relbaseDocumentId

        ) ||

        null;

      if (!record) {

        return res

          .status(404)

          .json({

            success: false,

            message:

              "El DTE indicado no fue encontrado en la página consultada de Relbase",

            code:

              "RELBASE_DTE_NOT_FOUND_ON_PAGE",

            data: {

              read_only:

                true,

              endpoint:

                `GET ${endpoint}`,

              type_document:

                typeDocument,

              relbase_document_id:

                relbaseDocumentId,

              page,

              records_on_page:

                records.length,

            },

          });

      }

      const normalized =

        normalizeRelbaseDteRecord(

          record

        );

      /* =====================================*

*         ESTADO PREVIEW LAMINATIWORD*

*         No usamos status=paid para decidir*

*         aceptación tributaria.*

*         ACCEPTED/REJECTED dependen de SII.*

*      ===================================== */

      const normalizedSiiStatus =

        String(

          normalized.sii_status ||

          ""

        )

          .trim()

          .toLowerCase();

      let normalizedStatus =

        "ISSUED";

      if (

        [

          "accepted",

          "aceptado",

        ].includes(

          normalizedSiiStatus

        )

      ) {

        normalizedStatus =

          "ACCEPTED";

      } else if (

        [

          "rejected",

          "rechazado",

        ].includes(

          normalizedSiiStatus

        )

      ) {

        normalizedStatus =

          "REJECTED";

      }

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Preview de sincronización DTE generado correctamente",

          data: {

            read_only:

              true,

            persistence_executed:

              false,

            emission_executed:

              false,

            source: {

              endpoint:

                `GET ${endpoint}`,

              api_version:

                "v2",

              auth_mode:

                "OAUTH_BEARER",

              page,

              records_on_page:

                records.length,

            },

            dte: {

              relbase_document_id:

                normalized.relbase_document_id,

              folio:

                normalized.folio,

              track_id:

                normalized.track_id,

              type_document:

                normalized.type_document,

              relbase_status:

                normalized.relbase_status,

              sii_status:

                normalized.sii_status,

              sii_status_name:

                normalized.sii_status_name,

              normalized_status:

                normalizedStatus,

              pdf_available:

                Boolean(

                  normalized.pdf_url

                ),

              xml_available:

                Boolean(

                  normalized.xml_url

                ),

              amounts:

                normalized.amounts,

            },

          },

        });

    } catch (error) {

      console.error(

        "Error preview sincronización DTE Relbase:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible generar el preview de sincronización DTE",

          code:

            error.code ||

            null,

        });

    }

  };

/* =========================================
   DETALLE EXTERNO DTE RELBASE V2
   SOLO LECTURA

   OBJETIVO:
   - Consultar GET /api/v2/dtes/:e_document_id.
   - Inspeccionar de forma segura la estructura real.
   - Detectar pistas de referencias / notas de crédito.
   - NO INSERT.
   - NO UPDATE.
   - NO POST.
   - NO emite documentos.

   SEGURIDAD:
   - No exponemos el payload completo de Relbase.
   - No devolvemos datos personales del receptor.
   - Sólo entregamos un resumen tributario y campos
     potencialmente relacionados con anulaciones,
     referencias o documentos vinculados.
========================================= */

const toOptionalRelbaseString = (
  value
) => {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  return normalized || null;
};

const toOptionalRelbaseNumber = (
  value
) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const normalized =
    Number(value);

  return Number.isFinite(
    normalized
  )
    ? normalized
    : null;
};

const RELBASE_RELATION_KEY_PATTERN =
  /(referenc|credit|nota|anul|annul|cancel|void|related|relation|parent|origin|document|dte)/i;

const RELBASE_RELATION_SAFE_FIELD_PATTERN =
  /^(id|folio|type_document|type_document_name|document_type|reference_type|reference_type_id|reason|reason_code|date|start_date|end_date|document_id|e_document_id|parent_id|reference_document_id|reference_folio|reference_type_document|status|sii_status|sii_status_name|code|name|comment)$/i;

const collectRelbaseRelationHints = (
  value,
  options = {}
) => {
  const {
    path = "data",
    depth = 0,
    insideRelation = false,
    output = [],
    seen = new WeakSet(),
  } = options;

  if (
    output.length >= 200 ||
    depth > 8 ||
    value === undefined ||
    value === null
  ) {
    return output;
  }

  if (
    typeof value !== "object"
  ) {
    if (insideRelation) {
      output.push({
        path,
        value,
      });
    }

    return output;
  }

  if (seen.has(value)) {
    return output;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    if (insideRelation) {
      output.push({
        path,
        type: "array",
        length:
          value.length,
      });
    }

    value
      .slice(0, 50)
      .forEach(
        (item, index) => {
          collectRelbaseRelationHints(
            item,
            {
              path:
                `${path}[${index}]`,
              depth:
                depth + 1,
              insideRelation,
              output,
              seen,
            }
          );
        }
      );

    return output;
  }

  for (
    const [key, child]
    of Object.entries(value)
  ) {
    if (output.length >= 200) {
      break;
    }

    const childPath =
      `${path}.${key}`;

    const relationKey =
      RELBASE_RELATION_KEY_PATTERN.test(
        key
      );

    const nextInsideRelation =
      insideRelation ||
      relationKey;

    if (relationKey) {
      if (
        child === null ||
        child === undefined ||
        typeof child !== "object"
      ) {
        output.push({
          path:
            childPath,
          value:
            child ?? null,
        });
      } else {
        output.push({
          path:
            childPath,
          type:
            Array.isArray(child)
              ? "array"
              : "object",
          keys:
            Array.isArray(child)
              ? null
              : Object.keys(child)
                  .slice(0, 40),
          length:
            Array.isArray(child)
              ? child.length
              : null,
        });
      }
    } else if (
      insideRelation &&
      RELBASE_RELATION_SAFE_FIELD_PATTERN.test(
        key
      ) &&
      (
        child === null ||
        child === undefined ||
        typeof child !== "object"
      )
    ) {
      output.push({
        path:
          childPath,
        value:
          child ?? null,
      });
    }

    collectRelbaseRelationHints(
      child,
      {
        path:
          childPath,
        depth:
          depth + 1,
        insideRelation:
          nextInsideRelation,
        output,
        seen,
      }
    );
  }

  return output;
};

const resolveRelbaseDteDetailRecord = (
  payload
) => {
  const data =
    payload?.data ??
    payload ??
    null;

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return null;
  }

  if (
    data.dte &&
    typeof data.dte === "object" &&
    !Array.isArray(data.dte)
  ) {
    return data.dte;
  }

  if (
    data.document &&
    typeof data.document === "object" &&
    !Array.isArray(data.document)
  ) {
    return data.document;
  }

  return data;
};

const buildSafeRelbaseDteDetail = (
  record
) => {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record)
  ) {
    return null;
  }

  let normalized =
    null;

  try {
    normalized =
      normalizeRelbaseDteRecord(
        record
      );
  } catch {
    /*
     * El endpoint de detalle puede incluir una
     * estructura más amplia que el listado.
     * No hacemos fallar el diagnóstico si el
     * normalizador existente no reconoce todo.
     */
  }

  return {
    relbase_document_id:
      normalized
        ?.relbase_document_id ||
      toOptionalRelbaseString(
        record.id
      ),

    folio:
      normalized?.folio ||
      toOptionalRelbaseString(
        record.folio
      ),

    track_id:
      normalized?.track_id ||
      toOptionalRelbaseString(
        record.track_id
      ),

    type_document:
      normalized
        ?.type_document ??
      toOptionalRelbaseNumber(
        record.type_document
      ),

    type_document_name:
      toOptionalRelbaseString(
        record.type_document_name
      ),

    relbase_status:
      normalized
        ?.relbase_status ||
      toOptionalRelbaseString(
        record.status
      ),

    sii_status:
      normalized?.sii_status ||
      toOptionalRelbaseString(
        record.sii_status
      ),

    sii_status_name:
      normalized
        ?.sii_status_name ||
      toOptionalRelbaseString(
        record.sii_status_name
      ),

    start_date:
      toOptionalRelbaseString(
        record.start_date
      ),

    end_date:
      toOptionalRelbaseString(
        record.end_date
      ),

    comment:
      toOptionalRelbaseString(
        record.comment
      ),

    mnt_bruto:
      typeof record.mnt_bruto ===
      "boolean"
        ? record.mnt_bruto
        : null,

    amounts:
      normalized?.amounts ||
      {
        net:
          toOptionalRelbaseNumber(
            record.real_amount_neto ??
            record.amount_neto
          ),

        exempt:
          toOptionalRelbaseNumber(
            record.real_amount_exempt ??
            record.amount_exempt
          ),

        tax:
          toOptionalRelbaseNumber(
            record.real_amount_iva ??
            record.amount_iva
          ),

        total:
          toOptionalRelbaseNumber(
            record.real_amount_total ??
            record.amount_total
          ),
      },

    created_at:
      toOptionalRelbaseString(
        record.created_at
      ),

    updated_at:
      toOptionalRelbaseString(
        record.updated_at
      ),
  };
};

export const previewRelbaseDteExternalDetail =
  async (req, res) => {
    const relbaseDocumentId =
      String(
        req.params
          .relbaseDocumentId ||
        ""
      ).trim();

    if (
      !relbaseDocumentId ||
      !/^\d+$/.test(
        relbaseDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "relbaseDocumentId debe ser un ID numérico válido",
          code:
            "INVALID_RELBASE_DTE_ID",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }

    const endpoint =
      `/api/v2/dtes/${encodeURIComponent(
        relbaseDocumentId
      )}`;

    try {
      const result =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const payload =
        result?.data ??
        null;

      const record =
        resolveRelbaseDteDetailRecord(
          payload
        );

      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record)
      ) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió con una estructura de detalle DTE no reconocida",
            code:
              "RELBASE_DTE_DETAIL_INVALID",
            data: {
              read_only:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source: {
                endpoint:
                  `GET ${endpoint}`,
                api_version:
                  "v2",
                auth_mode:
                  "OAUTH_BEARER",
              },
              response_shape: {
                top_level_keys:
                  payload &&
                  typeof payload ===
                    "object" &&
                  !Array.isArray(payload)
                    ? Object.keys(payload)
                        .slice(0, 50)
                    : [],
              },
            },
          });
      }

      const safeDte =
        buildSafeRelbaseDteDetail(
          record
        );

      const relationHints =
        collectRelbaseRelationHints(
          payload,
          {
            path:
              "response",
          }
        );

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Detalle externo DTE Relbase consultado correctamente",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            raw_detail_exposed:
              false,

            source: {
              endpoint:
                `GET ${endpoint}`,
              api_version:
                "v2",
              auth_mode:
                "OAUTH_BEARER",
              relbase_document_id:
                relbaseDocumentId,
              rate_limit:
                result?.rateLimit ||
                null,
            },

            response_shape: {
              top_level_keys:
                payload &&
                typeof payload ===
                  "object" &&
                !Array.isArray(payload)
                  ? Object.keys(payload)
                      .slice(0, 50)
                  : [],

              data_keys:
                payload?.data &&
                typeof payload.data ===
                  "object" &&
                !Array.isArray(
                  payload.data
                )
                  ? Object.keys(
                      payload.data
                    ).slice(0, 80)
                  : [],

              detail_keys:
                Object.keys(record)
                  .slice(0, 120),
            },

            dte:
              safeDte,

            relation_hints:
              relationHints,
          },
        });
    } catch (error) {
      console.error(
        "Error consultando detalle externo DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible consultar el detalle externo del DTE en Relbase",
          code:
            error.code ||
            "RELBASE_DTE_DETAIL_ERROR",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            endpoint:
              `GET ${endpoint}`,
          },
        });
    }
  };


/* =========================================
   OBTENER PDF DTE RELBASE PARA BACKOFFICE

   SOLO LECTURA:
   - Valida el tax_document local.
   - Reutiliza pdf_url local si ya existe.
   - Si falta, consulta GET /api/v2/dtes/:id.
   - NO INSERT.
   - NO UPDATE.
   - NO claim.
   - NO POST.
   - NO emite documentos.
========================================= */
export const getRelbaseDtePdf =
  async (req, res) => {
    const taxDocumentId =
      String(
        req.params.taxDocumentId ||
        ""
      ).trim();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !taxDocumentId ||
      !uuidPattern.test(
        taxDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "taxDocumentId no es un UUID válido",
          code:
            "INVALID_TAX_DOCUMENT_ID",
        });
    }

    try {
      const localResult =
        await pool.query(
          `
            SELECT
              id,
              order_id,
              document_type,
              sii_code,
              status,
              relbase_document_id,
              folio,
              track_id,
              sii_status,
              sii_status_name,
              pdf_url
            FROM tax_documents
            WHERE id = $1
            LIMIT 1
          `,
          [
            taxDocumentId,
          ]
        );

      if (
        localResult.rowCount ===
        0
      ) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "El documento tributario local no existe",
            code:
              "TAX_DOCUMENT_NOT_FOUND",
          });
      }

      const local =
        localResult.rows[0];

      const localStatus =
        String(
          local.status ||
          ""
        )
          .trim()
          .toUpperCase();

      if (
        ![
          "ISSUED",
          "ACCEPTED",
        ].includes(
          localStatus
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El documento todavía no se encuentra emitido y disponible para visualización",
            code:
              "TAX_DOCUMENT_NOT_VIEWABLE",
            data: {
              tax_document_id:
                taxDocumentId,
              status:
                localStatus ||
                null,
            },
          });
      }

      const relbaseDocumentId =
        String(
          local.relbase_document_id ||
          ""
        ).trim();

      if (
        !relbaseDocumentId ||
        !/^\d+$/.test(
          relbaseDocumentId
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El documento emitido no posee un relbase_document_id válido",
            code:
              "RELBASE_DTE_ID_MISSING",
          });
      }

      const requestedFormat =
        String(
          req.query.format ||
          ""
        )
          .trim()
          .toLowerCase();

      const supportedFormats =
        new Set([
          "",
          "original",
          "letter",
          "carta",
          "a4",
        ]);

      if (
        !supportedFormats.has(
          requestedFormat
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Formato de impresión no soportado. Usa original, letter, carta o a4.",
            code:
              "RELBASE_DTE_PDF_FORMAT_INVALID",
          });
      }

      /*
       * Política Laminatiword:
       *
       * - FACTURA sin parámetro -> A4/Carta.
       * - BOLETA sin parámetro   -> PDF original.
       * - ?format=original       -> PDF original Relbase.
       * - ?format=letter|carta|a4 -> representación A4 Laminatiword.
       *
       * El DTE NO se reemite ni se modifica.
       * Sólo cambia la representación impresa.
       */
      const localDocumentType =
        String(
          local.document_type ||
          ""
        )
          .trim()
          .toUpperCase();

      const renderLetterPdf =
        [
          "letter",
          "carta",
          "a4",
        ].includes(
          requestedFormat
        ) ||
        (
          !requestedFormat &&
          localDocumentType ===
            "FACTURA"
        );

      if (
        renderLetterPdf
      ) {
        const printEndpoint =
          `/api/v2/dtes/${encodeURIComponent(
            relbaseDocumentId
          )}/imprimir`;

        const printResult =
          await relbaseRequest(
            printEndpoint,
            {
              method:
                "GET",
            }
          );

        const pdfBuffer =
          await buildRelbaseDteLetterPdfBuffer({
            taxDocumentId,
            localDocument:
              local,
            printPayload:
              printResult?.data ??
              null,
          });

        const safeFolio =
          String(
            local.folio ||
            relbaseDocumentId
          )
            .replace(
              /[^0-9A-Za-z_-]/g,
              ""
            ) ||
          "dte";

        res.setHeader(
          "Content-Type",
          "application/pdf"
        );

        res.setHeader(
          "Content-Disposition",
          `inline; filename="factura-${safeFolio}-a4.pdf"`
        );

        res.setHeader(
          "Cache-Control",
          "private, no-store, max-age=0"
        );

        res.setHeader(
          "X-Laminatiword-DTE-Format",
          "A4"
        );

        return res
          .status(200)
          .send(
            pdfBuffer
          );
      }

      /*
       * Camino rápido del formato original:
       * si la persistencia normal ya dejó pdf_url,
       * no hacemos una llamada extra.
       */
      const localPdfUrl =
        normalizeRelbaseHttpUrl(
          local.pdf_url
        );

      const localPdfUsable =
        isRelbaseHttpUrlUsable(
          localPdfUrl,
          60
        );

      if (localPdfUsable) {
        return res
          .status(200)
          .json({
            success: true,
            message:
              "PDF del documento tributario disponible",
            data: {
              read_only:
                true,
              relbase_get_executed:
                false,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source:
                "LOCAL_PDF_URL",
              document: {
                tax_document_id:
                  local.id,
                order_id:
                  local.order_id,
                document_type:
                  local.document_type,
                status:
                  localStatus,
                relbase_document_id:
                  relbaseDocumentId,
                folio:
                  local.folio ||
                  null,
                track_id:
                  local.track_id ||
                  null,
                sii_status:
                  local.sii_status ||
                  null,
                sii_status_name:
                  local.sii_status_name ||
                  null,
                pdf_url:
                  localPdfUrl,
              },
            },
          });
      }

      const endpoint =
        `/api/v2/dtes/${encodeURIComponent(
          relbaseDocumentId
        )}`;

      const result =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const payload =
        result?.data ??
        null;

      const record =
        resolveRelbaseDteDetailRecord(
          payload
        );

      if (
        !record ||
        typeof record !==
          "object" ||
        Array.isArray(record)
      ) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió con una estructura de detalle DTE no reconocida",
            code:
              "RELBASE_DTE_DETAIL_INVALID",
          });
      }

      const normalized =
        normalizeRelbaseDteRecord(
          record
        );

      if (
        String(
          normalized
            .relbase_document_id ||
          ""
        ) !==
        relbaseDocumentId
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El DTE obtenido desde Relbase no coincide con la identidad externa local",
            code:
              "RELBASE_DTE_ID_CONFLICT",
          });
      }

      if (
        normalized
          .type_document !==
          null &&
        local.sii_code !==
          null &&
        Number(
          normalized
            .type_document
        ) !==
        Number(
          local.sii_code
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El tipo del DTE de Relbase no coincide con el documento tributario local",
            code:
              "RELBASE_DTE_TYPE_MISMATCH",
          });
      }

      if (
        local.folio &&
        normalized.folio &&
        String(
          local.folio
        ) !==
        String(
          normalized.folio
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El folio del DTE de Relbase no coincide con el documento tributario local",
            code:
              "RELBASE_DTE_FOLIO_MISMATCH",
          });
      }

      const pdfUrl =
        normalizeRelbaseHttpUrl(
          normalized.pdf_url
        );

      const refreshedPdfUsable =
        isRelbaseHttpUrlUsable(
          pdfUrl,
          60
        );

      if (
        !pdfUrl ||
        !refreshedPdfUsable
      ) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Relbase todavía no tiene disponible el PDF de este documento",
            code:
              "RELBASE_DTE_PDF_NOT_AVAILABLE",
            data: {
              read_only:
                true,
              relbase_get_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              relbase_document_id:
                relbaseDocumentId,
              local_pdf_url_stale:
                Boolean(
                  localPdfUrl &&
                  !localPdfUsable
                ),
              folio:
                normalized.folio ||
                local.folio ||
                null,
              sii_status:
                normalized.sii_status ||
                local.sii_status ||
                null,
              sii_status_name:
                normalized
                  .sii_status_name ||
                local
                  .sii_status_name ||
                null,
            },
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          message:
            "PDF del documento tributario obtenido correctamente",
          data: {
            read_only:
              true,
            relbase_get_executed:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            source:
              "RELBASE_DTE_DETAIL",
            rate_limit:
              result?.rateLimit ||
              null,
            document: {
              tax_document_id:
                local.id,
              order_id:
                local.order_id,
              document_type:
                local.document_type,
              status:
                localStatus,
              relbase_document_id:
                relbaseDocumentId,
              folio:
                normalized.folio ||
                local.folio ||
                null,
              track_id:
                normalized.track_id ||
                local.track_id ||
                null,
              sii_status:
                normalized.sii_status ||
                local.sii_status ||
                null,
              sii_status_name:
                normalized
                  .sii_status_name ||
                local
                  .sii_status_name ||
                null,
              pdf_url:
                pdfUrl,
            },
          },
        });
    } catch (error) {
      console.error(
        "Error obteniendo PDF DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible obtener el PDF del documento tributario",
          code:
            error.code ||
            "RELBASE_DTE_PDF_ERROR",
        });
    }
  };



/* =========================================
   DATOS DE IMPRESIÓN DTE RELBASE V2

   SOLO LECTURA:
   - Valida el tax_document local.
   - Exige DTE ya emitido/aceptado.
   - Consulta GET /api/v2/dtes/:id/imprimir.
   - Devuelve el contrato oficial de impresión
     de Relbase sin inventar parámetros de formato.
   - NO INSERT.
   - NO UPDATE.
   - NO claim.
   - NO POST.
   - NO emite documentos.

   OBJETIVO:
   Inspeccionar el payload oficial que Relbase
   entrega para impresión y, a partir de ese
   contrato real, implementar Carta/80mm/58mm
   sin depender del pdf_url original.
========================================= */
export const getRelbaseDtePrintData =
  async (req, res) => {
    const taxDocumentId =
      String(
        req.params.taxDocumentId ||
        ""
      ).trim();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !taxDocumentId ||
      !uuidPattern.test(
        taxDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "taxDocumentId no es un UUID válido",
          code:
            "INVALID_TAX_DOCUMENT_ID",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }

    try {
      const localResult =
        await pool.query(
          `
            SELECT
              id,
              order_id,
              document_type,
              sii_code,
              status,
              relbase_document_id,
              folio,
              track_id,
              sii_status,
              sii_status_name
            FROM tax_documents
            WHERE id = $1
            LIMIT 1
          `,
          [
            taxDocumentId,
          ]
        );

      if (
        localResult.rowCount ===
        0
      ) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "El documento tributario local no existe",
            code:
              "TAX_DOCUMENT_NOT_FOUND",
            data: {
              read_only:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
            },
          });
      }

      const local =
        localResult.rows[0];

      const localStatus =
        String(
          local.status ||
          ""
        )
          .trim()
          .toUpperCase();

      if (
        ![
          "ISSUED",
          "ACCEPTED",
        ].includes(
          localStatus
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El documento todavía no se encuentra emitido y disponible para impresión",
            code:
              "TAX_DOCUMENT_NOT_PRINTABLE",
            data: {
              read_only:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              tax_document_id:
                taxDocumentId,
              status:
                localStatus ||
                null,
            },
          });
      }

      const relbaseDocumentId =
        String(
          local.relbase_document_id ||
          ""
        ).trim();

      if (
        !relbaseDocumentId ||
        !/^\d+$/.test(
          relbaseDocumentId
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El documento emitido no posee un relbase_document_id válido",
            code:
              "RELBASE_DTE_ID_MISSING",
            data: {
              read_only:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
            },
          });
      }

      const endpoint =
        `/api/v2/dtes/${encodeURIComponent(
          relbaseDocumentId
        )}/imprimir`;

      const result =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const printPayload =
        result?.data ??
        null;

      if (
        printPayload ===
          null ||
        printPayload ===
          undefined
      ) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió sin datos de impresión para el DTE",
            code:
              "RELBASE_DTE_PRINT_DATA_EMPTY",
            data: {
              read_only:
                true,
              relbase_get_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              endpoint:
                `GET ${endpoint}`,
              relbase_document_id:
                relbaseDocumentId,
            },
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Datos oficiales de impresión DTE obtenidos desde Relbase",
          data: {
            read_only:
              true,
            relbase_get_executed:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            source: {
              endpoint:
                `GET ${endpoint}`,
              api_version:
                "v2",
              auth_mode:
                "OAUTH_BEARER",
              rate_limit:
                result?.rateLimit ||
                null,
            },
            document: {
              tax_document_id:
                local.id,
              order_id:
                local.order_id,
              document_type:
                local.document_type,
              status:
                localStatus,
              relbase_document_id:
                relbaseDocumentId,
              folio:
                local.folio ||
                null,
              track_id:
                local.track_id ||
                null,
              sii_status:
                local.sii_status ||
                null,
              sii_status_name:
                local.sii_status_name ||
                null,
            },
            print_payload:
              printPayload,
          },
        });
    } catch (error) {
      console.error(
        "Error obteniendo datos de impresión DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
          data:
            error.relbaseData ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible obtener los datos de impresión del DTE",
          code:
            error.code ||
            "RELBASE_DTE_PRINT_DATA_ERROR",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }
  };



/* =========================================
   PREVIEW NOTAS DE CRÉDITO RELBASE V2

   SOLO LECTURA:
   - GET /api/v2/dtes?type_document=61&page=N
   - NO INSERT.
   - NO UPDATE.
   - NO claim.
   - NO POST.
   - NO emite documentos.

   OBJETIVO:
   Localizar la Nota de Crédito que anuló un
   DTE previo antes de permitir una reemisión.
========================================= */
export const previewRelbaseCreditNotes =
  async (req, res) => {
    const page =
      Number(
        req.query.page ||
        1
      );

    if (
      !Number.isInteger(page) ||
      page < 1
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "page debe ser un entero mayor o igual a 1",
          code:
            "INVALID_RELBASE_CREDIT_NOTE_PAGE",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }

    const endpoint =
      `/api/v2/dtes?type_document=61&page=${encodeURIComponent(
        page
      )}`;

    try {
      const result =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const payload =
        result?.data ??
        null;

      const records =
        payload?.data?.dtes;

      if (!Array.isArray(records)) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió con una estructura de listado de Notas de Crédito no reconocida",
            code:
              "RELBASE_CREDIT_NOTE_LIST_INVALID",
            data: {
              read_only:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source: {
                endpoint:
                  `GET ${endpoint}`,
                api_version:
                  "v2",
                auth_mode:
                  "OAUTH_BEARER",
              },
              response_shape: {
                top_level_keys:
                  payload &&
                  typeof payload ===
                    "object" &&
                  !Array.isArray(payload)
                    ? Object.keys(payload)
                        .slice(0, 50)
                    : [],
                data_keys:
                  payload?.data &&
                  typeof payload.data ===
                    "object" &&
                  !Array.isArray(
                    payload.data
                  )
                    ? Object.keys(
                        payload.data
                      ).slice(0, 50)
                    : [],
              },
            },
          });
      }

      const creditNotes =
        records.map(
          (record) => ({
            ...buildSafeRelbaseDteDetail(
              record
            ),
            relation_hints:
              collectRelbaseRelationHints(
                record,
                {
                  path:
                    "record",
                }
              ),
          })
        );

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Preview de Notas de Crédito Relbase generado correctamente",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            raw_records_exposed:
              false,

            source: {
              endpoint:
                `GET ${endpoint}`,
              api_version:
                "v2",
              auth_mode:
                "OAUTH_BEARER",
              type_document:
                61,
              rate_limit:
                result?.rateLimit ||
                null,
            },

            response_shape: {
              first_record_keys:
                records[0] &&
                typeof records[0] ===
                  "object" &&
                !Array.isArray(
                  records[0]
                )
                  ? Object.keys(
                      records[0]
                    ).slice(0, 100)
                  : [],
            },

            pagination: {
              current_page:
                payload?.meta
                  ?.current_page ??
                page,
              next_page:
                payload?.meta
                  ?.next_page ??
                null,
              total_pages:
                payload?.meta
                  ?.total_pages ??
                null,
              total_count:
                payload?.meta
                  ?.total_count ??
                null,
              records_on_page:
                records.length,
            },

            credit_notes:
              creditNotes,
          },
        });
    } catch (error) {
      console.error(
        "Error consultando Notas de Crédito Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible consultar las Notas de Crédito en Relbase",
          code:
            error.code ||
            "RELBASE_CREDIT_NOTE_PREVIEW_ERROR",
          data: {
            read_only:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            endpoint:
              `GET ${endpoint}`,
          },
        });
    }
  };

/* =========================================*

*   CLAIM EMISIÓN DTE LAMINATIWORD*

*   PASO 84.5.6*

*   IMPORTANTE:*

*   - NO llama a Relbase.*

*   - NO emite boleta/factura.*

*   - NO hace POST externo.*

*   - Sólo reclama atómicamente el documento:*

*       PENDING -> PROCESSING*

*   Esto permite validar desde HTTP la barrera*

*   anti-doble-emisión antes de integrar el*

*   POST real de Relbase.*

*========================================= */

export const claimRelbaseDteEmission =

  async (req, res) => {

    try {

      const taxDocumentId =

        String(

          req.params.taxDocumentId ||

          ""

        ).trim();

      const uuidPattern =

        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (

        !taxDocumentId ||

        !uuidPattern.test(

          taxDocumentId

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "taxDocumentId no es un UUID válido",

            code:

              "INVALID_TAX_DOCUMENT_ID",

          });

      }

      const result =

        await claimTaxDocumentForEmission({

          taxDocumentId,

          issuedBy:

            req.user?.id ||

            null,

        });

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Documento tributario reservado correctamente para emisión",

          data: {

            claim_executed:

              true,

            emission_executed:

              false,

            relbase_request_executed:

              false,

            claim:

              result,

          },

        });

    } catch (error) {

      console.error(

        "Error reclamando documento tributario para emisión:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible reservar el documento tributario para emisión",

          code:

            error.code ||

            null,

          data: {

            claim_executed:

              false,

            emission_executed:

              false,

            relbase_request_executed:

              false,

          },

        });

    }

  };



/* =========================================*

*   SIMULAR ERROR DE EMISIÓN DTE*

*   PASO 84.5.7.1*

*   SOLO PARA PRUEBAS NO PRODUCTIVAS:*

*   - NO llama a Relbase.*

*   - NO emite boleta/factura.*

*   - NO hace POST externo.*

*   - Sólo valida:*

*       PROCESSING -> ERROR*

*   En producción este endpoint queda bloqueado.*

*========================================= */

export const simulateRelbaseDteEmissionError =

  async (req, res) => {

    try {

      if (

        String(

          process.env.NODE_ENV ||

          "development"

        )

          .trim()

          .toLowerCase() ===

        "production"

      ) {

        return res

          .status(404)

          .json({

            success: false,

            message:

              "Ruta no disponible",

            code:

              "ROUTE_NOT_AVAILABLE",

          });

      }

      const taxDocumentId =

        String(

          req.params.taxDocumentId ||

          ""

        ).trim();

      const uuidPattern =

        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (

        !taxDocumentId ||

        !uuidPattern.test(

          taxDocumentId

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "taxDocumentId no es un UUID válido",

            code:

              "INVALID_TAX_DOCUMENT_ID",

          });

      }

      const result =

        await markTaxDocumentEmissionError({

          taxDocumentId,

          errorCode:

            "SIMULATED_RELBASE_ERROR",

          errorMessage:

            "Error simulado de emisión Relbase para validar la transición PROCESSING -> ERROR",

        });

      return res

        .status(200)

        .json({

          success: true,

          message:

            result.already_error

              ? "El documento ya se encontraba en ERROR"

              : "Error de emisión simulado y registrado correctamente",

          data: {

            simulation_executed:

              true,

            emission_executed:

              false,

            relbase_request_executed:

              false,

            result,

          },

        });

    } catch (error) {

      console.error(

        "Error simulando fallo de emisión DTE:",

        {

          message:

            error.message,

          status:

            error.status || null,

          code:

            error.code || null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible registrar el error simulado de emisión",

          code:

            error.code ||

            null,

          data: {

            simulation_executed:

              false,

            emission_executed:

              false,

            relbase_request_executed:

              false,

          },

        });

    }

  };



/* =========================================*

*   RESET ERROR SIMULADO DTE*

*   PASO 84.5.8*

*   Sólo fuera de producción.*

*   NO llama a Relbase.*

*   NO emite documentos.*

*========================================= */

export const resetSimulatedRelbaseDteEmissionError =

  async (req, res) => {

    try {

      if (

        String(

          process.env.NODE_ENV ||

          "development"

        )

          .trim()

          .toLowerCase() ===

        "production"

      ) {

        return res

          .status(404)

          .json({

            success: false,

            message:

              "Ruta no disponible",

            code:

              "ROUTE_NOT_AVAILABLE",

          });

      }

      const taxDocumentId =

        String(

          req.params.taxDocumentId ||

          ""

        ).trim();

      const uuidPattern =

        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (

        !taxDocumentId ||

        !uuidPattern.test(

          taxDocumentId

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            message:

              "taxDocumentId no es un UUID válido",

            code:

              "INVALID_TAX_DOCUMENT_ID",

          });

      }

      const result =

        await resetSimulatedTaxDocumentEmissionError({

          taxDocumentId,

        });

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Documento de prueba reiniciado correctamente a PENDING",

          data: {

            reset_executed:

              true,

            emission_executed:

              false,

            relbase_request_executed:

              false,

            result,

          },

        });

    } catch (error) {

      console.error(

        "Error reiniciando fallo simulado DTE:",

        {

          message:

            error.message,

          status:

            error.status || null,

          code:

            error.code || null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success: false,

          message:

            error.message ||

            "No fue posible reiniciar el documento tributario",

          code:

            error.code ||

            null,

          data: {

            reset_executed:

              false,

            emission_executed:

              false,

            relbase_request_executed:

              false,

          },

        });

    }

  };



/* =========================================*

*   PREVIEW RECONCILIACIÓN PRE-EMISIÓN DTE*

*   PASO 84.5.9*

*   SOLO LECTURA:*

*   - Consulta Relbase por GET.*

*   - Busca el marcador único de la orden.*

*   - NO persiste.*

*   - NO emite.*

*========================================= */

export const previewRelbaseDteReconciliation =

  async (req, res) => {

    try {

      const taxDocumentId =

        String(

          req.params.taxDocumentId ||

          ""

        ).trim();

      const uuidPattern =

        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (

        !taxDocumentId ||

        !uuidPattern.test(

          taxDocumentId

        )

      ) {

        return res

          .status(400)

          .json({

            success:

              false,

            message:

              "taxDocumentId no es un UUID válido",

            code:

              "INVALID_TAX_DOCUMENT_ID",

          });

      }

      const maxPages =

        Math.min(

          Math.max(

            Number(

              req.query.max_pages

            ) || 20,

            1

          ),

          500

        );

      const result =

        await previewTaxDocumentRelbaseReconciliation({

          taxDocumentId,

          maxPages,

        });

      return res

        .status(200)

        .json({

          success:

            true,

          message:

            "Preview de reconciliación DTE generado correctamente",

          data: {

            reconciliation_executed:

              true,

            read_only:

              true,

            persistence_executed:

              false,

            emission_executed:

              false,

            relbase_post_executed:

              false,

            reconciliation:

              result,

          },

        });

    } catch (error) {

      console.error(

        "Error preview reconciliación DTE:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success:

            false,

          message:

            error.message ||

            "No fue posible generar la reconciliación DTE",

          code:

            error.code ||

            null,

          data: {

            reconciliation_executed:

              false,

            persistence_executed:

              false,

            emission_executed:

              false,

            relbase_post_executed:

              false,

          },

        });

    }

  };

/* =========================================
   SINCRONIZAR DTE EXISTENTE POR ID CONOCIDO

   FLUJO NORMAL POST-EMISIÓN:
   - Parte desde relbase_document_id ya persistido.
   - Ejecuta UN GET exacto /api/v2/dtes/:id.
   - Valida ID, tipo, folio y marcador de orden.
   - Persiste estados/track/PDF/XML mediante
     persistRelbaseDteResult.
   - NO recorre páginas.
   - NO claim.
   - NO ejecuta POST /api/v2/dtes.
   - NO emite un DTE nuevo.

   IMPORTANTE:
   Si no existe relbase_document_id local, se debe
   usar reconcile-existing, porque ese es el flujo
   conservador para recuperaciones inciertas.
========================================= */
export const syncExistingRelbaseDteStatus =
  async (req, res) => {
    const taxDocumentId =
      String(
        req.params.taxDocumentId ||
        ""
      ).trim();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !taxDocumentId ||
      !uuidPattern.test(
        taxDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "taxDocumentId no es un UUID válido",
          code:
            "INVALID_TAX_DOCUMENT_ID",
          data: {
            sync_executed:
              false,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }

    try {
      const localResult =
        await pool.query(
          `
            SELECT
              td.id,
              td.order_id,
              td.document_type,
              td.sii_code,
              td.status,
              td.relbase_document_id,
              td.folio,
              td.track_id,
              td.sii_status,
              td.sii_status_name,
              td.total_amount,
              o.order_number
            FROM tax_documents td
            INNER JOIN orders o
              ON o.id = td.order_id
            WHERE td.id = $1
            LIMIT 1
          `,
          [
            taxDocumentId,
          ]
        );

      if (
        localResult.rowCount ===
        0
      ) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "El documento tributario local no existe",
            code:
              "TAX_DOCUMENT_NOT_FOUND",
            data: {
              sync_executed:
                false,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
            },
          });
      }

      const local =
        localResult.rows[0];

      const relbaseDocumentId =
        String(
          local.relbase_document_id ||
          ""
        ).trim();

      if (
        !relbaseDocumentId ||
        !/^\d+$/.test(
          relbaseDocumentId
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El documento local no posee un relbase_document_id conocido. Usa reconcile-existing para una recuperación segura.",
            code:
              "RELBASE_DTE_ID_MISSING_USE_RECONCILIATION",
            data: {
              sync_executed:
                false,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              tax_document_id:
                taxDocumentId,
            },
          });
      }

      const endpoint =
        `/api/v2/dtes/${encodeURIComponent(
          relbaseDocumentId
        )}`;

      const detailResult =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const payload =
        detailResult?.data ??
        null;

      const record =
        resolveRelbaseDteDetailRecord(
          payload
        );

      if (
        !record ||
        typeof record !==
          "object" ||
        Array.isArray(record)
      ) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió con una estructura de detalle DTE no reconocida",
            code:
              "RELBASE_DTE_DETAIL_INVALID",
            data: {
              sync_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source: {
                endpoint:
                  `GET ${endpoint}`,
              },
            },
          });
      }

      const normalized =
        normalizeRelbaseDteRecord(
          record
        );

      if (
        String(
          normalized.relbase_document_id ||
          ""
        ) !==
        relbaseDocumentId
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El DTE obtenido desde Relbase no coincide con la identidad externa local",
            code:
              "RELBASE_DTE_ID_CONFLICT",
            data: {
              sync_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
            },
          });
      }

      if (
        normalized.type_document !==
          null &&
        local.sii_code !==
          null &&
        Number(
          normalized.type_document
        ) !==
        Number(
          local.sii_code
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El tipo del DTE de Relbase no coincide con el documento tributario local",
            code:
              "RELBASE_DTE_TYPE_MISMATCH",
          });
      }

      if (
        local.folio &&
        normalized.folio &&
        String(
          local.folio
        ) !==
        String(
          normalized.folio
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El folio del DTE de Relbase no coincide con el documento tributario local",
            code:
              "RELBASE_DTE_FOLIO_MISMATCH",
          });
      }

      const expectedMarker =
        `Laminatiword ${String(
          local.order_number ||
          ""
        ).trim()}`;

      const detailMarkers =
        [
          record.comment,
          record.label_value,
        ]
          .map(
            (value) =>
              String(
                value ||
                ""
              ).trim()
          )
          .filter(Boolean);

      if (
        expectedMarker &&
        !detailMarkers.includes(
          expectedMarker
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El DTE externo no conserva el marcador único esperado de la orden",
            code:
              "RELBASE_DTE_MARKER_MISMATCH",
            data: {
              expected_marker:
                expectedMarker,
              relbase_document_id:
                relbaseDocumentId,
            },
          });
      }

      const persisted =
        await persistRelbaseDteResult({
          taxDocumentId,
          relbaseDte:
            record,
          issuedBy:
            req.user?.id ||
            null,
        });

      const taxDocument =
        persisted?.tax_document ||
        null;

      let emailArtifacts =
        null;

      let emailArtifactsError =
        null;

      if (
        String(
          taxDocument?.status ||
          ""
        )
          .trim()
          .toUpperCase() ===
        "ACCEPTED"
      ) {
        try {
          emailArtifacts =
            await ensureDteAcceptedEmailArtifacts({
              taxDocumentId,
            });
        } catch (
          notificationError
        ) {
          emailArtifactsError = {
            code:
              notificationError?.code ||
              "DTE_ACCEPTED_EMAIL_ARTIFACTS_ERROR",
            message:
              notificationError?.message ||
              "No fue posible preparar el Email 1",
          };

          console.error(
            "DTE aceptado, pero no fue posible preparar Email 1:",
            emailArtifactsError
          );
        }
      }

      const exposeEmailDebug =
        String(
          process.env.NODE_ENV ||
          "development"
        )
          .trim()
          .toLowerCase() !==
        "production";

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Estado DTE sincronizado correctamente desde Relbase",
          data: {
            sync_executed:
              true,
            sync_mode:
              "DIRECT_EXTERNAL_ID",
            relbase_pages_scanned:
              0,
            relbase_get_executed:
              true,
            persistence_executed:
              true,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            source: {
              endpoint:
                `GET ${endpoint}`,
              api_version:
                "v2",
              auth_mode:
                "OAUTH_BEARER",
              relbase_document_id:
                relbaseDocumentId,
              rate_limit:
                detailResult?.rateLimit ||
                null,
            },
            previous: {
              status:
                local.status ||
                null,
              track_id:
                local.track_id ||
                null,
              sii_status:
                local.sii_status ||
                null,
              sii_status_name:
                local.sii_status_name ||
                null,
            },
            dte: {
              tax_document_id:
                taxDocument?.id ||
                taxDocumentId,
              order_id:
                taxDocument?.order_id ||
                local.order_id,
              order_number:
                local.order_number,
              document_type:
                taxDocument?.document_type ||
                local.document_type,
              relbase_document_id:
                taxDocument?.relbase_document_id ||
                relbaseDocumentId,
              folio:
                taxDocument?.folio ||
                normalized.folio ||
                null,
              track_id:
                taxDocument?.track_id ||
                normalized.track_id ||
                null,
              status:
                taxDocument?.status ||
                null,
              external_status:
                taxDocument?.external_status ||
                null,
              relbase_status:
                taxDocument?.relbase_status ||
                null,
              sii_status:
                taxDocument?.sii_status ||
                null,
              sii_status_name:
                taxDocument?.sii_status_name ||
                null,
              issued_at:
                taxDocument?.issued_at ||
                null,
              last_status_sync_at:
                taxDocument?.last_status_sync_at ||
                null,
              pdf_url_available:
                Boolean(
                  taxDocument?.pdf_url
                ),
              xml_url_available:
                Boolean(
                  taxDocument?.xml_url
                ),
            },
            email_1: {
              eligible:
                String(
                  taxDocument?.status ||
                  ""
                )
                  .trim()
                  .toUpperCase() ===
                "ACCEPTED",
              prepared:
                Boolean(
                  emailArtifacts
                ),
              event_created:
                emailArtifacts
                  ?.event_created ||
                false,
              event_already_exists:
                emailArtifacts
                  ?.event_already_exists ||
                false,
              outbox_id:
                emailArtifacts
                  ?.outbox?.id ||
                null,
              outbox_status:
                emailArtifacts
                  ?.outbox?.status ||
                null,
              document_access_id:
                emailArtifacts
                  ?.document_access?.id ||
                null,
              document_access_expires_at:
                emailArtifacts
                  ?.document_access?.expires_at ||
                null,
              test_pdf_path:
                exposeEmailDebug &&
                emailArtifacts
                  ?.document_access
                  ?.credential
                  ? `/api/checkout/documents/${encodeURIComponent(
                      emailArtifacts.document_access.credential
                    )}/pdf?response=json`
                  : null,
              error:
                emailArtifactsError,
            },
          },
        });
    } catch (error) {
      console.error(
        "Error sincronizando estado DTE Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible sincronizar el estado del DTE desde Relbase",
          code:
            error.code ||
            "RELBASE_DTE_STATUS_SYNC_ERROR",
          data: {
            sync_executed:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }
  };

/* =========================================
   RECONCILIAR DTE EXISTENTE RELBASE

   RECUPERACIÓN SEGURA POST-EMISIÓN:
   - Ejecuta reconciliación por GET.
   - Exige MATCH_FOUND.
   - Obtiene el DTE exacto por GET /api/v2/dtes/:id.
   - Revalida identidad y marcador de la orden.
   - Persiste el DTE ya existente mediante
     persistRelbaseDteResult.
   - NO claim.
   - NO ejecuta POST /api/v2/dtes.
   - NO emite un DTE nuevo.
========================================= */
export const reconcileExistingRelbaseDte =
  async (req, res) => {
    const taxDocumentId =
      String(
        req.params.taxDocumentId ||
        ""
      ).trim();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !taxDocumentId ||
      !uuidPattern.test(
        taxDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message:
            "taxDocumentId no es un UUID válido",
          code:
            "INVALID_TAX_DOCUMENT_ID",
          data: {
            reconciliation_executed:
              false,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }

    const maxPages =
      Math.min(
        Math.max(
          Number(
            req.query.max_pages
          ) || 100,
          1
        ),
        500
      );

    try {
      const reconciliation =
        await previewTaxDocumentRelbaseReconciliation({
          taxDocumentId,
          maxPages,
        });

      const reconciliationStatus =
        String(
          reconciliation
            ?.reconciliation_status ||
          ""
        )
          .trim()
          .toUpperCase();

      const candidate =
        reconciliation
          ?.candidate ||
        null;

      const relbaseDocumentId =
        String(
          candidate
            ?.relbase_document_id ||
          ""
        ).trim();

      if (
        reconciliationStatus !==
          "MATCH_FOUND" ||
        !relbaseDocumentId
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "La reconciliación no encontró un único DTE existente que pueda persistirse de forma segura",
            code:
              "RELBASE_DTE_RECONCILIATION_MATCH_REQUIRED",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              reconciliation,
            },
          });
      }

      if (
        reconciliation?.conflict ||
        reconciliation
          ?.cancellation_pending
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "La reconciliación detectó un conflicto o una anulación pendiente y no se realizará persistencia automática",
            code:
              "RELBASE_DTE_RECONCILIATION_CONFLICT",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              reconciliation,
            },
          });
      }

      if (
        !/^\d+$/.test(
          relbaseDocumentId
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "La reconciliación devolvió un ID de DTE Relbase no válido",
            code:
              "RELBASE_DTE_RECONCILIATION_ID_INVALID",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              reconciliation_status:
                reconciliationStatus,
            },
          });
      }

      const endpoint =
        `/api/v2/dtes/${encodeURIComponent(
          relbaseDocumentId
        )}`;

      const detailResult =
        await relbaseRequest(
          endpoint,
          {
            method:
              "GET",
          }
        );

      const payload =
        detailResult?.data ??
        null;

      const record =
        resolveRelbaseDteDetailRecord(
          payload
        );

      if (
        !record ||
        typeof record !==
          "object" ||
        Array.isArray(
          record
        )
      ) {
        return res
          .status(502)
          .json({
            success: false,
            message:
              "Relbase respondió con una estructura de detalle DTE no reconocida",
            code:
              "RELBASE_DTE_DETAIL_INVALID",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source: {
                endpoint:
                  `GET ${endpoint}`,
              },
            },
          });
      }

      const detailRelbaseId =
        String(
          record.id ||
          ""
        ).trim();

      if (
        !detailRelbaseId ||
        detailRelbaseId !==
          relbaseDocumentId
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El detalle consultado en Relbase no coincide con el DTE encontrado durante la reconciliación",
            code:
              "RELBASE_DTE_RECONCILIATION_ID_MISMATCH",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              candidate_relbase_document_id:
                relbaseDocumentId,
              detail_relbase_document_id:
                detailRelbaseId ||
                null,
            },
          });
      }

      const expectedMarker =
        String(
          reconciliation?.marker ||
          ""
        ).trim();

      /*
       * El listado v2 puede identificar el DTE por:
       *
       * - comment con el marcador técnico Laminatiword; o
       * - label_value con el order_number.
       *
       * En el detalle Relbase puede conservar en comment
       * la observación comercial real de la factura, por lo
       * que exigimos que el detalle mantenga al menos uno de
       * los identificadores que ya produjo MATCH_FOUND.
       *
       * Seguridad adicional:
       * - el relbase_document_id del detalle ya fue validado
       *   contra el candidato inmediatamente arriba;
       * - no aceptamos un label_value arbitrario: debe ser
       *   exactamente el mismo del candidato reconciliado.
       */
      const expectedLabelValue =
        String(
          candidate?.label_value ||
          ""
        ).trim();

      const detailComment =
        String(
          record.comment ||
          ""
        ).trim();

      const detailLabelValue =
        String(
          record.label_value ||
          ""
        ).trim();

      const technicalMarkerMatches =
        Boolean(
          expectedMarker &&
          detailComment ===
            expectedMarker
        );

      const labelValueMatches =
        Boolean(
          expectedLabelValue &&
          detailLabelValue ===
            expectedLabelValue
        );

      const markerMatches =
        technicalMarkerMatches ||
        labelValueMatches;

      if (!markerMatches) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El DTE encontrado no conserva ninguno de los identificadores únicos esperados de la orden",
            code:
              "RELBASE_DTE_RECONCILIATION_MARKER_MISMATCH",
            data: {
              reconciliation_executed:
                true,
              persistence_executed:
                false,
              emission_executed:
                false,
              relbase_post_executed:
                false,
              expected_marker:
                expectedMarker ||
                null,
              expected_label_value:
                expectedLabelValue ||
                null,
              detail_comment:
                detailComment ||
                null,
              detail_label_value:
                detailLabelValue ||
                null,
              relbase_document_id:
                relbaseDocumentId,
            },
          });
      }

      const persisted =
        await persistRelbaseDteResult({
          taxDocumentId,
          relbaseDte:
            record,
          issuedBy:
            req.user?.id ||
            null,
        });

      const taxDocument =
        persisted
          ?.tax_document ||
        null;

      return res
        .status(200)
        .json({
          success: true,
          message:
            "DTE existente de Relbase reconciliado y persistido correctamente en Laminatiword",
          data: {
            reconciliation_executed:
              true,
            persistence_executed:
              true,
            emission_executed:
              false,
            relbase_post_executed:
              false,
            source: {
              endpoint:
                `GET ${endpoint}`,
              api_version:
                "v2",
              auth_mode:
                "OAUTH_BEARER",
              relbase_document_id:
                relbaseDocumentId,
              rate_limit:
                detailResult
                  ?.rateLimit ||
                null,
            },
            reconciliation: {
              reconciliation_status:
                reconciliationStatus,
              marker:
                reconciliation?.marker ||
                null,
              candidate,
            },
            dte: {
              relbase_document_id:
                taxDocument
                  ?.relbase_document_id ||
                relbaseDocumentId,
              folio:
                taxDocument
                  ?.folio ||
                candidate?.folio ||
                null,
              track_id:
                taxDocument
                  ?.track_id ||
                candidate?.track_id ||
                null,
              status:
                taxDocument
                  ?.status ||
                null,
              external_status:
                taxDocument
                  ?.external_status ||
                null,
              relbase_status:
                taxDocument
                  ?.relbase_status ||
                null,
              sii_status:
                taxDocument
                  ?.sii_status ||
                null,
              sii_status_name:
                taxDocument
                  ?.sii_status_name ||
                null,
              issued_at:
                taxDocument
                  ?.issued_at ||
                null,
              pdf_url:
                taxDocument
                  ?.pdf_url ||
                null,
              xml_url:
                taxDocument
                  ?.xml_url ||
                null,
            },
          },
        });
    } catch (error) {
      console.error(
        "Error reconciliando DTE existente Relbase:",
        {
          message:
            error.message,
          status:
            error.status ||
            null,
          code:
            error.code ||
            null,
        }
      );

      const httpStatus =
        Number(
          error.status
        );

      return res
        .status(
          Number.isInteger(
            httpStatus
          ) &&
          httpStatus >= 400 &&
          httpStatus < 500
            ? httpStatus
            : 502
        )
        .json({
          success: false,
          message:
            error.message ||
            "No fue posible reconciliar y persistir el DTE existente de Relbase",
          code:
            error.code ||
            "RELBASE_DTE_RECONCILIATION_PERSIST_ERROR",
          data: {
            reconciliation_executed:
              true,
            persistence_executed:
              false,
            emission_executed:
              false,
            relbase_post_executed:
              false,
          },
        });
    }
  };


/* =========================================*

*   PREFLIGHT COMPLETO EMISIÓN DTE*

*   PASO 84.6.6*

*   Sólo lectura:*

*   - SELECT local.*

*   - GET de reconciliación hacia Relbase.*

*   - NO claim.*

*   - NO persiste.*

*   - NO POST.*

*   - NO emite.*

*========================================= */

export const previewRelbaseDteEmissionPreflight =

  async (req, res) => {

    try {

      const taxDocumentId =

        String(

          req.params.taxDocumentId ||

          ""

        ).trim();

      const uuidPattern =

        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (

        !taxDocumentId ||

        !uuidPattern.test(

          taxDocumentId

        )

      ) {

        return res

          .status(400)

          .json({

            success:

              false,

            message:

              "taxDocumentId no es un UUID válido",

            code:

              "INVALID_TAX_DOCUMENT_ID",

          });

      }

      const maxPages =

        Math.min(

          Math.max(

            Number(

              req.query.max_pages

            ) || 100,

            1

          ),

          500

        );

      const result =

        await previewTaxDocumentRelbaseEmissionPreflight({

          taxDocumentId,

          maxPages,

        });

      return res

        .status(200)

        .json({

          success:

            true,

          message:

            "Preflight DTE Relbase generado correctamente",

          data: {

            preflight_executed:

              true,

            read_only:

              true,

            database_write_executed:

              false,

            claim_executed:

              false,

            emission_executed:

              false,

            relbase_post_executed:

              false,

            preflight:

              result,

          },

        });

    } catch (error) {

      console.error(

        "Error preflight DTE Relbase:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success:

            false,

          message:

            error.message ||

            "No fue posible generar el preflight DTE Relbase",

          code:

            error.code ||

            null,

          data: {

            preflight_executed:

              false,

            database_write_executed:

              false,

            claim_executed:

              false,

            emission_executed:

              false,

            relbase_post_executed:

              false,

          },

        });

    }

  };



/* =========================================*

*   PROBE CONTRATO ESCRITURA DTE V2*

*   PASO 84.6.1*

*   Ejecuta únicamente OPTIONS contra Relbase.*

*   NO envía POST ni body DTE.*

*========================================= */

export const probeRelbaseDteV2WriteContractController =

  async (req, res) => {

    try {

      const result =

        await probeRelbaseDteV2WriteContract();

      return res

        .status(200)

        .json({

          success:

            true,

          message:

            "Probe seguro del contrato de escritura DTE v2 ejecutado",

          data: {

            read_only:

              true,

            emission_executed:

              false,

            relbase_post_executed:

              false,

            probe:

              result,

          },

        });

    } catch (error) {

      console.error(

        "Error probe contrato escritura DTE v2:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success:

            false,

          message:

            error.message ||

            "No fue posible ejecutar el probe del contrato DTE v2",

          code:

            error.code ||

            null,

          data: {

            emission_executed:

              false,

            relbase_post_executed:

              false,

          },

        });

    }

  };

/* =========================================*

*   PROBE CONTROL CORS DTE V2*

*   PASO 84.6.2*

*   Compara OPTIONS del recurso DTE con un*

*   endpoint inexistente. No ejecuta POST.*

*========================================= */

export const probeRelbaseDteV2CorsControlController =

  async (req, res) => {

    try {

      const result =

        await probeRelbaseDteV2CorsControl();

      return res

        .status(200)

        .json({

          success:

            true,

          message:

            "Probe de control CORS DTE v2 ejecutado correctamente",

          data: {

            read_only:

              true,

            emission_executed:

              false,

            relbase_post_executed:

              false,

            probe:

              result,

          },

        });

    } catch (error) {

      console.error(

        "Error probe control CORS DTE v2:",

        {

          message:

            error.message,

          status:

            error.status ||

            null,

          code:

            error.code ||

            null,

        }

      );

      return res

        .status(

          error.status ||

          500

        )

        .json({

          success:

            false,

          message:

            error.message ||

            "No fue posible ejecutar el probe de control CORS DTE v2",

          code:

            error.code ||

            null,

          data: {

            emission_executed:

              false,

            relbase_post_executed:

              false,

          },

        });

    }

  };

/* =========================================
   EMITIR DTE RELBASE

   IMPORTANTE:

   RELBASE_DTE_EMISSION_ENABLED=false
   => DRY RUN
   => NO CLAIM
   => NO POST
   => NO DTE REAL

   RELBASE_DTE_EMISSION_ENABLED=true
   => puede ejecutar emisión real
========================================= */
export const emitRelbaseDteController =
  async (req, res) => {
    try {
      const taxDocumentId =
        String(
          req.params.taxDocumentId ||
          ""
        ).trim();

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (
        !taxDocumentId ||
        !uuidPattern.test(
          taxDocumentId
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "taxDocumentId no es un UUID válido",

            code:
              "INVALID_TAX_DOCUMENT_ID",
          });
      }

      const maxPages =
        Math.min(
          Math.max(
            Number(
              req.query.max_pages
            ) || 100,
            1
          ),
          500
        );

      const result =
        await emitRelbaseDte({
          taxDocumentId,

          issuedBy:
            req.user?.id ||
            null,

          maxPages,
        });

      const emissionExecuted =
        result
          ?.emission_executed ===
        true;

      return res
        .status(
          emissionExecuted
            ? 201
            : 200
        )
        .json({
          success:
            true,

          message:
            emissionExecuted
              ? "DTE emitido correctamente mediante Relbase"
              : "DTE validado correctamente. La emisión real continúa deshabilitada.",

          data:
            result,
        });
    } catch (error) {
      console.error(
        "Error en emisión DTE Relbase:",
        {
          message:
            error.message,

          status:
            error.status ||
            null,

          code:
            error.code ||
            null,
        }
      );

      return res
        .status(
          error.status ||
          500
        )
        .json({
          success:
            false,

          message:
            error.message ||
            "No fue posible procesar la emisión DTE",

          code:
            error.code ||
            null,

          details:
            error.details ||
            null,
        });
    }
  };

