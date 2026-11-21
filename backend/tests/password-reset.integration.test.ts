import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { REFRESH_COOKIE_NAME } from "../src/services/auth-cookies.js";
import { PASSWORD_BCRYPT_COST } from "../src/services/password-policy.js";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "../src/services/password-reset.js";
import type { PasswordResetDelivery } from "../src/services/password-reset-delivery.js";
import {
  createDisabledPasswordResetDelivery,
  createMemoryPasswordResetDelivery,
  type MemoryPasswordResetDelivery,
} from "../src/services/password-reset-delivery.js";
import {
  computePasswordRecoveryBucketHash,
  derivePasswordRecoveryKey,
  FORGOT_EMAIL_LIMIT,
  PASSWORD_RECOVERY_QUOTA_KINDS,
  type PasswordRecoveryQuotaGuard,
} from "../src/services/password-recovery-quota.js";
import { TEST_AUTH_ORIGIN, TEST_ENV } from "./helpers/app.js";
import { createTestPrisma, hashPassword, makeUser, resetDb } from "./helpers/db.js";

const ORIGIN = TEST_AUTH_ORIGIN;
const OLD_PASSWORD = "OldPassword123!";
const NEW_PASSWORD = "NewPassword123!";
const NEW_PASSWORD_2 = "AnotherPassword123!";
const START = new Date("2026-11-19T00:00:00.000Z");

const prisma = createTestPrisma();
let app: FastifyInstance;
let delivery: MemoryPasswordResetDelivery;
let clockNow = START;

beforeAll(async () => {
  delivery = createMemoryPasswordResetDelivery();
  app = await buildApp({
    env: TEST_ENV,
    prisma,
    now: () => clockNow,
    passwordResetDelivery: delivery,
  });
  await app.ready();
});

beforeEach(async () => {
  await resetDb(prisma);
  delivery.clear();
  clockNow = START;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function allowedGuard(): PasswordRecoveryQuotaGuard {
  return {
    async reserveForgotIp() {
      return { allowed: true };
    },
    async reserveForgotEmail() {
      return { allowed: true };
    },
    async reserveResetIp() {
      return { allowed: true };
    },
  };
}

async function createUser(
  options: {
    email?: string;
    isActive?: boolean;
    password?: string;
    failedLoginCount?: number;
    lockedUntil?: Date | null;
    role?: "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN";
  } = {},
) {
  const user = await makeUser(prisma, options.role ?? "OFTALMOLOGO", {
    email: options.email ?? `reset-${randomUUID()}@clearsight.test`,
    passwordHash: await hashPassword(options.password ?? OLD_PASSWORD),
    ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    ...(options.lockedUntil === undefined ? {} : { lockedUntil: options.lockedUntil }),
  });
  if (options.failedLoginCount !== undefined) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: options.failedLoginCount },
    });
  }
  return user;
}

async function insertResetToken(
  userId: string,
  options: {
    rawToken?: string;
    createdAt?: Date;
    expiresAt?: Date;
    consumedAt?: Date | null;
    revokedAt?: Date | null;
  } = {},
) {
  const rawToken = options.rawToken ?? generatePasswordResetToken();
  const createdAt = options.createdAt ?? START;
  const expiresAt =
    options.expiresAt ?? new Date(createdAt.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
  const row = await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashPasswordResetToken(rawToken),
      createdAt,
      expiresAt,
      consumedAt: options.consumedAt ?? null,
      revokedAt: options.revokedAt ?? null,
    },
  });
  return { rawToken, row };
}

interface RequestOptions {
  target?: FastifyInstance;
  ip?: string;
  origin?: boolean;
  payload?: unknown;
}

function forgot(email: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.origin !== false) {
    headers.origin = ORIGIN;
  }
  return (options.target ?? app).inject({
    method: "POST",
    url: "/auth/password/forgot",
    headers,
    remoteAddress: options.ip ?? "203.0.113.10",
    payload: options.payload ?? { email },
  });
}

function reset(token: string, newPassword = NEW_PASSWORD, options: RequestOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.origin !== false) {
    headers.origin = ORIGIN;
  }
  return (options.target ?? app).inject({
    method: "POST",
    url: "/auth/password/reset",
    headers,
    remoteAddress: options.ip ?? "203.0.113.10",
    payload: options.payload ?? { token, newPassword },
  });
}

function login(
  email: string,
  password = OLD_PASSWORD,
  options: RequestOptions = {},
) {
  return (options.target ?? app).inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin: ORIGIN },
    remoteAddress: options.ip ?? "203.0.113.10",
    payload: { email, password },
  });
}

function deactivateUser(
  userId: string,
  adminAccessToken: string,
  target: FastifyInstance = app,
) {
  return target.inject({
    method: "PATCH",
    url: `/admin/users/${userId}`,
    headers: { authorization: `Bearer ${adminAccessToken}` },
    payload: { isActive: false },
  });
}

function me(accessToken: string, target: FastifyInstance = app) {
  return target.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function refresh(token: string, target: FastifyInstance = app) {
  return target.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: {
      origin: ORIGIN,
      cookie: `${REFRESH_COOKIE_NAME}=${token}`,
    },
  });
}

