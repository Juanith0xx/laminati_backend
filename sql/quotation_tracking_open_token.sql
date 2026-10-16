ALTER TABLE quotation_email_messages
ADD COLUMN IF NOT EXISTS open_token_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quotation_email_messages_open_token_hash
ON quotation_email_messages(open_token_hash)
WHERE open_token_hash IS NOT NULL;
