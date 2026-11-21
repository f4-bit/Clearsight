import { PrismaPg } from "@prisma/adapter-pg";
import { createDecoder, createSigner } from "fast-jwt";
import type { FastifyInstance } from "fastify";
import { createHmac, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PrismaClient as GeneratedPrismaClient } from "../src/generated/prisma/client.js";
import type { UserRole } from "../src/generated/prisma/enums.js";
import { prisma as defaultPrisma, type PrismaClient } from "../src/lib/prisma.js";
import { createAuthSessionService } from "../src/services/session.js";
import {
  createAuthLoginProtection,
  type AuthLoginProtectionOptions,
} from "../src/services/login-guard.js";
import { bearer, buildTestApp, TEST_AUTH_ORIGIN, TEST_ENV } from "./helpers/app.js";
import {
  createTestPrisma,
  hashPassword,
  makeSession,
  makeUser,
  resetDb,
  testDatabaseUrl,
} from "./helpers/db.js";
import { applyMigrations } from "./helpers/migrations.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

const PASSWORD = "synthetic-login-password";
const AUTH_ORIGIN = { origin: TEST_AUTH_ORIGIN };
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  app = await buildTestApp(prisma);
});

beforeEach(() => resetDb(prisma));

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

interface UserOverrides {
  role?: UserRole;
  isActive?: boolean;
  lockedUntil?: Date | null;
  tokenVersion?: number;
  email?: string;
  passwordHash?: string;
}

async function createUser(overrides: UserOverrides = {}) {
  return makeUser(prisma, overrides.role ?? "OFTALMOLOGO", {
    passwordHash: overrides.passwordHash ?? passwordHash,
    ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
    ...(overrides.lockedUntil !== undefined ? { lockedUntil: overrides.lockedUntil } : {}),
    ...(overrides.tokenVersion !== undefined ? { tokenVersion: overrides.tokenVersion } : {}),
    ...(overrides.email !== undefined ? { email: overrides.email } : {}),
  });
}

function decodeToken(token: string): Record<string, unknown> {
  const decoded = app.jwt.decode<Record<string, unknown>>(token);
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("token did not decode");
  }
  return decoded;
}

async function me(target: FastifyInstance, token: string) {
  return target.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
}

function buildGuard(
  db: PrismaClient,
  overrides: Omit<AuthLoginProtectionOptions, "jwtSecret"> = {},
) {
  return createAuthLoginProtection(db, { jwtSecret: TEST_ENV.JWT_SECRET, ...overrides });
}