function setCookieHeader(response: { headers: Record<string, unknown> }): string | null {
  const raw = response.headers["set-cookie"];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? null;
  }
  return null;
}

function refreshTokenFromResponse(response: { headers: Record<string, unknown> }): string | null {
  const header = setCookieHeader(response);
  if (header === null) {
    return null;
  }
  const match = new RegExp(`${REFRESH_COOKIE_NAME}=([^;]+)`).exec(header);
  return match?.[1] ?? null;
}

function accessTokenFrom(response: { json(): { accessToken?: unknown } }): string {
  const token = response.json().accessToken;
  if (typeof token !== "string") {
    throw new Error("login did not return an access token");
  }
  return token;
}

async function userState(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      passwordHash: true,
      tokenVersion: true,
      isActive: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });
}

async function recoveryRows() {
  return prisma.$queryRawUnsafe<
    Array<{ kind: string; key_hash: string; attempt_count: number }>
  >("SELECT kind, key_hash, attempt_count FROM auth_recovery_buckets ORDER BY kind, key_hash");
}

async function loginRows() {
  return prisma.authLoginBucket.findMany({
    orderBy: [{ kind: "asc" }, { keyHash: "asc" }],
    select: {
      kind: true,
      keyHash: true,
      failureCount: true,
      windowStartedAt: true,
      lockedUntil: true,
    },
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
                      return Reflect.get(
                        delegateTarget,
                        delegateProperty,
                        delegateReceiver,
                      );
                    },
                  });
                }
                return Reflect.get(txTarget, txProperty, txReceiver);
              },
            });
            return callback(guardedTx);
          }, options);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;
}

function failingTransactionClient(base: PrismaClient): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async () => {
          throw new Error("simulated transaction/store failure");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;
}

describe("POST /auth/password/forgot", () => {
  it("returns the same 202 for active, inactive and unknown accounts", async () => {
    const active = await createUser({ email: "active-forgot@clearsight.test" });
    const inactive = await createUser({
      email: "inactive-forgot@clearsight.test",
      isActive: false,
    });
    const unknown = `unknown-${randomUUID()}@clearsight.test`;

    const activeResponse = await forgot(active.email, { ip: "203.0.113.1" });
    const inactiveResponse = await forgot(inactive.email, { ip: "203.0.113.2" });
    const unknownResponse = await forgot(unknown, { ip: "203.0.113.3" });

    for (const response of [activeResponse, inactiveResponse, unknownResponse]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(setCookieHeader(response)).toBeNull();
      expect(response.body).not.toContain("token");
      expect(response.body).not.toContain("email");
    }

    const tokens = await prisma.passwordResetToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.userId).toBe(active.id);
    expect(tokens[0]?.revokedAt).toBeNull();
    expect(tokens[0]?.consumedAt).toBeNull();
    expect(tokens[0]!.expiresAt.getTime() - tokens[0]!.createdAt.getTime()).toBe(
      PASSWORD_RESET_TOKEN_TTL_MS,
    );

    expect(delivery.delivered).toHaveLength(1);
    expect(delivery.delivered[0]?.recipient).toBe(active.email);
    expect(delivery.delivered[0]?.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens[0]?.tokenHash).toBe(
      hashPasswordResetToken(delivery.delivered[0]!.rawToken),
    );

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "ANONYMOUS",
      targetType: "USER",
      targetUserId: active.id,
      action: "PASSWORD_RESET_REQUESTED",
      outcome: "SUCCESS",
      metadata: { channel: "password-reset" },
    });
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain(active.email);
    expect(serializedAudit).not.toContain(delivery.delivered[0]!.rawToken);
  });

  it("does not create or invalidate tokens when delivery is DISABLED", async () => {
    const disabledDelivery = createDisabledPasswordResetDelivery();
    const disabledApp = await buildApp({
      env: TEST_ENV,
      prisma,
      now: () => clockNow,
      passwordResetDelivery: disabledDelivery,
    });
    await disabledApp.ready();

    try {
      const user = await createUser({ email: "disabled-forgot@clearsight.test" });
      const existing = await insertResetToken(user.id);

      const response = await forgot(user.email, {
        target: disabledApp,
        ip: "203.0.113.4",
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.id).toBe(existing.row.id);
      expect(tokens[0]?.revokedAt).toBeNull();
      expect(tokens[0]?.consumedAt).toBeNull();
    } finally {
      await disabledApp.close();
    }
  });

  it("keeps only the last token from sequential forgot requests valid", async () => {
    const user = await createUser({ email: "last-token@clearsight.test" });

    expect((await forgot(user.email, { ip: "203.0.113.10" })).statusCode).toBe(202);
    expect((await forgot(user.email, { ip: "203.0.113.11" })).statusCode).toBe(202);

    expect(delivery.delivered).toHaveLength(2);
    const firstToken = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(delivery.delivered[0]!.rawToken) },
    });
    const secondToken = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(delivery.delivered[1]!.rawToken) },
    });
    expect(firstToken.revokedAt).not.toBeNull();
    expect(secondToken.revokedAt).toBeNull();

    const firstResponse = await reset(delivery.delivered[0]!.rawToken, NEW_PASSWORD);
    expect(firstResponse.statusCode).toBe(401);
    expect(firstResponse.json()).toEqual({
      error: "Unauthorized",
      message: "Invalid or expired reset token",
      statusCode: 401,
    });

    const secondResponse = await reset(delivery.delivered[1]!.rawToken, NEW_PASSWORD);
    expect(secondResponse.statusCode).toBe(204);
    expect(secondResponse.body).toBe("");
    expect(setCookieHeader(secondResponse)).toBeNull();

    const after = await userState(user.id);
    expect(after.tokenVersion).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD, after.passwordHash)).toBe(true);
  });

  it("consumes IP first and enforces the 3/hour email quota", async () => {
    const user = await createUser({ email: "quota-email@clearsight.test" });
    const ip = "203.0.113.20";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await forgot(user.email, { ip })).statusCode).toBe(202);
    }
    const blocked = await forgot(user.email, { ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("3600");
    expect(blocked.json()).toEqual({
      error: "Too Many Requests",
      message: "Too many password recovery attempts",
      statusCode: 429,
    });

    const rows = await recoveryRows();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "FORGOT_EMAIL", attempt_count: 3 }),
        expect.objectContaining({ kind: "FORGOT_IP", attempt_count: 4 }),
      ]),
    );
    expect(await prisma.authLoginBucket.count()).toBe(0);
  });

  it("enforces the 20/hour IP quota for forgot independently", async () => {
    const ip = "203.0.113.21";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await forgot(`unknown-${randomUUID()}@clearsight.test`, { ip });
      expect(response.statusCode).toBe(202);
    }
    const blocked = await forgot(`unknown-${randomUUID()}@clearsight.test`, { ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("3600");

    const rows = await recoveryRows();
    expect(rows.find((row) => row.kind === "FORGOT_IP")?.attempt_count).toBe(20);
  });

  it("rolls token creation back when audit fails and never delivers", async () => {
    const auditApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
      now: () => clockNow,
      passwordResetDelivery: delivery,
    });
    await auditApp.ready();

    try {
      const user = await createUser({ email: "audit-forgot@clearsight.test" });
      const response = await forgot(user.email, {
        target: auditApp,
        ip: "203.0.113.30",
      });
      expect(response.statusCode).toBe(202);
      expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
      expect(delivery.delivered).toHaveLength(0);
    } finally {
      await auditApp.close();
    }
  });

  it("returns 202 for a post-quota store failure, not 503", async () => {
    const storeApp = await buildApp({
      env: TEST_ENV,
      prisma: failingTransactionClient(prisma),
      now: () => clockNow,
      passwordResetDelivery: delivery,
      passwordRecoveryQuotaGuard: allowedGuard(),
    });
    await storeApp.ready();

    try {
      const user = await createUser({ email: "store-forgot@clearsight.test" });
      const response = await forgot(user.email, {
        target: storeApp,
        ip: "203.0.113.31",
      });
      expect(response.statusCode).toBe(202);
      expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
      expect(delivery.delivered).toHaveLength(0);
    } finally {
      await storeApp.close();
    }
  });
});

