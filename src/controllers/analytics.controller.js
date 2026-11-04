import {
  createAnalyticsEvent,
  getAnalyticsOverview,
  getAnalyticsProducts,
  getAnalyticsCollections,
  getAnalyticsLocations,
  getAnalyticsSearches,
  getAnalyticsSources,
  getAnalyticsDevices,
} from "../services/analytics.service.js";

export const createAnalyticsEventController = async (req, res, next) => {
  try {
    const result = await createAnalyticsEvent(req.body);

    return res.status(201).json({
      success: true,
      message: "Evento de analytics registrado correctamente",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsOverviewController = async (req, res, next) => {
  try {
    const data = await getAnalyticsOverview({
      days: req.query.days,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsProductsController = async (req, res, next) => {
  try {
    const data = await getAnalyticsProducts({
      days: req.query.days,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsCollectionsController = async (req, res, next) => {
  try {
    const data = await getAnalyticsCollections({
      days: req.query.days,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsLocationsController = async (req, res, next) => {
  try {
    const data = await getAnalyticsLocations({
      days: req.query.days,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsSearchesController = async (req, res, next) => {
  try {
    const data = await getAnalyticsSearches({
      days: req.query.days,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsSourcesController = async (req, res, next) => {
  try {
    const data = await getAnalyticsSources({
      days: req.query.days,
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

export const getAnalyticsDevicesController = async (req, res, next) => {
  try {
    const data = await getAnalyticsDevices({
      days: req.query.days,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
};
