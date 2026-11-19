import { PrismaPg } from "@prisma/adapter-pg";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { PrismaClient as GeneratedPrismaClient } from "../src/generated/prisma/client.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import {
  computeLoginBucketHash,
  createAuthLoginProtection,
  deriveLoginProtectionKey,
  FIXED_LOGIN_LOCKOUT_MS,
  INTERNAL_CLIENT_BUCKET,
  LOGIN_BUCKET_KINDS,
  normalizeLoginIdentifier,
  type AuthLoginProtectionOptions,
} from "../src/services/login-guard.js";
import { createAuthSessionService } from "../src/services/session.js";
import { buildTestApp, TEST_ENV } from "./helpers/app.js";
import {
  createTestPrisma,
  hashPassword,
  makeUser,
  resetDb,
  testDatabaseUrl,
} from "./helpers/db.js";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

const prisma = createTestPrisma();
let app: FastifyInstance;
let admin: PgClient;

const PASSWORD = "synthetic-login-password";
const GENERIC_401 = {
  error: "Unauthorized",
  message: "Invalid credentials",
  statusCode: 401,
} as const;
const GENERIC_429 = {
  error: "Too Many Requests",
  message: "Too many login attempts",
  statusCode: 429,
} as const;
const AUTH_UNAVAILABLE = {
  error: "service_unavailable",
  message: "Authentication is temporarily unavailable",
  statusCode: 503,
} as const;
const LOGIN_MIGRATION = "20261119000000_login_protection";

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  app = await buildTestApp(prisma);
  admin = new PgClient({ connectionString: testDatabaseUrl() });
  await admin.connect();
});

beforeEach(async () => {
  await resetDb(prisma);
});

afterAll(async () => {
  await app.close();
  await admin.end();
  await prisma.$disconnect();
});

function buildGuard(
  db: PrismaClient,
  overrides: Omit<AuthLoginProtectionOptions, "jwtSecret"> = {},
) {
  return createAuthLoginProtection(db, { jwtSecret: TEST_ENV.JWT_SECRET, ...overrides });
}

interface AuthUserOverrides {
  isActive?: boolean;
  lockedUntil?: Date | null;
  email?: string;
}

async function createUser(overrides: AuthUserOverrides = {}) {
  return makeUser(prisma, "OFTALMOLOGO", {
    passwordHash,
    ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
    ...(overrides.lockedUntil !== undefined ? { lockedUntil: overrides.lockedUntil } : {}),
    ...(overrides.email !== undefined ? { email: overrides.email } : {}),
  });
}

interface LoginOptions {
  remoteAddress?: string;
  headers?: Record<string, string>;
}

function login(
  target: FastifyInstance,
  payload: Record<string, unknown> | string,
  options: LoginOptions = {},
) {
  return target.inject({
    method: "POST",
    url: "/auth/login",
    payload,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

interface BucketRow {
  kind: string;
  key_hash: string;
  failure_count: number;
  window_started_at: Date | null;
  locked_until: Date | null;
  updated_at: Date;
}

async function buckets(): Promise<BucketRow[]> {
  return prisma.$queryRawUnsafe<BucketRow[]>(
    "SELECT kind, key_hash, failure_count, window_started_at, locked_until, updated_at " +
      "FROM auth_login_buckets ORDER BY kind, key_hash",
  );
}

async function userState(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { failedLoginCount: true, lockedUntil: true },
  });
}

function auditFailingClient(base: PrismaClient): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = target.$transaction.bind(target) as (
          callback: (tx: unknown) => Promise<unknown>,
          options?: unknown,
        ) => Promise<unknown>;
        return async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          transaction(async (tx) => {
            const guardedTx = new Proxy(tx as object, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === "auditEvent") {
                  const delegate = Reflect.get(txTarget, txProperty, txReceiver) as Record<
                    string,
                    unknown
                  >;
                  return new Proxy(delegate, {
                    get(delegateTarget, delegateProperty, delegateReceiver) {
                      if (delegateProperty === "create") {
                        return async () => {
                          throw new Error("simulated audit write failure");
                        };
                      }
                      const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
                      return typeof value === "function" ? value.bind(delegateTarget) : value;
                    },
                  });
                }
                const value = Reflect.get(txTarget, txProperty, txReceiver);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            });
            return callback(guardedTx);
          }, options);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

