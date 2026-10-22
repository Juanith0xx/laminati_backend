import {
  createPosSale,
  getPosSaleByOrderId,
  listPosProducts,
  listProjectQuotationProducts,
  ensurePosInvoiceCustomer,
} from "../services/pos.service.js";

import {
  enqueueTaxDocumentEmissionJob,
  processTaxDocumentEmissionJobByOrderId,
  startTaxDocumentEmissionQueueWorker,
} from "../services/taxDocumentEmissionQueue.service.js";


startTaxDocumentEmissionQueueWorker();

const sendServiceError = (res, error) => {
  const status =
    Number(error?.status) || 500;

  return res.status(status).json({
    success: false,
    message:
      error?.message ||
      "No fue posible procesar la operación POS",
    code:
      error?.code ||
      "POS_INTERNAL_ERROR",
  });
};


export const listPosProductsController =
  async (req, res) => {
    try {
      const result = await listPosProducts({
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Error obteniendo catálogo POS:",
        {
          message: error?.message,
          code: error?.code || null,
          status: error?.status || null,
        }
      );

      return sendServiceError(
        res,
        error
      );
    }
  };

export const listProjectQuotationProductsController =
  async (req, res) => {
    try {
      const result =
        await listProjectQuotationProducts({
          query: req.query,
        });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Error obteniendo catálogo de cotización PROJECT:",
        {
          message: error?.message,
          code: error?.code || null,
          status: error?.status || null,
        }
      );

      return sendServiceError(
        res,
        error
      );
    }
  };

export const ensurePosInvoiceCustomerController =
  async (req, res) => {
    try {
      const result =
        await ensurePosInvoiceCustomer({
          body: req.body,
        });

      return res.status(
        result.created ? 201 : 200
      ).json({
        success: true,
        message: result.created
          ? "Cliente empresa creado y verificado correctamente en Relbase"
          : "Cliente empresa encontrado y verificado correctamente en Relbase",
        data: result,
      });
    } catch (error) {
      console.error(
        "Error asegurando cliente Factura POS:",
        {
          message: error?.message,
          code: error?.code || null,
          status: error?.status || null,
        }
      );

      return sendServiceError(
        res,
        error
      );
    }
  };

export const createPosSaleController =
  async (req, res) => {
    try {
      const result = await createPosSale({
        cashierUserId: req.user.id,
        body: req.body,
      });

      let dteEmission =
        null;

      try {
        const queued =
          await enqueueTaxDocumentEmissionJob({
            orderId:
              result?.order?.id,
            requestedBy:
              req.user?.id ||
              null,
          });

        const queueStatus =
          String(
            queued?.job?.status ||
            ""
          ).toUpperCase();

        dteEmission = {
          status:
            queueStatus ||
            null,
          queued:
            [
              "QUEUED",
              "PROCESSING",
            ].includes(
              queueStatus
            ),
          completed:
            queueStatus ===
            "COMPLETED",
          created:
            queued?.created ===
            true,
          job:
            queued?.job ||
            null,
        };

        if (
          queued?.job?.status ===
          "QUEUED"
        ) {
          setImmediate(
            () => {
              void processTaxDocumentEmissionJobByOrderId({
                orderId:
                  result.order.id,
              }).catch(
                (
                  asyncEmissionError
                ) => {
                  console.error(
                    "No fue posible iniciar la emisión DTE asíncrona:",
                    {
                      order_id:
                        result.order.id,
                      message:
                        asyncEmissionError?.message ||
                        null,
                      code:
                        asyncEmissionError?.code ||
                        null,
                    }
                  );
                }
              );
            }
          );
        }
      } catch (
        queueError
      ) {
        console.error(
          "La venta fue creada, pero no fue posible encolar la emisión DTE:",
          {
            order_id:
              result?.order?.id ||
              null,
            message:
              queueError?.message ||
              null,
            code:
              queueError?.code ||
              null,
          }
        );

        dteEmission = {
          queued: false,
          created: false,
          job: null,
          error: {
            message:
              queueError?.message ||
              "No fue posible encolar la emisión tributaria",
            code:
              queueError?.code ||
              "DTE_EMISSION_QUEUE_ERROR",
          },
        };
      }

      return res
        .status(result.created ? 201 : 200)
        .json({
          success: true,
          message: result.created
            ? "Venta POS registrada correctamente"
            : "La venta POS ya había sido registrada",
          data: {
            ...result,
            dte_emission:
              dteEmission,
          },
        });
    } catch (error) {
      console.error(
        "Error creando venta POS:",
        {
          message: error?.message,
          code: error?.code || null,
          status: error?.status || null,
        }
      );

      return sendServiceError(
        res,
        error
      );
    }
  };

export const getPosSaleController =
  async (req, res) => {
    try {
      const result =
        await getPosSaleByOrderId({
          orderId: req.params.orderId,
        });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error
      );
    }
  };
