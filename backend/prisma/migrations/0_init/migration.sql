-- Clearsight clinical schema bootstrap.
--
-- This script is idempotent: every statement uses IF NOT EXISTS so it can be
-- re-executed safely (locally via docker-entrypoint-initdb.d, or manually on
-- Azure Database for PostgreSQL Flexible Server) without raising errors.
--
-- It creates the five core entities used by the platform: patients,
-- consultations, images, inferences and clinical_feedback (the gold-standard
-- source consumed by the ML retraining cycle).

-- patients --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_code VARCHAR(64),
    age INTEGER,
    gender VARCHAR(16),
    clinical_history_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    clinical_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patients_external_code
    ON patients (external_code);

-- consultations ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    doctor_id UUID NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDIENTE',
    clinical_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultations_patient_id
    ON consultations (patient_id);
CREATE INDEX IF NOT EXISTS idx_consultations_doctor_id
    ON consultations (doctor_id);
CREATE INDEX IF NOT EXISTS idx_consultations_status
    ON consultations (status);

-- images ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES consultations (id) ON DELETE CASCADE,
    eye_side VARCHAR(2) NOT NULL CHECK (eye_side IN ('OD', 'OS')),
    storage_path TEXT NOT NULL,
    hash_md5 VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_images_consultation_id
    ON images (consultation_id);
CREATE INDEX IF NOT EXISTS idx_images_hash_md5
    ON images (hash_md5);

-- inferences ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    image_id UUID NOT NULL REFERENCES images (id) ON DELETE CASCADE,
    predicted_class INTEGER,
    confidence DOUBLE PRECISION,
    probabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    gradcam_path TEXT,
    model_version VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inferences_image_id
    ON inferences (image_id);
CREATE INDEX IF NOT EXISTS idx_inferences_predicted_class
    ON inferences (predicted_class);

-- clinical_feedback -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES consultations (id) ON DELETE CASCADE,
    inference_id UUID NOT NULL REFERENCES inferences (id) ON DELETE CASCADE,
    doctor_id UUID NOT NULL,
    predicted_class INTEGER,
    validated_class INTEGER NOT NULL,
    confidence DOUBLE PRECISION,
    agreement BOOLEAN,
    doctor_notes TEXT,
    is_gold_standard BOOLEAN NOT NULL DEFAULT FALSE,
    clinical_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinical_feedback_consultation_id
    ON clinical_feedback (consultation_id);
CREATE INDEX IF NOT EXISTS idx_clinical_feedback_inference_id
    ON clinical_feedback (inference_id);
CREATE INDEX IF NOT EXISTS idx_clinical_feedback_doctor_id
    ON clinical_feedback (doctor_id);
CREATE INDEX IF NOT EXISTS idx_clinical_feedback_gold_standard
    ON clinical_feedback (is_gold_standard);