function failingTransactionClient(base: PrismaClient, error: Error): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async () => {
          throw error;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("HU01 consecutive credential failures", () => {
  it("allows four 401s, locks on the fifth for 15 minutes and never resets or extends during the lock", async () => {
    const user = await createUser();
    let current = new Date("2026-11-19T08:00:00.000Z");
    const clocked = await buildApp({
      env: TEST_ENV,
      prisma,
      now: () => new Date(current.getTime()),
    });
    await clocked.ready();

    try {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await login(clocked, { email: user.email, password: "wrong-password" });
        expect(response.statusCode, `attempt ${attempt}`).toBe(401);
        expect(response.json()).toEqual(GENERIC_401);
      }

      const afterFour = await userState(user.id);
      expect(afterFour.failedLoginCount).toBe(4);
      expect(afterFour.lockedUntil).toBeNull();

      const fifth = await login(clocked, { email: user.email, password: "wrong-password" });
      expect(fifth.statusCode).toBe(429);
      expect(fifth.json()).toEqual(GENERIC_429);
      expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(0);

      const locked = await userState(user.id);
      expect(locked.failedLoginCount).toBe(5);
      expect(locked.lockedUntil).not.toBeNull();
      const lockTime = locked.lockedUntil?.getTime() ?? 0;
      expect(lockTime - current.getTime()).toBe(FIXED_LOGIN_LOCKOUT_MS);

      const identifier = (await buckets()).find(
        (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
      );
      expect(identifier).toMatchObject({ failure_count: 5 });
      expect(identifier?.locked_until?.getTime()).toBe(lockTime);

      // The correct password during the lockout returns the same generic 429,
      // creates no session and neither resets nor extends the stored lock.
      const duringLock = await login(clocked, { email: user.email, password: PASSWORD });
      expect(duringLock.statusCode).toBe(429);
      expect(duringLock.json()).toEqual(GENERIC_429);

      const stillLocked = await userState(user.id);
      expect(stillLocked.failedLoginCount).toBe(5);
      expect(stillLocked.lockedUntil?.getTime()).toBe(lockTime);
      const stillIdentifier = (await buckets()).find(
        (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
      );
      expect(stillIdentifier).toMatchObject({ failure_count: 5 });
      expect(stillIdentifier?.locked_until?.getTime()).toBe(lockTime);
      expect(await prisma.userSession.count()).toBe(0);

      // At the exact 15-minute boundary the fresh guard clock allows the login
      // and the success resets both the user mirror and the bucket.
      current = new Date(lockTime);
      const atBoundary = await login(clocked, { email: user.email, password: PASSWORD });
      expect(atBoundary.statusCode).toBe(200);
      expect(atBoundary.json().tokenType).toBe("bearer");

      const reset = await userState(user.id);
      expect(reset.failedLoginCount).toBe(0);
      expect(reset.lockedUntil).toBeNull();
      const resetIdentifier = (await buckets()).find(
        (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
      );
      expect(resetIdentifier).toMatchObject({ failure_count: 0, locked_until: null });
      expect(await prisma.userSession.count()).toBe(1);
    } finally {
      await clocked.close();
    }
  });

  it("applies the identical 5th-attempt lockout to an unknown identifier with no fake user", async () => {
    const ghost = `ghost-${randomUUID()}@clearsight.test`;
    const known = await createUser();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await login(app, { email: ghost, password: "wrong-password" });
      expect(response.statusCode, `unknown attempt ${attempt}`).toBe(401);
      expect(response.json()).toEqual(GENERIC_401);
    }

    const unknownLocked = await login(app, { email: ghost, password: "wrong-password" });
    expect(unknownLocked.statusCode).toBe(429);
    expect(unknownLocked.json()).toEqual(GENERIC_429);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await login(app, { email: known.email, password: "wrong-password" });
      expect(response.statusCode, `known attempt ${attempt}`).toBe(401);
    }
    const knownLocked = await login(app, { email: known.email, password: "wrong-password" });
    expect(knownLocked.statusCode).toBe(429);

    // Unknown and known identifiers expose the exact same throttled response.
    expect(unknownLocked.body).toBe(knownLocked.body);
    const unknownRetry = Number(unknownLocked.headers["retry-after"]);
    const knownRetry = Number(knownLocked.headers["retry-after"]);
    expect(Number.isInteger(unknownRetry) && unknownRetry > 0).toBe(true);
    expect(Number.isInteger(knownRetry) && knownRetry > 0).toBe(true);

    // No fake user is ever created for the unknown identifier.
    expect(await prisma.user.findFirst({ where: { email: ghost } })).toBeNull();

    const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
    const ghostHash = computeLoginBucketHash(
      key,
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      ghost.toLowerCase(),
    );
    const ghostBucket = (await buckets()).find((row) => row.key_hash === ghostHash);
    expect(ghostBucket).toMatchObject({ kind: LOGIN_BUCKET_KINDS.IDENTIFIER, failure_count: 5 });
    expect(ghostBucket?.locked_until).not.toBeNull();
  });

  it("resets the counter on an earlier success and starts again at one on the next failure", async () => {
    const user = await createUser();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await login(app, { email: user.email, password: "wrong-password" });
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
    }
    expect((await userState(user.id)).failedLoginCount).toBe(4);

    const success = await login(app, { email: user.email, password: PASSWORD });
    expect(success.statusCode).toBe(200);
    const afterSuccess = await userState(user.id);
    expect(afterSuccess.failedLoginCount).toBe(0);
    expect(afterSuccess.lockedUntil).toBeNull();

    const nextFailure = await login(app, { email: user.email, password: "wrong-password" });
    expect(nextFailure.statusCode).toBe(401);
    expect((await userState(user.id)).failedLoginCount).toBe(1);
    expect(await prisma.userSession.count()).toBe(1);
  });

  it("rolls back the success reset when the signer or audit write fails", async () => {
    const signerUser = await createUser();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(app, { email: signerUser.email, password: "wrong-password" });
    }
    expect((await userState(signerUser.id)).failedLoginCount).toBe(4);

    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });
    await expect(
      service.login({ email: signerUser.email, password: PASSWORD }, () => {
        throw new Error("signer canary");
      }),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    const afterSigner = await userState(signerUser.id);
    expect(afterSigner.failedLoginCount).toBe(4);
    expect(afterSigner.lockedUntil).toBeNull();

    const auditUser = await createUser();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(app, { email: auditUser.email, password: "wrong-password" });
    }
    expect((await userState(auditUser.id)).failedLoginCount).toBe(4);

    const failingApp = await buildApp({ env: TEST_ENV, prisma: auditFailingClient(prisma) });
    await failingApp.ready();
    try {
      const response = await login(failingApp, { email: auditUser.email, password: PASSWORD });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(AUTH_UNAVAILABLE);
    } finally {
      await failingApp.close();
    }

    const afterAudit = await userState(auditUser.id);
    expect(afterAudit.failedLoginCount).toBe(4);
    expect(afterAudit.lockedUntil).toBeNull();
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("locks once at the fifth consecutive failure under concurrency without extending the lock", async () => {
    const user = await createUser();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(app, { email: user.email, password: "wrong-password" });
    }
    expect((await userState(user.id)).failedLoginCount).toBe(4);

    const [first, second] = await Promise.all([
      login(app, { email: user.email, password: "wrong-password" }),
      login(app, { email: user.email, password: "wrong-password" }),
    ]);

    expect(first.statusCode).toBe(429);
    expect(second.statusCode).toBe(429);
    expect(first.json()).toEqual(GENERIC_429);
    expect(second.json()).toEqual(GENERIC_429);

    const locked = await userState(user.id);
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).not.toBeNull();

    const identifierRows = (await buckets()).filter(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifierRows).toHaveLength(1);
    expect(identifierRows[0]).toMatchObject({ failure_count: 5 });
    expect(identifierRows[0]?.locked_until?.getTime()).toBe(locked.lockedUntil?.getTime());
  });
});

