-- Migration H: PostgreSQL-backed inference process queue (4.9).
--
-- Replaces the BullMQ/Redis queue with durable columns on `inferences`. The
-- application marks rows ready (`next_process_at`) and claims due QUEUED rows
-- under an explicit `process_lease_until`; terminal results keep using the
-- existing compare-and-set. Additive and idempotent over the historical tables.
-- No historical migration or baseline is edited. Existing table-level grants on
-- `inferences` cover the new columns; the DO block verifies the effective column
-- grants and refuses forbidden table privileges without granting anything new.

DO $$
DECLARE
    inferences_oid REGCLASS;
    schema_name TEXT;
BEGIN
    -- Resolve the table the migration actually alters, not whatever schema
    -- current_schema() happens to return under a hostile search_path.
    inferences_oid := to_regclass('inferences');
    IF inferences_oid IS NULL THEN
        RAISE EXCEPTION 'inferences table must exist before process queue columns are added'
            USING ERRCODE = 'undefined_table';
    END IF;
    SELECT n.nspname INTO schema_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = inferences_oid;
    IF schema_name IS NULL THEN
        RAISE EXCEPTION 'inferences table schema could not be resolved'
            USING ERRCODE = 'undefined_table';
    END IF;

    EXECUTE format(
        'ALTER TABLE %I.inferences
            ADD COLUMN IF NOT EXISTS process_attempts INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS next_process_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN IF NOT EXISTS process_lease_until TIMESTAMPTZ',
        schema_name
    );

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conname = 'inferences_process_attempts_nonnegative'
           AND conrelid = inferences_oid
    ) THEN
        EXECUTE format(
            'ALTER TABLE %I.inferences
                ADD CONSTRAINT inferences_process_attempts_nonnegative
                CHECK (process_attempts >= 0)',
            schema_name
        );
    END IF;

    -- Only QUEUED rows participate in the poller claim.
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_inferences_process_queue
            ON %I.inferences (next_process_at)
            WHERE status = ''QUEUED''',
        schema_name
    );
END
$$;

DO $$
DECLARE
    app_oid OID;
    inferences_oid REGCLASS;
    schema_name TEXT;
    qualified_name TEXT;
BEGIN
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        RAISE EXCEPTION 'clearsight_app must exist before process queue grants are verified'
            USING ERRCODE = 'undefined_object';
    END IF;

    inferences_oid := to_regclass('inferences');
    IF inferences_oid IS NULL THEN
        RAISE EXCEPTION 'inferences table must exist before process queue grants are verified'
            USING ERRCODE = 'undefined_table';
    END IF;
    SELECT n.nspname INTO schema_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = inferences_oid;
    IF schema_name IS NULL THEN
        RAISE EXCEPTION 'inferences table schema could not be resolved'
            USING ERRCODE = 'undefined_table';
    END IF;

    qualified_name := format('%I.inferences', schema_name);
    IF NOT has_column_privilege(app_oid, qualified_name, 'process_attempts', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'process_attempts', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'next_process_at', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'next_process_at', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'process_lease_until', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'process_lease_until', 'UPDATE') THEN
        RAISE EXCEPTION 'clearsight_app must read/update new process queue columns'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF has_table_privilege(app_oid, qualified_name, 'DELETE')
       OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
       OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
       OR has_table_privilege(app_oid, qualified_name, 'REFERENCES') THEN
        RAISE EXCEPTION 'clearsight_app must not have DELETE/TRUNCATE/TRIGGER/REFERENCES on inferences'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;
