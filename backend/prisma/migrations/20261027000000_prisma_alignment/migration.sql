-- Aligns the baseline (init.sql) with the Prisma schema and PROJECT.md.
--
-- Written to be re-runnable on a database that was already bootstrapped from
-- docker/init.sql (every step is guarded or idempotent).

-- 1. users --------------------------------------------------------------------
DO $$
BEGIN
    CREATE TYPE user_role AS ENUM ('OFTALMOLOGO', 'INVESTIGADOR', 'ADMIN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'OFTALMOLOGO',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

-- doctor_id was a bare UUID in init.sql. Create a disabled placeholder user for
-- every orphan id so the foreign keys below can be added without losing rows.
INSERT INTO users (id, email, password_hash, full_name, role, is_active)
SELECT d.doctor_id,
       'legacy-' || d.doctor_id::text || '@clearsight.invalid',
       '!',
       'Legacy doctor ' || left(d.doctor_id::text, 8),
       'OFTALMOLOGO',
       FALSE
FROM (
    SELECT doctor_id FROM consultations
    UNION
    SELECT doctor_id FROM clinical_feedback
) AS d
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.doctor_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'consultations_doctor_id_fkey'
          AND conrelid = 'consultations'::regclass
    ) THEN
        ALTER TABLE consultations
            ADD CONSTRAINT consultations_doctor_id_fkey
            FOREIGN KEY (doctor_id) REFERENCES users (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'clinical_feedback_doctor_id_fkey'
          AND conrelid = 'clinical_feedback'::regclass
    ) THEN
        ALTER TABLE clinical_feedback
            ADD CONSTRAINT clinical_feedback_doctor_id_fkey
            FOREIGN KEY (doctor_id) REFERENCES users (id)
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END
$$;

-- 2. consultations.status: single vocabulary (ml/service/schemas.py JobStatus) -
-- Legacy values: PENDIENTE -> QUEUED, EN_PROCESO -> QUEUED (re-driven from the
-- queue), COMPLETADA -> COMPLETED, FALLIDA -> FAILED.
ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_status_check;

UPDATE consultations
SET status = CASE status
    WHEN 'PENDIENTE'  THEN 'QUEUED'
    WHEN 'EN_PROCESO' THEN 'QUEUED'
    WHEN 'COMPLETADA' THEN 'COMPLETED'
    WHEN 'FALLIDA'    THEN 'FAILED'
    ELSE status
END;

ALTER TABLE consultations ALTER COLUMN status SET DEFAULT 'QUEUED';

ALTER TABLE consultations
    ADD CONSTRAINT consultations_status_check CHECK (status IN (
        'QUEUED', 'DOWNLOADING', 'LOCALIZING', 'SEGMENTING', 'CLASSIFYING',
        'COMPLETED', 'REVIEW_REQUIRED', 'FAILED'
    ));

-- 3. inferences: fields of the ML InferenceResult contract ---------------------
ALTER TABLE inferences
    ADD COLUMN IF NOT EXISTS job_id UUID,
    ADD COLUMN IF NOT EXISTS cdr DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cdr_vertical DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS quality JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS elapsed_seconds DOUBLE PRECISION;

CREATE UNIQUE INDEX IF NOT EXISTS inferences_job_id_key ON inferences (job_id);

-- 4. clinical_feedback ---------------------------------------------------------
-- NULL validated_class = "no concluyente" (PROJECT.md).
ALTER TABLE clinical_feedback ALTER COLUMN validated_class DROP NOT NULL;

ALTER TABLE clinical_feedback
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One verdict per doctor per inference (target of the /feedback upsert).
-- If duplicates already exist, keep the most recent one.
DELETE FROM clinical_feedback AS older
USING clinical_feedback AS newer
WHERE older.inference_id = newer.inference_id
  AND older.doctor_id = newer.doctor_id
  AND (
      older.created_at < newer.created_at
      OR (older.created_at = newer.created_at AND older.id < newer.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS clinical_feedback_inference_id_doctor_id_key
    ON clinical_feedback (inference_id, doctor_id);

-- A "no concluyente" verdict can never feed retraining.
ALTER TABLE clinical_feedback
    DROP CONSTRAINT IF EXISTS clinical_feedback_gold_requires_label;
ALTER TABLE clinical_feedback
    ADD CONSTRAINT clinical_feedback_gold_requires_label
    CHECK (NOT is_gold_standard OR validated_class IS NOT NULL);
