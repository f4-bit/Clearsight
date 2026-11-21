-- D1 fix: allow `data_version` and `rendering_inputs` to be replaced while a
-- report is still PENDING.
--
-- Migration B made both fields immutable from creation and `data_version`
-- NOT NULL with a non-empty CHECK. A retryable pre-render failure therefore
-- cannot leave it NULL, and a reused FAILED row must eventually carry the real
-- content hash and the real rendering provenance. This migration keeps the
-- non-empty constraint and every other identity field immutable, but permits
-- exactly one narrow mutation pair: PENDING -> PENDING replacement of
-- `data_version` and `rendering_inputs` together (or either one).
-- FAILED -> PENDING must happen first, and AVAILABLE remains fully immutable.
-- No table/column/unique-index change is needed.

CREATE OR REPLACE FUNCTION pdf_reports_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    inference_exists UUID;
    inference_snapshot UUID;
    artifact_exists UUID;
    artifact_inference UUID;
    artifact_type VARCHAR(32);
    artifact_version INTEGER;
    artifact_status VARCHAR(16);
    artifact_content_type VARCHAR(255);
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'AVAILABLE' THEN
            RAISE EXCEPTION 'published PDF reports cannot be deleted'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.inference_id IS DISTINCT FROM OLD.inference_id
           OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
           OR NEW.model_versions IS DISTINCT FROM OLD.model_versions
           OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'PDF report identity and rendering inputs are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.status = 'AVAILABLE' THEN
            RAISE EXCEPTION 'published PDF reports are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- The only permitted content-provenance mutation is PENDING -> PENDING.
        -- This lets a repaired retry replace the pending-content placeholder
        -- and neutral rendering inputs with the real hash/checksums before
        -- finalizing AVAILABLE.
        IF (
            NEW.data_version IS DISTINCT FROM OLD.data_version
            OR NEW.rendering_inputs IS DISTINCT FROM OLD.rendering_inputs
        ) AND NOT (OLD.status = 'PENDING' AND NEW.status = 'PENDING') THEN
            RAISE EXCEPTION 'data_version and rendering_inputs can only change while the report remains PENDING'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'AVAILABLE', 'FAILED') THEN
            RAISE EXCEPTION 'invalid PDF report status transition'
                USING ERRCODE = 'check_violation';
        ELSIF OLD.status = 'FAILED' AND NEW.status NOT IN ('FAILED', 'PENDING') THEN
            RAISE EXCEPTION 'invalid PDF report status transition'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    EXECUTE format(
        'SELECT id, clinical_snapshot_id FROM %I.inferences WHERE id = $1',
        TG_TABLE_SCHEMA
    ) INTO inference_exists, inference_snapshot USING NEW.inference_id;

    IF inference_exists IS NULL THEN
        RAISE EXCEPTION 'PDF report inference % does not exist', NEW.inference_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Provenance is captured at creation. A report records the exact snapshot
    -- known then (NULL remains an explicit historical "unknown"); a later
    -- parent snapshot must not freeze a legacy PENDING row or rewrite it.
    -- Updates cannot change source_snapshot_id (identity trigger), so only the
    -- INSERT path validates the parent at capture time.
    IF TG_OP = 'INSERT' AND NEW.source_snapshot_id IS DISTINCT FROM inference_snapshot THEN
        RAISE EXCEPTION 'PDF report source_snapshot_id must match the inference snapshot'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.artifact_id IS NOT NULL THEN
        EXECUTE format(
            'SELECT id, inference_id, artifact_type, version, status, content_type '
            'FROM %I.artifact_records WHERE id = $1',
            TG_TABLE_SCHEMA
        ) INTO artifact_exists, artifact_inference, artifact_type, artifact_version,
            artifact_status, artifact_content_type
        USING NEW.artifact_id;

        IF artifact_exists IS NULL THEN
            RAISE EXCEPTION 'PDF report artifact % does not exist', NEW.artifact_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        IF artifact_inference IS DISTINCT FROM NEW.inference_id
           OR artifact_type IS DISTINCT FROM 'pdf'
           OR artifact_version IS DISTINCT FROM NEW.version THEN
            RAISE EXCEPTION 'PDF report artifact must be a pdf artifact of the same inference and version'
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.status = 'AVAILABLE'
           AND (
               artifact_status IS DISTINCT FROM 'AVAILABLE'
               OR artifact_content_type IS DISTINCT FROM 'application/pdf'
           ) THEN
            RAISE EXCEPTION 'published PDF report requires an available application/pdf artifact'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pdf_reports_integrity_guard ON pdf_reports;
CREATE TRIGGER pdf_reports_integrity_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pdf_reports
    FOR EACH ROW EXECUTE FUNCTION pdf_reports_enforce_integrity();