function beforeTransactionClient(
  base: PrismaClient,
  mutate: () => Promise<unknown>,
): PrismaClient {
  let transactions = 0;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = target.$transaction.bind(target) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (callback: unknown, options?: unknown) => {
          transactions += 1;
          // The first transaction is the guard's independent IP reservation,
          // committed before the password KDF. The login transaction is the
          // second: mutate only there, after the bcrypt proof, so the stale
          // proof is re-checked under the real user row lock.
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

/** Intercepts only the audit insert inside the real transaction. */
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

function countingSessionReadsClient(base: PrismaClient): {
  client: PrismaClient;
  reads: () => number;
} {
  let reads = 0;
  const client = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "userSession") {
        const delegate = target.userSession;
        return new Proxy(delegate, {
          get(delegateTarget, delegateProperty) {
            if (delegateProperty === "findUnique") {
              const findUnique = delegateTarget.findUnique.bind(delegateTarget) as (
                ...args: unknown[]
              ) => unknown;
              return (...args: unknown[]) => {
                reads += 1;
                return findUnique(...args);
              };
            }
            const value = Reflect.get(delegateTarget, delegateProperty);
            return typeof value === "function" ? value.bind(delegateTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
  return { client, reads: () => reads };
}

function failingDelegateClient(
  base: PrismaClient,
  model: "user" | "userSession",
  operation: "findFirst" | "findUnique",
  error: Error,
): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === model) {
        const delegate = target[model];
        return new Proxy(delegate, {
          get(delegateTarget, delegateProperty) {
            if (delegateProperty === operation) {
              return () => {
                throw error;
              };
            }
            const value = Reflect.get(delegateTarget, delegateProperty);
            return typeof value === "function" ? value.bind(delegateTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

function trapModelClient(base: PrismaClient, onCall: () => void): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "user" || property === "userSession" || property === "auditEvent") {
        const delegate = Reflect.get(target, property, receiver) as object;
        return new Proxy(delegate, {
          get(delegateTarget, delegateProperty) {
            const value = Reflect.get(delegateTarget, delegateProperty);
            if (typeof value === "function") {
              return (...args: unknown[]) => {
                onCall();
                return (value as (...a: unknown[]) => unknown).apply(delegateTarget, args);
              };
            }
            return value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

/**
 * Waits until a login backend is blocked by the holder on the schema-qualified
 * public users row. This is the deterministic barrier that would never appear
 * if the raw lock still used an unqualified `users` table shadowed by a decoy
 * search_path schema.
 */
async function waitForBlockedPublicLock(
  db: PrismaClient,
  blockerPid: number,
  loginSettled: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (loginSettled()) {
      throw new Error("login settled before it could block on the public users row");
    }

    const rows = await db.$queryRawUnsafe<
      Array<{ pid: number; query: string; blockers: number[] }>
    >(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    const blocked = rows.some(
      (row) =>
        row.blockers.includes(blockerPid) &&
        row.query.includes('"public"."users"') &&
        row.query.toUpperCase().includes("FOR UPDATE"),
    );
    if (blocked) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the login to block on the public users row");
}

describe("durable access sessions", () => {
  it("issues a 900s HS256 token and persists a seven-day session with one audit", async () => {
    const user = await createUser();

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: `  ${user.email.toUpperCase()}  `, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      tokenType: "bearer",
      expiresIn: "15m",
      user: { id: user.id, email: user.email, role: user.role },
    });
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("refreshToken");
    expect(response.body).not.toContain("passwordHash");

    const claims = decodeToken(body.accessToken);
    expect(claims).toMatchObject({
      sub: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
    expect(claims.sessionId).toMatch(UUID_PATTERN);
    expect(claims.exp).toBeTypeOf("number");
    expect(claims.iat).toBeTypeOf("number");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    expect(Number(claims.exp)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const complete = createDecoder({ complete: true })(body.accessToken) as {
      header: { alg: string };
    };
    expect(complete.header.alg).toBe("HS256");

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: claims.sessionId as string },
    });
    expect(session.userId).toBe(user.id);
    expect(session.issuedTokenVersion).toBe(user.tokenVersion);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(7 * DAY_MS);
    expect(session.revokedAt).toBeNull();
    expect(session.lastUsedAt).toBeNull();

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "USER",
      actorUserId: user.id,
      targetType: "SESSION",
      targetId: session.id,
      targetUserId: null,
      action: "AUTH_SESSION_CREATED",
      outcome: "SUCCESS",
      metadata: { channel: "password" },
    });
    expect(JSON.stringify(audits[0])).not.toContain(body.accessToken);
    expect(JSON.stringify(audits[0])).not.toContain(PASSWORD);

    const current = await me(app, body.accessToken);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ id: user.id, email: user.email, role: user.role });

    const afterMe = await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(afterMe.lastUsedAt).toBeNull();
  });

  it("returns the same generic 401 for invalid credentials and never issues a session", async () => {
    const active = await createUser();
    const inactive = await createUser({ isActive: false });

    const attempts = [
      { label: "unknown", payload: { email: "missing-login@clearsight.test", password: PASSWORD } },
      { label: "wrong password", payload: { email: active.email, password: "wrong-password" } },
      { label: "inactive", payload: { email: inactive.email, password: PASSWORD } },
      { label: "over 72 bytes", payload: { email: active.email, password: "x".repeat(73) } },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: attempt.payload,
      });
      expect(response.statusCode, attempt.label).toBe(401);
      expect(response.json(), attempt.label).toEqual({
        error: "Unauthorized",
        message: "Invalid credentials",
        statusCode: 401,
      });
      expect(response.body, attempt.label).not.toContain("accessToken");
    }

    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("returns the documented 429 with Retry-After for an already-locked identifier", async () => {
    const locked = await createUser({ lockedUntil: new Date(Date.now() + 3_600_000) });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: locked.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: "Too Many Requests",
      message: "Too many login attempts",
      statusCode: 429,
    });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.body).not.toContain("accessToken");
    expect(response.body).not.toContain(locked.email);
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rejects password, role or version changes that land after bcrypt verification", async () => {
    const changes: Array<{
      label: string;
      mutate: (userId: string) => Promise<unknown>;
    }> = [
      {
        label: "password",
        mutate: async (userId) =>
          prisma.user.update({
            where: { id: userId },
            data: { passwordHash: await hashPassword("changed-login-password") },
          }),
      },
      {
        label: "role",
        mutate: async (userId) =>
          prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } }),
      },
      {
        label: "token version",
        mutate: async (userId) =>
          prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
      },
    ];

    for (const change of changes) {
      await resetDb(prisma);
      const user = await createUser();
      const racingClient = beforeTransactionClient(prisma, () => change.mutate(user.id));
      const racingApp = await buildApp({ env: TEST_ENV, prisma: racingClient });
      await racingApp.ready();

      try {
        const response = await racingApp.inject({
          method: "POST",
          url: "/auth/login",
      headers: AUTH_ORIGIN,
          payload: { email: user.email, password: PASSWORD },
        });
        expect(response.statusCode, change.label).toBe(401);
        expect(await prisma.userSession.count(), change.label).toBe(0);
        expect(await prisma.auditEvent.count(), change.label).toBe(0);
      } finally {
        await racingApp.close();
      }
    }
  });

  it("rejects inactive users, stale roles, stale versions and invalid sessions", async () => {
    const user = await createUser();
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    const token = loginResponse.json().accessToken as string;
    expect((await me(app, token)).statusCode).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await me(app, token)).statusCode).toBe(401);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await me(app, token)).statusCode).toBe(401);
    await prisma.user.update({ where: { id: user.id }, data: { role: user.role } });

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    expect((await me(app, token)).statusCode).toBe(401);

    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const freshLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    const freshToken = freshLogin.json().accessToken as string;
    const freshClaims = decodeToken(freshToken);
    expect((await me(app, freshToken)).statusCode).toBe(200);

    await prisma.userSession.update({
      where: { id: freshClaims.sessionId as string },
      data: { revokedAt: new Date(), reasonCode: "LOGOUT" },
    });
    expect((await me(app, freshToken)).statusCode).toBe(401);

    const expiredSession = await makeSession(
      prisma,
      current,
      new Date(Date.now() - 8 * DAY_MS),
      { expiresAt: new Date(Date.now() - DAY_MS) },
    );
    const expiredToken = app.jwt.sign({
      sub: current.id,
      role: current.role,
      sessionId: expiredSession.id,
      tokenVersion: current.tokenVersion,
    });
    expect((await me(app, expiredToken)).statusCode).toBe(401);

    const otherUser = await createUser();
    const otherSession = await makeSession(prisma, otherUser);
    const foreignToken = app.jwt.sign({
      sub: current.id,
      role: current.role,
      sessionId: otherSession.id,
      tokenVersion: current.tokenVersion,
    });
    expect((await me(app, foreignToken)).statusCode).toBe(401);

    const missingToken = app.jwt.sign({
      sub: current.id,
      role: current.role,
      sessionId: randomUUID(),
      tokenVersion: current.tokenVersion,
    });
    expect((await me(app, missingToken)).statusCode).toBe(401);
  });

  it("rejects bad claims or algorithms without reading the session store", async () => {
    const user = await createUser();
    const { client, reads } = countingSessionReadsClient(prisma);
    const hardenedApp = await buildApp({ env: TEST_ENV, prisma: client });
    await hardenedApp.ready();

    const now = Math.floor(Date.now() / 1000);
    const base = {
      sub: user.id,
      role: "OFTALMOLOGO",
      sessionId: randomUUID(),
      tokenVersion: 0,
    };
    const hs256 = createSigner({ key: TEST_ENV.JWT_SECRET, algorithm: "HS256" });
    const hs512 = createSigner({
      key: TEST_ENV.JWT_SECRET,
      algorithm: "HS512",
      expiresIn: "15m",
    });

    const tokens: Record<string, string> = {
      legacy: hs256({ sub: user.id, role: "OFTALMOLOGO" }),
      missingExp: hs256(base),
      futureIat: hs256({ ...base, iat: now + 3_600, exp: now + 4_500 }),
      overlong: hs256({ ...base, iat: now, exp: now + 3_601 }),
      expired: hs256({ ...base, iat: now - 100, exp: now - 1 }),
      hs512: hs512(base),
    };

    try {
      for (const [label, token] of Object.entries(tokens)) {
        const response = await me(hardenedApp, token);
        expect(response.statusCode, label).toBe(401);
      }
      expect(reads()).toBe(0);
    } finally {
      await hardenedApp.close();
    }
  });

  it("returns the same generic 401 body for malformed signed claims", async () => {
    const user = await createUser();
    const signer = createSigner({ key: TEST_ENV.JWT_SECRET, algorithm: "HS256" });
    const token = signer({ sub: user.id, role: "OFTALMOLOGO" });

    const response = await me(app, token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "unauthorized",
      message: "Invalid or missing token",
      statusCode: 401,
    });
    expect(response.body).not.toContain("sessionId");
  });

  it("fails closed with a safe 503 when the session or user store is unavailable", async () => {
    const user = await createUser();
    const session = await makeSession(prisma, user);
    const token = app.jwt.sign({
      sub: user.id,
      role: user.role,
      sessionId: session.id,
      tokenVersion: user.tokenVersion,
    });
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";

    const failingSessionApp = await buildApp({
      env: TEST_ENV,
      prisma: failingDelegateClient(prisma, "userSession", "findUnique", new Error(canary)),
    });
    await failingSessionApp.ready();
    try {
      const response = await me(failingSessionApp, token);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "service_unavailable",
        message: "Authentication is temporarily unavailable",
        statusCode: 503,
      });
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
    } finally {
      await failingSessionApp.close();
    }

    const failingLoginApp = await buildApp({
      env: TEST_ENV,
      prisma: failingDelegateClient(prisma, "user", "findFirst", new Error(canary)),
    });
    await failingLoginApp.ready();
    try {
      const response = await failingLoginApp.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: user.email, password: PASSWORD },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
    } finally {
      await failingLoginApp.close();
    }
  });

  it("rolls back the session when the audit write fails", async () => {
    const user = await createUser();
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await failingApp.ready();

    try {
      const response = await failingApp.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: user.email, password: PASSWORD },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("accessToken");
      expect(await prisma.userSession.count()).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });

  it("rolls back the session and audit when the token issuer throws", async () => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });

    await expect(
      service.login({ email: user.email, password: PASSWORD }, () => {
        throw new Error("signer canary");
      }),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("keeps POST /auth/register at 410 without touching the database", async () => {
    let calls = 0;
    const trappedApp = await buildApp({
      env: TEST_ENV,
      prisma: trapModelClient(prisma, () => {
        calls += 1;
      }),
    });
    await trappedApp.ready();

    try {
      const response = await trappedApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "public-attacker@clearsight.test", role: "ADMIN" },
      });
      expect(response.statusCode).toBe(410);
      expect(calls).toBe(0);
    } finally {
      await trappedApp.close();
    }
  });

  it("ignores client-supplied privilege claims in the login body", async () => {
    const user = await createUser();
    const suppliedSessionId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: {
        email: user.email,
        password: PASSWORD,
        role: "ADMIN",
        sessionId: suppliedSessionId,
        tokenVersion: 99,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe(user.role);

    const claims = decodeToken(response.json().accessToken);
    expect(claims.role).toBe(user.role);
    expect(claims.tokenVersion).toBe(user.tokenVersion);
    expect(claims.sessionId).not.toBe(suppliedSessionId);
  });

  it("uses the injected client for auth and never the process-wide singleton", async () => {
    const user = await createUser();
    const singletonRead = vi.spyOn(defaultPrisma.userSession, "findUnique");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: user.email, password: PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      expect((await me(app, response.json().accessToken)).statusCode).toBe(200);
      expect(singletonRead).not.toHaveBeenCalled();
    } finally {
      singletonRead.mockRestore();
    }
  });

  it("fails closed at startup for known, short or public-placeholder production JWT secrets", async () => {
    const knownSecret = "clearsight-dev-secret-change-in-prod-32chars!";
    await expect(
      buildApp({
        env: {
          NODE_ENV: "production",
          JWT_SECRET: knownSecret,
          EXPORT_HMAC_SECRET: "x".repeat(32),
        },
        prisma,
      }),
    ).rejects.toThrow(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );

    await expect(
      buildApp({
        env: {
          NODE_ENV: "production",
          JWT_SECRET: "too-short",
          EXPORT_HMAC_SECRET: "x".repeat(32),
        },
        prisma,
      }),
    ).rejects.toThrow(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );

    const placeholder = "replace-me-with-at-least-32-characters";
    let startupMessage = "";
    try {
      await buildApp({
        env: {
          NODE_ENV: "production",
          JWT_SECRET: placeholder,
          EXPORT_HMAC_SECRET: "x".repeat(32),
        },
        prisma,
      });
    } catch (error) {
      startupMessage = error instanceof Error ? error.message : String(error);
    }
    expect(startupMessage).toBe(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );
    expect(startupMessage).not.toContain(placeholder);

    const validProdApp = await buildApp({
      env: {
        NODE_ENV: "production",
        JWT_SECRET: "N9f3k2Lm7Qp8Rt5Vx1Za4Bc6De0Fg2Hj",
        EXPORT_HMAC_SECRET: "x".repeat(32),
      },
      prisma,
    });
    try {
      await validProdApp.ready();
    } finally {
      await validProdApp.close();
    }
  });

  it("can still issue an authenticated request through the shared bearer helper", async () => {
    const user = await createUser();
    const headers = await bearer(app, prisma, user);
    const response = await app.inject({ method: "GET", url: "/auth/me", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, email: user.email, role: user.role });
  });
});

