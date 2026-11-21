-- Migration D: integrity hardening and least-privilege application role.
--
-- Additive. Replaces A guards without editing A, adds direct-image reparent
-- protection, and creates the global NOLOGIN group role `clearsight_app`.
-- The migration is idempotent; grants are applied to current_schema().

-- 1. required selection: deterministic inference locks before recheck ---------
-- Lock existing referenced inference rows in UUID order, then validate against a
-- fresh READ COMMITTED snapshot. This serializes freeze against concurrent
-- deletes/context updates while preserving the A freeze semantics.
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

        -- schema-qualified lock; EXECUTE without INTO discards rows but the
        -- FOR SHARE locks are retained for the transaction.
        EXECUTE format(
            'SELECT 1 FROM %I.inferences i WHERE i.id = ANY($1) ORDER BY i.id FOR SHARE',
            TG_TABLE_SCHEMA
        ) USING ids;

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

-- 2. inference context: image/parent SHARE locks ------------------------------
-- Replaces the A function with the same validity rules plus row locks. A child
-- INSERT/UPDATE locks the authoritative image; a parent UPDATE locks its own
-- image/parent and then checks children, preventing silent context drift.
CREATE OR REPLACE FUNCTION inferences_enforce_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    image_consultation UUID;
    image_eye_side VARCHAR(2);
    snapshot_consultation UUID;
    parent_exists UUID;
    parent_image_id UUID;
    parent_consultation UUID;
    parent_eye_side VARCHAR(2);
    conflict INTEGER;
