import {
  getQuotationTracking,
} from "../services/quotationTracking.service.js";

import {
  cancelQuotation,
  convertQuotationToSale,
  createProjectQuotation,
  createQuotation,
  deleteQuotation,
  emailQuotation,
  getQuotationById,
  getQuotationPdf,
  listQuotations,
  updateProjectQuotation,
  updateQuotation,
} from "../services/quotation.service.js";

const sendError = (res, error) =>
  res.status(Number(error?.status) || 500).json({
    success: false,
    message:
      error?.message ||
      "No fue posible procesar la cotización",
    code: error?.code || "QUOTATION_INTERNAL_ERROR",
  });

export const createQuotationController = async (
  req,
  res
) => {
  try {
    const result = await createQuotation({
      createdBy: req.user.id,
      body: req.body,
    });

    return res.status(201).json({
      success: true,
      message: "Cotización creada correctamente",
      data: result,
    });
  } catch (error) {
    console.error("Error creando cotización:", {
      message: error?.message,
      code: error?.code || null,
      status: error?.status || null,
    });
    return sendError(res, error);
  }
};




export const createProjectQuotationController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await createProjectQuotation({
          createdBy:
            req.user.id,
          body:
            req.body,
        });

      return res
        .status(201)
        .json({
          success:
            true,
          message:
            "Cotización de proyecto creada correctamente",
          data:
            result,
        });
    } catch (
      error
    ) {
      console.error(
        "Error creando cotización de proyecto:",
        {
          message:
            error?.message,
          code:
            error?.code ||
            null,
          status:
            error?.status ||
            null,
        }
      );

      return sendError(
        res,
        error
      );
    }
  };


export const updateProjectQuotationController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await updateProjectQuotation({
          quotationId:
            req.params
              .quotationId,
          body:
            req.body,
        });

      return res
        .status(200)
        .json({
          success:
            true,
          message:
            "Cotización de proyecto actualizada correctamente",
          data:
            result,
        });
    } catch (
      error
    ) {
      console.error(
        "Error actualizando cotización de proyecto:",
        {
          message:
            error?.message,
          code:
            error?.code ||
            null,
          status:
            error?.status ||
            null,
        }
      );

      return sendError(
        res,
        error
      );
    }
  };


export const updateQuotationController = async (
  req,
  res
) => {
  try {
    const result = await updateQuotation({
      quotationId: req.params.quotationId,
      body: req.body,
    });

    return res.status(200).json({
      success: true,
      message: "Cotización actualizada correctamente",
      data: result,
    });
  } catch (error) {
    console.error("Error actualizando cotización:", {
      message: error?.message,
      code: error?.code || null,
      status: error?.status || null,
    });

    return sendError(res, error);
  }
};


export const listQuotationsController = async (
  req,
  res
) => {
  try {
    const result = await listQuotations({
      query: req.query,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getQuotationController = async (
  req,
  res
) => {
  try {
    const result = await getQuotationById({
      quotationId: req.params.quotationId,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getQuotationPdfController = async (
  req,
  res
) => {
  try {
    const result = await getQuotationPdf({
      quotationId: req.params.quotationId,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${result.filename}"`
    );
    res.setHeader("Cache-Control", "private, no-store");

    return res.status(200).send(result.buffer);
  } catch (error) {
    return sendError(res, error);
  }
};

export const emailQuotationController = async (
  req,
  res
) => {
  try {
    const result = await emailQuotation({
      quotationId: req.params.quotationId,
    });

    return res.status(200).json({
      success: true,
      message: "Cotización enviada por correo correctamente",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getQuotationTrackingController = async (
  req,
  res
) => {
  try {
    const result =
      await getQuotationTracking({
        quotationId:
          req.params.quotationId,
      });

    return res
      .status(200)
      .json({
        success: true,
        data: result,
      });
  } catch (error) {
    console.error(
      "Error obteniendo tracking de cotización:",
      {
        message:
          error?.message,
        code:
          error?.code ||
          null,
        status:
          error?.status ||
          null,
      }
    );

    return sendError(
      res,
      error
    );
  }
};


export const deleteQuotationController = async (
  req,
  res
) => {
  try {
    const result = await deleteQuotation({
      quotationId: req.params.quotationId,
    });

    return res.status(200).json({
      success: true,
      message: "Cotización eliminada correctamente",
      data: result,
    });
  } catch (error) {
    console.error("Error eliminando cotización:", {
      message: error?.message,
      code: error?.code || null,
      status: error?.status || null,
    });
    return sendError(res, error);
  }
};

export const cancelQuotationController = async (
  req,
  res
) => {
  try {
    const result = await cancelQuotation({
      quotationId: req.params.quotationId,
    });

    return res.status(200).json({
      success: true,
      message: "Cotización cancelada correctamente",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const convertQuotationController = async (
  req,
  res
) => {
  try {
    const result = await convertQuotationToSale({
      quotationId: req.params.quotationId,
      cashierUserId: req.user.id,
      body: req.body,
    });

    return res.status(result.converted ? 201 : 200).json({
      success: true,
      message: result.converted
        ? "Cotización convertida en venta correctamente"
        : "La cotización ya había sido convertida",
      data: result,
    });
  } catch (error) {
    console.error("Error convirtiendo cotización:", {
      message: error?.message,
      code: error?.code || null,
      status: error?.status || null,
    });
    return sendError(res, error);
  }
};
