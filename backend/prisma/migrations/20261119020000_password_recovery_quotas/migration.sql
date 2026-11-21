-- Durable password-recovery quotas (forgot/reset).
--
-- Additive and idempotent. Buckets store only purpose-scoped HMAC-SHA256
-- pseudonymous key hashes, never raw email/IP/secret/token. There is no FK to
-- users: unknown, inactive and active identifiers share the same quota path.
--
-- This migration does not reuse or modify auth_login_buckets. The application
-- role grant block mirrors the least-privilege pattern from login protection.

CREATE TABLE IF NOT EXISTS auth_recovery_buckets (
    kind VARCHAR(16) NOT NULL,
    key_hash VARCHAR(64) NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ(6) NOT NULL,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT auth_recovery_buckets_pkey PRIMARY KEY (kind, key_hash),
    CONSTRAINT auth_recovery_buckets_kind_check CHECK (
        kind IN ('FORGOT_EMAIL', 'FORGOT_IP', 'RESET_IP')
    ),
    CONSTRAINT auth_recovery_buckets_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    -- Fixed windows: 3/hour for forgot-email and 20/window for the two IP
    -- dimensions. The row can never hold a count above the approved limit.
    CONSTRAINT auth_recovery_buckets_attempt_count_check CHECK (
        (kind = 'FORGOT_EMAIL' AND attempt_count >= 0 AND attempt_count <= 3)
        OR (kind IN ('FORGOT_IP', 'RESET_IP') AND attempt_count >= 0 AND attempt_count <= 20)
    ),
    CONSTRAINT auth_recovery_buckets_window_check CHECK (updated_at >= window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_auth_recovery_buckets_window_started_at
    ON auth_recovery_buckets (window_started_at);
CREATE INDEX IF NOT EXISTS idx_auth_recovery_buckets_updated_at
    ON auth_recovery_buckets (updated_at);

-- The application group role is owned by the integrity-hardening migration.
-- This migration only grants the exact DML the guard needs and fails closed on
-- a missing/unsafe role, ownership, effective forbidden grants (including
-- PUBLIC) or a missing schema. It never rewrites the PUBLIC ACL.
DO $$
DECLARE
    app_oid OID;
    schema_name TEXT := current_schema();
    qualified_name TEXT;
BEGIN
    IF schema_name IS NULL THEN
        RAISE EXCEPTION 'no schema has been selected to create in'
            USING ERRCODE = '3F000';
    END IF;

    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'clearsight_app';
    IF app_oid IS NULL THEN
        RAISE EXCEPTION 'clearsight_app must exist before password recovery grants; apply the integrity-hardening migration first'
            USING ERRCODE = 'undefined_object';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE oid = app_oid
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
               OR rolreplication OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION 'existing clearsight_app has unsafe role attributes; refusing to grant password recovery quotas'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.relnamespace = to_regnamespace(schema_name)
          AND c.relname = 'auth_recovery_buckets'
          AND c.relowner = app_oid
    ) THEN
        RAISE EXCEPTION 'clearsight_app must not own auth_recovery_buckets'
            USING ERRCODE = 'check_violation';
    END IF;

    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO clearsight_app',
        schema_name, 'auth_recovery_buckets'
    );
    EXECUTE format(
        'REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %I.%I FROM clearsight_app',
        schema_name, 'auth_recovery_buckets'
    );

    qualified_name := format('%I.%I', schema_name, 'auth_recovery_buckets');

    -- Check PUBLIC first: a PUBLIC grant is inherited by clearsight_app, so the
    -- generic effective check alone would mask the actual source. Inspecting
    -- the ACL explodes the grant source without rewriting the PUBLIC ACL.
    IF EXISTS (
        SELECT 1
        FROM aclexplode(
            COALESCE(
                (SELECT c.relacl FROM pg_class c WHERE c.oid = qualified_name::regclass),
                acldefault('r', (SELECT c.relowner FROM pg_class c WHERE c.oid = qualified_name::regclass))
            )
        ) acl
        WHERE acl.grantee = 0
          AND acl.privilege_type IN ('DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
    ) THEN
        RAISE EXCEPTION 'effective forbidden PUBLIC privilege on %', qualified_name
            USING ERRCODE = 'check_violation';
    END IF;

    IF has_table_privilege(app_oid, qualified_name, 'DELETE')
       OR has_table_privilege(app_oid, qualified_name, 'TRUNCATE')
       OR has_table_privilege(app_oid, qualified_name, 'TRIGGER')
       OR has_table_privilege(app_oid, qualified_name, 'REFERENCES') THEN
        RAISE EXCEPTION 'effective forbidden privilege on %: clearsight_app must not have DELETE/TRUNCATE/TRIGGER/REFERENCES',
            qualified_name
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;
