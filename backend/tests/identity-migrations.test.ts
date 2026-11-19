import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { inject } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Migration C invariants on a fresh schema. The schema is owned by this file
 * and dropped afterwards; it never touches the shared public test schema.
 */
const SCHEMA = "identity_rules";
const MIGRATIONS = migrationNames();
const IDENTITY_MIGRATION = "20261118020000_identity_audit";

const D1 = "00000000-0000-4000-8000-0000000003d1";
const D2 = "00000000-0000-4000-8000-0000000003d2";
const D3 = "00000000-0000-4000-8000-0000000003d3";
const INACTIVE = "00000000-0000-4000-8000-0000000003d4";
const P = "00000000-0000-4000-8000-0000000003a1";
const C1 = "00000000-0000-4000-8000-0000000003c1";
const C2 = "00000000-0000-4000-8000-0000000003c2";
const IMG1 = "00000000-0000-4000-8000-0000000003b1";
const IMG2 = "00000000-0000-4000-8000-0000000003b2";
const I1 = "00000000-0000-4000-8000-0000000003e1";
const I2 = "00000000-0000-4000-8000-0000000003e2";
const I3 = "00000000-0000-4000-8000-0000000003e3";
const J1 = "00000000-0000-4000-8000-0000000003f1";
const J2 = "00000000-0000-4000-8000-0000000003f2";
const J3 = "00000000-0000-4000-8000-0000000003f3";
const SESS1 = "00000000-0000-4000-8000-0000000004a1";
const SESS2 = "00000000-0000-4000-8000-0000000004a2";
const SESS3 = "00000000-0000-4000-8000-0000000004a3";
const RT1 = "00000000-0000-4000-8000-0000000004b1";
const RT2 = "00000000-0000-4000-8000-0000000004b2";
const RT3 = "00000000-0000-4000-8000-0000000004b3";
const PR1 = "00000000-0000-4000-8000-0000000004c1";
const PR2 = "00000000-0000-4000-8000-0000000004c2";
const AE1 = "00000000-0000-4000-8000-0000000004d1";
const AE2 = "00000000-0000-4000-8000-0000000004d2";
const AE3 = "00000000-0000-4000-8000-0000000004d3";
const ID1 = "00000000-0000-4000-8000-0000000004e1";
const ID2 = "00000000-0000-4000-8000-0000000004e2";
const ID3 = "00000000-0000-4000-8000-0000000004e3";
const ID4 = "00000000-0000-4000-8000-0000000004e4";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
  for (const name of MIGRATIONS) {
    await client.query(migrationSql(name));
  }
});

afterAll(async () => {
  await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

beforeEach(async () => {
  await client.query(
    "TRUNCATE TABLE idempotency_records, audit_events, password_reset_tokens, refresh_tokens, user_sessions, pdf_reports, artifact_records, clinical_snapshots, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
  );
});

async function seedBase(): Promise<void> {
  await client.query(
    "INSERT INTO users (id, email, password_hash, full_name, role, is_active, token_version) VALUES " +
      "($1, $2, 'x', 'Dr One', 'OFTALMOLOGO', TRUE, 0), " +
      "($3, $4, 'x', 'Dr Two', 'OFTALMOLOGO', TRUE, 0), " +
      "($5, $6, 'x', 'Dr Three', 'OFTALMOLOGO', TRUE, 0), " +
      "($7, $8, 'x', 'Inactive', 'OFTALMOLOGO', FALSE, 0)",
    [D1, "d1@identity.test", D2, "d2@identity.test", D3, "d3@identity.test", INACTIVE, "inactive@identity.test"],
  );
  await client.query("INSERT INTO patients (id) VALUES ($1)", [P]);
  await client.query(
    "INSERT INTO consultations (id, patient_id, doctor_id) VALUES ($1, $2, $3), ($4, $2, $5)",
    [C1, P, D1, C2, D2],
  );
  await client.query(
    "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'a'), ($3, $4, 'OD', 'b')",
    [IMG1, C1, IMG2, C2],
  );
  await client.query(
    "INSERT INTO inferences (id, image_id, consultation_id, eye_side, job_id, status) VALUES " +
      "($1, $2, $3, 'OD', $4, 'COMPLETED'), " +
      "($5, $6, $7, 'OD', $8, 'COMPLETED'), " +
      "($9, $2, NULL, NULL, $10, 'COMPLETED')",
    [I1, IMG1, C1, J1, I2, IMG2, C2, J2, I3, J3],
  );
}

async function insertSession(
  id: string,
  userId: string,
  opts: {
    issuedTokenVersion?: number;
    createdAt?: Date;
    expiresAt?: Date;
    revokedAt?: Date | null;
    reasonCode?: string | null;
    lastUsedAt?: Date | null;
  } = {},
): Promise<void> {
  const createdAt = opts.createdAt ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(createdAt.getTime() + 86_400_000);

  await client.query(
    "INSERT INTO user_sessions (id, user_id, issued_token_version, created_at, expires_at, revoked_at, reason_code, last_used_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      userId,
      opts.issuedTokenVersion ?? 0,
      createdAt,
      expiresAt,
      opts.revokedAt ?? null,
      opts.reasonCode ?? null,
      opts.lastUsedAt ?? null,
    ],
  );
}

async function insertRefreshToken(
  id: string,
  userId: string,
  sessionId: string,
  opts: {
    parentTokenId?: string | null;
    tokenHash?: string;
    createdAt?: Date;
    expiresAt?: Date;
    consumedAt?: Date | null;
    revokedAt?: Date | null;
  } = {},
): Promise<void> {
  const createdAt = opts.createdAt ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(createdAt.getTime() + 3_600_000);

  await client.query(
    "INSERT INTO refresh_tokens (id, user_id, session_id, parent_token_id, token_hash, created_at, expires_at, consumed_at, revoked_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      userId,
      sessionId,
      opts.parentTokenId ?? null,
      opts.tokenHash ?? HASH_A,
      createdAt,
      expiresAt,
      opts.consumedAt ?? null,
      opts.revokedAt ?? null,
    ],
  );
}

