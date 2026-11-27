import {
  getMailingSummary,
  listMailingContacts,
  createMailingContact,
  updateMailingContact,
  listMailingSegments,
  createMailingSegment,
  listMailingTemplates,
  createMailingTemplate,
  listMailingCampaigns,
  createMailingCampaign,
  listMailingSuppressions,
  createMailingSuppression,
} from "../services/mailing.service.js";

const respondError = (res, error) => res.status(error?.status || 500).json({
  success: false,
  message: error?.message || "Error interno del módulo Mailing",
  code: error?.code || "MAILING_INTERNAL_ERROR",
});

export const getMailingSummaryController = async (_req, res) => {
  try { return res.json({ success: true, summary: await getMailingSummary() }); }
  catch (error) { return respondError(res, error); }
};

export const listMailingContactsController = async (req, res) => {
  try { return res.json({ success: true, contacts: await listMailingContacts(req.query) }); }
  catch (error) { return respondError(res, error); }
};
export const createMailingContactController = async (req, res) => {
  try { return res.status(201).json({ success: true, contact: await createMailingContact(req.body) }); }
  catch (error) { return respondError(res, error); }
};
export const updateMailingContactController = async (req, res) => {
  try { return res.json({ success: true, contact: await updateMailingContact(req.params.contactId, req.body) }); }
  catch (error) { return respondError(res, error); }
};

export const listMailingSegmentsController = async (_req, res) => {
  try { return res.json({ success: true, segments: await listMailingSegments() }); }
  catch (error) { return respondError(res, error); }
};
export const createMailingSegmentController = async (req, res) => {
  try { return res.status(201).json({ success: true, segment: await createMailingSegment(req.body) }); }
  catch (error) { return respondError(res, error); }
};

export const listMailingTemplatesController = async (_req, res) => {
  try { return res.json({ success: true, templates: await listMailingTemplates() }); }
  catch (error) { return respondError(res, error); }
};
export const createMailingTemplateController = async (req, res) => {
  try { return res.status(201).json({ success: true, template: await createMailingTemplate(req.body) }); }
  catch (error) { return respondError(res, error); }
};

export const listMailingCampaignsController = async (_req, res) => {
  try { return res.json({ success: true, campaigns: await listMailingCampaigns() }); }
  catch (error) { return respondError(res, error); }
};
export const createMailingCampaignController = async (req, res) => {
  try { return res.status(201).json({ success: true, campaign: await createMailingCampaign(req.body, req.user?.id || null) }); }
  catch (error) { return respondError(res, error); }
};

export const listMailingSuppressionsController = async (_req, res) => {
  try { return res.json({ success: true, suppressions: await listMailingSuppressions() }); }
  catch (error) { return respondError(res, error); }
};
export const createMailingSuppressionController = async (req, res) => {
  try { return res.status(201).json({ success: true, suppression: await createMailingSuppression(req.body) }); }
  catch (error) { return respondError(res, error); }
};