/**
 * Adversarial corner regressions (QA). Permanent tests, no scaffolding.
 * They pin behaviors the primary suite does not isolate: the bcrypt 72-byte
 * truncation class, the lockout/deactivation policy boundary, issuer failure
 * modes beyond the synchronous throw, hand-crafted temporal garbage that must
 * be rejected before any store read, and the trusted DI seam.
 */
describe("adversarial corners: bcrypt 72-byte bound", () => {
  it("rejects the 73-byte truncation alias of a 72-byte password", async () => {
    // bcrypt silently truncates input at 72 bytes: compare("x" x 73, hash("x" x 72))
    // returns true. The UTF-8 byte bound must reject the alias before compare.
    const secret72 = "x".repeat(72);
    const user = await createUser({ passwordHash: await hashPassword(secret72) });

    const exact = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: secret72 },
    });
    expect(exact.statusCode).toBe(200);

    for (const alias of ["x".repeat(73), "x".repeat(200)]) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: user.email, password: alias },
      });
      expect(response.statusCode, `alias of ${alias.length} chars`).toBe(401);
      expect(response.json()).toEqual({
        error: "Unauthorized",
        message: "Invalid credentials",
        statusCode: 401,
      });
    }
  });

  it("measures the bound in UTF-8 bytes, not code points", async () => {
    // "é" is 2 bytes: 36 code points = exactly 72 bytes (accepted),
    // 37 code points = 74 bytes (must reject even though bcrypt would
    // truncate-match the 72-byte prefix), 72 code points = 144 bytes (must
    // reject even though the code-point count fits the legacy limit).
    const secret = "\u00e9".repeat(36);
    const user = await createUser({ passwordHash: await hashPassword(secret) });

    const exact = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: secret },
    });
    expect(exact.statusCode).toBe(200);

    for (const alias of ["\u00e9".repeat(37), "\u00e9".repeat(72)]) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: user.email, password: alias },
      });
      expect(response.statusCode, `alias of ${alias.length} code points`).toBe(401);
    }
  });

  it("rejects an empty password with the same generic 401", async () => {
    const user = await createUser();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: "" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Unauthorized",
      message: "Invalid credentials",
      statusCode: 401,
    });
    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("adversarial corners: lockout vs deactivation policy", () => {
  it("blocks new logins while locked but keeps already-issued sessions valid", async () => {
    // Policy boundary: lockedUntil gates *login*; it is not account
    // deactivation. A session issued before the lockout stays valid until its
    // own expiry, matching the industry default (5.3 owns the lockout policy).
    const user = await createUser();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;

    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() + 3_600_000) },
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: "Too Many Requests",
      message: "Too many login attempts",
      statusCode: 429,
    });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // The pre-lockout session is still valid (lockout != deactivation)...
    expect((await me(app, token)).statusCode).toBe(200);

    // ...but deactivation does revoke it on the very next request.
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await me(app, token)).statusCode).toBe(401);
  });

  it("denies the next request after a role demotion or a tokenVersion bump", async () => {
    const user = await createUser({ role: "ADMIN" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    const token = login.json().accessToken as string;
    expect((await me(app, token)).statusCode).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { role: "OFTALMOLOGO" } });
    const demoted = await me(app, token);
    expect(demoted.statusCode).toBe(401);
    expect(demoted.json()).toEqual({
      error: "unauthorized",
      message: "Invalid or missing token",
      statusCode: 401,
    });

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    const relogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    expect(relogin.statusCode).toBe(200);
    const freshToken = relogin.json().accessToken as string;
    expect((await me(app, freshToken)).statusCode).toBe(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    expect((await me(app, freshToken)).statusCode).toBe(401);
  });
});

