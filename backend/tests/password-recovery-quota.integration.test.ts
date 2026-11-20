import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { inject } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  computePasswordRecoveryBucketHash,
  createPasswordRecoveryQuotaGuard,
  derivePasswordRecoveryKey,
  FORGOT_EMAIL_LIMIT,
  FORGOT_EMAIL_WINDOW_SECONDS,
  FORGOT_IP_LIMIT,
  FORGOT_IP_WINDOW_SECONDS,
  PASSWORD_RECOVERY_QUOTA_KINDS,
  PasswordRecoveryQuotaInputError,
  RESET_IP_LIMIT,
  RESET_IP_WINDOW_SECONDS,
} from "../src/services/password-recovery-quota.js";
import { createAuthLoginProtection } from "../src/services/login-guard.js";
import { TEST_ENV } from "./helpers/app.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

const RECOVERY_MIGRATION = "20261119020000_password_recovery_quotas";
const START = new Date("2026-11-19T00:00:00.000Z");

const prisma = createTestPrisma();

afterAll(async () => {
  await prisma.$disconnect();
});

interface RecoveryRow {
  kind: string;
  key_hash: string;
  attempt_count: number;
  window_started_at: Date;
  updated_at: Date;
}

async function recoveryRows(): Promise<RecoveryRow[]> {
  return prisma.$queryRawUnsafe<RecoveryRow[]>(
    "SELECT kind, key_hash, attempt_count, window_started_at, updated_at " +
      "FROM auth_recovery_buckets ORDER BY kind, key_hash",
  );
}

function makeClock(start: Date) {
  let current = start;
  return {
    now: () => current,
    set(value: Date) {
      current = value;
    },
  };
}

function makeGuard(clock: ReturnType<typeof makeClock>) {
  return createPasswordRecoveryQuotaGuard(prisma, {
    jwtSecret: TEST_ENV.JWT_SECRET,
    now: clock.now,
  });
}

