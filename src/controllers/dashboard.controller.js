import {
  getSalesDashboard,
  resolveDashboardFilters,
  getDashboardFilterOptions,
} from "../services/dashboard.service.js";

export const getAdminSalesDashboard = async (req, res) => {
  try {
    const filters = resolveDashboardFilters(req.query || {});
    const dashboard = await getSalesDashboard(filters);
    return res.status(200).json({ success: true, ...dashboard });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({
        success: false,
        code: error.code || "DASHBOARD_INVALID_FILTERS",
        message: error.message,
      });
    }
    console.error("No fue posible cargar el dashboard comercial:", {
      message: error?.message || "error desconocido",
      code: error?.code || null,
    });
    return res.status(500).json({
      success: false,
      message: "No fue posible consultar el dashboard comercial",
    });
  }
};

export const getAdminDashboardFilterOptions = async (_req, res) => {
  try {
    const options = await getDashboardFilterOptions();
    return res.status(200).json({ success: true, ...options });
  } catch (error) {
    console.error("No fue posible cargar filtros comerciales:", {
      message: error?.message || "error desconocido",
    });
    return res.status(500).json({
      success: false,
      message: "No fue posible cargar las colecciones y segmentos",
    });
  }
};