BEGIN
    IF NEW.reanalysis_of_id IS NOT NULL AND NEW.reanalysis_of_id = NEW.id THEN
        RAISE EXCEPTION 'an inference cannot be a reanalysis of itself'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.reanalysis_of_id IS DISTINCT FROM OLD.reanalysis_of_id THEN
        RAISE EXCEPTION 'reanalysis_of_id is immutable; create a new reanalysis row'
            USING ERRCODE = 'restrict_violation';
    END IF;

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

    -- For reanalysis, lock the parent row first, then its image, then the child
    -- image. This is the same order as a parent-context UPDATE (parent row then
    -- image) and avoids the inverse-order deadlock.
    IF NEW.reanalysis_of_id IS NOT NULL THEN
        EXECUTE format(
            'SELECT id FROM %I.inferences WHERE id = $1 FOR SHARE',
            TG_TABLE_SCHEMA
        ) INTO parent_exists USING NEW.reanalysis_of_id;

        IF parent_exists IS NULL THEN
            RAISE EXCEPTION 'reanalysis parent % does not exist', NEW.reanalysis_of_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        EXECUTE format(
            'SELECT image_id FROM %I.inferences WHERE id = $1',
            TG_TABLE_SCHEMA
        ) INTO parent_image_id USING NEW.reanalysis_of_id;

        EXECUTE format(
            'SELECT consultation_id, eye_side FROM %I.images WHERE id = $1 FOR SHARE',
            TG_TABLE_SCHEMA
        ) INTO parent_consultation, parent_eye_side USING parent_image_id;
    END IF;

    EXECUTE format(
        'SELECT consultation_id, eye_side FROM %I.images WHERE id = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO image_consultation, image_eye_side USING NEW.image_id;

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
        IF parent_consultation IS NULL THEN
            RAISE EXCEPTION 'reanalysis parent % has no authoritative image', NEW.reanalysis_of_id
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

-- 3. direct image reparent protection ----------------------------------------
-- Once any inference references an image, its consultation/eye context cannot
-- change. No-op updates and unreferenced images remain allowed.
CREATE OR REPLACE FUNCTION images_reject_reparent_with_inferences()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    child_exists BOOLEAN;
BEGIN
    IF NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
       OR NEW.eye_side IS DISTINCT FROM OLD.eye_side THEN
        -- Own row already has the UPDATE write lock (NO KEY UPDATE), which
        -- conflicts with a concurrent child INSERT's image FOR SHARE. Do not
        -- take child row locks here: only EXISTS is needed and locked rows
        -- would invert the image/inference lock order under concurrency.
        EXECUTE format(
            'SELECT EXISTS (SELECT 1 FROM %I.inferences WHERE image_id = $1)',
            TG_TABLE_SCHEMA
        ) INTO child_exists USING OLD.id;

        IF child_exists THEN
            RAISE EXCEPTION 'image consultation/eye context cannot change while referenced by an inference'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS images_reparent_with_inferences_guard ON images;
CREATE TRIGGER images_reparent_with_inferences_guard
    BEFORE UPDATE OF consultation_id, eye_side ON images
    FOR EACH ROW EXECUTE FUNCTION images_reject_reparent_with_inferences();

-- 4. least-privilege application group role ----------------------------------
-- Global role, intentionally NOLOGIN and without memberships. Existing role
-- attributes are verified, never silently downgraded. The migration needs
-- CREATEROLE in the deployment login; failures are explicit.
DO $$
DECLARE
    app_oid OID;
    schema_name TEXT := current_schema();
    mutable_tables TEXT[] := ARRAY[
        'users', 'patients', 'consultations', 'images', 'inferences',
        'clinical_feedback', 'artifact_records', 'pdf_reports',
        'user_sessions', 'refresh_tokens', 'password_reset_tokens',
        'idempotency_records'
    ];
    append_only_tables TEXT[] := ARRAY['audit_events', 'clinical_snapshots'];
    protected_tables TEXT[] := mutable_tables || append_only_tables;
    table_name TEXT;
    qualified_name TEXT;
BEGIN
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        BEGIN
            CREATE ROLE clearsight_app
                NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE EXCEPTION 'creating clearsight_app requires CREATEROLE; deploy with an explicit admin role'
                    USING ERRCODE = 'insufficient_privilege';
        END;
        SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    ELSE
        IF EXISTS (
            SELECT 1 FROM pg_roles
            WHERE oid = app_oid
              AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
                   OR rolreplication OR rolbypassrls)
        ) THEN
            RAISE EXCEPTION 'existing clearsight_app has unsafe role attributes; refusing to downgrade silently'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = app_oid) THEN
        RAISE EXCEPTION 'clearsight_app must not be a member of any role'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.relnamespace = to_regnamespace(schema_name)
          AND c.relname = ANY(protected_tables)
          AND c.relowner = app_oid
    ) THEN
        RAISE EXCEPTION 'clearsight_app must not own protected tables'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_namespace n
        WHERE n.nspname = schema_name
          AND n.nspowner = app_oid
    ) THEN
        RAISE EXCEPTION 'clearsight_app must not own the application schema'
            USING ERRCODE = 'check_violation';
    END IF;

    IF has_schema_privilege(app_oid, schema_name, 'CREATE') THEN
        RAISE EXCEPTION 'clearsight_app must not have CREATE on the application schema'
            USING ERRCODE = 'check_violation';
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO clearsight_app', schema_name);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM clearsight_app', schema_name);

    FOREACH table_name IN ARRAY mutable_tables LOOP
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO clearsight_app',
            schema_name, table_name
        );
        EXECUTE format(
            'REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %I.%I FROM clearsight_app',
            schema_name, table_name
        );
    END LOOP;

    FOREACH table_name IN ARRAY append_only_tables LOOP
        EXECUTE format(
            'GRANT SELECT, INSERT ON TABLE %I.%I TO clearsight_app',
            schema_name, table_name
        );
        EXECUTE format(
            'REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %I.%I FROM clearsight_app',
            schema_name, table_name
        );
    END LOOP;

    -- Effective privilege verification also catches grants inherited from
    -- PUBLIC or another role. Never rewrite the PUBLIC/source ACL here.
    FOREACH table_name IN ARRAY mutable_tables LOOP
        qualified_name := format('%I.%I', schema_name, table_name);
        IF has_table_privilege(app_oid, qualified_name, 'DELETE')
           OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
           OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
           OR has_table_privilege(app_oid, qualified_name, 'REFERENCES') THEN
            RAISE EXCEPTION 'effective forbidden privilege on %: clearsight_app must not have DELETE/TRUNCATE/TRIGGER/REFERENCES',
                qualified_name
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY append_only_tables LOOP
        qualified_name := format('%I.%I', schema_name, table_name);
        IF has_table_privilege(app_oid, qualified_name, 'UPDATE')
           OR has_table_privilege(app_oid, qualified_name, 'DELETE')
           OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
           OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
           OR has_table_privilege(app_oid, qualified_name, 'REFERENCES') THEN
            RAISE EXCEPTION 'effective forbidden privilege on %: clearsight_app must not have UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES',
                qualified_name
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
END
$$;