describe("complementary per-IP quota", () => {
  it("counts valid-schema attempts across different accounts sharing a NAT IP", async () => {
    const first = await createUser();
    const second = await createUser();
    let current = new Date("2026-11-19T09:00:00.000Z");
    const limited = await buildApp({
      env: { ...TEST_ENV, IP_RATE_LIMIT: 3, IP_RATE_WINDOW_SECONDS: 60 },
      prisma,
      now: () => new Date(current.getTime()),
    });
    await limited.ready();

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await login(
          limited,
          { email: first.email, password: "wrong-password" },
          { remoteAddress: "203.0.113.20" },
        );
        expect(response.statusCode, `attempt ${attempt}`).toBe(401);
      }

      const blockedSameAccount = await login(
        limited,
        { email: first.email, password: "wrong-password" },
        { remoteAddress: "203.0.113.20" },
      );
      expect(blockedSameAccount.statusCode).toBe(429);
      expect(blockedSameAccount.json()).toEqual(GENERIC_429);

      // A different, otherwise-valid account behind the same NAT IP is still
      // subject to the shared complementary quota.
      const blockedOtherAccount = await login(
        limited,
        { email: second.email, password: PASSWORD },
        { remoteAddress: "203.0.113.20" },
      );
      expect(blockedOtherAccount.statusCode).toBe(429);

      const ipBucket = (await buckets()).find((row) => row.kind === LOGIN_BUCKET_KINDS.IP);
      expect(ipBucket).toMatchObject({ failure_count: 3 });
      expect(ipBucket?.window_started_at).not.toBeNull();
      const windowStart = ipBucket?.window_started_at?.getTime() ?? 0;

      // A blocked retry does not grow the count or move the window.
      const blockedRetry = await login(
        limited,
        { email: first.email, password: "wrong-password" },
        { remoteAddress: "203.0.113.20" },
      );
      expect(blockedRetry.statusCode).toBe(429);
      const afterRetry = (await buckets()).find((row) => row.kind === LOGIN_BUCKET_KINDS.IP);
      expect(afterRetry).toMatchObject({ failure_count: 3 });
      expect(afterRetry?.window_started_at?.getTime()).toBe(windowStart);

      // After the fixed window elapses the next valid attempt starts a new
      // logical window instead of extending the old one.
      current = new Date(windowStart + 60_000);
      const afterWindow = await login(
        limited,
        { email: second.email, password: PASSWORD },
        { remoteAddress: "203.0.113.20" },
      );
      expect(afterWindow.statusCode).toBe(200);
      expect(await prisma.userSession.count()).toBe(1);
    } finally {
      await limited.close();
    }
  });

  it("still applies the IP quota to internal service calls without request metadata", async () => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma, { ipRateLimit: 2, ipRateWindowSeconds: 60 }),
    });
    const issuer = () => "never-emitted";

    await expect(
      service.login({ email: user.email, password: "wrong-password" }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    await expect(
      service.login({ email: user.email, password: "wrong-password" }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    await expect(
      service.login({ email: user.email, password: PASSWORD }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_LOGIN_THROTTLED" });

    const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
    const internalHash = computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, INTERNAL_CLIENT_BUCKET);
    const internal = (await buckets()).find((row) => row.key_hash === internalHash);
    expect(internal).toMatchObject({ kind: LOGIN_BUCKET_KINDS.IP, failure_count: 2 });
    expect(await prisma.userSession.count()).toBe(0);
  });

  it("uses the actual peer address and ignores a spoofed X-Forwarded-For header", async () => {
    const user = await createUser();
    const limited = await buildApp({
      env: { ...TEST_ENV, IP_RATE_LIMIT: 3, IP_RATE_WINDOW_SECONDS: 60 },
      prisma,
    });
    await limited.ready();

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await login(
          limited,
          { email: user.email, password: "wrong-password" },
          {
            remoteAddress: "203.0.113.30",
            headers: { "x-forwarded-for": `198.51.100.${attempt}` },
          },
        );
        expect(response.statusCode, `attempt ${attempt}`).toBe(401);
      }

      const blocked = await login(
        limited,
        { email: user.email, password: "wrong-password" },
        {
          remoteAddress: "203.0.113.30",
          headers: { "x-forwarded-for": "192.0.2.99" },
        },
      );
      expect(blocked.statusCode).toBe(429);

      const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
      const keys = new Set(
        (await buckets())
          .filter((row) => row.kind === LOGIN_BUCKET_KINDS.IP)
          .map((row) => row.key_hash),
      );
      const peerHashes = [
        computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, "203.0.113.30"),
        computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, "::ffff:203.0.113.30"),
      ];
      expect(peerHashes.some((hash) => keys.has(hash))).toBe(true);
      expect(keys.has(computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, "192.0.2.99"))).toBe(false);
    } finally {
      await limited.close();
    }
  });
});

