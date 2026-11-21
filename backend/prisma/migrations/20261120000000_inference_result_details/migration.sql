-- Migration F: actual ML result details for inference executions (4.2).
--
-- Additive and idempotent. `model_version` is the existing legacy compatibility
-- string and is preserved; the new JSONB columns are the actual ML result.
-- Legacy rows read as `{}` ("unknown result"); nothing is copied from the
-- snapshot and no historical value is rewritten or backfilled.

ALTER TABLE inferences
    ADD COLUMN IF NOT EXISTS model_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS model_predictions JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inferences_model_versions_object_check'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_model_versions_object_check
            CHECK (jsonb_typeof(model_versions) = 'object');
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inferences_model_predictions_object_check'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_model_predictions_object_check
            CHECK (jsonb_typeof(model_predictions) = 'object');
    END IF;
END
$$;

-- Existing table-level grants on `inferences` already cover ADD COLUMN. Verify
-- the effective column privileges explicitly and refuse any broader privilege.
DO $$
DECLARE
    app_oid OID;
    inferences_oid REGCLASS;
    schema_name TEXT;
    qualified_name TEXT;
BEGIN
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        RAISE EXCEPTION 'clearsight_app must exist before result detail grants are verified'
            USING ERRCODE = 'undefined_object';
    END IF;

    -- Resolve the table the migration actually altered, not whatever schema
    -- current_schema() happens to return under a hostile search_path.
    inferences_oid := to_regclass('inferences');
    IF inferences_oid IS NULL THEN
        RAISE EXCEPTION 'inferences table must exist before result detail grants are verified'
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
    IF NOT has_column_privilege(app_oid, qualified_name, 'model_versions', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'model_versions', 'UPDATE')
       OR NOT has_column_privilege(app_oid, qualified_name, 'model_predictions', 'SELECT')
       OR NOT has_column_privilege(app_oid, qualified_name, 'model_predictions', 'UPDATE') THEN
        RAISE EXCEPTION 'clearsight_app must read/update new result detail columns'
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