describe("adversarial corners: token issuer failure modes", () => {
  it("rolls back when the async issuer rejects instead of returning a string", async () => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });

    await expect(
      service.login({ email: user.email, password: PASSWORD }, async () => {
        throw new Error("async signer canary");
      }),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it.each([
    ["empty string", () => ""],
    ["non-string", () => 42 as unknown as string],
    ["resolving undefined", async () => undefined as unknown as string],
  ])("rolls back when the issuer resolves %s", async (_label, issuer) => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });

    await expect(
      service.login({ email: user.email, password: PASSWORD }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    expect(await prisma.userSession.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("commits exactly one session and one audit when the async issuer succeeds", async () => {
    const user = await createUser();
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });

    const result = await service.login({ email: user.email, password: PASSWORD }, async () => {
      return "async-issued-token";
    });

    expect(result.accessToken).toBe("async-issued-token");
    expect(result.user).toEqual({ id: user.id, email: user.email, role: user.role });
    expect(await prisma.userSession.count()).toBe(1);
    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("AUTH_SESSION_CREATED");
  });
});

describe("adversarial corners: temporal garbage rejected before the store", () => {
  function signRaw(payload: Record<string, unknown>): string {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const body = encode(payload);
    const signature = createHmac("sha256", TEST_ENV.JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");
    return `${header}.${body}.${signature}`;
  }

  it("rejects hand-crafted exp/iat garbage with zero session-store reads", async () => {
    const user = await createUser();
    const { client, reads } = countingSessionReadsClient(prisma);
    const hardenedApp = await buildApp({ env: TEST_ENV, prisma: client });
    await hardenedApp.ready();

    const now = Math.floor(Date.now() / 1000);
    const base = {
      sub: user.id,
      role: "OFTALMOLOGO",
      sessionId: randomUUID(),
      tokenVersion: 0,
    };

    // JSON.stringify maps NaN to null exactly like a decoded JWT payload would.
    const nanThenNull = JSON.parse(JSON.stringify({ exp: NaN }));

    // The classic JWT "alg: none" downgrade: structurally valid, unsigned.
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const noneBody = Buffer.from(
      JSON.stringify({ ...base, iat: now, exp: now + 600 }),
    ).toString("base64url");
    const algNone = `${noneHeader}.${noneBody}.`;

    const tokens: Record<string, string> = {
      algNone,
      missingExp: signRaw({ ...base, iat: now }),
      missingIat: signRaw({ ...base, exp: now + 600 }),
      zeroExp: signRaw({ ...base, iat: now, exp: 0 }),
      nullFromNaNExp: signRaw({ ...base, iat: now, exp: nanThenNull.exp }),
      floatExp: signRaw({ ...base, iat: now, exp: now + 100.5 }),
      hugeExp: signRaw({ ...base, iat: now, exp: 2 ** 53 + 2 }),
      negativeExp: signRaw({ ...base, iat: now, exp: now * -1 }),
      stringIat: signRaw({ ...base, iat: `${now}`, exp: now + 600 }),
    };

    try {
      for (const [label, token] of Object.entries(tokens)) {
        const response = await me(hardenedApp, token);
        expect(response.statusCode, label).toBe(401);
      }
      expect(reads()).toBe(0);
    } finally {
      await hardenedApp.close();
    }
  });
});

describe("adversarial corners: DI seam and test-double source equality", () => {
  it("honors an injected authService seam without env or singleton bypass", async () => {
    const sentinel = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "sentinel-principal@clearsight.test",
      role: "INVESTIGADOR" as const,
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tokenVersion: 7,
    };
    const stub = {
      accessTtlSeconds: 900,
      accessTtlLabel: "15m",
      login: async () => {
        throw new Error("login must not be reached in this test");
      },
      verifySession: async () => sentinel,
    };
    const seamApp = await buildApp({
      env: TEST_ENV,
      prisma,
      authService: stub,
    });
    await seamApp.ready();

    try {
      const user = await createUser();
      const token = seamApp.jwt.sign({
        sub: user.id,
        role: user.role,
        sessionId: sentinel.sessionId,
        tokenVersion: user.tokenVersion,
      });
      const response = await me(seamApp, token);
      expect(response.statusCode).toBe(200);
      // The decorated service (the seam) answered, not the source-built one:
      // the sentinel identity is impossible from the database.
      expect(response.json()).toEqual({
        id: sentinel.id,
        email: sentinel.email,
        role: sentinel.role,
      });
      expect(response.body).not.toContain(user.email);
    } finally {
      await seamApp.close();
    }
  });

  it("issues helper tokens with the same claim set as the real login", async () => {
    // The bearer() test double must be source-equal to the login path: same
    // principal claims, same temporal claims, same verification outcome.
    const user = await createUser();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: PASSWORD },
    });
    const loginClaims = decodeToken(login.json().accessToken);

    const headers = await bearer(app, prisma, user);
    const helperToken = headers.authorization.replace("Bearer ", "");
    const helperClaims = decodeToken(helperToken);

    expect(Object.keys(helperClaims).sort()).toEqual(Object.keys(loginClaims).sort());
    expect(helperClaims).toMatchObject({
      sub: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
    expect((await me(app, helperToken)).statusCode).toBe(200);
  });

  it("serves /auth/me from the cached principal with exactly one session read", async () => {
    // The handler must reuse the middleware principal: one store read per
    // request (the verification itself), never a second user lookup.
    const user = await createUser();
    const session = await makeSession(prisma, user);
    const token = app.jwt.sign({
      sub: user.id,
      role: user.role,
      sessionId: session.id,
      tokenVersion: user.tokenVersion,
    });

    const { client, reads } = countingSessionReadsClient(prisma);
    const countingApp = await buildApp({ env: TEST_ENV, prisma: client });
    await countingApp.ready();
    try {
      const response = await me(countingApp, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: user.id, email: user.email, role: user.role });
      expect(response.body).not.toContain("passwordHash");
      expect(reads()).toBe(1);
    } finally {
      await countingApp.close();
    }
  });

  it("accepts legacy short passwords but rejects unbounded or whitespace emails", async () => {
    // No minimum length is imposed beyond bcrypt's own handling: a legacy
    // 8-character password must keep working.
    const legacy = "12345678";
    const user = await createUser({ passwordHash: await hashPassword(legacy) });
    const short = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: user.email, password: legacy },
    });
    expect(short.statusCode).toBe(200);

    // Service-level normalization bounds the email even if a caller bypasses
    // the route schema: too long or blank -> generic invalid credentials.
    const service = createAuthSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
      loginProtection: buildGuard(prisma),
    });
    const issuer = async () => "never-emitted";
    await expect(
      service.login({ email: "a".repeat(256), password: legacy }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    await expect(
      service.login({ email: "   ", password: legacy }, issuer),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    expect(await prisma.userSession.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
  });
});