describe("durable pseudonymous storage", () => {
  it("stores only normalized HMAC buckets and never raw identifiers or secrets", async () => {
    const user = await createUser({ email: "hmac-normalization@clearsight.test" });
    const peer = "198.51.100.25";

    const response = await login(
      app,
      { email: "  HMAC-Normalization@Clearsight.TEST  ", password: "wrong-password" },
      { remoteAddress: peer },
    );
    expect(response.statusCode).toBe(401);

    const rows = await buckets();
    expect(rows.map((row) => row.kind).sort()).toEqual([
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      LOGIN_BUCKET_KINDS.IP,
    ]);

    const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
    const identifier = rows.find((row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER);
    const ip = rows.find((row) => row.kind === LOGIN_BUCKET_KINDS.IP);
    expect(identifier?.key_hash).toBe(
      computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, "hmac-normalization@clearsight.test"),
    );
    const peerHashes = [
      computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, peer),
      computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, `::ffff:${peer}`),
    ];
    expect(peerHashes).toContain(ip?.key_hash);

    for (const row of rows) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_hash).not.toContain("hmac-normalization");
      expect(row.key_hash).not.toContain(peer);
    }

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("hmac-normalization@clearsight.test");
    expect(serialized).not.toContain(peer);
    expect(serialized).not.toContain(TEST_ENV.JWT_SECRET);

    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      "SELECT column_name FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'auth_login_buckets' ORDER BY column_name",
    );
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual([
      "failure_count",
      "key_hash",
      "kind",
      "locked_until",
      "updated_at",
      "window_started_at",
    ]);
    for (const name of names) {
      expect(name).not.toMatch(/email|address|ip$|secret|password|token/i);
    }
  });
});

describe("failure and lock coherence", () => {
  it("blocks on a known mirrored counter of four even when the identifier bucket is missing", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 4, lockedUntil: null },
    });
    expect(await buckets()).toHaveLength(0);

    const response = await login(app, { email: user.email, password: "wrong-password" });
    expect(response.statusCode).toBe(429);

    const state = await userState(user.id);
    expect(state.failedLoginCount).toBe(5);
    expect(state.lockedUntil).not.toBeNull();
    const identifier = (await buckets()).find(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifier).toMatchObject({ failure_count: 5 });
    expect(identifier?.locked_until?.getTime()).toBe(state.lockedUntil?.getTime());
  });

  it("resets an expired user lock with a stale count of five instead of relocking", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() - 60_000) },
    });

    const response = await login(app, { email: user.email, password: "wrong-password" });
    expect(response.statusCode).toBe(401);

    const state = await userState(user.id);
    expect(state.failedLoginCount).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });

  it("honors an active user lock even when no identifier bucket exists", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 3_600_000) },
    });
    expect(await buckets()).toHaveLength(0);

    const response = await login(app, { email: user.email, password: PASSWORD });
    expect(response.statusCode).toBe(429);
    expect(await prisma.userSession.count()).toBe(0);

    const state = await userState(user.id);
    expect(state.failedLoginCount).toBe(5);
    const identifierRows = (await buckets()).filter(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifierRows).toHaveLength(0);
  });

  it("fails closed with a safe 503 when the durable guard store is unavailable", async () => {
    const user = await createUser();
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: failingTransactionClient(prisma, new Error(canary)),
    });
    await failingApp.ready();

    try {
      const response = await login(failingApp, { email: user.email, password: PASSWORD });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(AUTH_UNAVAILABLE);
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
    } finally {
      await failingApp.close();
    }

    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
    expect(await buckets()).toHaveLength(0);
  });
});

