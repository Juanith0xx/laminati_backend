import {
  createAccountAddress,
  createAccountDocumentAccess,
  deleteAccountAddress,
  getAccountMe,
  getAccountOrder,
  listAccountAddresses,
  listAccountCompanies,
  listAccountDocuments,
  listAccountExclusiveProducts,
  listAccountOrders,
  updateAccountAddress,
  updateAccountCompany,
  updateAccountProfile,
} from "../services/account.service.js";

import {
  createAddressSchema,
  updateAccountProfileSchema,
  updateAddressSchema,
  updateCompanySchema,
} from "../validators/account.validator.js";

const sendServiceError = (
  res,
  error,
  fallbackMessage
) => {
  const status = Number(error?.status) || 500;

  return res.status(status).json({
    success: false,
    message:
      error?.message || fallbackMessage,
    code:
      error?.code || "ACCOUNT_INTERNAL_ERROR",
  });
};

const sendValidationError = (
  res,
  validation,
  message
) => {
  return res.status(400).json({
    success: false,
    message,
    errors: validation.error.issues,
  });
};

export const getAccountMeController =
  async (req, res) => {
    try {
      const user = await getAccountMe({
        userId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener la cuenta"
      );
    }
  };

export const updateAccountProfileController =
  async (req, res) => {
    const validation =
      updateAccountProfileSchema.safeParse(req.body);

    if (!validation.success) {
      return sendValidationError(
        res,
        validation,
        "Datos de perfil inválidos"
      );
    }

    try {
      const profile = await updateAccountProfile({
        userId: req.user.id,
        data: validation.data,
      });

      const user = await getAccountMe({
        userId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        message: "Perfil actualizado correctamente",
        data: {
          profile,
          user,
        },
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible actualizar el perfil"
      );
    }
  };

export const listAccountAddressesController =
  async (req, res) => {
    try {
      const addresses = await listAccountAddresses({
        userId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        addresses,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener las direcciones"
      );
    }
  };

export const createAccountAddressController =
  async (req, res) => {
    const validation =
      createAddressSchema.safeParse(req.body);

    if (!validation.success) {
      return sendValidationError(
        res,
        validation,
        "Datos de dirección inválidos"
      );
    }

    try {
      const address = await createAccountAddress({
        userId: req.user.id,
        data: validation.data,
      });

      return res.status(201).json({
        success: true,
        message: "Dirección creada correctamente",
        data: address,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible crear la dirección"
      );
    }
  };

export const updateAccountAddressController =
  async (req, res) => {
    const validation =
      updateAddressSchema.safeParse(req.body);

    if (!validation.success) {
      return sendValidationError(
        res,
        validation,
        "Datos de dirección inválidos"
      );
    }

    try {
      const address = await updateAccountAddress({
        userId: req.user.id,
        addressId: req.params.addressId,
        data: validation.data,
      });

      return res.status(200).json({
        success: true,
        message: "Dirección actualizada correctamente",
        data: address,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible actualizar la dirección"
      );
    }
  };

export const deleteAccountAddressController =
  async (req, res) => {
    try {
      const result = await deleteAccountAddress({
        userId: req.user.id,
        addressId: req.params.addressId,
      });

      return res.status(200).json({
        success: true,
        message: "Dirección eliminada correctamente",
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible eliminar la dirección"
      );
    }
  };

export const listAccountCompaniesController =
  async (req, res) => {
    try {
      const companies = await listAccountCompanies({
        userId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        companies,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener las empresas"
      );
    }
  };

export const updateAccountCompanyController =
  async (req, res) => {
    const validation =
      updateCompanySchema.safeParse(req.body);

    if (!validation.success) {
      return sendValidationError(
        res,
        validation,
        "Datos de empresa inválidos"
      );
    }

    try {
      const result = await updateAccountCompany({
        userId: req.user.id,
        companyId: req.params.companyId,
        data: validation.data,
      });

      return res.status(200).json({
        success: true,
        message: "Empresa actualizada correctamente",
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible actualizar la empresa"
      );
    }
  };

export const listAccountOrdersController =
  async (req, res) => {
    try {
      const result = await listAccountOrders({
        userId: req.user.id,
        role: req.user.role,
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener los pedidos"
      );
    }
  };

export const getAccountOrderController =
  async (req, res) => {
    try {
      const result = await getAccountOrder({
        userId: req.user.id,
        role: req.user.role,
        orderId: req.params.orderId,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener el pedido"
      );
    }
  };



export const listAccountExclusiveProductsController =
  async (req, res) => {
    try {
      const result = await listAccountExclusiveProducts({
        userId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener tus productos exclusivos"
      );
    }
  };

export const listAccountDocumentsController =
  async (req, res) => {
    try {
      const result = await listAccountDocuments({
        userId: req.user.id,
        role: req.user.role,
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener los documentos"
      );
    }
  };

export const createAccountDocumentAccessController =
  async (req, res) => {
    try {
      const result = await createAccountDocumentAccess({
        userId: req.user.id,
        role: req.user.role,
        taxDocumentId: req.params.taxDocumentId,
      });

      return res.status(200).json({
        success: true,
        message: "Acceso al documento disponible",
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible habilitar el documento"
      );
    }
  };
