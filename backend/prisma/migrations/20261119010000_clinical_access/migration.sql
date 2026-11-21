-- Migration E: clinical ownership and explicit inference access grants (Hito 5.2).
--
-- Additive. Does not edit A/B/C/D and performs no clinical backfill beyond the
-- controlled access-owner assignment of a patient whose *all* legacy
-- consultations point to the same OFTALMOLOGO. No snapshot, status, hash or
-- clinical JSON is rewritten.

-- 1. patients.owner_doctor_id -------------------------------------------------
ALTER TABLE patients
    ADD COLUMN IF NOT EXISTS owner_doctor_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'patients_owner_doctor_id_fkey'
          AND conrelid = 'patients'::regclass
    ) THEN
        ALTER TABLE patients
            ADD CONSTRAINT patients_owner_doctor_id_fkey
            FOREIGN KEY (owner_doctor_id) REFERENCES users (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_patients_owner_doctor_id
    ON patients (owner_doctor_id);

-- Controlled legacy backfill. Only assign the access owner when every
-- associated consultation points to exactly one doctor and that user is an
-- OFTALMOLOGO. Orphans/mixed/other roles stay NULL; no first/latest guess.
UPDATE patients AS p
SET owner_doctor_id = candidate.doctor_id
FROM (
    SELECT c.patient_id, (array_agg(DISTINCT c.doctor_id))[1] AS doctor_id
    FROM consultations c
    GROUP BY c.patient_id
    HAVING count(DISTINCT c.doctor_id) = 1
) AS candidate
JOIN users u ON u.id = candidate.doctor_id AND u.role = 'OFTALMOLOGO'
WHERE p.id = candidate.patient_id
  AND p.owner_doctor_id IS NULL;

-- The owner is an access assignment, not a fabricated creator. Once non-NULL it
-- can never be reassigned; a legacy NULL row may be assigned once, by the
-- server-side application path only.
CREATE OR REPLACE FUNCTION patients_enforce_owner_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.owner_doctor_id IS NOT NULL
       AND NEW.owner_doctor_id IS DISTINCT FROM OLD.owner_doctor_id THEN
        RAISE EXCEPTION 'patient owner cannot be reassigned'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patients_owner_immutable_guard ON patients;
CREATE TRIGGER patients_owner_immutable_guard
    BEFORE UPDATE OF owner_doctor_id ON patients
    FOR EACH ROW EXECUTE FUNCTION patients_enforce_owner_immutable();

-- 2. consultations: author/patient binding immutable after create ------------
-- Same-value upserts (seed replay) remain valid because only an actual identity
-- change is rejected.
CREATE OR REPLACE FUNCTION consultations_enforce_binding_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
           NEW.patient_id IS DISTINCT FROM OLD.patient_id
           OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
       ) THEN
        RAISE EXCEPTION 'consultation patient/doctor binding is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consultations_binding_immutable_guard ON consultations;
CREATE TRIGGER consultations_binding_immutable_guard
    BEFORE UPDATE OF patient_id, doctor_id ON consultations
    FOR EACH ROW EXECUTE FUNCTION consultations_enforce_binding_immutable();