describe("durable recovery quota guard", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it("allows exactly three forgot-email attempts and reports a generic retry", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const email = "email-limit@recovery.test";

    for (let attempt = 0; attempt < FORGOT_EMAIL_LIMIT; attempt += 1) {
      await expect(guard.reserveForgotEmail(email)).resolves.toEqual({ allowed: true });
    }

    const blocked = await guard.reserveForgotEmail(email);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(FORGOT_EMAIL_WINDOW_SECONDS);
    }

    expect(await recoveryRows()).toEqual([
      expect.objectContaining({ kind: "FORGOT_EMAIL", attempt_count: FORGOT_EMAIL_LIMIT }),
    ]);
  });

  it("allows twenty forgot-IP attempts per hour", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const ip = "203.0.113.10";

    for (let attempt = 0; attempt < FORGOT_IP_LIMIT; attempt += 1) {
      await expect(guard.reserveForgotIp(ip)).resolves.toEqual({ allowed: true });
    }

    const blocked = await guard.reserveForgotIp(ip);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(FORGOT_IP_WINDOW_SECONDS);
    }

    expect(await recoveryRows()).toEqual([
      expect.objectContaining({ kind: "FORGOT_IP", attempt_count: FORGOT_IP_LIMIT }),
    ]);
  });

  it("allows twenty reset-IP attempts per fifteen minutes", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const ip = "198.51.100.20";

    for (let attempt = 0; attempt < RESET_IP_LIMIT; attempt += 1) {
      await expect(guard.reserveResetIp(ip)).resolves.toEqual({ allowed: true });
    }

    const blocked = await guard.reserveResetIp(ip);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(RESET_IP_WINDOW_SECONDS);
    }

    expect(await recoveryRows()).toEqual([
      expect.objectContaining({ kind: "RESET_IP", attempt_count: RESET_IP_LIMIT }),
    ]);
  });

  it("honors the exact window boundary and reports at least one second before it", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const email = "boundary@recovery.test";

    for (let attempt = 0; attempt < FORGOT_EMAIL_LIMIT; attempt += 1) {
      await guard.reserveForgotEmail(email);
    }

    const oneMsBefore = new Date(
      START.getTime() + FORGOT_EMAIL_WINDOW_SECONDS * 1000 - 1,
    );
    clock.set(oneMsBefore);
    const before = await guard.reserveForgotEmail(email);
    expect(before.allowed).toBe(false);
    if (!before.allowed) {
      expect(before.retryAfterSeconds).toBe(1);
    }

    const boundary = new Date(START.getTime() + FORGOT_EMAIL_WINDOW_SECONDS * 1000);
    clock.set(boundary);
    await expect(guard.reserveForgotEmail(email)).resolves.toEqual({ allowed: true });

    const rows = await recoveryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "FORGOT_EMAIL",
      attempt_count: 1,
    });
    expect(rows[0]?.window_started_at.getTime()).toBe(boundary.getTime());
  });

  it("never allows more than the fixed limit under concurrent reservations", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const email = "concurrent@recovery.test";

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => guard.reserveForgotEmail(email)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(
      FORGOT_EMAIL_LIMIT,
    );
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(7);
    for (const decision of decisions) {
      if (!decision.allowed) {
        expect(decision.retryAfterSeconds).toBe(FORGOT_EMAIL_WINDOW_SECONDS);
      }
    }

    const rows = await recoveryRows();
    expect(rows).toEqual([
      expect.objectContaining({ kind: "FORGOT_EMAIL", attempt_count: FORGOT_EMAIL_LIMIT }),
    ]);
  });

  it("commits the forgot-IP reservation even after the email quota is exhausted", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const email = "email-exhausted@recovery.test";
    const ip = "203.0.113.11";

    for (let attempt = 0; attempt < FORGOT_EMAIL_LIMIT; attempt += 1) {
      await expect(guard.reserveForgotEmail(email)).resolves.toEqual({ allowed: true });
    }
    await expect(guard.reserveForgotEmail(email)).resolves.toMatchObject({
      allowed: false,
    });

    for (let attempt = 0; attempt < FORGOT_IP_LIMIT; attempt += 1) {
      await expect(guard.reserveForgotIp(ip)).resolves.toEqual({ allowed: true });
    }
    await expect(guard.reserveForgotIp(ip)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: FORGOT_IP_WINDOW_SECONDS,
    });
  });

  it("applies the same quota to active, inactive and unknown identifiers without account writes", async () => {
    const active = await makeUser(prisma, "OFTALMOLOGO", {
      email: "active-recovery@clearsight.test",
    });
    const inactive = await makeUser(prisma, "OFTALMOLOGO", {
      email: "inactive-recovery@clearsight.test",
      isActive: false,
    });
    const usersBefore = await prisma.user.count();
    const clock = makeClock(START);
    const guard = makeGuard(clock);

    const cases = [
      { email: active.email, ip: "203.0.113.21" },
      { email: inactive.email, ip: "203.0.113.22" },
      { email: `unknown-${randomUUID()}@clearsight.test`, ip: "203.0.113.23" },
    ];

    for (const item of cases) {
      for (let attempt = 0; attempt < FORGOT_EMAIL_LIMIT; attempt += 1) {
        await expect(
          guard.reserveForgotEmail(item.email),
        ).resolves.toEqual({ allowed: true });
      }
      await expect(
        guard.reserveForgotEmail(item.email),
      ).resolves.toMatchObject({ allowed: false, retryAfterSeconds: 3600 });
      await expect(guard.reserveForgotIp(item.ip)).resolves.toEqual({ allowed: true });
    }

    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("does not read or write login buckets and uses a distinct HMAC domain", async () => {
    const loginGuard = createAuthLoginProtection(prisma, {
      jwtSecret: TEST_ENV.JWT_SECRET,
    });
    await loginGuard.reserveIpAttempt("198.51.100.30");
    const loginBefore = await prisma.authLoginBucket.count();
    expect(loginBefore).toBe(1);

    const clock = makeClock(START);
    const guard = makeGuard(clock);
    await guard.reserveForgotIp("203.0.113.30");

    expect(await prisma.authLoginBucket.count()).toBe(loginBefore);
    const recovery = await recoveryRows();
    expect(recovery).toHaveLength(1);

    const recoveryKey = derivePasswordRecoveryKey(TEST_ENV.JWT_SECRET);
    const expected = computePasswordRecoveryBucketHash(
      recoveryKey,
      PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_IP,
      "203.0.113.30",
    );
    expect(recovery[0]?.key_hash).toBe(expected);
    expect(recovery[0]?.key_hash).not.toBe(
      (await prisma.authLoginBucket.findFirstOrThrow()).keyHash,
    );
  });

  it("stores only HMAC hashes and never raw identifiers or secret material", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);
    const email = "raw-canary-email@recovery.test";
    const ip = "203.0.113.55";

    await guard.reserveForgotEmail(email);
    await guard.reserveForgotIp(ip);

    const rows = await recoveryRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_hash).not.toContain("raw-canary");
      expect(row.key_hash).not.toContain(ip);
    }

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(ip);
    expect(serialized).not.toContain(TEST_ENV.JWT_SECRET);

    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      "SELECT column_name FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'auth_recovery_buckets' " +
        "ORDER BY column_name",
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "attempt_count",
      "key_hash",
      "kind",
      "updated_at",
      "window_started_at",
    ]);
  });

  it("rejects invalid direct values before opening a store transaction", async () => {
    const clock = makeClock(START);
    const guard = makeGuard(clock);

    await expect(guard.reserveForgotEmail("not-an-email")).rejects.toBeInstanceOf(
      PasswordRecoveryQuotaInputError,
    );
    await expect(guard.reserveForgotIp("example.com")).rejects.toBeInstanceOf(
      PasswordRecoveryQuotaInputError,
    );
    expect(await recoveryRows()).toHaveLength(0);
  });
});

