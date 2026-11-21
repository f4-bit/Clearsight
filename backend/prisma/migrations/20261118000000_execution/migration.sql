-- Migration A: clinical snapshot, execution metadata and required selection.
--
-- Additive and idempotent. Existing legacy rows are not backfilled: snapshots,
-- execution metadata and required selections stay empty/NULL until the future
-- application flow creates them. The statements are schema-qualified through
-- search_path/TG_TABLE_SCHEMA so they work in isolated test schemas as well as
-- in the default schema.

-- 1. clinical_snapshots -------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL,
    raw_payload JSONB NOT NULL,
    normalized_payload JSONB NOT NULL,
    schema_version VARCHAR(128) NOT NULL,
    model_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT clinical_snapshots_raw_payload_object
        CHECK (jsonb_typeof(raw_payload) = 'object'),
    CONSTRAINT clinical_snapshots_normalized_payload_object
        CHECK (jsonb_typeof(normalized_payload) = 'object'),
    CONSTRAINT clinical_snapshots_model_versions_object
        CHECK (jsonb_typeof(model_versions) = 'object'),
    CONSTRAINT clinical_snapshots_schema_version_nonempty
        CHECK (length(btrim(schema_version)) > 0)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'clinical_snapshots_consultation_id_fkey'
          AND conrelid = 'clinical_snapshots'::regclass
    ) THEN
        ALTER TABLE clinical_snapshots
            ADD CONSTRAINT clinical_snapshots_consultation_id_fkey
            FOREIGN KEY (consultation_id) REFERENCES consultations (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_clinical_snapshots_consultation_id
    ON clinical_snapshots (consultation_id);

-- Snapshots are evidence: neither UPDATE nor DELETE is allowed. The delete
-- policy is enforced by the trigger itself (not only by the FK) so a direct
-- DELETE is rejected even if the owning consultation still exists.
CREATE OR REPLACE FUNCTION clinical_snapshots_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'clinical_snapshots are immutable; % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS clinical_snapshots_reject_update_delete ON clinical_snapshots;
CREATE TRIGGER clinical_snapshots_reject_update_delete
    BEFORE UPDATE OR DELETE ON clinical_snapshots
    FOR EACH ROW EXECUTE FUNCTION clinical_snapshots_reject_mutation();

-- 2. consultations: explicit required selection -------------------------------
ALTER TABLE consultations
    ADD COLUMN IF NOT EXISTS required_execution_ids UUID[]
        NOT NULL DEFAULT ARRAY[]::UUID[],
    ADD COLUMN IF NOT EXISTS required_set_version VARCHAR(128),
    ADD COLUMN IF NOT EXISTS required_set_frozen_at TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS idx_consultations_required_execution_ids
    ON consultations USING GIN (required_execution_ids);

-- 3. inferences: execution metadata ------------------------------------------
ALTER TABLE inferences
    ADD COLUMN IF NOT EXISTS consultation_id UUID,
    ADD COLUMN IF NOT EXISTS eye_side VARCHAR(2),
    ADD COLUMN IF NOT EXISTS clinical_snapshot_id UUID,
    ADD COLUMN IF NOT EXISTS status VARCHAR(32),
    ADD COLUMN IF NOT EXISTS reanalysis_of_id UUID;

CREATE INDEX IF NOT EXISTS idx_inferences_consultation_id
    ON inferences (consultation_id);
CREATE INDEX IF NOT EXISTS idx_inferences_clinical_snapshot_id
    ON inferences (clinical_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_inferences_reanalysis_of_id
    ON inferences (reanalysis_of_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_consultation_id_fkey'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_consultation_id_fkey
            FOREIGN KEY (consultation_id) REFERENCES consultations (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_clinical_snapshot_id_fkey'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_clinical_snapshot_id_fkey
            FOREIGN KEY (clinical_snapshot_id) REFERENCES clinical_snapshots (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_reanalysis_of_id_fkey'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_reanalysis_of_id_fkey
            FOREIGN KEY (reanalysis_of_id) REFERENCES inferences (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_eye_side_check'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_eye_side_check
            CHECK (eye_side IS NULL OR eye_side IN ('OD', 'OS'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_status_check'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_status_check
            CHECK (status IS NULL OR status IN (
                'QUEUED', 'DOWNLOADING', 'LOCALIZING', 'SEGMENTING', 'CLASSIFYING',
                'COMPLETED', 'REVIEW_REQUIRED', 'FAILED'
            ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inferences_reanalysis_not_self'
          AND conrelid = 'inferences'::regclass
    ) THEN
        ALTER TABLE inferences
            ADD CONSTRAINT inferences_reanalysis_not_self
            CHECK (reanalysis_of_id IS NULL OR reanalysis_of_id <> id);
    END IF;
END
$$;

-- 4. required selection integrity --------------------------------------------
-- A non-empty set must be frozen with a non-empty version and may only contain
-- executions that belong to the same consultation. Legacy rows keep an empty
-- array, NULL version and NULL frozen timestamp (open, not "not selected v1").
CREATE OR REPLACE FUNCTION consultations_enforce_required_selection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    ids UUID[] := COALESCE(NEW.required_execution_ids, ARRAY[]::UUID[]);
    duplicate_count INTEGER;
    missing_ids UUID[];
BEGIN
    SELECT count(*) - count(DISTINCT u.value)
      INTO duplicate_count
      FROM unnest(ids) AS u(value);

    IF duplicate_count > 0 THEN
        RAISE EXCEPTION 'required_execution_ids must not contain duplicates'
            USING ERRCODE = 'check_violation';
    END IF;

    IF cardinality(ids) = 0 THEN
        IF NEW.required_set_version IS NOT NULL OR NEW.required_set_frozen_at IS NOT NULL THEN
            RAISE EXCEPTION 'an empty required selection cannot be frozen'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF NEW.required_set_version IS NULL OR btrim(NEW.required_set_version) = '' THEN
            RAISE EXCEPTION 'a non-empty required selection needs required_set_version'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.required_set_frozen_at IS NULL THEN
            RAISE EXCEPTION 'a non-empty required selection must be frozen'
                USING ERRCODE = 'check_violation';
        END IF;

        EXECUTE format(
            'SELECT array_agg(u.value) FROM unnest($1) AS u(value) '
            'WHERE NOT EXISTS ('
            '  SELECT 1 FROM %I.inferences i '
            '  JOIN %I.images img ON img.id = i.image_id '
            '  WHERE i.id = u.value '
            '    AND COALESCE(i.consultation_id, img.consultation_id) = $2'
            ')',
            TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO missing_ids USING ids, NEW.id;

        IF missing_ids IS NOT NULL THEN
            RAISE EXCEPTION 'required_execution_ids must belong to this consultation: %', missing_ids
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.required_set_frozen_at IS NOT NULL
       AND (
           NEW.required_execution_ids IS DISTINCT FROM OLD.required_execution_ids
           OR NEW.required_set_version IS DISTINCT FROM OLD.required_set_version
           OR NEW.required_set_frozen_at IS DISTINCT FROM OLD.required_set_frozen_at
       ) THEN
        RAISE EXCEPTION 'required selection is frozen and cannot change'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consultations_required_selection_guard ON consultations;
CREATE TRIGGER consultations_required_selection_guard
    BEFORE INSERT OR UPDATE OF
        required_execution_ids, required_set_version, required_set_frozen_at
    ON consultations
    FOR EACH ROW EXECUTE FUNCTION consultations_enforce_required_selection();

-- A selected execution is evidence of a target membership; deleting it while
-- it is still selected would leave a dangling required ID. This is deliberately
-- conservative until task 1.4/2.5 owns a full selection lifecycle.
CREATE OR REPLACE FUNCTION inferences_reject_selected_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    selected INTEGER;
BEGIN
    EXECUTE format(
        'SELECT 1 FROM %I.consultations c '
        'WHERE $1 = ANY(c.required_execution_ids) LIMIT 1',
        TG_TABLE_SCHEMA
    ) INTO selected USING OLD.id;

    IF selected IS NOT NULL THEN
        RAISE EXCEPTION 'cannot delete an inference selected as required by a consultation'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS inferences_required_selection_delete_guard ON inferences;
CREATE TRIGGER inferences_required_selection_delete_guard
    BEFORE DELETE ON inferences
    FOR EACH ROW EXECUTE FUNCTION inferences_reject_selected_delete();

-- 5. inference execution context ---------------------------------------------
-- Copied metadata is only validated when present: legacy rows keep NULL and
-- the authoritative image remains the source of truth for consistency checks.
CREATE OR REPLACE FUNCTION inferences_enforce_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    image_consultation UUID;
    image_eye_side VARCHAR(2);
    snapshot_consultation UUID;
    parent_consultation UUID;
    parent_eye_side VARCHAR(2);
    conflict INTEGER;
BEGIN
    IF NEW.reanalysis_of_id IS NOT NULL AND NEW.reanalysis_of_id = NEW.id THEN
        RAISE EXCEPTION 'an inference cannot be a reanalysis of itself'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Provenance is append-only: a reanalysis is a new row, never an UPDATE of
    -- an existing row (including assigning a parent to a legacy NULL row).
    IF TG_OP = 'UPDATE' AND NEW.reanalysis_of_id IS DISTINCT FROM OLD.reanalysis_of_id THEN
        RAISE EXCEPTION 'reanalysis_of_id is immutable; create a new reanalysis row'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Once set, the snapshot link is immutable. A legacy row with NULL may get
    -- its first real link only while it is not part of any frozen selection.
    IF TG_OP = 'UPDATE' AND NEW.clinical_snapshot_id IS DISTINCT FROM OLD.clinical_snapshot_id THEN
        IF OLD.clinical_snapshot_id IS NOT NULL THEN
            RAISE EXCEPTION 'snapshot link is immutable once set'
                USING ERRCODE = 'restrict_violation';
        END IF;

        EXECUTE format(
            'SELECT 1 FROM %I.consultations c '
            'WHERE $1 = ANY(c.required_execution_ids) LIMIT 1',
            TG_TABLE_SCHEMA
        ) INTO conflict USING OLD.id;

        IF conflict IS NOT NULL THEN
            RAISE EXCEPTION 'selected inference cannot change its snapshot link'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    EXECUTE format('SELECT consultation_id, eye_side FROM %I.images WHERE id = $1', TG_TABLE_SCHEMA)
        INTO image_consultation, image_eye_side
        USING NEW.image_id;

    IF image_consultation IS NULL THEN
        RAISE EXCEPTION 'inference image % does not exist', NEW.image_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.consultation_id IS NOT NULL AND NEW.consultation_id <> image_consultation THEN
        RAISE EXCEPTION 'inference consultation_id % does not match image consultation %',
            NEW.consultation_id, image_consultation
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.eye_side IS NOT NULL AND NEW.eye_side <> image_eye_side THEN
        RAISE EXCEPTION 'inference eye_side % does not match image eye_side %',
            NEW.eye_side, image_eye_side
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.clinical_snapshot_id IS NOT NULL THEN
        EXECUTE format('SELECT consultation_id FROM %I.clinical_snapshots WHERE id = $1', TG_TABLE_SCHEMA)
            INTO snapshot_consultation
            USING NEW.clinical_snapshot_id;

        IF snapshot_consultation IS NULL THEN
            RAISE EXCEPTION 'clinical snapshot % does not exist', NEW.clinical_snapshot_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF snapshot_consultation <> image_consultation THEN
            RAISE EXCEPTION 'clinical snapshot % belongs to another consultation', NEW.clinical_snapshot_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.reanalysis_of_id IS NOT NULL THEN
        EXECUTE format(
            'SELECT img.consultation_id, img.eye_side '
            'FROM %I.inferences parent JOIN %I.images img ON img.id = parent.image_id '
            'WHERE parent.id = $1',
            TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO parent_consultation, parent_eye_side USING NEW.reanalysis_of_id;

        IF parent_consultation IS NULL THEN
            RAISE EXCEPTION 'reanalysis parent % does not exist', NEW.reanalysis_of_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF parent_consultation <> image_consultation
           OR parent_eye_side IS DISTINCT FROM image_eye_side THEN
            RAISE EXCEPTION 'reanalysis must stay in the same consultation and eye context'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND (
           NEW.image_id IS DISTINCT FROM OLD.image_id
           OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
           OR NEW.eye_side IS DISTINCT FROM OLD.eye_side
       ) THEN
        EXECUTE format(
            'SELECT 1 FROM %I.inferences child '
            'JOIN %I.images child_img ON child_img.id = child.image_id '
            'WHERE child.reanalysis_of_id = $1 '
            '  AND (child_img.consultation_id <> $2 OR child_img.eye_side IS DISTINCT FROM $3) '
            'LIMIT 1',
            TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO conflict USING OLD.id, image_consultation, image_eye_side;

        IF conflict IS NOT NULL THEN
            RAISE EXCEPTION 'changing this inference would invalidate a reanalysis child'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- Any image/consultation/eye identity change of a selected execution
        -- invalidates frozen evidence, even when the new image happens to share
        -- the same consultation and eye side.
        EXECUTE format(
            'SELECT 1 FROM %I.consultations c '
            'WHERE $1 = ANY(c.required_execution_ids) LIMIT 1',
            TG_TABLE_SCHEMA
        ) INTO conflict USING OLD.id;

        IF conflict IS NOT NULL THEN
            RAISE EXCEPTION 'changing this inference would invalidate a required selection'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inferences_context_guard ON inferences;
CREATE TRIGGER inferences_context_guard
    BEFORE INSERT OR UPDATE OF
        image_id, consultation_id, eye_side, clinical_snapshot_id, reanalysis_of_id
    ON inferences
    FOR EACH ROW EXECUTE FUNCTION inferences_enforce_context();