async function insertPasswordResetToken(
  id: string,
  userId: string,
  opts: {
    tokenHash?: string;
    createdAt?: Date;
    expiresAt?: Date;
    consumedAt?: Date | null;
    revokedAt?: Date | null;
  } = {},
): Promise<void> {
  const createdAt = opts.createdAt ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(createdAt.getTime() + 30 * 60_000);

  await client.query(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at, consumed_at, revoked_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, userId, opts.tokenHash ?? HASH_B, createdAt, expiresAt, opts.consumedAt ?? null, opts.revokedAt ?? null],
  );
}

async function insertAudit(
  id: string,
  opts: {
    actorKind?: string;
    actorUserId?: string | null;
    targetType?: string;
    targetId?: string | null;
    targetUserId?: string | null;
    action?: string;
    outcome?: string;
    requestId?: string | null;
    metadata?: unknown;
  } = {},
): Promise<void> {
  const actorKind = opts.actorKind ?? "USER";
  await client.query(
    "INSERT INTO audit_events (id, actor_kind, actor_user_id, target_type, target_id, target_user_id, action, outcome, request_id, metadata) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)",
    [
      id,
      actorKind,
      opts.actorUserId !== undefined ? opts.actorUserId : actorKind === "USER" ? D1 : null,
      opts.targetType ?? "INFERENCE",
      opts.targetId !== undefined ? opts.targetId : opts.targetType === "USER" ? null : I1,
      opts.targetUserId !== undefined ? opts.targetUserId : opts.targetType === "USER" ? D3 : null,
      opts.action ?? "LOGIN",
      opts.outcome ?? "SUCCESS",
      opts.requestId ?? null,
      JSON.stringify(opts.metadata ?? {}),
    ],
  );
}

async function insertIdempotency(
  id: string,
  actorUserId: string,
  inferenceId: string,
  opts: {
    scope?: string;
    key?: string;
    payloadHash?: string;
    modelVersions?: unknown;
    state?: string;
    responseStatus?: number | null;
    responseBody?: unknown;
    acceptedAt?: Date | null;
    createdAt?: Date;
  } = {},
): Promise<void> {
  await client.query(
    "INSERT INTO idempotency_records (id, actor_user_id, scope, key, payload_hash, inference_id, resolved_model_versions, state, response_status, response_body, accepted_at, created_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12)",
    [
      id,
      actorUserId,
      opts.scope ?? "inferences:create",
      opts.key ?? `key-${id}`,
      opts.payloadHash ?? HASH_C,
      inferenceId,
      JSON.stringify(opts.modelVersions ?? { model: "2026-09-24" }),
      opts.state ?? "PENDING",
      opts.responseStatus ?? null,
      opts.responseBody === undefined ? null : JSON.stringify(opts.responseBody),
      opts.acceptedAt ?? null,
      opts.createdAt ?? new Date(),
    ],
  );
}

function acceptedBody(inferenceId: string, jobId: string): Record<string, string> {
  return { inferenceId, jobId, status: "QUEUED" };
}