describe("password recovery migration invariants", () => {
  const SCHEMA = "password_recovery_rules";
  let rules: PgClient;

  beforeAll(async () => {
    rules = new PgClient({ connectionString: inject("databaseUrl") });
    await rules.connect();
    await rules.query(
      `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`,
    );
    for (const name of migrationNames()) {
      await rules.query(migrationSql(name));
    }
  });

  afterAll(async () => {
    await rules.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await rules.end();
  });

  beforeEach(async () => {
    await rules.query(`TRUNCATE TABLE ${SCHEMA}.auth_recovery_buckets`);
  });

  it("is part of the checked-in migration inventory", () => {
    expect(migrationNames()).toContain(RECOVERY_MIGRATION);
  });

  it("enforces kind, hash, count and window constraints", async () => {
    const hash = "a".repeat(64);
    await rules.query(
      `INSERT INTO ${SCHEMA}.auth_recovery_buckets
         (kind, key_hash, attempt_count, window_started_at, updated_at)
       VALUES ('FORGOT_EMAIL', $1, 3, now(), now())`,
      [hash],
    );

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_EMAIL', $1, 0, now(), now())`,
        [hash],
      ),
    ).rejects.toThrow(/duplicate key/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('BOGUS', $1, 0, now(), now())`,
        ["b".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_EMAIL', 'not-a-hash', 0, now(), now())`,
      ),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_IP', $1, -1, now(), now())`,
        ["c".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_EMAIL', $1, 4, now(), now())`,
        ["d".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_IP', $1, 21, now(), now())`,
        ["e".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_IP', $1, 0, NULL, now())`,
        ["f".repeat(64)],
      ),
    ).rejects.toThrow(/null value in column "window_started_at"/);

    await expect(
      rules.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_IP', $1, 0, now(), now() - interval '1 second')`,
        ["1".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("replays idempotently and preserves durable rows", async () => {
    const hash = "2".repeat(64);
    await rules.query(
      `INSERT INTO ${SCHEMA}.auth_recovery_buckets
         (kind, key_hash, attempt_count, window_started_at, updated_at)
       VALUES ('RESET_IP', $1, 2, now(), now())`,
      [hash],
    );

    await rules.query(migrationSql(RECOVERY_MIGRATION));

    const rows = await rules.query(
      `SELECT kind, key_hash, attempt_count FROM ${SCHEMA}.auth_recovery_buckets
       WHERE kind = 'RESET_IP' AND key_hash = $1`,
      [hash],
    );
    expect(rows.rows).toEqual([{ kind: "RESET_IP", key_hash: hash, attempt_count: 2 }]);
  });

  it("grants the application role only SELECT/INSERT/UPDATE", async () => {
    const roleClient = new PgClient({ connectionString: inject("databaseUrl") });
    await roleClient.connect();
    const hash = "3".repeat(64);
    try {
      await roleClient.query(`SET ROLE clearsight_app`);

      await roleClient.query(
        `INSERT INTO ${SCHEMA}.auth_recovery_buckets
           (kind, key_hash, attempt_count, window_started_at, updated_at)
         VALUES ('FORGOT_IP', $1, 1, now(), now())`,
        [hash],
      );
      const selected = await roleClient.query(
        `SELECT attempt_count FROM ${SCHEMA}.auth_recovery_buckets
         WHERE kind = 'FORGOT_IP' AND key_hash = $1`,
        [hash],
      );
      expect(selected.rows).toEqual([{ attempt_count: 1 }]);

      const updated = await roleClient.query(
        `UPDATE ${SCHEMA}.auth_recovery_buckets SET attempt_count = 2
         WHERE kind = 'FORGOT_IP' AND key_hash = $1`,
        [hash],
      );
      expect(updated.rowCount).toBe(1);

      await expect(
        roleClient.query(
          `DELETE FROM ${SCHEMA}.auth_recovery_buckets
           WHERE kind = 'FORGOT_IP' AND key_hash = $1`,
          [hash],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        roleClient.query(`TRUNCATE TABLE ${SCHEMA}.auth_recovery_buckets`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await roleClient.query("RESET ROLE").catch(() => undefined);
      await roleClient.end();
    }
  });

  it("fails closed on an effective forbidden PUBLIC grant without rewriting it", async () => {
    await rules.query("BEGIN");
    try {
      await rules.query(
        `GRANT DELETE ON TABLE ${SCHEMA}.auth_recovery_buckets TO PUBLIC`,
      );
      const acl = await rules.query(
        "SELECT count(*)::int AS count FROM aclexplode(" +
          "(SELECT relacl FROM pg_class WHERE oid = $1::regclass)) " +
          "WHERE grantee = 0 AND privilege_type = 'DELETE'",
        [`${SCHEMA}.auth_recovery_buckets`],
      );
      expect(acl.rows).toEqual([{ count: 1 }]);

      await expect(rules.query(migrationSql(RECOVERY_MIGRATION))).rejects.toThrow(
        /effective forbidden PUBLIC privilege/,
      );
    } finally {
      await rules.query("ROLLBACK");
    }
  });
});
