-- Migration E: durable login protection (HU01 + complementary per-IP quota).
--
-- Additive and idempotent. Buckets store only purpose-scoped HMAC-SHA256
-- pseudonymous key hashes, never raw email/IP/secret/password. There is no FK
-- to users on purpose: unknown identifiers and synthetic internal callers are
-- counted too, and deleting a user must not evict protection state.
--
-- A-D and their history rows stay untouched. The grant block reuses the
-- least-privilege role created by D and never creates or escalates a role.

CREATE TABLE IF NOT EXISTS auth_login_buckets (
    kind VARCHAR(16) NOT NULL,
    key_hash VARCHAR(64) NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ(6),
    locked_until TIMESTAMPTZ(6),
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT auth_login_buckets_pkey PRIMARY KEY (kind, key_hash),
    CONSTRAINT auth_login_buckets_kind_check CHECK (kind IN ('IDENTIFIER', 'IP')),
    CONSTRAINT auth_login_buckets_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT auth_login_buckets_failure_count_nonnegative CHECK (failure_count >= 0),
    -- The fixed-window IP quota always has a window start; identifier lockout
    -- records carry only locked_until and therefore keep the window NULL.
    CONSTRAINT auth_login_buckets_window_state_check CHECK (
        (kind = 'IP' AND window_started_at IS NOT NULL)
        OR (kind = 'IDENTIFIER' AND window_started_at IS NULL)
    ),
    -- IP blocking is the computed window quota, never a stored lock timestamp.
    CONSTRAINT auth_login_buckets_lock_state_check CHECK (
        kind = 'IDENTIFIER' OR locked_until IS NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_auth_login_buckets_locked_until
    ON auth_login_buckets (locked_until);
CREATE INDEX IF NOT EXISTS idx_auth_login_buckets_updated_at
    ON auth_login_buckets (updated_at);

-- The application group role is owned by D. This migration only grants the
-- exact DML the guard needs and fails closed on missing/unsafe roles or any
-- effective forbidden privilege, including PUBLIC.
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
        RAISE EXCEPTION 'clearsight_app must exist before login protection grants; apply migration D first'
            USING ERRCODE = 'undefined_object';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE oid = app_oid
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
               OR rolreplication OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION 'existing clearsight_app has unsafe role attributes; refusing to grant login protection'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.relnamespace = to_regnamespace(schema_name)
          AND c.relname = 'auth_login_buckets'
          AND c.relowner = app_oid
    ) THEN
        RAISE EXCEPTION 'clearsight_app must not own auth_login_buckets'
            USING ERRCODE = 'check_violation';
    END IF;

    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO clearsight_app',
        schema_name, 'auth_login_buckets'
    );
    EXECUTE format(
        'REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %I.%I FROM clearsight_app',
        schema_name, 'auth_login_buckets'
    );

    qualified_name := format('%I.%I', schema_name, 'auth_login_buckets');

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
