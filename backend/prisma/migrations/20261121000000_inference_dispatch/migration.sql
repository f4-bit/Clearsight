-- Migration G: bounded dispatch reconciliation for inference idempotency (4.6).
--
-- Additive and idempotent over the existing `idempotency_records` table from
-- migration C. No historical migration or baseline is edited. The existing
-- integrity trigger already treats identity/hash/inference/model versions and
-- ACCEPTED rows as immutable; these dispatch columns stay mutable only while
-- the row is PENDING. Existing table-level grants on `idempotency_records`
-- cover the new columns; the DO block verifies the effective column grants and
-- refuses forbidden table privileges without granting anything new.

ALTER TABLE idempotency_records
    ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_dispatch_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'idempotency_records_dispatch_attempts_nonnegative'
          AND conrelid = 'idempotency_records'::regclass
    ) THEN
        ALTER TABLE idempotency_records
            ADD CONSTRAINT idempotency_records_dispatch_attempts_nonnegative
            CHECK (dispatch_attempts >= 0);
    END IF;
END
$$;

-- Claim order: due rows first, oldest first. The predicate is partial because
-- only PENDING rows participate in dispatch reconciliation.
CREATE INDEX IF NOT EXISTS idx_idempotency_records_pending_dispatch
    ON idempotency_records (next_dispatch_at, created_at)
    WHERE state = 'PENDING';

DO $$
DECLARE
    app_oid OID;
    schema_name TEXT := current_schema();
    qualified_name TEXT;
BEGIN
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        RAISE EXCEPTION 'clearsight_app must exist before dispatch grants are verified'
            USING ERRCODE = 'undefined_object';
    END IF;

    qualified_name := format('%I.idempotency_records', schema_name);
    IF NOT has_column_privilege(app_oid, qualified_name, 'dispatch_attempts', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'dispatch_attempts', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'next_dispatch_at', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'next_dispatch_at', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'lease_until', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'lease_until', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'last_error_code', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'last_error_code', 'UPDATE') THEN
        RAISE EXCEPTION 'clearsight_app must read/update new dispatch columns'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF has_table_privilege(app_oid, qualified_name, 'DELETE')
       OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
       OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
       OR has_table_privilege(app_oid, qualified_name, 'REFERENCES') THEN
        RAISE EXCEPTION 'clearsight_app must not have DELETE/TRUNCATE/TRIGGER/REFERENCES on idempotency_records'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;
