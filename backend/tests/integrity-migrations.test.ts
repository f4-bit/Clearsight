import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { inject } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Migration D integrity/role invariants on a fresh schema. Concurrency tests use
 * real PostgreSQL sessions; no external database or cloud service is involved.
 */
const SCHEMA = "integrity_rules";
const MIGRATIONS = migrationNames();
const HARDENING_MIGRATION = "20261118030000_integrity_hardening";

const D1 = "00000000-0000-4000-8000-0000000005d1";
const D2 = "00000000-0000-4000-8000-0000000005d2";
const P = "00000000-0000-4000-8000-0000000005a1";
const C1 = "00000000-0000-4000-8000-0000000005c1";
const C2 = "00000000-0000-4000-8000-0000000005c2";
const IMG1 = "00000000-0000-4000-8000-0000000005b1";
const IMG2 = "00000000-0000-4000-8000-0000000005b2";
const IMG3 = "00000000-0000-4000-8000-0000000005b3";
const IMG4 = "00000000-0000-4000-8000-0000000005b4";
const I1 = "00000000-0000-4000-8000-0000000005e1";
const I2 = "00000000-0000-4000-8000-0000000005e2";
const I3 = "00000000-0000-4000-8000-0000000005e3";
const I4 = "00000000-0000-4000-8000-0000000005e4";
const J1 = "00000000-0000-4000-8000-0000000005f1";
const J2 = "00000000-0000-4000-8000-0000000005f2";
const J3 = "00000000-0000-4000-8000-0000000005f3";
const J4 = "00000000-0000-4000-8000-0000000005f4";
const J5 = "00000000-0000-4000-8000-0000000005f5";
const J6 = "00000000-0000-4000-8000-0000000005f6";
const I5 = "00000000-0000-4000-8000-0000000005e5";
const I6 = "00000000-0000-4000-8000-0000000005e6";
const DECOY_SCHEMA = "integrity_decoy";

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

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: inject("databaseUrl") });
  await c.connect();
  await c.query(`SET search_path TO ${SCHEMA}`);
  return c;
}

async function backendPid(c: Client): Promise<number> {
  const row = await c.query("SELECT pg_backend_pid() AS pid");
  return Number(row.rows[0].pid);
}

async function waitForLockWait(observer: Client, pid: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
      [pid],
    );
    if ((row.rowCount ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for a lock on pid ${pid}`);
}

type Outcome = { ok: true; rowCount: number | null } | { ok: false; error: unknown };

function capture(promise: Promise<{ rowCount: number | null }>): Promise<Outcome> {
  return promise.then(
    (result) => ({ ok: true, rowCount: result.rowCount }),
    (error) => ({ ok: false, error }),
  );
}

async function waitForBlockedBy(
  observer: Client,
  pid: number,
  blockerPid: number,
  timeoutMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await observer.query("SELECT pg_blocking_pids($1) AS blockers", [pid]);
    const blockers: number[] = row.rows[0]?.blockers ?? [];
    if (blockers.includes(blockerPid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const qualifiedFreezeSql =
  `UPDATE ${SCHEMA}.consultations SET required_execution_ids = $2::uuid[], ` +
  "required_set_version = $3, required_set_frozen_at = now() WHERE id = $1";

async function createDecoySchema(): Promise<void> {
  await client.query(
    `DROP SCHEMA IF EXISTS ${DECOY_SCHEMA} CASCADE; CREATE SCHEMA ${DECOY_SCHEMA}; ` +
      `CREATE TABLE ${DECOY_SCHEMA}.images (id uuid PRIMARY KEY); ` +
      `CREATE TABLE ${DECOY_SCHEMA}.inferences (id uuid PRIMARY KEY, image_id uuid)`,
  );
}

async function dropDecoySchema(): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${DECOY_SCHEMA} CASCADE`);
}

/** Session whose search_path resolves unqualified names to the decoy schema first. */
async function hostileClient(): Promise<Client> {
  const c = new Client({ connectionString: inject("databaseUrl") });
  await c.connect();
  await c.query(`SET search_path TO ${DECOY_SCHEMA}, ${SCHEMA}`);
  return c;
}