-- 3. inference_access_grants --------------------------------------------------
CREATE TABLE IF NOT EXISTS inference_access_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inference_id UUID NOT NULL,
    consultation_id UUID NOT NULL,
    recipient_user_id UUID NOT NULL,
    approval_reference VARCHAR(128) NOT NULL,
    approved_by_user_id UUID,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ(6) NOT NULL,
    revoked_at TIMESTAMPTZ(6),
    read_result BOOLEAN NOT NULL DEFAULT false,
    read_artifacts BOOLEAN NOT NULL DEFAULT false,
    read_pdf BOOLEAN NOT NULL DEFAULT false,
    can_export_gold_standard BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT inference_access_grants_approval_reference_nonempty
        CHECK (length(btrim(approval_reference)) > 0),
    CONSTRAINT inference_access_grants_approval_reference_not_url
        CHECK (approval_reference !~* '^[A-Za-z][A-Za-z0-9+.-]*://'),
    CONSTRAINT inference_access_grants_expiry_after_created
        CHECK (expires_at > created_at),
    CONSTRAINT inference_access_grants_revoked_after_created
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CONSTRAINT inference_access_grants_at_least_one_capability
        CHECK (read_result OR read_artifacts OR read_pdf OR can_export_gold_standard)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inference_access_grants_inference_id_fkey'
          AND conrelid = 'inference_access_grants'::regclass
    ) THEN
        ALTER TABLE inference_access_grants
            ADD CONSTRAINT inference_access_grants_inference_id_fkey
            FOREIGN KEY (inference_id) REFERENCES inferences (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inference_access_grants_consultation_id_fkey'
          AND conrelid = 'inference_access_grants'::regclass
    ) THEN
        ALTER TABLE inference_access_grants
            ADD CONSTRAINT inference_access_grants_consultation_id_fkey
            FOREIGN KEY (consultation_id) REFERENCES consultations (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inference_access_grants_recipient_user_id_fkey'
          AND conrelid = 'inference_access_grants'::regclass
    ) THEN
        ALTER TABLE inference_access_grants
            ADD CONSTRAINT inference_access_grants_recipient_user_id_fkey
            FOREIGN KEY (recipient_user_id) REFERENCES users (id)
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inference_access_grants_approved_by_user_id_fkey'
          AND conrelid = 'inference_access_grants'::regclass
    ) THEN
        ALTER TABLE inference_access_grants
            ADD CONSTRAINT inference_access_grants_approved_by_user_id_fkey
            FOREIGN KEY (approved_by_user_id) REFERENCES users (id)
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inference_access_grants_recipient_inference_approval_key'
          AND conrelid = 'inference_access_grants'::regclass
    ) THEN
        ALTER TABLE inference_access_grants
            ADD CONSTRAINT inference_access_grants_recipient_inference_approval_key
            UNIQUE (recipient_user_id, inference_id, approval_reference);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_inference_access_grants_inference_id
    ON inference_access_grants (inference_id);
CREATE INDEX IF NOT EXISTS idx_inference_access_grants_consultation_id
    ON inference_access_grants (consultation_id);