describe("migration C identity, audit, sessions and idempotency", () => {
  it("creates the expected tables and legacy user auth defaults", async () => {
    expect(MIGRATIONS).toContain(IDENTITY_MIGRATION);

    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN " +
        "('user_sessions', 'audit_events', 'refresh_tokens', 'password_reset_tokens', 'idempotency_records') ORDER BY table_name",
      [SCHEMA],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "audit_events",
      "idempotency_records",
      "password_reset_tokens",
      "refresh_tokens",
      "user_sessions",
    ]);

    const userColumns = await client.query(
      "SELECT column_name, column_default, is_nullable FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'users' AND column_name IN ('token_version', 'failed_login_count', 'locked_until')",
      [SCHEMA],
    );
    expect(userColumns.rows).toEqual(
      expect.arrayContaining([
        { column_name: "token_version", column_default: "0", is_nullable: "NO" },
        { column_name: "failed_login_count", column_default: "0", is_nullable: "NO" },
        { column_name: "locked_until", column_default: null, is_nullable: "YES" },
      ]),
    );

    await client.query("INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Legacy')", [
      D3,
      "legacy@identity.test",
    ]);
    const user = await client.query(
      "SELECT token_version, failed_login_count, locked_until, role, is_active FROM users WHERE id = $1",
      [D3],
    );
    expect(user.rows).toEqual([
      { token_version: 0, failed_login_count: 0, locked_until: null, role: "OFTALMOLOGO", is_active: true },
    ]);

    const counts = await client.query(
      "SELECT (SELECT count(*)::int FROM user_sessions) AS sessions, " +
        "(SELECT count(*)::int FROM audit_events) AS audits, " +
        "(SELECT count(*)::int FROM refresh_tokens) AS refresh, " +
        "(SELECT count(*)::int FROM password_reset_tokens) AS reset, " +
        "(SELECT count(*)::int FROM idempotency_records) AS idempotency",
    );
    expect(counts.rows).toEqual([{ sessions: 0, audits: 0, refresh: 0, reset: 0, idempotency: 0 }]);
  });

  it("keeps user counters non-negative and tokenVersion monotonic without touching role/status", async () => {
    await seedBase();
    const before = await client.query("SELECT role, is_active, password_hash FROM users WHERE id = $1", [D1]);
    await client.query("UPDATE users SET token_version = 1, failed_login_count = 3 WHERE id = $1", [D1]);
    await expect(client.query("UPDATE users SET token_version = 0 WHERE id = $1", [D1])).rejects.toThrow(
      /users\.token_version cannot decrease/,
    );
    await expect(client.query("UPDATE users SET token_version = -1 WHERE id = $1", [D1])).rejects.toThrow(
      /users_token_version_nonnegative|users\.token_version cannot decrease/,
    );
    await expect(client.query("UPDATE users SET failed_login_count = -1 WHERE id = $1", [D1])).rejects.toThrow(
      /users_failed_login_count_nonnegative/,
    );
    const after = await client.query("SELECT role, is_active, password_hash, token_version, failed_login_count FROM users WHERE id = $1", [
      D1,
    ]);
    expect(after.rows).toEqual([
      {
        role: "OFTALMOLOGO",
        is_active: true,
        password_hash: "x",
        token_version: 1,
        failed_login_count: 3,
      },
    ]);
    expect(after.rows[0]).toMatchObject(before.rows[0]);
  });

  it("enforces append-only audit actors, targets and metadata", async () => {
    await seedBase();
    await insertAudit(AE1);
    await insertAudit(AE2, { actorKind: "SYSTEM", actorUserId: null, targetType: "SYSTEM", targetId: null });
    await insertAudit(AE3, {
      actorKind: "ANONYMOUS",
      actorUserId: null,
      targetType: "USER",
      targetUserId: D3,
    });

    await expect(insertAudit(AE1, { actorKind: "USER", actorUserId: null })).rejects.toThrow(
      /audit_events_actor_pair_check/,
    );
    await expect(insertAudit(AE1, { actorKind: "SYSTEM", actorUserId: D1 })).rejects.toThrow(
      /audit_events_actor_pair_check/,
    );
    await expect(
      insertAudit(AE1, { targetType: "USER", targetUserId: D3, targetId: I1 }),
    ).rejects.toThrow(/audit_events_target_pair_check/);
    await expect(
      insertAudit(AE1, { targetType: "INFERENCE", targetId: I1, targetUserId: D3 }),
    ).rejects.toThrow(/audit_events_target_pair_check/);
    await expect(insertAudit(AE1, { action: "login" })).rejects.toThrow(/audit_events_action_check/);
    await expect(insertAudit(AE1, { outcome: "MAYBE" })).rejects.toThrow(/audit_events_outcome_check/);
    await expect(insertAudit(AE1, { metadata: [] })).rejects.toThrow(/audit_events_metadata_object/);
    await expect(insertAudit(AE1, { metadata: { url: "https://example.test/x" } })).rejects.toThrow(
      /audit_events_metadata_no_secrets/,
    );
    await expect(insertAudit(AE1, { metadata: { sig: "secret" } })).rejects.toThrow(
      /audit_events_metadata_no_secrets/,
    );

    await expect(client.query("UPDATE audit_events SET outcome = 'FAILURE' WHERE id = $1", [AE1])).rejects.toThrow(
      /append-only/,
    );
    await expect(client.query("DELETE FROM audit_events WHERE id = $1", [AE1])).rejects.toThrow(/append-only/);

    await expect(client.query("DELETE FROM users WHERE id = $1", [D3])).rejects.toThrow(/foreign key/);
    await expect(client.query("UPDATE users SET is_active = FALSE WHERE id = $1", [D3])).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("keeps session identity/expiry fixed and revocation append-only", async () => {
    await seedBase();
    await insertSession(SESS1, D1);
    await expect(insertSession(SESS2, INACTIVE)).rejects.toThrow(/inactive user/);
    await expect(insertSession(SESS2, D1, { issuedTokenVersion: 1 })).rejects.toThrow(/must match/);
    const sameInstant = new Date();
    await expect(
      insertSession(SESS2, D1, { createdAt: sameInstant, expiresAt: sameInstant }),
    ).rejects.toThrow(/user_sessions_expiry_positive/);
    await expect(insertSession(SESS2, D1, { issuedTokenVersion: -1 })).rejects.toThrow(
      /must match|user_sessions_issued_token_version_nonnegative/,
    );

    await expect(
      client.query("UPDATE user_sessions SET expires_at = expires_at + interval '1 day' WHERE id = $1", [SESS1]),
    ).rejects.toThrow(/identity, version and expiry are immutable/);
    await expect(
      client.query("UPDATE user_sessions SET issued_token_version = 1 WHERE id = $1", [SESS1]),
    ).rejects.toThrow(/identity, version and expiry are immutable/);
    await expect(
      client.query("UPDATE user_sessions SET user_id = $2 WHERE id = $1", [SESS1, D2]),
    ).rejects.toThrow(/identity, version and expiry are immutable/);
    await expect(
      client.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [SESS1]),
    ).rejects.toThrow(/user_sessions_revocation_pair/);
    await client.query("UPDATE user_sessions SET revoked_at = now(), reason_code = 'LOGOUT' WHERE id = $1", [SESS1]);
    await expect(
      client.query("UPDATE user_sessions SET revoked_at = NULL, reason_code = NULL WHERE id = $1", [SESS1]),
    ).rejects.toThrow(/revocation is append-only/);
    await expect(
      client.query("UPDATE user_sessions SET reason_code = 'OTHER' WHERE id = $1", [SESS1]),
    ).rejects.toThrow(/revocation is append-only/);

    await insertSession(SESS2, D2);
    const later = new Date(Date.now() + 60_000);
    await client.query("UPDATE user_sessions SET last_used_at = $2 WHERE id = $1", [SESS2, later]);
    await expect(
      client.query("UPDATE user_sessions SET last_used_at = last_used_at - interval '1 second' WHERE id = $1", [SESS2]),
    ).rejects.toThrow(/last_used_at must be monotonic/);
    await expect(
      client.query("UPDATE user_sessions SET last_used_at = NULL WHERE id = $1", [SESS2]),
    ).rejects.toThrow(/last_used_at must be monotonic/);

    await insertSession(SESS3, D3);
    await expect(client.query("DELETE FROM users WHERE id = $1", [D3])).rejects.toThrow(/foreign key/);
  });

  it("binds refresh tokens to the session, hash, expiry and parent chain", async () => {
    await seedBase();
    await insertSession(SESS1, D1);
    await insertSession(SESS2, D2);
    await insertRefreshToken(RT1, D1, SESS1, { tokenHash: HASH_A });
    await insertRefreshToken(RT2, D1, SESS1, { parentTokenId: RT1, tokenHash: HASH_B });

    await expect(
      insertRefreshToken(RT3, D2, SESS2, { parentTokenId: RT1, tokenHash: HASH_C }),
    ).rejects.toThrow(/same session/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, {
        parentTokenId: "00000000-0000-4000-8000-0000000004ff",
        tokenHash: HASH_C,
      }),
    ).rejects.toThrow(/parent refresh token/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, { tokenHash: HASH_A }),
    ).rejects.toThrow(/refresh_tokens_token_hash_key|duplicate key/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, { tokenHash: "A".repeat(64) }),
    ).rejects.toThrow(/refresh_tokens_hash_check/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, { expiresAt: new Date(Date.now() + 2 * 86_400_000), tokenHash: HASH_C }),
    ).rejects.toThrow(/expiry exceeds the session expiry/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, {
        parentTokenId: RT1,
        createdAt: new Date(Date.now() - 60_000),
        tokenHash: HASH_C,
      }),
    ).rejects.toThrow(/cannot precede its parent/);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, { parentTokenId: RT1, tokenHash: HASH_C }),
    ).rejects.toThrow(/refresh_tokens_parent_token_id_key|duplicate key/);

    await expect(
      client.query("UPDATE refresh_tokens SET session_id = $2 WHERE id = $1", [RT2, SESS2]),
    ).rejects.toThrow(/identity, hash and expiry are immutable/);
    await expect(
      client.query("UPDATE refresh_tokens SET token_hash = $2 WHERE id = $1", [RT2, HASH_D]),
    ).rejects.toThrow(/identity, hash and expiry are immutable/);
    await expect(
      client.query("UPDATE refresh_tokens SET parent_token_id = NULL WHERE id = $1", [RT2]),
    ).rejects.toThrow(/identity, hash and expiry are immutable/);
    await client.query("UPDATE refresh_tokens SET consumed_at = now() WHERE id = $1", [RT2]);
    await expect(
      client.query("UPDATE refresh_tokens SET consumed_at = NULL WHERE id = $1", [RT2]),
    ).rejects.toThrow(/consumed_at is append-only/);
    await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [RT2]);
    await expect(
      client.query("UPDATE refresh_tokens SET revoked_at = NULL WHERE id = $1", [RT2]),
    ).rejects.toThrow(/revoked_at is append-only/);

    await expect(client.query("DELETE FROM user_sessions WHERE id = $1", [SESS1])).rejects.toThrow(/foreign key/);

    await client.query("UPDATE user_sessions SET revoked_at = now(), reason_code = 'LOGOUT' WHERE id = $1", [SESS1]);
    await expect(
      insertRefreshToken(RT3, D1, SESS1, { tokenHash: HASH_E }),
    ).rejects.toThrow(/revoked session/);
  });

  it("caps password reset tokens and keeps consumption append-only", async () => {
    await seedBase();
    const created = new Date();
    await insertPasswordResetToken(PR1, D1, { tokenHash: HASH_B, createdAt: created });
    await expect(
      insertPasswordResetToken(PR2, D1, {
        tokenHash: HASH_C,
        createdAt: created,
        expiresAt: new Date(created.getTime() + 30 * 60_000 + 1),
      }),
    ).rejects.toThrow(/password_reset_tokens_expiry_check/);
    await expect(
      insertPasswordResetToken(PR2, D1, { tokenHash: "B".repeat(64) }),
    ).rejects.toThrow(/password_reset_tokens_hash_check/);
    await expect(
      insertPasswordResetToken(PR2, D1, { tokenHash: HASH_B }),
    ).rejects.toThrow(/password_reset_tokens_token_hash_key|duplicate key/);
    await expect(
      insertPasswordResetToken(PR2, D1, {
        tokenHash: HASH_C,
        createdAt: created,
        consumedAt: new Date(created.getTime() - 1),
      }),
    ).rejects.toThrow(/password_reset_tokens_consumed_bound/);

    await client.query("UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1", [PR1]);
    await expect(
      client.query("UPDATE password_reset_tokens SET consumed_at = NULL WHERE id = $1", [PR1]),
    ).rejects.toThrow(/consumed_at is append-only/);
    await client.query("UPDATE password_reset_tokens SET revoked_at = now() WHERE id = $1", [PR1]);
    await expect(
      client.query("UPDATE password_reset_tokens SET revoked_at = NULL WHERE id = $1", [PR1]),
    ).rejects.toThrow(/revoked_at is append-only/);
    await expect(
      client.query("UPDATE password_reset_tokens SET expires_at = expires_at + interval '1 minute' WHERE id = $1", [PR1]),
    ).rejects.toThrow(/identity, hash and expiry are immutable/);

    await insertPasswordResetToken(PR2, D3, { tokenHash: HASH_C });
    await expect(client.query("DELETE FROM users WHERE id = $1", [D3])).rejects.toThrow(/foreign key/);
  });

  it("records PENDING/ACCEPTED idempotency with exact 202 execution binding", async () => {
    await seedBase();
    await insertIdempotency(ID1, D1, I1, { key: "pending-key" });
    const pending = await client.query(
      "SELECT state, response_status, response_body, accepted_at FROM idempotency_records WHERE id = $1",
      [ID1],
    );
    expect(pending.rows).toEqual([
      { state: "PENDING", response_status: null, response_body: null, accepted_at: null },
    ]);

    await insertIdempotency(ID2, D1, I1, {
      key: "accepted-key",
      state: "ACCEPTED",
      responseStatus: 202,
      responseBody: acceptedBody(I1, J1),
      acceptedAt: new Date(),
    });
    const accepted = await client.query(
      "SELECT state, response_status, response_body FROM idempotency_records WHERE id = $1",
      [ID2],
    );
    expect(accepted.rows).toEqual([
      {
        state: "ACCEPTED",
        response_status: 202,
        response_body: { inferenceId: I1, jobId: J1, status: "QUEUED" },
      },
    ]);
  });

  it("rejects invalid idempotency ownership, uniqueness, transitions and response shapes", async () => {
    await seedBase();

    await expect(insertIdempotency(ID1, D2, I1, { key: "cross-user" })).rejects.toThrow(
      /does not own the inference case/,
    );
    await insertIdempotency(ID1, D1, I3, { key: "legacy-owner" });
    const legacyRecord = await client.query(
      "SELECT inference_id, state FROM idempotency_records WHERE id = $1",
      [ID1],
    );
    expect(legacyRecord.rows).toEqual([{ inference_id: I3, state: "PENDING" }]);
    await expect(insertIdempotency(ID2, D2, I3, { key: "legacy-cross" })).rejects.toThrow(
      /does not own the inference case/,
    );

    await insertIdempotency(ID2, D1, I1, { key: "unique" });
    await expect(insertIdempotency(ID3, D1, I1, { key: "unique" })).rejects.toThrow(
      /idempotency_records_actor_user_id_scope_key_key|duplicate key/,
    );
    await insertIdempotency(ID3, D2, I2, { key: "unique" });
    await insertIdempotency(ID4, D1, I1, { key: "unique", scope: "inferences:other" });

    await expect(
      insertIdempotency(randomUUID(), D1, I1, { key: "bad-pending", responseStatus: 202 }),
    ).rejects.toThrow(/idempotency_records_accepted_check/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "bad-accepted",
        state: "ACCEPTED",
        responseStatus: 200,
        responseBody: acceptedBody(I1, J1),
        acceptedAt: new Date(),
      }),
    ).rejects.toThrow(/idempotency_records_accepted_check|accepted idempotency record requires/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "wrong-inference",
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: acceptedBody(I2, J1),
        acceptedAt: new Date(),
      }),
    ).rejects.toThrow(/inferenceId must match/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "wrong-job",
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: acceptedBody(I1, J2),
        acceptedAt: new Date(),
      }),
    ).rejects.toThrow(/jobId must match/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "wrong-status",
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: { inferenceId: I1, jobId: J1, status: "COMPLETED" },
        acceptedAt: new Date(),
      }),
    ).rejects.toThrow(/status must be QUEUED/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "bad-url",
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: { inferenceId: I1, jobId: J1, status: "QUEUED", url: "https://example.test/x" },
        acceptedAt: new Date(),
      }),
    ).rejects.toThrow(/response_body_no_secrets/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "bad-accepted-time",
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: acceptedBody(I1, J1),
        acceptedAt: new Date(Date.now() - 60_000),
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/idempotency_records_accepted_check/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, { key: "bad-state", state: "PROCESSING" }),
    ).rejects.toThrow(/idempotency_records_state_check|idempotency_records_accepted_check/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, {
        key: "bad-model",
        state: "PENDING",
        modelVersions: [],
      }),
    ).rejects.toThrow(/idempotency_records_model_versions_object/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, { key: "", scope: "inferences:create" }),
    ).rejects.toThrow(/idempotency_records_key_nonempty/);
    await expect(
      insertIdempotency(randomUUID(), D1, I1, { key: "bad-hash", payloadHash: "A".repeat(64) }),
    ).rejects.toThrow(/idempotency_records_payload_hash_check/);

    await expect(
      client.query("UPDATE idempotency_records SET resolved_model_versions = '{\"model\":\"v2\"}'::jsonb WHERE id = $1", [
        ID2,
      ]),
    ).rejects.toThrow(/model versions are immutable/);
    await expect(
      client.query("UPDATE idempotency_records SET key = 'changed' WHERE id = $1", [ID2]),
    ).rejects.toThrow(/model versions are immutable/);
    await expect(client.query("DELETE FROM idempotency_records WHERE id = $1", [ID2])).rejects.toThrow(
      /cannot be deleted/,
    );

    await client.query(
      "UPDATE idempotency_records SET state = 'ACCEPTED', response_status = 202, response_body = $2::jsonb, accepted_at = now() WHERE id = $1",
      [ID2, JSON.stringify(acceptedBody(I1, J1))],
    );
    await expect(
      client.query("UPDATE idempotency_records SET state = 'PENDING' WHERE id = $1", [ID2]),
    ).rejects.toThrow(/accepted idempotency records are immutable/);
    await expect(
      client.query("UPDATE idempotency_records SET response_body = '{}'::jsonb WHERE id = $1", [ID2]),
    ).rejects.toThrow(/accepted idempotency records are immutable/);
    await expect(client.query("DELETE FROM idempotency_records WHERE id = $1", [ID2])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("serializes concurrent duplicate idempotency keys to one winner", async () => {
    await seedBase();
    const other = new Client({ connectionString: inject("databaseUrl") });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${SCHEMA}`);
      const sql =
        "INSERT INTO idempotency_records (id, actor_user_id, scope, key, payload_hash, inference_id, resolved_model_versions) " +
        "VALUES ($1, $2, 'inferences:create', 'race-key', $3, $4, '{\"model\":\"v1\"}'::jsonb)";
      const results = await Promise.allSettled([
        client.query(sql, [ID3, D1, HASH_D, I1]),
        other.query(sql, [ID4, D1, HASH_E, I1]),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/duplicate key/);

      const rows = await client.query(
        "SELECT count(*)::int AS count FROM idempotency_records WHERE actor_user_id = $1 AND scope = 'inferences:create' AND key = 'race-key'",
        [D1],
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    } finally {
      await other.end();
    }
  });

  it("replays migration C without rewriting durable rows", async () => {
    await seedBase();
    await insertSession(SESS1, D1);
    await insertRefreshToken(RT1, D1, SESS1, { tokenHash: HASH_A });
    await insertAudit(AE1);
    await insertIdempotency(ID1, D1, I1, {
      key: "replay-key",
      state: "ACCEPTED",
      responseStatus: 202,
      responseBody: acceptedBody(I1, J1),
      acceptedAt: new Date(),
    });

    const before = await client.query(
      "SELECT (SELECT token_version FROM users WHERE id = $1) AS token_version, " +
        "(SELECT count(*)::int FROM user_sessions) AS sessions, " +
        "(SELECT count(*)::int FROM refresh_tokens) AS refresh, " +
        "(SELECT count(*)::int FROM audit_events) AS audits, " +
        "(SELECT count(*)::int FROM idempotency_records) AS idempotency",
      [D1],
    );
    await expect(client.query(migrationSql(IDENTITY_MIGRATION))).resolves.toBeDefined();
    const after = await client.query(
      "SELECT (SELECT token_version FROM users WHERE id = $1) AS token_version, " +
        "(SELECT count(*)::int FROM user_sessions) AS sessions, " +
        "(SELECT count(*)::int FROM refresh_tokens) AS refresh, " +
        "(SELECT count(*)::int FROM audit_events) AS audits, " +
        "(SELECT count(*)::int FROM idempotency_records) AS idempotency",
      [D1],
    );
    expect(after.rows).toEqual(before.rows);

    await expect(client.query("UPDATE audit_events SET outcome = 'FAILURE' WHERE id = $1", [AE1])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      client.query("UPDATE idempotency_records SET state = 'PENDING' WHERE id = $1", [ID1]),
    ).rejects.toThrow(/accepted idempotency records are immutable/);
  });
});

describe("migration C direct guards: live-state isolation, NULL-logic and time bounds", () => {
  it("revokes already-issued sessions after tokenVersion bumps or deactivation and rejects new stale rows", async () => {
    await seedBase();
    await insertSession(SESS1, D1); // issued at token_version 0

    await client.query("UPDATE users SET token_version = 1 WHERE id = $1", [D1]);
    await expect(insertSession(SESS2, D1, { issuedTokenVersion: 0 })).rejects.toThrow(/must match/);
    await insertSession(SESS2, D1, { issuedTokenVersion: 1 });

    await client.query("UPDATE users SET is_active = FALSE WHERE id = $1", [D1]);
    await expect(insertSession(SESS3, D1, { issuedTokenVersion: 1 })).rejects.toThrow(/inactive user/);

    // Already-issued sessions stay revocable: no live-user coupling, no zombie cleanup.
    await client.query(
      "UPDATE user_sessions SET revoked_at = now(), reason_code = 'TOKEN_VERSION_BUMP' WHERE id = $1",
      [SESS1],
    );
    await client.query(
      "UPDATE user_sessions SET revoked_at = now(), reason_code = 'USER_DEACTIVATED' WHERE id = $1",
      [SESS2],
    );
    const rows = await client.query(
      "SELECT id, user_id, issued_token_version, revoked_at, reason_code FROM user_sessions ORDER BY id",
    );
    expect(rows.rows.map((row) => row.id)).toEqual([SESS1, SESS2]);
    expect(rows.rows.map((row) => row.reason_code)).toEqual(["TOKEN_VERSION_BUMP", "USER_DEACTIVATED"]);
    expect(rows.rows.every((row) => row.revoked_at instanceof Date)).toBe(true);
    // Identity snapshot survives the revocation of the older generation.
    expect(rows.rows[0]?.issued_token_version).toBe(0);
    expect(rows.rows[1]?.issued_token_version).toBe(1);
  });

  it("keeps audit history writable without live user role or active-state requirements", async () => {
    await seedBase();
    await client.query("UPDATE users SET is_active = FALSE, role = 'INVESTIGADOR' WHERE id = $1", [D3]);
    await insertAudit(AE1, {
      actorKind: "USER",
      actorUserId: D3,
      targetType: "USER",
      targetUserId: INACTIVE,
    });
    await insertAudit(AE2, {
      actorKind: "USER",
      actorUserId: INACTIVE,
      targetType: "INFERENCE",
      targetId: I1,
    });
    const rows = await client.query(
      "SELECT actor_user_id, target_user_id, target_id, action FROM audit_events ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { actor_user_id: D3, target_user_id: INACTIVE, target_id: null, action: "LOGIN" },
      { actor_user_id: INACTIVE, target_user_id: null, target_id: I1, action: "LOGIN" },
    ]);
    // History still blocks deletion of the (inactive) user it references.
    await expect(client.query("DELETE FROM users WHERE id = $1", [D3])).rejects.toThrow(/foreign key/);
  });

  it("keeps ACCEPTED idempotency as immutable history after actor deactivation", async () => {
    await seedBase();
    await insertIdempotency(ID1, D1, I1, {
      key: "history-key",
      state: "ACCEPTED",
      responseStatus: 202,
      responseBody: acceptedBody(I1, J1),
      acceptedAt: new Date(),
    });
    await client.query("UPDATE users SET is_active = FALSE WHERE id = $1", [D1]);
    const row = await client.query(
      "SELECT state, response_status, response_body, accepted_at FROM idempotency_records WHERE id = $1",
      [ID1],
    );
    expect(row.rows).toEqual([
      {
        state: "ACCEPTED",
        response_status: 202,
        response_body: { inferenceId: I1, jobId: J1, status: "QUEUED" },
        accepted_at: expect.any(Date),
      },
    ]);
    await expect(
      client.query("UPDATE idempotency_records SET state = 'PENDING' WHERE id = $1", [ID1]),
    ).rejects.toThrow(/accepted idempotency records are immutable/);
    await expect(
      client.query("UPDATE idempotency_records SET response_body = '{}'::jsonb WHERE id = $1", [ID1]),
    ).rejects.toThrow(/accepted idempotency records are immutable/);
    await expect(client.query("DELETE FROM idempotency_records WHERE id = $1", [ID1])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("rejects ACCEPTED response bodies with missing or null canonical properties", async () => {
    await seedBase();
    const cases: Array<[string, unknown, RegExp]> = [
      ["empty-body", {}, /inferenceId must match/],
      ["missing-status", { inferenceId: I1, jobId: J1 }, /status must be QUEUED/],
      ["missing-job", { inferenceId: I1, status: "QUEUED" }, /jobId must match/],
      ["null-inference", { inferenceId: null, jobId: J1, status: "QUEUED" }, /inferenceId must match/],
      ["null-job", { inferenceId: I1, jobId: null, status: "QUEUED" }, /jobId must match/],
      ["null-status", { inferenceId: I1, jobId: J1, status: null }, /status must be QUEUED/],
    ];
    for (const [key, body, message] of cases) {
      await expect(
        insertIdempotency(randomUUID(), D1, I1, {
          key,
          state: "ACCEPTED",
          responseStatus: 202,
          responseBody: body,
          acceptedAt: new Date(),
        }),
      ).rejects.toThrow(message);
    }
    await insertIdempotency(ID1, D1, I1, {
      key: "canonical",
      state: "ACCEPTED",
      responseStatus: 202,
      responseBody: { inferenceId: I1, jobId: J1, status: "QUEUED" },
      acceptedAt: new Date(),
    });
    const rows = await client.query("SELECT count(*)::int AS count FROM idempotency_records");
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it("binds refresh tokens to the exact session owner and an existing session", async () => {
    await seedBase();
    await insertSession(SESS1, D1);
    await expect(insertRefreshToken(RT1, D2, SESS1, { tokenHash: HASH_A })).rejects.toThrow(
      /does not match the session user/,
    );
    await expect(
      insertRefreshToken(RT1, D1, "00000000-0000-4000-8000-0000000004ff", { tokenHash: HASH_A }),
    ).rejects.toThrow(/refresh token session/);
    await insertRefreshToken(RT1, D1, SESS1, { tokenHash: HASH_A });
    const rows = await client.query("SELECT user_id, session_id FROM refresh_tokens WHERE id = $1", [RT1]);
    expect(rows.rows).toEqual([{ user_id: D1, session_id: SESS1 }]);
  });

  it("enforces credential time bounds and bounded session reason codes", async () => {
    await seedBase();
    await insertSession(SESS1, D1);
    const created = new Date();
    await expect(
      insertRefreshToken(RT1, D1, SESS1, { createdAt: created, expiresAt: created, tokenHash: HASH_A }),
    ).rejects.toThrow(/refresh_tokens_expiry_positive/);
    await expect(
      insertRefreshToken(RT1, D1, SESS1, {
        createdAt: created,
        expiresAt: new Date(created.getTime() - 1),
        tokenHash: HASH_A,
      }),
    ).rejects.toThrow(/refresh_tokens_expiry_positive/);
    await expect(
      insertRefreshToken(RT1, D1, SESS1, {
        tokenHash: HASH_A,
        consumedAt: new Date(Date.now() - 3_600_001),
      }),
    ).rejects.toThrow(/refresh_tokens_consumed_bound/);
    await expect(
      insertRefreshToken(RT1, D1, SESS1, {
        tokenHash: HASH_A,
        revokedAt: new Date(Date.now() - 3_600_001),
      }),
    ).rejects.toThrow(/refresh_tokens_revoked_bound/);
    await expect(
      insertPasswordResetToken(PR1, D1, {
        tokenHash: HASH_B,
        revokedAt: new Date(Date.now() - 60_001),
      }),
    ).rejects.toThrow(/password_reset_tokens_revoked_bound/);
    await expect(
      insertSession(SESS2, D1, { revokedAt: new Date(), reasonCode: "1bad" }),
    ).rejects.toThrow(/user_sessions_reason_code_check/);
    await expect(
      insertSession(SESS2, D1, { revokedAt: new Date(), reasonCode: "has space" }),
    ).rejects.toThrow(/user_sessions_reason_code_check/);
    await expect(insertSession(SESS2, D1, { lastUsedAt: new Date(Date.now() - 60_000) })).rejects.toThrow(
      /last_used_at cannot precede|user_sessions_last_used_check/,
    );
  });

  it("coerces whitespace-only identifiers and rejects empty audit codes", async () => {
    await seedBase();
    await expect(insertIdempotency(randomUUID(), D1, I1, { key: "   " })).rejects.toThrow(
      /idempotency_records_key_nonempty/,
    );
    await expect(insertIdempotency(randomUUID(), D1, I1, { key: "k", scope: "  " })).rejects.toThrow(
      /idempotency_records_scope_nonempty/,
    );
    await expect(insertAudit(AE1, { action: "" })).rejects.toThrow(/audit_events_action_check/);
    await expect(insertAudit(AE1, { targetType: "" })).rejects.toThrow(/audit_events_target_type_check/);
  });

  it("stores credential hashes only, without raw tokens or email payloads", async () => {
    const columnsOf = async (table: string): Promise<string[]> => {
      const result = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name",
        [SCHEMA, table],
      );
      return result.rows.map((row) => row.column_name);
    };
    expect(await columnsOf("refresh_tokens")).toEqual([
      "consumed_at",
      "created_at",
      "expires_at",
      "id",
      "parent_token_id",
      "revoked_at",
      "session_id",
      "token_hash",
      "user_id",
    ]);
    expect(await columnsOf("password_reset_tokens")).toEqual([
      "consumed_at",
      "created_at",
      "expires_at",
      "id",
      "revoked_at",
      "token_hash",
      "user_id",
    ]);
    expect(await columnsOf("user_sessions")).toEqual([
      "created_at",
      "expires_at",
      "id",
      "issued_token_version",
      "last_used_at",
      "reason_code",
      "revoked_at",
      "user_id",
    ]);
  });
});