async function seedBase(): Promise<void> {
  await client.query(
    "INSERT INTO users (id, email, password_hash, full_name, role, is_active, token_version) VALUES " +
      "($1, $2, 'x', 'Dr One', 'OFTALMOLOGO', TRUE, 0), " +
      "($3, $4, 'x', 'Dr Two', 'OFTALMOLOGO', TRUE, 0)",
    [D1, "d1@integrity.test", D2, "d2@integrity.test"],
  );
  await client.query("INSERT INTO patients (id) VALUES ($1)", [P]);
  await client.query(
    "INSERT INTO consultations (id, patient_id, doctor_id) VALUES ($1, $2, $3), ($4, $2, $5)",
    [C1, P, D1, C2, D2],
  );
  await client.query(
    "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES " +
      "($1, $2, 'OD', 'a'), ($3, $2, 'OS', 'b'), ($4, $5, 'OD', 'c'), ($6, $2, 'OD', 'd')",
    [IMG1, C1, IMG2, IMG3, C2, IMG4],
  );
  await client.query(
    "INSERT INTO inferences (id, image_id, consultation_id, eye_side, job_id, status) VALUES " +
      "($1, $2, $3, 'OD', $4, 'COMPLETED'), ($5, $6, $3, 'OS', $7, 'COMPLETED'), ($8, $9, $10, 'OD', $11, 'COMPLETED')",
    [I1, IMG1, C1, J1, I2, IMG2, J2, I3, IMG3, C2, J3],
  );
}

function insertInference(
  c: Client,
  id: string,
  imageId: string,
  consultationId: string,
  eyeSide: string,
  jobId: string,
  parentId: string | null = null,
): Promise<{ rowCount: number | null }> {
  return c.query(
    "INSERT INTO inferences (id, image_id, consultation_id, eye_side, job_id, status, reanalysis_of_id) " +
      "VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6)",
    [id, imageId, consultationId, eyeSide, jobId, parentId],
  );
}

async function freeze(c: Client, consultationId: string, ids: string[], version = "required-v1"): Promise<void> {
  await c.query(
    "UPDATE consultations SET required_execution_ids = $2::uuid[], required_set_version = $3, required_set_frozen_at = now() WHERE id = $1",
    [consultationId, ids, version],
  );
}

const freezeSql =
  "UPDATE consultations SET required_execution_ids = $2::uuid[], required_set_version = $3, required_set_frozen_at = now() WHERE id = $1";

