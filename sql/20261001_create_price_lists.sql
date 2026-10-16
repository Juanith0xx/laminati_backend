BEGIN;

CREATE TABLE IF NOT EXISTS price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name character varying(120) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT TRUE,
  valid_from date,
  valid_until date,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT price_lists_name_not_empty
    CHECK (TRIM(BOTH FROM name) <> ''::text),

  CONSTRAINT price_lists_dates_valid
    CHECK (
      valid_until IS NULL
      OR valid_from IS NULL
      OR valid_until >= valid_from
    ),

  CONSTRAINT price_lists_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT price_lists_updated_by_fkey
    FOREIGN KEY (updated_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_lists_name_lower
  ON price_lists (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_price_lists_active
  ON price_lists (is_active, name);

CREATE INDEX IF NOT EXISTS idx_price_lists_validity
  ON price_lists (valid_from, valid_until);

CREATE TABLE IF NOT EXISTS price_list_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id uuid NOT NULL,
  scope_type character varying(20) NOT NULL,
  product_id uuid,
  collection_id uuid,
  discount_type character varying(20) NOT NULL DEFAULT 'PERCENTAGE',
  discount_value numeric(14,2) NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT price_list_rules_price_list_id_fkey
    FOREIGN KEY (price_list_id)
    REFERENCES price_lists(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT price_list_rules_product_id_fkey
    FOREIGN KEY (product_id)
    REFERENCES products(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT price_list_rules_collection_id_fkey
    FOREIGN KEY (collection_id)
    REFERENCES collections(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT price_list_rules_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT price_list_rules_updated_by_fkey
    FOREIGN KEY (updated_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT price_list_rules_scope_type_check
    CHECK (scope_type IN ('PRODUCT', 'COLLECTION')),

  CONSTRAINT price_list_rules_discount_type_check
    CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),

  CONSTRAINT price_list_rules_discount_value_check
    CHECK (
      discount_value > 0
      AND (
        discount_type <> 'PERCENTAGE'
        OR discount_value <= 100
      )
    ),

  CONSTRAINT price_list_rules_target_check
    CHECK (
      (
        scope_type = 'PRODUCT'
        AND product_id IS NOT NULL
        AND collection_id IS NULL
      )
      OR
      (
        scope_type = 'COLLECTION'
        AND collection_id IS NOT NULL
        AND product_id IS NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_list_rules_product
  ON price_list_rules (price_list_id, product_id)
  WHERE scope_type = 'PRODUCT';

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_list_rules_collection
  ON price_list_rules (price_list_id, collection_id)
  WHERE scope_type = 'COLLECTION';

CREATE INDEX IF NOT EXISTS idx_price_list_rules_price_list
  ON price_list_rules (price_list_id, is_active);

CREATE INDEX IF NOT EXISTS idx_price_list_rules_product
  ON price_list_rules (product_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_price_list_rules_collection
  ON price_list_rules (collection_id)
  WHERE collection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  assigned_by uuid,
  assigned_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT user_price_lists_user_id_key
    UNIQUE (user_id),

  CONSTRAINT user_price_lists_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT user_price_lists_price_list_id_fkey
    FOREIGN KEY (price_list_id)
    REFERENCES price_lists(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT user_price_lists_assigned_by_fkey
    FOREIGN KEY (assigned_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_price_lists_price_list
  ON user_price_lists (price_list_id);

DROP TRIGGER IF EXISTS trg_price_lists_updated_at ON price_lists;
CREATE TRIGGER trg_price_lists_updated_at
BEFORE UPDATE ON price_lists
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_price_list_rules_updated_at ON price_list_rules;
CREATE TRIGGER trg_price_list_rules_updated_at
BEFORE UPDATE ON price_list_rules
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_price_lists_updated_at ON user_price_lists;
CREATE TRIGGER trg_user_price_lists_updated_at
BEFORE UPDATE ON user_price_lists
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