describe("migration E grants and replay", () => {
  it("is part of the checked-in migration inventory", () => {
    expect(migrationNames()).toContain(LOGIN_MIGRATION);
  });

  it("grants the application role only SELECT/INSERT/UPDATE and rejects TRUNCATE/DELETE", async () => {
    const roleClient = new PgClient({ connectionString: testDatabaseUrl() });
    await roleClient.connect();
    const keyHash = "1".repeat(64);
    try {
      await roleClient.query("SET ROLE clearsight_app");

      await roleClient.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count, window_started_at) " +
          "VALUES ('IP', $1, 1, now())",
        [keyHash],
      );
      const selected = await roleClient.query(
        "SELECT failure_count FROM public.auth_login_buckets WHERE kind = 'IP' AND key_hash = $1",
        [keyHash],
      );
      expect(selected.rows).toEqual([{ failure_count: 1 }]);

      const updated = await roleClient.query(
        "UPDATE public.auth_login_buckets SET failure_count = 2 WHERE kind = 'IP' AND key_hash = $1",
        [keyHash],
      );
      expect(updated.rowCount).toBe(1);

      await expect(
        roleClient.query("TRUNCATE TABLE public.auth_login_buckets"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        roleClient.query("DELETE FROM public.auth_login_buckets WHERE kind = 'IP' AND key_hash = $1", [
          keyHash,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await roleClient.query("RESET ROLE").catch(() => undefined);
      await roleClient.end();
    }
  });

  it("fails closed on an effective forbidden PUBLIC grant without rewriting it", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("GRANT DELETE ON TABLE public.auth_login_buckets TO PUBLIC");
      const acl = await admin.query(
        "SELECT count(*)::int AS count FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) " +
          "WHERE grantee = 0 AND privilege_type = 'DELETE'",
        ["public.auth_login_buckets"],
      );
      expect(acl.rows).toEqual([{ count: 1 }]);

      await expect(admin.query(migrationSql(LOGIN_MIGRATION))).rejects.toThrow(
        /effective forbidden PUBLIC privilege/,
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("replays without wiping durable buckets", async () => {
    const keyHash = `${"2".repeat(64)}`;
    await admin.query(
      "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count, locked_until) " +
        "VALUES ('IDENTIFIER', $1, 3, now() + interval '5 minutes')",
      [keyHash],
    );

    await admin.query(migrationSql(LOGIN_MIGRATION));

    const rows = await admin.query(
      "SELECT failure_count FROM public.auth_login_buckets WHERE kind = 'IDENTIFIER' AND key_hash = $1",
      [keyHash],
    );
    expect(rows.rows).toEqual([{ failure_count: 3 }]);
  });

  it("enforces the declared bucket invariants in the database", async () => {
    const keyHash = "3".repeat(64);
    await admin.query(
      "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count, window_started_at, locked_until) " +
        "VALUES ('IDENTIFIER', $1, 2, NULL, now() + interval '5 minutes')",
      [keyHash],
    );

    // Primary key (kind, key_hash) is unique.
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count) VALUES ('IDENTIFIER', $1, 0)",
        [keyHash],
      ),
    ).rejects.toThrow(/duplicate key/);

    // Only the two documented kinds exist; synthetic internal callers share
    // the IP keyspace and never a third kind value.
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count) VALUES ('INTERNAL', $1, 0)",
        ["4".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count) VALUES ('BOGUS', $1, 0)",
        ["4".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    // key_hash is exactly 64 lowercase hex characters.
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count) VALUES ('IP', $1, 0)",
        ["not-a-hash"],
      ),
    ).rejects.toThrow(/violates check constraint/);

    // failure_count can never go negative.
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count) VALUES ('IP', $1, -1)",
        ["5".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);

    // Clock-state checks: IP rows carry a window and no lock; identifier rows
    // carry no window and may carry a lock.
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count, window_started_at) " +
          "VALUES ('IDENTIFIER', $1, 0, now())",
        ["6".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);
    await expect(
      admin.query(
        "INSERT INTO public.auth_login_buckets (kind, key_hash, failure_count, window_started_at, locked_until) " +
          "VALUES ('IP', $1, 0, now(), now() + interval '5 minutes')",
        ["6".repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});

describe("restricted application role login pipeline", () => {
  it("runs the real login and /me flow as clearsight_app without TRUNCATE or credential claims", async () => {
    const url = testDatabaseUrl();
    const ownerIdentity = await prisma.$queryRawUnsafe<
      Array<{ current_user: string; session_user: string }>
    >("SELECT current_user, session_user");
    const ownerSessionUser = ownerIdentity[0]?.session_user;
    expect(ownerSessionUser).toBeTypeOf("string");

    // Owner creates the fixture; the runtime client only ever connects through
    // the least-privilege role. No credential is created or rolled out.
    const user = await createUser();
    const rolePrisma = new GeneratedPrismaClient({
      adapter: new PrismaPg(
        { connectionString: url, options: "-c role=clearsight_app" },
        { schema: "public" },
      ),
    });
    let roleApp: FastifyInstance | undefined;

    try {
      roleApp = await buildApp({ env: TEST_ENV, prisma: rolePrisma, databaseSchema: "public" });
      await roleApp.ready();

      const identity = await rolePrisma.$queryRawUnsafe<
        Array<{ current_user: string; session_user: string }>
      >("SELECT current_user, session_user");
      expect(identity).toEqual([
        { current_user: "clearsight_app", session_user: ownerSessionUser },
      ]);

      const bad = await login(roleApp, { email: user.email, password: "wrong-password" });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual(GENERIC_401);
      expect((await userState(user.id)).failedLoginCount).toBe(1);
      const afterBad = (await buckets()).find(
        (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
      );
      expect(afterBad).toMatchObject({ failure_count: 1 });

      const good = await login(roleApp, { email: user.email, password: PASSWORD });
      expect(good.statusCode).toBe(200);
      const token = good.json().accessToken as string;

      const me = await roleApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ id: user.id, email: user.email, role: user.role });

      // Owner verifies the committed reset, session and audit rows.
      const reset = await userState(user.id);
      expect(reset.failedLoginCount).toBe(0);
      expect(reset.lockedUntil).toBeNull();
      const identifier = (await buckets()).find(
        (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
      );
      expect(identifier).toMatchObject({ failure_count: 0, locked_until: null });
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(1);
      const audits = await prisma.auditEvent.findMany();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorKind: "USER",
        actorUserId: user.id,
        action: "AUTH_SESSION_CREATED",
        outcome: "SUCCESS",
        metadata: { channel: "password" },
      });

      // The role remains the restricted CURRENT_USER after the whole flow.
      const after = await rolePrisma.$queryRawUnsafe<Array<{ current_user: string }>>(
        "SELECT current_user",
      );
      expect(after).toEqual([{ current_user: "clearsight_app" }]);

      const beforeRows = await prisma.authLoginBucket.count();
      let truncateError: unknown;
      try {
        await rolePrisma.$executeRawUnsafe("TRUNCATE TABLE public.auth_login_buckets");
      } catch (error) {
        truncateError = error;
      }
      // Prisma wraps raw driver errors as P2010 with the PostgreSQL SQLSTATE in
      // `meta`/message; assert the real 42501 and never the wrapper code only.
      const errorRecord = truncateError as
        | { code?: string; meta?: unknown; message?: string; cause?: { code?: string } }
        | undefined;
      const rawMeta = errorRecord?.meta;
      const metaText = [
        typeof rawMeta === "string"
          ? rawMeta
          : rawMeta === undefined
            ? ""
            : JSON.stringify(rawMeta),
        errorRecord?.message ?? "",
      ].join(" ");
      const sqlState =
        (typeof (rawMeta as { code?: unknown } | undefined)?.code === "string"
          ? (rawMeta as { code: string }).code
          : undefined) ??
        /Code:\s*`?([0-9A-Z]{5})`?/.exec(metaText)?.[1] ??
        (errorRecord?.code !== "P2010" ? errorRecord?.code : undefined) ??
        errorRecord?.cause?.code;
      expect(sqlState).toBe("42501");
      expect(metaText).toMatch(/permission denied for table auth_login_buckets/);
      expect(await prisma.authLoginBucket.count()).toBe(beforeRows);
    } finally {
      await roleApp?.close();
      await rolePrisma.$disconnect();
      // Privileged owner cleanup only; the app role is never granted TRUNCATE.
      await resetDb(prisma);
    }
  });
});