describe("migration D integrity hardening and application role", () => {
  it("creates the expected guards, role attributes and preserved unique indexes", async () => {
    const triggers = await client.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid IN ($1::regclass, $2::regclass, $3::regclass) AND NOT tgisinternal ORDER BY tgname",
      [`${SCHEMA}.consultations`, `${SCHEMA}.inferences`, `${SCHEMA}.images`],
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "consultations_required_selection_guard",
        "inferences_context_guard",
        "images_reparent_with_inferences_guard",
      ]),
    );

    const role = await client.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls " +
        "FROM pg_roles WHERE rolname = 'clearsight_app'",
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    const memberships = await client.query(
      "SELECT count(*)::int AS count FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'clearsight_app'",
    );
    expect(memberships.rows).toEqual([{ count: 0 }]);
    const schemaPrivileges = await client.query(
      "SELECT has_schema_privilege('clearsight_app', $1, 'USAGE') AS usage, has_schema_privilege('clearsight_app', $1, 'CREATE') AS create",
      [SCHEMA],
    );
    expect(schemaPrivileges.rows).toEqual([{ usage: true, create: false }]);

    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
      [SCHEMA],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "users_email_key",
        "inferences_job_id_key",
        "clinical_feedback_inference_id_doctor_id_key",
        "artifact_records_inference_id_artifact_type_version_key",
        "pdf_reports_inference_id_version_key",
        "refresh_tokens_token_hash_key",
        "refresh_tokens_parent_token_id_key",
        "password_reset_tokens_token_hash_key",
        "idempotency_records_actor_user_id_scope_key_key",
        "idx_consultations_required_execution_ids",
      ]),
    );
  });

  it("gives the application role safe DML but denies history mutation and DDL", async () => {
    await seedBase();
    await client.query("CREATE TABLE test_meta (run_id text PRIMARY KEY)");

    const mutableTables = [
      "users",
      "patients",
      "consultations",
      "images",
      "inferences",
      "clinical_feedback",
      "artifact_records",
      "pdf_reports",
      "user_sessions",
      "refresh_tokens",
      "password_reset_tokens",
      "idempotency_records",
    ];
    for (const table of mutableTables) {
      const privileges = await client.query(
        "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS select, " +
          "has_table_privilege('clearsight_app', $1, 'INSERT') AS insert, " +
          "has_table_privilege('clearsight_app', $1, 'UPDATE') AS update, " +
          "has_table_privilege('clearsight_app', $1, 'DELETE') AS delete, " +
          "has_table_privilege('clearsight_app', $1, 'TRUNCATE') AS truncate, " +
          "has_table_privilege('clearsight_app', $1, 'TRIGGER') AS trigger, " +
          "has_table_privilege('clearsight_app', $1, 'REFERENCES') AS references",
        [`${SCHEMA}.${table}`],
      );
      expect(privileges.rows).toEqual([
        {
          select: true,
          insert: true,
          update: true,
          delete: false,
          truncate: false,
          trigger: false,
          references: false,
        },
      ]);
    }
    for (const table of ["audit_events", "clinical_snapshots"]) {
      const privileges = await client.query(
        "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS select, " +
          "has_table_privilege('clearsight_app', $1, 'INSERT') AS insert, " +
          "has_table_privilege('clearsight_app', $1, 'UPDATE') AS update, " +
          "has_table_privilege('clearsight_app', $1, 'DELETE') AS delete, " +
          "has_table_privilege('clearsight_app', $1, 'TRUNCATE') AS truncate",
        [`${SCHEMA}.${table}`],
      );
      expect(privileges.rows).toEqual([
        { select: true, insert: true, update: false, delete: false, truncate: false },
      ]);
    }
    const testMeta = await client.query(
      "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS select, " +
        "has_table_privilege('clearsight_app', $1, 'INSERT') AS insert",
      [`${SCHEMA}.test_meta`],
    );
    expect(testMeta.rows).toEqual([{ select: false, insert: false }]);

    try {
      await client.query("SET ROLE clearsight_app");
      await expect(client.query("SELECT count(*)::int AS count FROM users")).resolves.toMatchObject({
        rows: [{ count: 2 }],
      });
      await expect(
        client.query("UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1", [D1]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(
          "INSERT INTO audit_events (actor_kind, target_type, action, outcome) VALUES ('SYSTEM', 'SYSTEM', 'LOGIN', 'SUCCESS')",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query(
          "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, '{}'::jsonb, '{}'::jsonb, 'v1')",
          [C1],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      await expect(client.query("UPDATE audit_events SET outcome = 'FAILURE'")).rejects.toThrow(
        /permission denied for table audit_events/,
      );
      await expect(client.query("DELETE FROM audit_events")).rejects.toThrow(
        /permission denied for table audit_events/,
      );
      await expect(client.query("DELETE FROM inferences WHERE id = $1", [I1])).rejects.toThrow(
        /permission denied for table inferences/,
      );
      await expect(client.query("TRUNCATE TABLE user_sessions")).rejects.toThrow(
        /permission denied for table user_sessions/,
      );
      await expect(client.query("CREATE TABLE app_ddl_test (id integer)")).rejects.toThrow(
        /permission denied for schema integrity_rules/,
      );
      await expect(client.query("SELECT * FROM test_meta")).rejects.toThrow(/permission denied for table test_meta/);
      await expect(client.query("DROP TABLE test_meta")).rejects.toThrow(/must be owner of table test_meta/);
    } finally {
      await client.query("RESET ROLE");
    }

    await expect(client.query("TRUNCATE TABLE clinical_feedback")).resolves.toMatchObject({ command: "TRUNCATE" });
    await client.query("DROP TABLE test_meta");
  });

  it("serializes delete-first versus freeze and forces the freeze recheck to reject", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM inferences WHERE id = $1", [I1]);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(other.query(freezeSql, [C1, [I1], "required-v1"]));
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/belong to this consultation/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const selection = await client.query("SELECT required_execution_ids FROM consultations WHERE id = $1", [C1]);
    const deleted = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I1]);
    expect(selection.rows).toEqual([{ required_execution_ids: [] }]);
    expect(deleted.rows).toEqual([{ count: 0 }]);
  });

  it("serializes freeze-first versus delete and preserves selected evidence", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await freeze(client, C1, [I1], "required-v1");
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(other.query("DELETE FROM inferences WHERE id = $1", [I1]));
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/selected as required/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const selection = await client.query("SELECT required_execution_ids FROM consultations WHERE id = $1", [C1]);
    const remaining = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I1]);
    expect(selection.rows).toEqual([{ required_execution_ids: [I1] }]);
    expect(remaining.rows).toEqual([{ count: 1 }]);
  });

  it("serializes selected identity updates against a freeze", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await freeze(client, C1, [I1], "required-v1");
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(
        other.query("UPDATE inferences SET image_id = $2, eye_side = 'OS' WHERE id = $1", [I1, IMG2]),
      );
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/required selection/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const row = await client.query("SELECT image_id, eye_side FROM inferences WHERE id = $1", [I1]);
    expect(row.rows).toEqual([{ image_id: IMG1, eye_side: "OD" }]);
  });

  it("rejects image reparent after a child inference wins the lock", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await insertInference(client, I4, IMG4, C1, "OD", J4);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(
        other.query("UPDATE images SET consultation_id = $2, eye_side = 'OD' WHERE id = $1", [IMG4, C2]),
      );
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/image consultation\/eye context cannot change|referenced by an inference/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const image = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG4]);
    const child = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I4]);
    expect(image.rows).toEqual([{ consultation_id: C1, eye_side: "OD" }]);
    expect(child.rows).toEqual([{ count: 1 }]);
  });

  it("rejects a stale child insert after an image reparent wins the lock", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE images SET consultation_id = $2, eye_side = 'OD' WHERE id = $1", [IMG4, C2]);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(insertInference(other, I4, IMG4, C1, "OD", J4));
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/consultation_id .* does not match|eye_side .* does not match/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const image = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG4]);
    const child = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I4]);
    expect(image.rows).toEqual([{ consultation_id: C2, eye_side: "OD" }]);
    expect(child.rows).toEqual([{ count: 0 }]);
  });

  it("rejects parent context changes after a reanalysis child wins the lock", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await insertInference(client, I4, IMG1, C1, "OD", J4, I1);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(
        other.query("UPDATE inferences SET image_id = $2, eye_side = 'OS' WHERE id = $1", [I1, IMG2]),
      );
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/reanalysis child|invalid/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const parent = await client.query("SELECT image_id, eye_side FROM inferences WHERE id = $1", [I1]);
    const child = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I4]);
    expect(parent.rows).toEqual([{ image_id: IMG1, eye_side: "OD" }]);
    expect(child.rows).toEqual([{ count: 1 }]);
  });

  it("rejects a stale reanalysis child after a parent context change wins the lock", async () => {
    await seedBase();
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE inferences SET image_id = $2, eye_side = 'OS' WHERE id = $1", [I1, IMG2]);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      const otherPid = await backendPid(other);
      const outcome = capture(insertInference(other, I4, IMG1, C1, "OD", J4, I1));
      await waitForLockWait(client, otherPid);
      await client.query("COMMIT");
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/same consultation and eye/);
      }
      await other.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const parent = await client.query("SELECT image_id, eye_side FROM inferences WHERE id = $1", [I1]);
    const child = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I4]);
    expect(parent.rows).toEqual([{ image_id: IMG2, eye_side: "OS" }]);
    expect(child.rows).toEqual([{ count: 0 }]);
  });

  it("freezes multi-ID selections deterministically and rejects duplicates", async () => {
    await seedBase();
    await freeze(client, C1, [I2, I1], "multi-v1");
    const row = await client.query("SELECT required_execution_ids FROM consultations WHERE id = $1", [C1]);
    expect(row.rows).toEqual([{ required_execution_ids: [I2, I1] }]);
    await expect(freeze(client, C1, [I1, I1], "dup-v1")).rejects.toThrow(/duplicates/);
  });

  it("replays D without rewriting frozen evidence or role attributes", async () => {
    await seedBase();
    await freeze(client, C1, [I1], "required-v1");
    const before = await client.query(
      "SELECT required_execution_ids, required_set_version FROM consultations WHERE id = $1",
      [C1],
    );
    await expect(client.query(migrationSql(HARDENING_MIGRATION))).resolves.toBeDefined();
    const after = await client.query(
      "SELECT required_execution_ids, required_set_version FROM consultations WHERE id = $1",
      [C1],
    );
    expect(after.rows).toEqual(before.rows);
    const role = await client.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls " +
        "FROM pg_roles WHERE rolname = 'clearsight_app'",
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
  });
});

