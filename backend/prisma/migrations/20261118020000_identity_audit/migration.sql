-- Migration C: durable identity, audit, sessions, credentials and idempotency.
--
-- Additive and idempotent. No auth route/service/worker behavior is implemented
-- here. New history tables start empty; legacy users keep valid defaults.
-- All SQL guards use TG_TABLE_SCHEMA/search_path so isolated test schemas work.

-- 1. users: future auth metadata ---------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ(6);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_token_version_nonnegative'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_token_version_nonnegative CHECK (token_version >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_failed_login_count_nonnegative'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_failed_login_count_nonnegative CHECK (failed_login_count >= 0);
    END IF;
END
$$;

-- Revocation versions may increase, never decrease, even through direct SQL.
CREATE OR REPLACE FUNCTION users_token_version_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.token_version < OLD.token_version THEN
        RAISE EXCEPTION 'users.token_version cannot decrease'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_token_version_monotonic_guard ON users;
CREATE TRIGGER users_token_version_monotonic_guard
    BEFORE UPDATE OF token_version ON users
    FOR EACH ROW EXECUTE FUNCTION users_token_version_monotonic();

-- 2. user_sessions -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    issued_token_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    reason_code VARCHAR(64),
    last_used_at TIMESTAMPTZ,
    CONSTRAINT user_sessions_issued_token_version_nonnegative CHECK (issued_token_version >= 0),
    CONSTRAINT user_sessions_expiry_positive CHECK (expires_at > created_at),
    CONSTRAINT user_sessions_revocation_pair CHECK (
        (revoked_at IS NULL AND reason_code IS NULL)
        OR (revoked_at IS NOT NULL AND reason_code IS NOT NULL)
    ),
    CONSTRAINT user_sessions_reason_code_check CHECK (
        reason_code IS NULL OR reason_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
    ),
    CONSTRAINT user_sessions_last_used_check CHECK (
        last_used_at IS NULL OR last_used_at >= created_at
    )
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
    ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at
    ON user_sessions (expires_at);

-- Session identity/expiry are fixed at creation. Revocation is append-only and
-- lastUsedAt is monotonic. Creating a session requires an active user whose
-- current tokenVersion matches the issued version.
CREATE OR REPLACE FUNCTION user_sessions_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_is_active BOOLEAN;
    user_token_version INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        EXECUTE format(
            'SELECT is_active, token_version FROM %I.users WHERE id = $1',
            TG_TABLE_SCHEMA
        ) INTO user_is_active, user_token_version USING NEW.user_id;

        IF user_is_active IS NULL THEN
            RAISE EXCEPTION 'session user % does not exist', NEW.user_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NOT user_is_active THEN
            RAISE EXCEPTION 'cannot create a session for an inactive user'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.issued_token_version <> user_token_version THEN
            RAISE EXCEPTION 'session issued_token_version must match the user token_version'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.last_used_at IS NOT NULL AND NEW.last_used_at < NEW.created_at THEN
            RAISE EXCEPTION 'session last_used_at cannot precede created_at'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.issued_token_version IS DISTINCT FROM OLD.issued_token_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'session identity, version and expiry are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.revoked_at IS NOT NULL
       AND (
           NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
           OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       ) THEN
        RAISE EXCEPTION 'session revocation is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.last_used_at IS NOT NULL
       AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
        RAISE EXCEPTION 'session last_used_at must be monotonic'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_sessions_integrity_guard ON user_sessions;
CREATE TRIGGER user_sessions_integrity_guard
    BEFORE INSERT OR UPDATE ON user_sessions
    FOR EACH ROW EXECUTE FUNCTION user_sessions_enforce_integrity();

