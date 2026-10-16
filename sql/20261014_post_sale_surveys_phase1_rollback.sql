BEGIN;

DROP VIEW IF EXISTS
  vw_product_review_summary;

DROP TABLE IF EXISTS
  product_reviews CASCADE;

DROP TABLE IF EXISTS
  post_sale_survey_responses CASCADE;

DROP TABLE IF EXISTS
  post_sale_survey_invitations CASCADE;

COMMIT;