describe("migration D adversarial regression coverage (QA)", () => {
  it("allows no-op and unreferenced image context moves but rejects referenced reparent", async () => {
    await seedBase();
    await expect(
      client.query("UPDATE images SET consultation_id = $1, eye_side = 'OD' WHERE id = $2", [C1, IMG1]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(client.query("UPDATE images SET consultation_id = $1 WHERE id = $2", [C2, IMG1])).rejects.toThrow(
      /image consultation\/eye context cannot change while referenced by an inference/,
    );
    await expect(client.query("UPDATE images SET eye_side = 'OS' WHERE id = $1", [IMG1])).rejects.toThrow(
      /image consultation\/eye context cannot change while referenced by an inference/,
    );
    await expect(
      client.query("UPDATE images SET consultation_id = $1, eye_side = 'OS' WHERE id = $2", [C2, IMG4]),
    ).resolves.toMatchObject({ rowCount: 1 });
    const moved = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG4]);
    expect(moved.rows).toEqual([{ consultation_id: C2, eye_side: "OS" }]);
    const referenced = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG1]);
    expect(referenced.rows).toEqual([{ consultation_id: C1, eye_side: "OD" }]);
    const child = await client.query("SELECT count(*)::int AS count FROM inferences WHERE image_id = $1", [IMG1]);
    expect(child.rows).toEqual([{ count: 1 }]);
  });

  it("serializes a reversed multi-ID freeze against ordered updates without deadlock", async () => {
    await seedBase();
    // Physical insertion order is reversed (I6 before I5) so that array-order or
    // scan-order lock acquisition would deadlock; only deterministic UUID order
    // keeps the two lock takers cycle-free.
    await insertInference(client, I6, IMG1, C1, "OD", J6);
    await insertInference(client, I5, IMG1, C1, "OD", J5);

    const other = await newClient();
    try {
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '5s'");
      await other.query("UPDATE inferences SET status = 'REVIEW_REQUIRED' WHERE id = $1", [I5]);
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const freezePid = await backendPid(client);
      const updaterPid = await backendPid(other);
      const freezeOutcome = capture(client.query(freezeSql, [C1, [I6, I5], "multi-rev"]));
      const blockedByUpdater = await waitForBlockedBy(other, freezePid, updaterPid);
      const secondUpdate = capture(
        other.query("UPDATE inferences SET status = 'REVIEW_REQUIRED' WHERE id = $1", [I6]),
      );
      const updateResult = await secondUpdate;
      await other.query(updateResult.ok ? "COMMIT" : "ROLLBACK").catch(() => undefined);
      const freezeResult = await freezeOutcome;
      await client.query(freezeResult.ok ? "COMMIT" : "ROLLBACK").catch(() => undefined);

      expect(blockedByUpdater).toBe(true);
      if (!freezeResult.ok) {
        expect.fail(`freeze must complete without deadlock: ${String(freezeResult.error)}`);
      }
      if (!updateResult.ok) {
        expect.fail(`ordered update must complete without deadlock: ${String(updateResult.error)}`);
      }
      expect(freezeResult.rowCount).toBe(1);
      expect(updateResult.rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const selection = await client.query("SELECT required_execution_ids FROM consultations WHERE id = $1", [C1]);
    expect(selection.rows).toEqual([{ required_execution_ids: [I6, I5] }]);
    const statuses = await client.query(
      "SELECT id, status FROM inferences WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[I5, I6]],
    );
    expect(statuses.rows).toEqual([
      { id: I5, status: "REVIEW_REQUIRED" },
      { id: I6, status: "REVIEW_REQUIRED" },
    ]);
  });

  it("does not deadlock image reparent against a locked existing child row", async () => {
    await seedBase();
    await insertInference(client, I5, IMG1, C1, "OD", J5);
    const other = await newClient();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM inferences WHERE id = $1 FOR NO KEY UPDATE", [I1]);
      const aPid = await backendPid(client);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '3s'");
      const bPid = await backendPid(other);
      const blocked = capture(
        other.query("UPDATE images SET consultation_id = $2, eye_side = 'OD' WHERE id = $1", [IMG1, C2]),
      );
      const result = await blocked;
      // The image guard must see the committed child rows and reject without
      // waiting on a child-row lock. A 40P01 deadlock or lock timeout is failure.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toMatch(/image consultation\/eye context cannot change/);
        expect(String(result.error)).not.toMatch(/deadlock detected|lock timeout/);
      }
      await other.query("ROLLBACK");
      expect(aPid).toBeGreaterThan(0);
      expect(bPid).toBeGreaterThan(0);
      const afterFailure = await client.query("SELECT consultation_id FROM images WHERE id = $1", [IMG1]);
      expect(afterFailure.rows).toEqual([{ consultation_id: C1 }]);

      const aUpdate = await client.query(
        "UPDATE inferences SET image_id = $2, consultation_id = $3, eye_side = 'OD' WHERE id = $1",
        [I1, IMG1, C1],
      );
      expect(aUpdate.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    const rows = await client.query(
      "SELECT id, image_id, eye_side FROM inferences WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[I1, I5]],
    );
    expect(rows.rows).toEqual([
      { id: I1, image_id: IMG1, eye_side: "OD" },
      { id: I5, image_id: IMG1, eye_side: "OD" },
    ]);
    const image = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG1]);
    expect(image.rows).toEqual([{ consultation_id: C1, eye_side: "OD" }]);
  });

  it("freeze waits on reference rows in the trigger schema even when search_path is hostile", async () => {
    await seedBase();
    await createDecoySchema();
    const deleter = await hostileClient();
    const freezer = await hostileClient();
    try {
      const delPid = await backendPid(deleter);
      await deleter.query("BEGIN");
      await deleter.query(`DELETE FROM ${SCHEMA}.inferences WHERE id = $1`, [I1]);
      await freezer.query("BEGIN");
      await freezer.query("SET LOCAL lock_timeout = '5s'");
      const freezePid = await backendPid(freezer);
      const outcome = capture(freezer.query(qualifiedFreezeSql, [C1, [I1], "required-v1"]));
      const blockedByDeleter = await waitForBlockedBy(client, freezePid, delPid);
      await deleter.query("COMMIT");
      const result = await outcome;
      await freezer.query(result.ok ? "COMMIT" : "ROLLBACK").catch(() => undefined);
      // Contract: delete-first makes the freeze wait on the referenced row and
      // then fail the membership recheck, regardless of session search_path.
      expect({ blockedByDeleter, ok: result.ok }).toEqual({ blockedByDeleter: true, ok: false });
      if (!result.ok) {
        expect(String(result.error)).toMatch(/belong to this consultation/);
      }
    } finally {
      await deleter.query("ROLLBACK").catch(() => undefined);
      await freezer.query("ROLLBACK").catch(() => undefined);
      await deleter.end();
      await freezer.end();
      await dropDecoySchema();
    }

    const selection = await client.query("SELECT required_execution_ids FROM consultations WHERE id = $1", [C1]);
    expect(selection.rows).toEqual([{ required_execution_ids: [] }]);
    const deleted = await client.query("SELECT count(*)::int AS count FROM inferences WHERE id = $1", [I1]);
    expect(deleted.rows).toEqual([{ count: 0 }]);
  });

  it("reparent guard consults inferences in the trigger schema even when search_path is hostile", async () => {
    await seedBase();
    await insertInference(client, I4, IMG4, C1, "OD", J4);
    await createDecoySchema();
    const hostile = await hostileClient();
    try {
      // Contract: a referenced image cannot change consultation/eye context, no
      // matter which schema the session resolves unqualified names to.
      await expect(
        hostile.query(`UPDATE ${SCHEMA}.images SET consultation_id = $1 WHERE id = $2`, [C2, IMG4]),
      ).rejects.toThrow(/image consultation\/eye context cannot change while referenced by an inference/);
    } finally {
      await hostile.end();
      await dropDecoySchema();
    }
    const image = await client.query("SELECT consultation_id, eye_side FROM images WHERE id = $1", [IMG4]);
    expect(image.rows).toEqual([{ consultation_id: C1, eye_side: "OD" }]);
  });

  it("refuses to apply when an existing clearsight_app has unsafe role attributes", async () => {
    for (const unsafe of ["LOGIN", "SUPERUSER"]) {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER ROLE clearsight_app ${unsafe}`);
        await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(/unsafe role attributes/);
      } finally {
        await client.query("ROLLBACK");
      }
      const role = await client.query(
        "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls " +
          "FROM pg_roles WHERE rolname = 'clearsight_app'",
      );
      expect(role.rows).toEqual([
        {
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ]);
    }
  });

  it("refuses to apply when clearsight_app is a member of another role", async () => {
    await client.query("BEGIN");
    try {
      await client.query("CREATE ROLE qa_probe_group NOLOGIN");
      await client.query("GRANT qa_probe_group TO clearsight_app");
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /clearsight_app must not be a member of any role/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
    const memberships = await client.query(
      "SELECT count(*)::int AS count FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'clearsight_app'",
    );
    expect(memberships.rows).toEqual([{ count: 0 }]);
  });

  it("refuses to apply when clearsight_app owns protected tables or the application schema", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`ALTER TABLE ${SCHEMA}.users OWNER TO clearsight_app`);
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /clearsight_app must not own protected tables/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query("BEGIN");
    try {
      await client.query(`ALTER SCHEMA ${SCHEMA} OWNER TO clearsight_app`);
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /clearsight_app must not own the application schema/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
    const owner = await client.query(
      "SELECT pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE n.nspname = $1",
      [SCHEMA],
    );
    expect(owner.rows).toEqual([{ owner: expect.not.stringMatching(/^clearsight_app$/) }]);
  });

  it("refuses when the role or PUBLIC effectively holds CREATE and never rewrites the PUBLIC ACL", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`GRANT CREATE ON SCHEMA ${SCHEMA} TO clearsight_app`);
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /clearsight_app must not have CREATE on the application schema/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query(`GRANT CREATE ON SCHEMA ${SCHEMA} TO PUBLIC`);
    try {
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /clearsight_app must not have CREATE on the application schema/,
      );
      const acl = await client.query(
        "SELECT count(*)::int AS count FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE nspname = $1)) " +
          "WHERE grantee = 0 AND privilege_type = 'CREATE'",
        [SCHEMA],
      );
      expect(acl.rows).toEqual([{ count: 1 }]);
    } finally {
      await client.query(`REVOKE CREATE ON SCHEMA ${SCHEMA} FROM PUBLIC`);
    }
  });

  it("fails closed on effective PUBLIC grants without rewriting the PUBLIC ACL", async () => {
    const cases = [
      { table: "audit_events", privilege: "UPDATE" },
      { table: "audit_events", privilege: "TRUNCATE" },
      { table: "users", privilege: "DELETE" },
      { table: "users", privilege: "TRUNCATE" },
    ] as const;

    for (const { table, privilege } of cases) {
      await client.query(`GRANT ${privilege} ON TABLE ${SCHEMA}.${table} TO PUBLIC`);
      try {
        await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
          /effective forbidden privilege/,
        );
        const acl = await client.query(
          "SELECT count(*)::int AS count FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) " +
            "WHERE grantee = 0 AND privilege_type = $2",
          [`${SCHEMA}.${table}`, privilege],
        );
        expect(acl.rows).toEqual([{ count: 1 }]);
      } finally {
        await client.query(`REVOKE ${privilege} ON TABLE ${SCHEMA}.${table} FROM PUBLIC`);
      }
      const after = await client.query(
        "SELECT count(*)::int AS count FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) " +
          "WHERE grantee = 0 AND privilege_type = $2",
        [`${SCHEMA}.${table}`, privilege],
      );
      expect(after.rows).toEqual([{ count: 0 }]);
    }

    await expect(client.query(migrationSql(HARDENING_MIGRATION))).resolves.toBeDefined();
  });

  it("replay leaves a pre-existing safe role, its memberships and its grants untouched", async () => {
    async function roleSnapshot() {
      const attrs = await client.query(
        "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls " +
          "FROM pg_roles WHERE rolname = 'clearsight_app'",
      );
      const parents = await client.query(
        "SELECT m.roleid::regrole::text AS parent FROM pg_auth_members m " +
          "JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'clearsight_app' ORDER BY 1",
      );
      const acls = await client.query(
        "SELECT privilege_type FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) " +
          "WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'clearsight_app') ORDER BY 1",
        [`${SCHEMA}.users`],
      );
      return { attrs: attrs.rows, parents: parents.rows, acls: acls.rows.map((row) => row.privilege_type) };
    }
    const before = await roleSnapshot();
    expect(before.attrs).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    expect(before.parents).toEqual([]);
    expect(before.acls).toEqual(["INSERT", "SELECT", "UPDATE"]);
    await expect(client.query(migrationSql(HARDENING_MIGRATION))).resolves.toBeDefined();
    expect(await roleSnapshot()).toEqual(before);
  });

  it("grants nothing to pre-existing metadata tables or identically named tables in other schemas", async () => {
    const metaSchema = "integrity_meta";
    const bystander = "integrity_bystander";
    await client.query(
      `DROP SCHEMA IF EXISTS ${metaSchema} CASCADE; CREATE SCHEMA ${metaSchema}; ` +
        `DROP SCHEMA IF EXISTS ${bystander} CASCADE; CREATE SCHEMA ${bystander}; ` +
        `CREATE TABLE ${bystander}.users (id uuid PRIMARY KEY)`,
    );
    try {
      const scratch = await newClient();
      try {
        await scratch.query(`SET search_path TO ${metaSchema}`);
        const hardeningIndex = MIGRATIONS.indexOf(HARDENING_MIGRATION);
        for (const name of MIGRATIONS.slice(0, hardeningIndex)) {
          await scratch.query(migrationSql(name));
        }
        // Metadata tables exist BEFORE D runs, so a loose grant loop would leak.
        await scratch.query(
          `CREATE TABLE ${metaSchema}._prisma_migrations (id text PRIMARY KEY, finished_at timestamptz)`,
        );
        await scratch.query(`CREATE TABLE ${metaSchema}.test_meta (run_id text PRIMARY KEY)`);
        await scratch.query(migrationSql(HARDENING_MIGRATION));
        for (const name of MIGRATIONS.slice(hardeningIndex + 1)) {
          await scratch.query(migrationSql(name));
        }
      } finally {
        await scratch.end();
      }
      for (const rel of [`${metaSchema}._prisma_migrations`, `${metaSchema}.test_meta`, `${bystander}.users`]) {
        const privileges = await client.query(
          "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS select, " +
            "has_table_privilege('clearsight_app', $1, 'INSERT') AS insert, " +
            "has_table_privilege('clearsight_app', $1, 'UPDATE') AS update, " +
            "has_table_privilege('clearsight_app', $1, 'DELETE') AS delete",
          [rel],
        );
        expect(privileges.rows).toEqual([{ select: false, insert: false, update: false, delete: false }]);
      }
      const granted = await client.query(
        "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS select, " +
          "has_table_privilege('clearsight_app', $1, 'INSERT') AS insert, " +
          "has_table_privilege('clearsight_app', $1, 'UPDATE') AS update, " +
          "has_table_privilege('clearsight_app', $1, 'DELETE') AS delete",
        [`${metaSchema}.users`],
      );
      expect(granted.rows).toEqual([{ select: true, insert: true, update: true, delete: false }]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${metaSchema} CASCADE; DROP SCHEMA IF EXISTS ${bystander} CASCADE`);
    }
  });

  it("fails closed when no schema is on the search_path", async () => {
    try {
      await client.query("SET search_path TO nonexistent_qa_schema");
      await expect(client.query(migrationSql(HARDENING_MIGRATION))).rejects.toThrow(
        /no schema has been selected to create in/,
      );
    } finally {
      await client.query(`SET search_path TO ${SCHEMA}`);
    }
    const role = await client.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'clearsight_app'");
    expect(role.rows).toEqual([{ rolcanlogin: false }]);
    const privileges = await client.query(
      "SELECT has_table_privilege('clearsight_app', $1, 'INSERT') AS insert",
      [`${SCHEMA}.users`],
    );
    expect(privileges.rows).toEqual([{ insert: true }]);
  });

  it("keeps audit writes sequence-free for the application role", async () => {
    await seedBase();
    const idFacts = await client.query(
      "SELECT data_type, column_default FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'audit_events' AND column_name = 'id'",
      [SCHEMA],
    );
    expect(idFacts.rows).toEqual([{ data_type: "uuid", column_default: "gen_random_uuid()" }]);
    const sequences = await client.query(
      "SELECT count(*)::int AS count FROM information_schema.sequences WHERE sequence_schema = $1",
      [SCHEMA],
    );
    expect(sequences.rows).toEqual([{ count: 0 }]);
    try {
      await client.query("SET ROLE clearsight_app");
      const inserted = await client.query(
        "INSERT INTO audit_events (actor_kind, target_type, action, outcome) " +
          "VALUES ('SYSTEM', 'SYSTEM', 'LOGIN', 'SUCCESS') RETURNING id",
      );
      expect(String(inserted.rows[0].id)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await client.query("RESET ROLE");
    }
  });
});
