-- Migration B: structured file artifacts and immutable PDF report versions.
--
-- Additive and idempotent. New tables start empty: legacy rows are not
-- backfilled. `result` remains the existing Inference projection; this table
-- stores binary/file artifacts (mask, overlay, pdf, gradcam, shap) only.
--
-- No signed URL, SAS or arbitrary endpoint is persisted. The key is preserved
-- exactly (unicode, `%`, spaces); checks only reject non-empty, URI-prefixed or
-- recognizable query-signature values.

-- 1. artifact_records ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inference_id UUID NOT NULL REFERENCES inferences (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- `result` is deliberately absent: it is the inline Inference projection.
    artifact_type VARCHAR(32) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    storage_id VARCHAR(128),
    bucket_or_container VARCHAR(255),
    key TEXT,
    content_type VARCHAR(255),
    size_bytes BIGINT,
    checksum_sha256 VARCHAR(64),
    failure_code VARCHAR(64),
    retryable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at TIMESTAMPTZ,
    CONSTRAINT artifact_records_artifact_type_check CHECK (
        artifact_type IN ('mask', 'overlay', 'pdf', 'gradcam', 'shap')
    ),
    CONSTRAINT artifact_records_version_positive CHECK (version > 0),
    CONSTRAINT artifact_records_status_check CHECK (
        status IN ('NOT_SUPPORTED', 'NOT_REQUESTED', 'PENDING', 'AVAILABLE', 'FAILED')
    ),
    -- AVAILABLE requires the complete public reference; any other state must
    -- expose no partial location. Explicit IS NULL/IS NOT NULL avoids the
    -- three-valued NULL loophole.
    CONSTRAINT artifact_records_available_fields_check CHECK (
        (
            status = 'AVAILABLE'
            AND storage_id IS NOT NULL
            AND bucket_or_container IS NOT NULL
            AND key IS NOT NULL
            AND content_type IS NOT NULL
            AND size_bytes IS NOT NULL
            AND checksum_sha256 IS NOT NULL
            AND available_at IS NOT NULL
        )
        OR
        (
            status <> 'AVAILABLE'
            AND storage_id IS NULL
            AND bucket_or_container IS NULL
            AND key IS NULL
            AND content_type IS NULL
            AND size_bytes IS NULL
            AND checksum_sha256 IS NULL
            AND available_at IS NULL
        )
    ),
    CONSTRAINT artifact_records_failure_check CHECK (
        (
            status = 'FAILED'
            AND failure_code IS NOT NULL
            AND failure_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
        )
        OR
        (
            status <> 'FAILED'
            AND failure_code IS NULL
            AND retryable = FALSE
        )
    ),
    CONSTRAINT artifact_records_storage_id_check CHECK (
        storage_id IS NULL
        OR (
            length(storage_id) BETWEEN 1 AND 128
            AND storage_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
            AND storage_id !~* '://'
        )
    ),
    CONSTRAINT artifact_records_bucket_check CHECK (
        bucket_or_container IS NULL
        OR (
            length(bucket_or_container) BETWEEN 1 AND 255
            AND bucket_or_container ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
            AND bucket_or_container !~* '://'
        )
    ),
    CONSTRAINT artifact_records_key_check CHECK (
        key IS NULL
        OR (
            length(btrim(key)) > 0
            -- Generic URI scheme, not a four-scheme allowlist; the exact key is
            -- otherwise preserved (unicode, spaces and `%` are not normalized).
            AND key !~* '^[a-z][a-z0-9+.-]*://'
            AND key !~* '(^|[?&])(sig|x-amz-signature|x-amz-credential|x-amz-security-token)='
        )
    ),
    CONSTRAINT artifact_records_content_type_check CHECK (
        content_type IS NULL
        OR (length(btrim(content_type)) > 0 AND content_type !~* '://')
    ),
    CONSTRAINT artifact_records_checksum_check CHECK (
        checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT artifact_records_size_check CHECK (
        size_bytes IS NULL OR size_bytes >= 0
    ),
    CONSTRAINT artifact_records_pdf_content_type_check CHECK (
        artifact_type <> 'pdf' OR status <> 'AVAILABLE' OR content_type = 'application/pdf'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_records_inference_id_artifact_type_version_key
    ON artifact_records (inference_id, artifact_type, version);
CREATE INDEX IF NOT EXISTS idx_artifact_records_inference_id
    ON artifact_records (inference_id);
CREATE INDEX IF NOT EXISTS idx_artifact_records_status
    ON artifact_records (status);

-- Identity is immutable. A published (AVAILABLE) record is completely
-- immutable: a later failure is a new explicit attempt/version, never a
-- destructive rewrite or silent "latest wins".
CREATE OR REPLACE FUNCTION artifact_records_enforce_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'AVAILABLE' THEN
            RAISE EXCEPTION 'published artifact records cannot be deleted'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.inference_id IS DISTINCT FROM OLD.inference_id
       OR NEW.artifact_type IS DISTINCT FROM OLD.artifact_type
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'artifact identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status = 'AVAILABLE' THEN
        RAISE EXCEPTION 'published artifact records are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS artifact_records_immutability_guard ON artifact_records;
CREATE TRIGGER artifact_records_immutability_guard
    BEFORE UPDATE OR DELETE ON artifact_records
    FOR EACH ROW EXECUTE FUNCTION artifact_records_enforce_immutability();

-- 2. pdf_reports -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdf_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inference_id UUID NOT NULL REFERENCES inferences (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    version INTEGER NOT NULL,
    artifact_id UUID REFERENCES artifact_records (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    source_snapshot_id UUID REFERENCES clinical_snapshots (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    document_kind VARCHAR(32) NOT NULL DEFAULT 'basic',
    data_version VARCHAR(128) NOT NULL,
    model_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    rendering_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    available_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pdf_reports_version_positive CHECK (version > 0),
    CONSTRAINT pdf_reports_status_check CHECK (
        status IN ('PENDING', 'AVAILABLE', 'FAILED')
    ),
    CONSTRAINT pdf_reports_document_kind_check CHECK (
        document_kind IN ('basic', 'gradcam', 'shap')
    ),
    CONSTRAINT pdf_reports_data_version_nonempty CHECK (
        length(btrim(data_version)) > 0
    ),
    CONSTRAINT pdf_reports_model_versions_object CHECK (
        jsonb_typeof(model_versions) = 'object'
    ),
    CONSTRAINT pdf_reports_rendering_inputs_object CHECK (
        jsonb_typeof(rendering_inputs) = 'object'
    ),
    CONSTRAINT pdf_reports_rendering_inputs_no_secrets CHECK (
        -- Generic URI schemes anywhere in the JSON text values, not only
        -- http(s)/s3/azure. The keys/query signature checks are bounded to the
        -- current contract; the future typed application allowlist remains 6.1.
        rendering_inputs::text !~* '[a-z][a-z0-9+.-]*://'
        AND rendering_inputs::text !~* '"(sig|x-amz-signature|x-amz-credential|x-amz-security-token)"[[:space:]]*:'
        AND rendering_inputs::text !~* '[?&](sig|x-amz-signature|x-amz-credential|x-amz-security-token)[[:space:]]*='
    ),
    CONSTRAINT pdf_reports_available_check CHECK (
        (
            status = 'AVAILABLE'
            AND artifact_id IS NOT NULL
            AND source_snapshot_id IS NOT NULL
            AND available_at IS NOT NULL
        )
        OR
        (
            status <> 'AVAILABLE'
            AND available_at IS NULL
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS pdf_reports_inference_id_version_key
    ON pdf_reports (inference_id, version);
CREATE INDEX IF NOT EXISTS idx_pdf_reports_inference_id
    ON pdf_reports (inference_id);
CREATE INDEX IF NOT EXISTS idx_pdf_reports_artifact_id
    ON pdf_reports (artifact_id);
CREATE INDEX IF NOT EXISTS idx_pdf_reports_source_snapshot_id
    ON pdf_reports (source_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_pdf_reports_status
    ON pdf_reports (status);

-- Report identity and rendering inputs are immutable from creation, including
-- while PENDING. Published rows are completely immutable. Allowed status
-- transitions: PENDING -> PENDING/AVAILABLE/FAILED and FAILED -> FAILED/PENDING.
-- A new version is a new row; no automatic "latest" and no required-set changes.
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
           OR NEW.data_version IS DISTINCT FROM OLD.data_version
           OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
           OR NEW.rendering_inputs IS DISTINCT FROM OLD.rendering_inputs
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'PDF report identity and rendering inputs are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.status = 'AVAILABLE' THEN
            RAISE EXCEPTION 'published PDF reports are immutable'
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