describe("transport validation stays cheap", () => {
  it("rejects malformed JSON with 400 before any guard or store write", async () => {
    const response = await login(app, '{ "email": "x@clearsight.test", ', {
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(await buckets()).toHaveLength(0);
    expect(await prisma.userSession.count()).toBe(0);
  });

  it("rejects an invalid DTO with 400 before any guard or store write", async () => {
    const response = await login(app, { email: "not-an-email", password: PASSWORD });
    expect(response.statusCode).toBe(400);
    expect(await buckets()).toHaveLength(0);
    expect(await prisma.userSession.count()).toBe(0);
  });

  it("counts an over-72-byte password as a failed credential attempt", async () => {
    const user = await createUser();
    const response = await login(app, { email: user.email, password: "x".repeat(73) });
    expect(response.statusCode).toBe(401);
    expect((await userState(user.id)).failedLoginCount).toBe(1);
  });
});

describe("regression: stale proof accounting and inherited lock recheck", () => {
  /**
   * Mutates state only before the login transaction (transaction 2): the first
   * transaction is the guard's independent IP reservation and any later one is
   * the failure recorder. The mutation therefore lands after the bcrypt proof
   * and before the in-transaction consistency and lock rechecks.
   */
  function mutateOnLoginTransaction(base: PrismaClient, mutate: () => Promise<unknown>): PrismaClient {
    let transactions = 0;
    return new Proxy(base, {
      get(target, property, receiver) {
        if (property === "$transaction") {
          const transaction = target.$transaction.bind(target) as (
            callback: (tx: unknown) => Promise<unknown>,
            options?: unknown,
          ) => Promise<unknown>;
          return async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => {
            transactions += 1;
            if (transactions === 2) {
              await mutate();
            }
            return transaction(callback, options);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
  }

  it("records exactly one durable failure for a stale proof detected inside the login transaction", async () => {
    const user = await createUser();
    const rotatedHash = await hashPassword("rotated-after-bcrypt");
    const racingApp = await buildApp({
      env: TEST_ENV,
      prisma: mutateOnLoginTransaction(prisma, () =>
        prisma.user.update({ where: { id: user.id }, data: { passwordHash: rotatedHash } }),
      ),
    });
    await racingApp.ready();

    try {
      const response = await login(racingApp, { email: user.email, password: PASSWORD });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(GENERIC_401);
    } finally {
      await racingApp.close();
    }

    // Exactly one recorded failure: zero would skip the counter and two would
    // inflate it past the HU01 threshold schedule.
    const state = await userState(user.id);
    expect(state.failedLoginCount).toBe(1);
    expect(state.lockedUntil).toBeNull();
    const identifier = (await buckets()).find(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifier).toMatchObject({ failure_count: 1, locked_until: null });
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("turns the fifth stale proof into a single lock and ignores a throttled replay", async () => {
    const user = await createUser();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(app, { email: user.email, password: "wrong-password" });
    }
    expect((await userState(user.id)).failedLoginCount).toBe(4);

    const rotatedHash = await hashPassword("rotated-after-bcrypt");
    const racingApp = await buildApp({
      env: TEST_ENV,
      prisma: mutateOnLoginTransaction(prisma, () =>
        prisma.user.update({ where: { id: user.id }, data: { passwordHash: rotatedHash } }),
      ),
    });
    await racingApp.ready();

    try {
      const response = await login(racingApp, { email: user.email, password: PASSWORD });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual(GENERIC_429);
    } finally {
      await racingApp.close();
    }

    const locked = await userState(user.id);
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).not.toBeNull();
    const lockTime = locked.lockedUntil?.getTime() ?? 0;

    // A failure handed to the guard while the lock is active must be a no-op:
    // throttled without incrementing the count or extending the lock.
    const decision = await buildGuard(prisma).recordFailure(user.email);
    expect(decision.blocked).toBe(true);
    const after = await userState(user.id);
    expect(after.failedLoginCount).toBe(5);
    expect(after.lockedUntil?.getTime()).toBe(lockTime);
    const identifier = (await buckets()).find(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifier).toMatchObject({ failure_count: 5 });
    expect(identifier?.locked_until?.getTime()).toBe(lockTime);
    expect(await prisma.userSession.count()).toBe(0);
  });

  it("rechecks a lock that appears after the precheck and leaves the counters untouched", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 2, lockedUntil: null },
    });

    const current = new Date("2026-11-19T10:00:00.000Z");
    const lockAt = new Date(current.getTime() + 3_600_000);
    const racingApp = await buildApp({
      env: TEST_ENV,
      prisma: mutateOnLoginTransaction(prisma, () =>
        prisma.user.update({ where: { id: user.id }, data: { lockedUntil: lockAt } }),
      ),
      now: () => new Date(current.getTime()),
    });
    await racingApp.ready();

    try {
      const response = await login(racingApp, { email: user.email, password: PASSWORD });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual(GENERIC_429);
      expect(Number(response.headers["retry-after"])).toBe(3600);
    } finally {
      await racingApp.close();
    }

    // The inherited lock aborted the success before any reset or session write.
    const state = await userState(user.id);
    expect(state.failedLoginCount).toBe(2);
    expect(state.lockedUntil?.getTime()).toBe(lockAt.getTime());
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
    // The throttled success never reached the failure recorder.
    const identifierRows = (await buckets()).filter(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifierRows).toHaveLength(0);
  });

  it("reports Retry-After from the latest of divergent user and bucket locks", async () => {
    const user = await createUser();
    const userLock = new Date("2026-11-19T11:00:00.000Z");
    const bucketLock = new Date("2026-11-19T10:01:40.000Z");
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 5, lockedUntil: userLock },
    });
    const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
    await prisma.$executeRawUnsafe(
      "INSERT INTO auth_login_buckets (kind, key_hash, failure_count, window_started_at, locked_until, updated_at) " +
        "VALUES ($1, $2, 5, NULL, $3, $4)",
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, normalizeLoginIdentifier(user.email)),
      bucketLock,
      new Date("2026-11-19T10:00:00.000Z"),
    );

    const current = new Date("2026-11-19T10:00:00.000Z");
    const clocked = await buildApp({
      env: TEST_ENV,
      prisma,
      now: () => new Date(current.getTime()),
    });
    await clocked.ready();

    try {
      const response = await login(clocked, { email: user.email, password: PASSWORD });
      expect(response.statusCode).toBe(429);
      // The user lock expires one hour from the controlled clock; the earlier
      // bucket lock must not shorten the reported wait.
      expect(Number(response.headers["retry-after"])).toBe(3600);
    } finally {
      await clocked.close();
    }

    const state = await userState(user.id);
    expect(state.lockedUntil?.getTime()).toBe(userLock.getTime());
    const identifier = (await buckets()).find(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifier?.failure_count).toBe(5);
    expect(identifier?.locked_until?.getTime()).toBe(bucketLock.getTime());
  });
});