describe("database schema robustness", () => {
  it("uses the explicit schema for both the row lock and the Prisma session store", async () => {
    const schema = `qa_auth_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const url = testDatabaseUrl();
    const admin = new PgClient({ connectionString: url });
    await admin.connect();
    let scoped: GeneratedPrismaClient | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await applyMigrations(admin);

      scoped = new GeneratedPrismaClient({
        adapter: new PrismaPg({ connectionString: url }, { schema }),
      });
      const service = createAuthSessionService(scoped, {
        accessTtl: { seconds: 900, label: "15m" },
        databaseSchema: schema,
        loginProtection: buildGuard(scoped, { databaseSchema: schema }),
      });
      const user = await scoped.user.create({
        data: {
          email: `alt-schema-${randomUUID()}@clearsight.test`,
          passwordHash: await hashPassword(PASSWORD),
          fullName: "Alt Schema User",
          role: "OFTALMOLOGO",
        },
      });

      const result = await service.login(
        { email: user.email, password: PASSWORD },
        () => "alt-schema-token",
      );
      expect(result.accessToken).toBe("alt-schema-token");
      expect(result.user.id).toBe(user.id);

      const session = await scoped.userSession.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(session.issuedTokenVersion).toBe(user.tokenVersion);

      const principal = await service.verifySession({
        sub: user.id,
        role: user.role,
        sessionId: session.id,
        tokenVersion: user.tokenVersion,
      });
      expect(principal).toMatchObject({ id: user.id, sessionId: session.id });
    } finally {
      await scoped?.$disconnect().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
    }
  });

  it("locks the Prisma schema public row, not a search_path decoy with the same UUID", async () => {
    const schema = `qa_decoy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const url = testDatabaseUrl();
    const setup = new PgClient({ connectionString: url });
    const holder = new PgClient({ connectionString: url });
    await setup.connect();
    await holder.connect();

    let scoped: GeneratedPrismaClient | undefined;
    let holderInTransaction = false;
    let loginPromise: Promise<unknown> | undefined;

    try {
      const user = await createUser();

      // The decoy is first in the connection search_path and mirrors the UUID.
      // An unqualified raw lock would resolve here and never block on public.
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO "${schema}".users (id) VALUES ($1::uuid)`, [user.id]);

      scoped = new GeneratedPrismaClient({
        adapter: new PrismaPg(
          { connectionString: url, options: `-c search_path=${schema},public` },
          { schema: "public" },
        ),
      });
      const searchPath = await scoped.$queryRawUnsafe<Array<{ search_path: string }>>(
        "SHOW search_path",
      );
      const searchPathValue = searchPath[0]?.search_path ?? "";
      expect(searchPathValue).toContain(schema);
      expect(searchPathValue.indexOf("public")).toBeGreaterThan(searchPathValue.indexOf(schema));

      const service = createAuthSessionService(scoped, {
        accessTtl: { seconds: 900, label: "15m" },
        databaseSchema: "public",
        loginProtection: buildGuard(scoped, { databaseSchema: "public" }),
      });

      await holder.query("BEGIN");
      holderInTransaction = true;
      const holderPid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      if (holderPid === undefined) {
        throw new Error("holder backend did not report a pid");
      }
      await holder.query(
        "SELECT id FROM public.users WHERE id = $1::uuid FOR NO KEY UPDATE",
        [user.id],
      );

      let loginSettled = false;
      loginPromise = service
        .login({ email: user.email, password: PASSWORD }, () => "must-not-be-issued")
        .finally(() => {
          loginSettled = true;
        });
      loginPromise.catch(() => undefined);

      await waitForBlockedPublicLock(prisma, holderPid, () => loginSettled);

      // The bcrypt proof was verified against the old hash. While the login is
      // blocked, commit a password and version change to the authentic row.
      await holder.query(
        "UPDATE public.users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2::uuid",
        [await hashPassword("changed-after-public-lock"), user.id],
      );
      await holder.query("COMMIT");
      holderInTransaction = false;

      await expect(loginPromise).rejects.toMatchObject({
        code: "AUTH_INVALID_CREDENTIALS",
      });
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      if (holderInTransaction) {
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      await loginPromise?.catch(() => undefined);
      await scoped?.$disconnect().catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await setup.end();
      await holder.end();
    }
  });
});