CREATE INDEX IF NOT EXISTS idx_inference_access_grants_recipient_user_id
    ON inference_access_grants (recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_inference_access_grants_expires_at
    ON inference_access_grants (expires_at);

-- 4. grant insert: bind to the authoritative image and eligible roles --------
-- Locks the inference and its image FOR SHARE before capturing/validating the
-- consultation. The captured consultation must equal the image consultation;
-- legacy inferences without copied metadata are fine (the image is the truth).
CREATE OR REPLACE FUNCTION inference_access_grants_enforce_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    authoritative_image UUID;
    authoritative_consultation UUID;
    recipient_role VARCHAR(32);
    approver_role VARCHAR(32);
    approver_active BOOLEAN;
BEGIN
    EXECUTE format(
        'SELECT image_id FROM %I.inferences WHERE id = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO authoritative_image USING NEW.inference_id;

    IF authoritative_image IS NULL THEN
        RAISE EXCEPTION 'grant inference % does not exist', NEW.inference_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    EXECUTE format(
        'SELECT consultation_id FROM %I.images WHERE id = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO authoritative_consultation USING authoritative_image;

    IF authoritative_consultation IS NULL THEN
        RAISE EXCEPTION 'grant inference % has no authoritative image', NEW.inference_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.consultation_id IS DISTINCT FROM authoritative_consultation THEN
        RAISE EXCEPTION 'grant consultation % does not match authoritative image consultation %',
            NEW.consultation_id, authoritative_consultation
            USING ERRCODE = 'check_violation';
    END IF;

    EXECUTE format('SELECT role FROM %I.users WHERE id = $1', TG_TABLE_SCHEMA)
        INTO recipient_role USING NEW.recipient_user_id;
    IF recipient_role IS NULL THEN
        RAISE EXCEPTION 'grant recipient % does not exist', NEW.recipient_user_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF recipient_role NOT IN ('ADMIN', 'INVESTIGADOR') THEN
        RAISE EXCEPTION 'grant recipient must be ADMIN or INVESTIGADOR'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.approved_by_user_id IS NOT NULL THEN
        EXECUTE format('SELECT role, is_active FROM %I.users WHERE id = $1', TG_TABLE_SCHEMA)
            INTO approver_role, approver_active USING NEW.approved_by_user_id;
        IF approver_role IS NULL THEN
            RAISE EXCEPTION 'grant approver % does not exist', NEW.approved_by_user_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF approver_role <> 'ADMIN' OR approver_active IS NOT TRUE THEN
            RAISE EXCEPTION 'grant approver must be an active ADMIN'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inference_access_grants_insert_guard ON inference_access_grants;
CREATE TRIGGER inference_access_grants_insert_guard
    BEFORE INSERT ON inference_access_grants
    FOR EACH ROW EXECUTE FUNCTION inference_access_grants_enforce_insert();

-- 5. grant terms immutable, revocation append-only ----------------------------
CREATE OR REPLACE FUNCTION inference_access_grants_enforce_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.inference_id IS DISTINCT FROM OLD.inference_id
       OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
       OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
       OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.read_result IS DISTINCT FROM OLD.read_result
       OR NEW.read_artifacts IS DISTINCT FROM OLD.read_artifacts
       OR NEW.read_pdf IS DISTINCT FROM OLD.read_pdf
       OR NEW.can_export_gold_standard IS DISTINCT FROM OLD.can_export_gold_standard THEN
        RAISE EXCEPTION 'grant terms are immutable; revoke and issue a new grant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'grant revocation is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.revoked_at IS NULL
       AND NEW.revoked_at IS NOT NULL
       AND NEW.revoked_at < OLD.created_at THEN
        RAISE EXCEPTION 'grant revocation cannot precede creation'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inference_access_grants_update_guard ON inference_access_grants;
CREATE TRIGGER inference_access_grants_update_guard
    BEFORE UPDATE ON inference_access_grants
    FOR EACH ROW EXECUTE FUNCTION inference_access_grants_enforce_update();

-- 6. granted execution identity: inference-row columns are frozen ------------
-- Once any grant exists (active, expired or revoked), the granted inference row
-- cannot change its image/context/snapshot/reanalysis columns, so an approval
-- can never be redirected to other data. This trigger deliberately does not add
-- a new guard on the parent `images` row; parent-image mutations remain outside
-- this trigger and are only covered by the earlier reparent guard where it
-- applies. No application writer moves images in this milestone.
CREATE OR REPLACE FUNCTION inferences_reject_identity_change_with_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    grant_exists INTEGER;
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
           NEW.image_id IS DISTINCT FROM OLD.image_id
           OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
           OR NEW.eye_side IS DISTINCT FROM OLD.eye_side
           OR NEW.clinical_snapshot_id IS DISTINCT FROM OLD.clinical_snapshot_id
           OR NEW.reanalysis_of_id IS DISTINCT FROM OLD.reanalysis_of_id
       ) THEN
        EXECUTE format(
            'SELECT 1 FROM %I.inference_access_grants WHERE inference_id = $1 LIMIT 1',
            TG_TABLE_SCHEMA
        ) INTO grant_exists USING OLD.id;

        IF grant_exists IS NOT NULL THEN
            RAISE EXCEPTION 'an inference with grant history cannot change execution identity'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inferences_granted_identity_guard ON inferences;
CREATE TRIGGER inferences_granted_identity_guard
    BEFORE UPDATE OF
        image_id, consultation_id, eye_side, clinical_snapshot_id, reanalysis_of_id
    ON inferences
    FOR EACH ROW EXECUTE FUNCTION inferences_reject_identity_change_with_grants();

-- 7. least-privilege application role on the new table -----------------------
-- Existing migration D keeps its fixed table list; this migration grants the
-- new table explicitly. The app can read grants and monotonically revoke them
-- but cannot create, widen, delete or truncate them.
DO $$
DECLARE
    app_oid OID;
    schema_name TEXT := current_schema();
    qualified_name TEXT := format('%I.%I', schema_name, 'inference_access_grants');
BEGIN
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        RAISE EXCEPTION 'clearsight_app must exist before clinical access grants are configured'
            USING ERRCODE = 'undefined_object';
    END IF;

    EXECUTE format('REVOKE ALL ON TABLE %s FROM clearsight_app', qualified_name);
    EXECUTE format('GRANT SELECT ON TABLE %s TO clearsight_app', qualified_name);
    EXECUTE format('GRANT UPDATE (revoked_at) ON TABLE %s TO clearsight_app', qualified_name);

    IF has_table_privilege(app_oid, qualified_name, 'INSERT')
       OR has_table_privilege(app_oid, qualified_name, 'DELETE')
       OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
       OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
       OR has_table_privilege(app_oid, qualified_name, 'REFERENCES')
       OR has_column_privilege(app_oid, qualified_name, 'read_result', 'UPDATE')
       OR has_column_privilege(app_oid, qualified_name, 'can_export_gold_standard', 'UPDATE')
       OR has_column_privilege(app_oid, qualified_name, 'expires_at', 'UPDATE') THEN
        RAISE EXCEPTION 'effective forbidden privilege on %', qualified_name
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT has_column_privilege(app_oid, qualified_name, 'revoked_at', 'UPDATE') THEN
        RAISE EXCEPTION 'clearsight_app must be able to monotonically revoke grants'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;