describe("POST /auth/password/reset", () => {
  it("resets once, revokes every session/refresh/other token and invalidates old credentials", async () => {
    const user = await createUser({ email: "reset-success@clearsight.test" });
    const firstLogin = await login(user.email);
    const secondLogin = await login(user.email);
    expect(firstLogin.statusCode).toBe(200);
    expect(secondLogin.statusCode).toBe(200);
    const firstAccess = accessTokenFrom(firstLogin);
    const secondAccess = accessTokenFrom(secondLogin);
    const firstRefresh = refreshTokenFromResponse(firstLogin);
    const secondRefresh = refreshTokenFromResponse(secondLogin);
    expect(firstRefresh).not.toBeNull();
    expect(secondRefresh).not.toBeNull();

    expect((await forgot(user.email, { ip: "203.0.113.40" })).statusCode).toBe(202);
    const rawToken = delivery.delivered[0]!.rawToken;
    const before = await userState(user.id);
    const other = await insertResetToken(user.id);

    const response = await reset(rawToken, NEW_PASSWORD, { ip: "203.0.113.41" });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(setCookieHeader(response)).toBeNull();

    const state = await userState(user.id);
    expect(state.tokenVersion).toBe(1);
    expect(state.passwordHash).not.toBe(before.passwordHash);
    expect(bcrypt.getRounds(state.passwordHash)).toBe(PASSWORD_BCRYPT_COST);
    expect(await bcrypt.compare(NEW_PASSWORD, state.passwordHash)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, state.passwordHash)).toBe(false);

    const sessions = await prisma.userSession.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).not.toBeNull();
      expect(session.reasonCode).toBe("PASSWORD_RESET");
    }
    expect(
      await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.refreshToken.count({ where: { userId: user.id } }),
    ).toBe(2);

    const used = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(rawToken) },
    });
    expect(used.consumedAt).not.toBeNull();
    expect(used.revokedAt).toBeNull();
    const otherAfter = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: other.row.id },
    });
    expect(otherAfter.revokedAt).not.toBeNull();

    expect((await me(firstAccess)).statusCode).toBe(401);
    expect((await me(secondAccess)).statusCode).toBe(401);
    expect((await refresh(firstRefresh!)).statusCode).toBe(401);
    expect((await refresh(secondRefresh!)).statusCode).toBe(401);

    expect((await login(user.email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);

    const audits = await prisma.auditEvent.findMany();
    expect(
      audits.some((event) => event.action === "PASSWORD_RESET_COMPLETED"),
    ).toBe(true);
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain(rawToken);
    expect(serializedAudit).not.toContain(user.email);
    expect(serializedAudit).not.toContain(NEW_PASSWORD);
    expect(response.body).not.toContain(rawToken);
  });

  it("preserves the HU01 login lock and counters across a successful reset", async () => {
    const user = await createUser({ email: "locked-reset@clearsight.test" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(user.email, "wrong-password", { ip: "203.0.113.50" });
    }
    const before = await userState(user.id);
    expect(before.failedLoginCount).toBe(5);
    expect(before.lockedUntil).not.toBeNull();
    const bucketsBefore = await loginRows();
    expect(bucketsBefore.length).toBeGreaterThan(0);

    expect((await forgot(user.email, { ip: "203.0.113.51" })).statusCode).toBe(202);
    expect(
      (await reset(delivery.delivered[0]!.rawToken, NEW_PASSWORD, { ip: "203.0.113.52" }))
        .statusCode,
    ).toBe(204);

    const after = await userState(user.id);
    expect(after.failedLoginCount).toBe(before.failedLoginCount);
    expect(after.lockedUntil?.getTime()).toBe(before.lockedUntil?.getTime());
    expect(await loginRows()).toEqual(bucketsBefore);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(429);
  });

  it("enforces the 20/15 min reset-IP quota before token lookup", async () => {
    const ip = "203.0.113.60";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await reset(generatePasswordResetToken(), NEW_PASSWORD, { ip });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await reset(generatePasswordResetToken(), NEW_PASSWORD, { ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
    expect(blocked.json()).toEqual({
      error: "Too Many Requests",
      message: "Too many password recovery attempts",
      statusCode: 429,
    });

    const rows = await recoveryRows();
    expect(rows).toEqual([
      expect.objectContaining({ kind: "RESET_IP", attempt_count: 20 }),
    ]);
  });

  it("returns one generic 401 for invalid, expired, consumed, revoked and inactive cases", async () => {
    const active = await createUser({ email: "invalid-reset@clearsight.test" });
    const inactive = await createUser({
      email: "inactive-reset@clearsight.test",
      isActive: false,
    });
    const expired = await insertResetToken(active.id, {
      createdAt: new Date(START.getTime() - 31 * 60 * 1000),
      expiresAt: new Date(START.getTime() - 60 * 1000),
    });
    const consumed = await insertResetToken(active.id, {
      consumedAt: new Date(START.getTime() + 1000),
    });
    const revoked = await insertResetToken(active.id, {
      revokedAt: new Date(START.getTime() + 1000),
    });
    const inactiveToken = await insertResetToken(inactive.id);

    const cases = [
      generatePasswordResetToken(),
      expired.rawToken,
      consumed.rawToken,
      revoked.rawToken,
      inactiveToken.rawToken,
    ];
    for (const token of cases) {
      const response = await reset(token);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "Unauthorized",
        message: "Invalid or expired reset token",
        statusCode: 401,
      });
      expect(response.headers["cache-control"]).toContain("no-store");
    }

    const activeState = await userState(active.id);
    expect(activeState.tokenVersion).toBe(0);
    expect(await bcrypt.compare(OLD_PASSWORD, activeState.passwordHash)).toBe(true);
    const inactiveState = await userState(inactive.id);
    expect(inactiveState.isActive).toBe(false);
    expect(inactiveState.tokenVersion).toBe(0);
    expect(await bcrypt.compare(OLD_PASSWORD, inactiveState.passwordHash)).toBe(true);
    const inactiveRow = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: inactiveToken.row.id },
    });
    expect(inactiveRow.consumedAt).toBeNull();
    expect(inactiveRow.revokedAt).toBeNull();
  });

  it("allows exactly one concurrent reset for the same token", async () => {
    const user = await createUser({ email: "concurrent-reset@clearsight.test" });
    expect((await forgot(user.email, { ip: "203.0.113.70" })).statusCode).toBe(202);
    const rawToken = delivery.delivered[0]!.rawToken;

    const responses = await Promise.all([
      reset(rawToken, NEW_PASSWORD),
      reset(rawToken, NEW_PASSWORD_2),
    ]);
    const successes = responses.filter((response) => response.statusCode === 204);
    const failures = responses.filter((response) => response.statusCode === 401);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winnerPassword =
      responses[0]?.statusCode === 204 ? NEW_PASSWORD : NEW_PASSWORD_2;
    const loserPassword = winnerPassword === NEW_PASSWORD ? NEW_PASSWORD_2 : NEW_PASSWORD;
    const state = await userState(user.id);
    expect(state.tokenVersion).toBe(1);
    expect(await bcrypt.compare(winnerPassword, state.passwordHash)).toBe(true);
    expect(await bcrypt.compare(loserPassword, state.passwordHash)).toBe(false);
    expect((await login(user.email, winnerPassword)).statusCode).toBe(200);
    expect((await login(user.email, loserPassword)).statusCode).toBe(401);

    const used = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(rawToken) },
    });
    expect(used.consumedAt).not.toBeNull();
  });

  it("handles reset+forgot races with exactly one observable winner", async () => {
    const user = await createUser({ email: "reset-forgot-race@clearsight.test" });
    expect((await forgot(user.email, { ip: "203.0.113.80" })).statusCode).toBe(202);
    const tokenA = delivery.delivered[0]!.rawToken;

    const [resetResponse, forgotResponse] = await Promise.all([
      reset(tokenA, NEW_PASSWORD, { ip: "203.0.113.81" }),
      forgot(user.email, { ip: "203.0.113.82" }),
    ]);
    expect(forgotResponse.statusCode).toBe(202);

    const tokenARow = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(tokenA) },
    });
    if (resetResponse.statusCode === 204) {
      expect(tokenARow.consumedAt).not.toBeNull();
      expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
      expect((await login(user.email, OLD_PASSWORD)).statusCode).toBe(401);
    } else {
      expect(resetResponse.statusCode).toBe(401);
      expect(tokenARow.revokedAt).not.toBeNull();
      expect((await login(user.email, OLD_PASSWORD)).statusCode).toBe(200);
      const valid = await prisma.passwordResetToken.findFirst({
        where: {
          userId: user.id,
          revokedAt: null,
          consumedAt: null,
          expiresAt: { gt: clockNow },
        },
      });
      expect(valid).not.toBeNull();
      const validRaw = delivery.delivered
        .map((record) => record.rawToken)
        .find(
          (candidate) =>
            hashPasswordResetToken(candidate) === valid!.tokenHash,
        );
      expect(validRaw).toBeDefined();
      expect((await reset(validRaw!, NEW_PASSWORD)).statusCode).toBe(204);
    }
  });

  it("invalidates a concurrent refresh even when it wins the race", async () => {
    const user = await createUser({ email: "reset-refresh-race@clearsight.test" });
    const loginResponse = await login(user.email);
    const oldRefresh = refreshTokenFromResponse(loginResponse);
    expect(oldRefresh).not.toBeNull();
    expect((await forgot(user.email, { ip: "203.0.113.90" })).statusCode).toBe(202);
    const token = delivery.delivered[0]!.rawToken;

    const [resetResponse, refreshResponse] = await Promise.all([
      reset(token, NEW_PASSWORD, { ip: "203.0.113.91" }),
      refresh(oldRefresh!),
    ]);
    expect(resetResponse.statusCode).toBe(204);

    if (refreshResponse.statusCode === 200) {
      const newAccess = accessTokenFrom(refreshResponse);
      const newRefresh = refreshTokenFromResponse(refreshResponse);
      expect(newRefresh).not.toBeNull();
      expect((await me(newAccess)).statusCode).toBe(401);
      expect((await refresh(newRefresh!)).statusCode).toBe(401);
    } else {
      expect(refreshResponse.statusCode).toBe(401);
    }

    expect(
      await prisma.userSession.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(0);
  });

  it("fails closed when an admin change commits before reset", async () => {
    const admin = await createUser({
      email: "admin-before-reset@clearsight.test",
      role: "ADMIN",
    });
    const adminLogin = await login(admin.email);
    expect(adminLogin.statusCode).toBe(200);
    const adminAccess = accessTokenFrom(adminLogin);

    const target = await createUser({ email: "admin-target-reset@clearsight.test" });
    const token = await insertResetToken(target.id);
    expect((await deactivateUser(target.id, adminAccess)).statusCode).toBe(200);

    const before = await userState(target.id);
    const response = await reset(token.rawToken, NEW_PASSWORD, {
      ip: "203.0.113.120",
    });
    expect(response.statusCode).toBe(401);

    const after = await userState(target.id);
    expect(after.isActive).toBe(false);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: token.row.id },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.consumedAt).toBeNull();

    const forgotAfter = await forgot(target.email, { ip: "203.0.113.121" });
    expect(forgotAfter.statusCode).toBe(202);
    expect(await prisma.passwordResetToken.count({ where: { userId: target.id } })).toBe(1);
  });

  it("leaves no valid forgot token after a concurrent admin deactivation", async () => {
    const admin = await createUser({
      email: "admin-race-reset@clearsight.test",
      role: "ADMIN",
    });
    const adminLogin = await login(admin.email);
    const adminAccess = accessTokenFrom(adminLogin);
    const target = await createUser({ email: "admin-race-target@clearsight.test" });

    const [deactivation, forgotResponse] = await Promise.all([
      deactivateUser(target.id, adminAccess),
      forgot(target.email, { ip: "203.0.113.122" }),
    ]);
    expect(deactivation.statusCode).toBe(200);
    expect(forgotResponse.statusCode).toBe(202);

    const state = await userState(target.id);
    expect(state.isActive).toBe(false);
    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: target.id },
    });
    for (const token of tokens) {
      expect(token.revokedAt !== null || token.consumedAt !== null).toBe(true);
    }
    if (delivery.delivered.length > 0) {
      expect(
        (await reset(delivery.delivered[0]!.rawToken, NEW_PASSWORD, {
          ip: "203.0.113.123",
        })).statusCode,
      ).toBe(401);
    }
  });

  it("rolls reset back on audit failure without consuming the token", async () => {
    const user = await createUser({ email: "audit-reset@clearsight.test" });
    const loginResponse = await login(user.email);
    expect(loginResponse.statusCode).toBe(200);
    const token = await insertResetToken(user.id);
    const before = await userState(user.id);

    const auditApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
      now: () => clockNow,
    });
    await auditApp.ready();
    try {
      const response = await reset(token.rawToken, NEW_PASSWORD, {
        target: auditApp,
        ip: "203.0.113.92",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "service_unavailable",
        message: "Password recovery is temporarily unavailable",
        statusCode: 503,
      });
    } finally {
      await auditApp.close();
    }

    const after = await userState(user.id);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: token.row.id },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.revokedAt).toBeNull();
    expect(
      await prisma.userSession.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(1);
    expect(
      await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(1);
  });

  it("returns 503 on reset store failure without consuming or changing anything", async () => {
    const user = await createUser({ email: "store-reset@clearsight.test" });
    const token = await insertResetToken(user.id);
    const before = await userState(user.id);

    const storeApp = await buildApp({
      env: TEST_ENV,
      prisma: failingTransactionClient(prisma),
      now: () => clockNow,
      passwordRecoveryQuotaGuard: allowedGuard(),
    });
    await storeApp.ready();
    try {
      const response = await reset(token.rawToken, NEW_PASSWORD, {
        target: storeApp,
        ip: "203.0.113.93",
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await storeApp.close();
    }

    const after = await userState(user.id);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: token.row.id },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it("enforces the absolute 30-minute expiry boundary", async () => {
    const user = await createUser({ email: "expiry-reset@clearsight.test" });
    expect((await forgot(user.email, { ip: "203.0.113.94" })).statusCode).toBe(202);
    const firstRaw = delivery.delivered[0]!.rawToken;
    const firstRow = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(firstRaw) },
    });

    clockNow = new Date(firstRow.expiresAt.getTime() - 1);
    expect((await reset(firstRaw, NEW_PASSWORD, { ip: "203.0.113.95" })).statusCode).toBe(204);

    expect((await forgot(user.email, { ip: "203.0.113.96" })).statusCode).toBe(202);
    const secondRaw = delivery.delivered[1]!.rawToken;
    const secondRow = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(secondRaw) },
    });
    clockNow = secondRow.expiresAt;
    expect((await reset(secondRaw, NEW_PASSWORD_2, { ip: "203.0.113.97" })).statusCode).toBe(401);

    const after = await userState(user.id);
    expect(await bcrypt.compare(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD_2, after.passwordHash)).toBe(false);
  });
});