-- 3. audit_events ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_kind VARCHAR(16) NOT NULL,
    actor_user_id UUID REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    target_type VARCHAR(64) NOT NULL,
    target_id UUID,
    target_user_id UUID REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    action VARCHAR(64) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_events_actor_kind_check CHECK (
        actor_kind IN ('USER', 'SYSTEM', 'ANONYMOUS')
    ),
    CONSTRAINT audit_events_actor_pair_check CHECK (
        (actor_kind = 'USER' AND actor_user_id IS NOT NULL)
        OR (actor_kind IN ('SYSTEM', 'ANONYMOUS') AND actor_user_id IS NULL)
    ),
    CONSTRAINT audit_events_target_type_check CHECK (
        target_type ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT audit_events_target_pair_check CHECK (
        (target_type = 'USER' AND target_user_id IS NOT NULL AND target_id IS NULL)
        OR (target_type <> 'USER' AND target_user_id IS NULL)
    ),
    CONSTRAINT audit_events_action_check CHECK (
        action ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT audit_events_outcome_check CHECK (
        outcome IN ('SUCCESS', 'DENIED', 'FAILURE')
    ),
    CONSTRAINT audit_events_metadata_object CHECK (
        jsonb_typeof(metadata) = 'object'
    ),
    CONSTRAINT audit_events_metadata_no_secrets CHECK (
        metadata::text !~* '[a-z][a-z0-9+.-]*://'
        AND metadata::text !~* '"(sig|x-amz-signature|x-amz-credential|x-amz-security-token)"[[:space:]]*:'
        AND metadata::text !~* '[?&](sig|x-amz-signature|x-amz-credential|x-amz-security-token)[[:space:]]*='
    )
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_user_id
    ON audit_events (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_target_user_id
    ON audit_events (target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_target_id
    ON audit_events (target_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action
    ON audit_events (action);
CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at
    ON audit_events (occurred_at);

-- Append-only audit. TRUNCATE/DDL by a privileged owner remains task 1.4.
CREATE OR REPLACE FUNCTION audit_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit events are append-only; % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only_guard ON audit_events;
CREATE TRIGGER audit_events_append_only_guard
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

-- 4. refresh_tokens ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    session_id UUID NOT NULL REFERENCES user_sessions (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    parent_token_id UUID REFERENCES refresh_tokens (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    token_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT refresh_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT refresh_tokens_expiry_positive CHECK (expires_at > created_at),
    CONSTRAINT refresh_tokens_consumed_bound CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    ),
    CONSTRAINT refresh_tokens_revoked_bound CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key
    ON refresh_tokens (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_parent_token_id_key
    ON refresh_tokens (parent_token_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session_id
    ON refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);

-- Refresh tokens store only a lowercase SHA-256 hash. Session/user/expiry and
-- parent pointers are immutable; parent is insert-only, which prevents cycles.
-- consumedAt/revokedAt are append-only. Family reuse detection remains 5.8.
CREATE OR REPLACE FUNCTION refresh_tokens_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_user_id UUID;
    session_expires_at TIMESTAMPTZ;
    session_revoked_at TIMESTAMPTZ;
    parent_session_id UUID;
    parent_created_at TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'INSERT' THEN
        EXECUTE format(
            'SELECT user_id, expires_at, revoked_at FROM %I.user_sessions WHERE id = $1',
            TG_TABLE_SCHEMA
        ) INTO session_user_id, session_expires_at, session_revoked_at
        USING NEW.session_id;

        IF session_user_id IS NULL THEN
            RAISE EXCEPTION 'refresh token session % does not exist', NEW.session_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF session_user_id <> NEW.user_id THEN
            RAISE EXCEPTION 'refresh token user does not match the session user'
                USING ERRCODE = 'check_violation';
        END IF;
        IF session_revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'cannot issue a refresh token for a revoked session'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.expires_at > session_expires_at THEN
            RAISE EXCEPTION 'refresh token expiry exceeds the session expiry'
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.parent_token_id IS NOT NULL THEN
            EXECUTE format(
                'SELECT session_id, created_at FROM %I.refresh_tokens WHERE id = $1',
                TG_TABLE_SCHEMA
            ) INTO parent_session_id, parent_created_at USING NEW.parent_token_id;

            IF parent_session_id IS NULL THEN
                RAISE EXCEPTION 'parent refresh token % does not exist', NEW.parent_token_id
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            IF parent_session_id <> NEW.session_id THEN
                RAISE EXCEPTION 'parent refresh token must belong to the same session'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.created_at < parent_created_at THEN
                RAISE EXCEPTION 'child refresh token cannot precede its parent'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.parent_token_id IS DISTINCT FROM OLD.parent_token_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'refresh token identity, hash and expiry are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'refresh token consumed_at is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'refresh token revoked_at is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_tokens_integrity_guard ON refresh_tokens;
CREATE TRIGGER refresh_tokens_integrity_guard
    BEFORE INSERT OR UPDATE ON refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION refresh_tokens_enforce_integrity();

-- 5. password_reset_tokens ---------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    token_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT password_reset_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT password_reset_tokens_expiry_check CHECK (
        expires_at > created_at
        AND expires_at <= created_at + INTERVAL '30 minutes'
    ),
    CONSTRAINT password_reset_tokens_consumed_bound CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    ),
    CONSTRAINT password_reset_tokens_revoked_bound CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_token_hash_key
    ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
    ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
    ON password_reset_tokens (expires_at);

-- Only a lowercase SHA-256 hash is stored. Identity/expiry are immutable and
-- consumed/revoked timestamps are append-only. Reset behavior remains 5.9.
CREATE OR REPLACE FUNCTION password_reset_tokens_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'password reset token identity, hash and expiry are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'password reset token consumed_at is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'password reset token revoked_at is append-only'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS password_reset_tokens_integrity_guard ON password_reset_tokens;
CREATE TRIGGER password_reset_tokens_integrity_guard
    BEFORE UPDATE ON password_reset_tokens
    FOR EACH ROW EXECUTE FUNCTION password_reset_tokens_enforce_integrity();

-- 6. idempotency_records -----------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    scope VARCHAR(128) NOT NULL,
    key VARCHAR(128) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    inference_id UUID NOT NULL REFERENCES inferences (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    resolved_model_versions JSONB NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    response_status INTEGER,
    response_body JSONB,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_records_scope_nonempty CHECK (length(btrim(scope)) > 0),
    CONSTRAINT idempotency_records_key_nonempty CHECK (length(btrim(key)) > 0),
    CONSTRAINT idempotency_records_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT idempotency_records_model_versions_object CHECK (
        jsonb_typeof(resolved_model_versions) = 'object'
    ),
    CONSTRAINT idempotency_records_state_check CHECK (state IN ('PENDING', 'ACCEPTED')),
    CONSTRAINT idempotency_records_response_status_check CHECK (
        response_status IS NULL OR response_status = 202
    ),
    CONSTRAINT idempotency_records_response_body_object CHECK (
        response_body IS NULL OR jsonb_typeof(response_body) = 'object'
    ),
    CONSTRAINT idempotency_records_response_body_no_secrets CHECK (
        response_body IS NULL
        OR (
            response_body::text !~* '[a-z][a-z0-9+.-]*://'
            AND response_body::text !~* '"(sig|x-amz-signature|x-amz-credential|x-amz-security-token)"[[:space:]]*:'
            AND response_body::text !~* '[?&](sig|x-amz-signature|x-amz-credential|x-amz-security-token)[[:space:]]*='
        )
    ),
    CONSTRAINT idempotency_records_accepted_check CHECK (
        (
            state = 'PENDING'
            AND response_status IS NULL
            AND response_body IS NULL
            AND accepted_at IS NULL
        )
        OR
        (
            state = 'ACCEPTED'
            AND response_status = 202
            AND response_body IS NOT NULL
            AND accepted_at IS NOT NULL
            AND accepted_at >= created_at
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_actor_user_id_scope_key_key
    ON idempotency_records (actor_user_id, scope, key);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_inference_id
    ON idempotency_records (inference_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_accepted_at
    ON idempotency_records (accepted_at);

-- Identity, scope/key/hash, execution and pinned model versions are fixed at
-- creation. PENDING may become ACCEPTED once; accepted rows are immutable and
-- cannot be deleted until an approved retention policy (B3). The actor must own
-- the inference case through consultation.doctorId (legacy NULL falls back to
-- the authoritative image consultation). Response is the exact 202 shape.
CREATE OR REPLACE FUNCTION idempotency_records_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    inference_job_id UUID;
    owner_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'idempotency records cannot be deleted until retention is approved'
            USING ERRCODE = 'restrict_violation';
    END IF;

    EXECUTE format(
        'SELECT i.job_id, c.doctor_id '
        'FROM %I.inferences i '
        'JOIN %I.images img ON img.id = i.image_id '
        'JOIN %I.consultations c ON c.id = COALESCE(i.consultation_id, img.consultation_id) '
        'WHERE i.id = $1',
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO inference_job_id, owner_id USING NEW.inference_id;

    IF owner_id IS NULL THEN
        RAISE EXCEPTION 'idempotency inference % has no owning consultation', NEW.inference_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF owner_id <> NEW.actor_user_id THEN
        RAISE EXCEPTION 'idempotency actor does not own the inference case'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
           OR NEW.scope IS DISTINCT FROM OLD.scope
           OR NEW.key IS DISTINCT FROM OLD.key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.inference_id IS DISTINCT FROM OLD.inference_id
           OR NEW.resolved_model_versions IS DISTINCT FROM OLD.resolved_model_versions
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'idempotency identity, hash, execution and model versions are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.state = 'ACCEPTED' THEN
            RAISE EXCEPTION 'accepted idempotency records are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF NEW.state = 'ACCEPTED' THEN
        IF NEW.response_status IS DISTINCT FROM 202
           OR NEW.response_body IS NULL
           OR NEW.accepted_at IS NULL THEN
            RAISE EXCEPTION 'accepted idempotency record requires a complete response'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.response_body->>'inferenceId' IS DISTINCT FROM NEW.inference_id::text THEN
            RAISE EXCEPTION 'idempotency response inferenceId must match the execution'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.response_body->>'jobId'
           IS DISTINCT FROM COALESCE(inference_job_id::text, NEW.inference_id::text) THEN
            RAISE EXCEPTION 'idempotency response jobId must match the stable execution job'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.response_body->>'status' IS DISTINCT FROM 'QUEUED' THEN
            RAISE EXCEPTION 'idempotency response status must be QUEUED'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS idempotency_records_integrity_guard ON idempotency_records;
CREATE TRIGGER idempotency_records_integrity_guard
    BEFORE INSERT OR UPDATE OR DELETE ON idempotency_records
    FOR EACH ROW EXECUTE FUNCTION idempotency_records_enforce_integrity();