describe("regression: reservation durability and shared quotas", () => {
  it("keeps the IP reservation committed when the login transaction rolls back", async () => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });
    const issuer = () => "never-emitted";
    const metadata = { clientIp: "203.0.113.80" };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        service.login({ email: user.email, password: "wrong-password" }, issuer, metadata),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    }
    await expect(
      service.login(
        { email: user.email, password: PASSWORD },
        () => {
          throw new Error("signer canary");
        },
        metadata,
      ),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    // All four attempts stay counted in the IP bucket: the reservation commits
    // in its own transaction and cannot be rolled back by the login failure.
    const key = deriveLoginProtectionKey(TEST_ENV.JWT_SECRET);
    const ipRow = (await buckets()).find(
      (row) => row.key_hash === computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, "203.0.113.80"),
    );
    expect(ipRow).toMatchObject({ kind: LOGIN_BUCKET_KINDS.IP, failure_count: 4 });

    // The rolled-back success attempt recorded no identifier failure.
    const identifier = (await buckets()).find(
      (row) => row.kind === LOGIN_BUCKET_KINDS.IDENTIFIER,
    );
    expect(identifier).toMatchObject({ failure_count: 3 });
    expect((await userState(user.id)).failedLoginCount).toBe(3);
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("shares durable kind/hash quotas across independent guard instances", async () => {
    const user = await createUser();
    const ghost = `ghost-${randomUUID()}@clearsight.test`;
    const guardA = buildGuard(prisma);
    const guardB = buildGuard(prisma);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await guardA.recordFailure(user.email)).blocked).toBe(false);
      expect((await guardB.recordFailure(user.email)).blocked).toBe(false);
    }
    expect((await userState(user.id)).failedLoginCount).toBe(4);
    expect((await guardA.recordFailure(user.email)).blocked).toBe(true);
    expect((await userState(user.id)).failedLoginCount).toBe(5);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await guardA.recordFailure(ghost)).blocked).toBe(false);
      expect((await guardB.recordFailure(ghost)).blocked).toBe(false);
    }
    expect((await guardB.recordFailure(ghost)).blocked).toBe(true);
    expect(await prisma.user.findFirst({ where: { email: ghost } })).toBeNull();
    const ghostHash = computeLoginBucketHash(
      deriveLoginProtectionKey(TEST_ENV.JWT_SECRET),
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      ghost.toLowerCase(),
    );
    const ghostBucket = (await buckets()).find((row) => row.key_hash === ghostHash);
    expect(ghostBucket).toMatchObject({ kind: LOGIN_BUCKET_KINDS.IDENTIFIER, failure_count: 5 });

    const ipA = buildGuard(prisma, { ipRateLimit: 2, ipRateWindowSeconds: 60 });
    const ipB = buildGuard(prisma, { ipRateLimit: 2, ipRateWindowSeconds: 60 });
    expect((await ipA.reserveIpAttempt("203.0.113.90")).blocked).toBe(false);
    expect((await ipA.reserveIpAttempt("203.0.113.90")).blocked).toBe(false);
    const third = await ipB.reserveIpAttempt("203.0.113.90");
    expect(third.blocked).toBe(true);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("consumes the IP quota for over-length and unknown attempts before any KDF", async () => {
    const user = await createUser();
    const limited = await buildApp({
      env: { ...TEST_ENV, IP_RATE_LIMIT: 2, IP_RATE_WINDOW_SECONDS: 60 },
      prisma,
    });
    await limited.ready();

    try {
      const overlong = await login(
        limited,
        { email: user.email, password: "x".repeat(73) },
        { remoteAddress: "203.0.113.40" },
      );
      expect(overlong.statusCode).toBe(401);
      const unknown = await login(
        limited,
        { email: `ghost-${randomUUID()}@clearsight.test`, password: "wrong-password" },
        { remoteAddress: "203.0.113.40" },
      );
      expect(unknown.statusCode).toBe(401);

      // Both attempts consumed the shared quota even though neither ran a
      // password KDF, so the third valid-schema attempt is throttled.
      const third = await login(
        limited,
        { email: user.email, password: PASSWORD },
        { remoteAddress: "203.0.113.40" },
      );
      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual(GENERIC_429);

      const ipRow = (await buckets()).find(
        (row) =>
          row.key_hash ===
          computeLoginBucketHash(
            deriveLoginProtectionKey(TEST_ENV.JWT_SECRET),
            LOGIN_BUCKET_KINDS.IP,
            "203.0.113.40",
          ),
      );
      expect(ipRow).toMatchObject({ kind: LOGIN_BUCKET_KINDS.IP, failure_count: 2 });
    } finally {
      await limited.close();
    }
  });

  it.each([
    ["zero limit", { IP_RATE_LIMIT: 0 }],
    ["negative limit", { IP_RATE_LIMIT: -5 }],
    ["limit past the cap", { IP_RATE_LIMIT: 10_001 }],
    ["zero window", { IP_RATE_WINDOW_SECONDS: 0 }],
    ["negative window", { IP_RATE_WINDOW_SECONDS: -1 }],
    ["window past the cap", { IP_RATE_WINDOW_SECONDS: 86_401 }],
  ] as const)(
    "refuses to build the app when the IP quota would be disabled or unbounded: %s",
    async (_label, override) => {
      await expect(buildApp({ env: { ...TEST_ENV, ...override }, prisma })).rejects.toThrow(
        /must be a positive integer within the trusted bound/,
      );
    },
  );
});