describe("password recovery transport and delivery compensation", () => {
  it("keeps strict JSON, optional Origin, no-store and no credentials in responses", async () => {
    const before = await recoveryRows();
    const mismatch = await forgot("unknown@clearsight.test", {
      origin: false,
      ip: "203.0.113.100",
    });
    expect(mismatch.statusCode).toBe(202);

    const extraField = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.101",
      payload: { email: "unknown@clearsight.test", extra: true },
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.headers["cache-control"]).toContain("no-store");

    const badOrigin = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      headers: { origin: "https://evil.test" },
      remoteAddress: "203.0.113.102",
      payload: { email: "unknown@clearsight.test" },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.headers["cache-control"]).toContain("no-store");

    const resetWithoutOrigin = await reset(generatePasswordResetToken(), NEW_PASSWORD, {
      origin: false,
      ip: "203.0.113.103",
    });
    expect(resetWithoutOrigin.statusCode).toBe(401);
    expect(resetWithoutOrigin.headers["cache-control"]).toContain("no-store");
    expect(setCookieHeader(resetWithoutOrigin)).toBeNull();

    const resetExtra = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.104",
      payload: {
        token: generatePasswordResetToken(),
        newPassword: NEW_PASSWORD,
        extra: true,
      },
    });
    expect(resetExtra.statusCode).toBe(400);

    const after = await recoveryRows();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(JSON.stringify(mismatch.json())).not.toContain("unknown@clearsight.test");
  });

  it("fails closed only when Origin is present and configuration is missing", async () => {
    const noOriginApp = await buildApp({
      env: { ...TEST_ENV, AUTH_PUBLIC_ORIGIN: undefined },
      prisma,
      now: () => clockNow,
      passwordResetDelivery: delivery,
    });
    await noOriginApp.ready();

    try {
      const withoutOrigin = await forgot("unknown@clearsight.test", {
        target: noOriginApp,
        origin: false,
        ip: "203.0.113.105",
      });
      expect(withoutOrigin.statusCode).toBe(202);

      const withOrigin = await forgot("unknown@clearsight.test", {
        target: noOriginApp,
        ip: "203.0.113.106",
      });
      expect(withOrigin.statusCode).toBe(503);
      expect(withOrigin.headers["cache-control"]).toContain("no-store");

      const resetWithoutOrigin = await reset(
        generatePasswordResetToken(),
        NEW_PASSWORD,
        { target: noOriginApp, origin: false, ip: "203.0.113.107" },
      );
      expect(resetWithoutOrigin.statusCode).toBe(401);

      const resetWithOrigin = await reset(
        generatePasswordResetToken(),
        NEW_PASSWORD,
        { target: noOriginApp, ip: "203.0.113.108" },
      );
      expect(resetWithOrigin.statusCode).toBe(503);
    } finally {
      await noOriginApp.close();
    }
  });

  it("revokes only the failed-delivery token, not a newer committed token", async () => {
    let firstCall = true;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const delivered: Array<{ rawToken: string }> = [];

    const blockingDelivery: PasswordResetDelivery = {
      mode: "MEMORY",
      async deliver(message) {
        if (firstCall) {
          firstCall = false;
          signalStarted();
          await failureGate;
          throw new Error("simulated delivery failure");
        }
        delivered.push({ rawToken: message.rawToken });
      },
    };

    const blockingApp = await buildApp({
      env: TEST_ENV,
      prisma,
      now: () => clockNow,
      passwordResetDelivery: blockingDelivery,
    });
    await blockingApp.ready();

    try {
      const user = await createUser({ email: "compensation@clearsight.test" });
      const firstRequest = forgot(user.email, {
        target: blockingApp,
        ip: "203.0.113.110",
      });
      await started;

      const newerResponse = await forgot(user.email, {
        target: blockingApp,
        ip: "203.0.113.111",
      });
      expect(newerResponse.statusCode).toBe(202);
      expect(delivered).toHaveLength(1);

      releaseFailure();
      const failedResponse = await firstRequest;
      expect(failedResponse.statusCode).toBe(202);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
      });
      expect(tokens).toHaveLength(2);
      const newerHash = hashPasswordResetToken(delivered[0]!.rawToken);
      const newer = tokens.find((token) => token.tokenHash === newerHash);
      const failed = tokens.find((token) => token.tokenHash !== newerHash);
      expect(newer).toMatchObject({ revokedAt: null, consumedAt: null });
      expect(failed?.revokedAt).not.toBeNull();

      expect((await reset(delivered[0]!.rawToken, NEW_PASSWORD)).statusCode).toBe(204);
    } finally {
      await blockingApp.close();
    }
  });
});

// HITO17 independent QA: permanent regression tests for concrete contract
// gaps found during adversarial review (D20 / identity spec recovery
// requirement). They only exercise public behavior; no production code is
// touched and no existing test was modified.
describe("HITO17 QA gap regressions", () => {
  it("defaults to DISABLED delivery at the app seam: no token minted and none invalidated", async () => {
    const defaultApp = await buildApp({ env: TEST_ENV, prisma, now: () => clockNow });
    await defaultApp.ready();
    try {
      const user = await createUser({ email: "qa-default-disabled@clearsight.test" });
      const existing = await insertResetToken(user.id);

      const response = await forgot(user.email, {
        target: defaultApp,
        ip: "203.0.113.200",
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.id).toBe(existing.row.id);
      expect(tokens[0]?.revokedAt).toBeNull();
      expect(tokens[0]?.consumedAt).toBeNull();
    } finally {
      await defaultApp.close();
    }
  });

  it("never accepts Authorization as a substitute for the reset token", async () => {
    const user = await createUser({ email: "qa-authz-substitute@clearsight.test" });
    const loginResponse = await login(user.email);
    expect(loginResponse.statusCode).toBe(200);
    const access = accessTokenFrom(loginResponse);

    // A valid Bearer must not turn a malformed body token into a reset.
    const withBearer = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { origin: ORIGIN, authorization: `Bearer ${access}` },
      remoteAddress: "203.0.113.201",
      payload: { token: "not-a-valid-token", newPassword: NEW_PASSWORD },
    });
    expect(withBearer.statusCode).toBe(401);
    expect(withBearer.json()).toEqual({
      error: "Unauthorized",
      message: "Invalid or expired reset token",
      statusCode: 401,
    });

    // Bearer does not relax the body contract either.
    const emptyToken = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { origin: ORIGIN, authorization: `Bearer ${access}` },
      remoteAddress: "203.0.113.202",
      payload: { token: "", newPassword: NEW_PASSWORD },
    });
    expect(emptyToken.statusCode).toBe(400);

    // forgot tolerates the header without ever using it as a credential.
    const forgotWithBearer = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      headers: { origin: ORIGIN, authorization: `Bearer ${access}` },
      remoteAddress: "203.0.113.203",
      payload: { email: user.email },
    });
    expect(forgotWithBearer.statusCode).toBe(202);
    expect(forgotWithBearer.json()).toEqual({ accepted: true });

    const state = await userState(user.id);
    expect(await bcrypt.compare(OLD_PASSWORD, state.passwordHash)).toBe(true);
    expect(state.tokenVersion).toBe(0);
  });

  it("rejects invalid bodies with 400 without consuming any recovery quota", async () => {
    expect(await recoveryRows()).toEqual([]);

    const forgotExtra = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.204",
      payload: { email: "qa-invalid-body@clearsight.test", extra: true },
    });
    expect(forgotExtra.statusCode).toBe(400);
    expect(forgotExtra.headers["cache-control"]).toContain("no-store");
    expect(await recoveryRows()).toEqual([]);

    const forgotBadEmail = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.205",
      payload: { email: "not-an-email" },
    });
    expect(forgotBadEmail.statusCode).toBe(400);
    expect(await recoveryRows()).toEqual([]);

    const resetShortPassword = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.206",
      payload: { token: generatePasswordResetToken(), newPassword: "short" },
    });
    expect(resetShortPassword.statusCode).toBe(400);
    expect(resetShortPassword.headers["cache-control"]).toContain("no-store");
    expect(await recoveryRows()).toEqual([]);

    const resetExtra = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { origin: ORIGIN },
      remoteAddress: "203.0.113.207",
      payload: {
        token: generatePasswordResetToken(),
        newPassword: NEW_PASSWORD,
        extra: true,
      },
    });
    expect(resetExtra.statusCode).toBe(400);
    expect(await recoveryRows()).toEqual([]);
  });

  it("stops before the email quota when the IP quota is exhausted and keeps 429 no-store", async () => {
    const ip = "203.0.113.208";
    const setupEmail = "qa-order-setup@clearsight.test";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await forgot(setupEmail, { ip });
    }

    const fresh = "qa-order-fresh@clearsight.test";
    const blocked = await forgot(fresh, { ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["cache-control"]).toContain("no-store");
    expect(blocked.headers["retry-after"]).toBe("3600");

    const rows = await recoveryRows();
    // The IP slot is consumed even while the email quota is exhausted.
    expect(rows.find((row) => row.kind === "FORGOT_IP")?.attempt_count).toBe(20);
    // The blocked attempt never reached the email bucket.
    const freshEmailKey = computePasswordRecoveryBucketHash(
      derivePasswordRecoveryKey(TEST_ENV.JWT_SECRET),
      PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_EMAIL,
      fresh,
    );
    expect(rows.find((row) => row.key_hash === freshEmailKey)).toBeUndefined();
    expect(rows.filter((row) => row.kind === "FORGOT_EMAIL")).toEqual([
      expect.objectContaining({
        attempt_count: FORGOT_EMAIL_LIMIT,
      }),
    ]);
  });

  it("returns one generic 503 for any account when the quota store is unavailable pre-lookup", async () => {
    const storeApp = await buildApp({
      env: TEST_ENV,
      prisma: failingTransactionClient(prisma),
      now: () => clockNow,
    });
    await storeApp.ready();
    try {
      const known = await createUser({ email: "qa-store-known@clearsight.test" });
      const inactive = await createUser({
        email: "qa-store-inactive@clearsight.test",
        isActive: false,
      });
      const unknown = `unknown-${randomUUID()}@clearsight.test`;
      const expected = {
        error: "service_unavailable",
        message: "Password recovery is temporarily unavailable",
        statusCode: 503,
      };

      const bodies = new Set<string>();
      for (const email of [known.email, inactive.email, unknown]) {
        const response = await forgot(email, {
          target: storeApp,
          ip: "203.0.113.209",
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual(expected);
        expect(response.headers["cache-control"]).toContain("no-store");
        bodies.add(response.body);
      }
      // Byte-identical for known, inactive and unknown accounts.
      expect(bodies.size).toBe(1);

      // reset fails with the same generic 503 before the token lookup: a
      // garbage token that would otherwise be 401 never reaches it.
      const resetResponse = await reset(generatePasswordResetToken(), NEW_PASSWORD, {
        target: storeApp,
        ip: "203.0.113.210",
      });
      expect(resetResponse.statusCode).toBe(503);
      expect(resetResponse.json()).toEqual(expected);

      expect(await recoveryRows()).toEqual([]);
      expect(await prisma.passwordResetToken.count()).toBe(0);
    } finally {
      await storeApp.close();
    }
  });

  it("keeps exactly one valid token when two concurrent forgot deliveries both succeed", async () => {
    const user = await createUser({ email: "qa-concurrent-forgot@clearsight.test" });
    const [first, second] = await Promise.all([
      forgot(user.email, { ip: "203.0.113.211" }),
      forgot(user.email, { ip: "203.0.113.212" }),
    ]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(delivery.delivered).toHaveLength(2);

    const rows = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(2);
    const valid = rows.filter(
      (row) => row.revokedAt === null && row.consumedAt === null,
    );
    const revoked = rows.filter((row) => row.revokedAt !== null);
    expect(valid).toHaveLength(1);
    expect(revoked).toHaveLength(1);

    const deliveredHashes = delivery.delivered.map((record) => ({
      raw: record.rawToken,
      hash: hashPasswordResetToken(record.rawToken),
    }));
    const validRaw = deliveredHashes.find(
      (record) => record.hash === valid[0]!.tokenHash,
    )?.raw;
    const revokedRaw = deliveredHashes.find(
      (record) => record.hash === revoked[0]!.tokenHash,
    )?.raw;
    expect(validRaw).toBeDefined();
    expect(revokedRaw).toBeDefined();

    // Mailbox arrival order must not resurrect the revoked token.
    expect((await reset(revokedRaw!, NEW_PASSWORD)).statusCode).toBe(401);
    expect((await reset(validRaw!, NEW_PASSWORD_2)).statusCode).toBe(204);

    const state = await userState(user.id);
    expect(state.tokenVersion).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD_2, state.passwordHash)).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, state.passwordHash)).toBe(false);
  });
});
