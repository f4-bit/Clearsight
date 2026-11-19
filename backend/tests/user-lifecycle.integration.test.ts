import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PrismaClient as GeneratedPrismaClient } from "../src/generated/prisma/client.js";
import type { UserRole } from "../src/generated/prisma/enums.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { createAdminUsersService } from "../src/services/admin-users.js";
import { bearer, buildTestApp, TEST_ENV } from "./helpers/app.js";
import {
  createTestPrisma,
  hashPassword,
  makeSession,
  makeStudy,
  makeUser,
  resetDb,
  testDatabaseUrl,
} from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

const PASSWORD = "synthetic-lifecycle-password-123";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  app = await buildTestApp(prisma);
});

beforeEach(async () => {
  await resetDb(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

interface AuthContext {
  readonly sessionId: string;
  readonly token: string;
  readonly headers: { authorization: string };
}

async function authFor(target: FastifyInstance, user: { id: string }): Promise<AuthContext> {
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { role: true, tokenVersion: true },
  });
  const session = await makeSession(prisma, {
    id: user.id,
    tokenVersion: current.tokenVersion,
  });
  const token = target.jwt.sign({
    sub: user.id,
    role: current.role,
    sessionId: session.id,
    tokenVersion: current.tokenVersion,
  });
  return {
    sessionId: session.id,
    token,
    headers: { authorization: `Bearer ${token}` },
  };
}

async function makeAdmin(): Promise<{ user: Awaited<ReturnType<typeof makeUser>>; auth: AuthContext }> {
  const user = await makeUser(prisma, "ADMIN", { passwordHash });
  return { user, auth: await authFor(app, user) };
}

async function makeTarget(role: UserRole = "OFTALMOLOGO") {
  return makeUser(prisma, role, { passwordHash, fullName: "Dr. Target" });
}

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function createUnrevokedCredentials(
  userId: string,
  tokenVersion: number,
  label: string,
) {
  const session = await makeSession(prisma, { id: userId, tokenVersion });
  const refresh = await prisma.refreshToken.create({
    data: {
      userId,
      sessionId: session.id,
      tokenHash: sha256(`${label}:refresh`),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const reset = await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(`${label}:reset`),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return { session, refresh, reset };
}

async function createPreRevokedCredentials(userId: string, tokenVersion: number, label: string) {
  const createdAt = new Date(Date.now() - 10 * 60 * 1000);
  const revokedAt = new Date(Date.now() - 5 * 60 * 1000);
  const session = await makeSession(prisma, { id: userId, tokenVersion }, createdAt);
  const refresh = await prisma.refreshToken.create({
    data: {
      userId,
      sessionId: session.id,
      tokenHash: sha256(`${label}:refresh`),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
      revokedAt,
    },
  });
  const reset = await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(`${label}:reset`),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000),
      revokedAt,
    },
  });
  await prisma.userSession.update({
    where: { id: session.id },
    data: { revokedAt, reasonCode: "LEGACY_REVOKED" },
  });
  return { session, refresh, reset, revokedAt };
}

async function unrevokedCounts(userId: string) {
  const [sessions, refreshTokens, resetTokens] = await Promise.all([
    prisma.userSession.count({ where: { userId, revokedAt: null } }),
    prisma.refreshToken.count({ where: { userId, revokedAt: null } }),
    prisma.passwordResetToken.count({ where: { userId, revokedAt: null } }),
  ]);
  return { sessions, refreshTokens, resetTokens };
}

async function listUsers(
  target: FastifyInstance,
  headers: { authorization?: string },
  query = "",
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: "GET",
    url: `/admin/users${query}`,
    headers,
  });
}

async function getDetail(
  target: FastifyInstance,
  id: string,
  headers: { authorization?: string },
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: "GET",
    url: `/admin/users/${id}`,
    headers,
  });
}

async function patchUser(
  target: FastifyInstance,
  id: string,
  body: InjectOptions["payload"],
  headers: { authorization?: string },
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: "PATCH",
    url: `/admin/users/${id}`,
    headers,
    payload: body,
  });
}

function createDirectUser(data: {
  id?: string;
  email: string;
  fullName?: string;
  role?: UserRole;
  isActive?: boolean;
  createdAt?: Date;
}) {
  return prisma.user.create({
    data: {
      ...(data.id !== undefined ? { id: data.id } : {}),
      email: data.email,
      passwordHash: "x",
      fullName: data.fullName ?? data.email,
      role: data.role ?? "OFTALMOLOGO",
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
    },
  });
}

/** Mutates after middleware but before the service transaction begins. */
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
          if (transactions === 1) {
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

function userReadFailureClient(base: PrismaClient, error: Error): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "user") {
        const delegate = target.user;
        return new Proxy(delegate, {
          get(delegateTarget, delegateProperty) {
            if (delegateProperty === "findUnique") {
              return async () => {
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

describe("GET/PATCH /admin/users authorization", () => {
  it("returns 401 unauthenticated and 403 for doctor/researcher roles", async () => {
    const target = await makeTarget();
    const admin = await makeAdmin();

    expect((await listUsers(app, {})).statusCode).toBe(401);
    expect((await getDetail(app, target.id, {})).statusCode).toBe(401);
    expect((await patchUser(app, target.id, { fullName: "Name" }, {})).statusCode).toBe(401);

    for (const role of ["OFTALMOLOGO", "INVESTIGADOR"] as const) {
      const actor = await makeUser(prisma, role, { passwordHash });
      const headers = await bearer(app, prisma, actor);
      expect((await listUsers(app, headers)).statusCode, role).toBe(403);
      expect((await getDetail(app, target.id, headers)).statusCode, role).toBe(403);
      expect((await patchUser(app, target.id, { fullName: "Name" }, headers)).statusCode, role).toBe(
        403,
      );
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.fullName).toBe(target.fullName);
    expect(await prisma.auditEvent.count()).toBe(0);
    expect(admin.user.role).toBe("ADMIN");
  });

  it("rejects mass-assignment PATCH fields with 400 and no hash or persistence", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    const hash = vi.spyOn(bcrypt, "hash");
    const response = await patchUser(
      app,
      target.id,
      {
        password: PASSWORD,
        passwordHash: "canary-hash",
        tokenVersion: 99,
        failedLoginCount: 9,
        actorUserId: auth.sessionId,
        grants: ["clinical-dataset"],
      },
      auth.headers,
    ).finally(() => {
      hash.mockRestore();
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "validation_error",
      message: "Request validation failed",
      statusCode: 400,
    });
    expect(response.body).not.toContain("canary-hash");
    expect(response.body).not.toContain(PASSWORD);
    expect(hash).not.toHaveBeenCalled();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({
      fullName: target.fullName,
      role: target.role,
      isActive: target.isActive,
      tokenVersion: target.tokenVersion,
      updatedAt: target.updatedAt,
    });
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("GET /admin/users read contract", () => {
  it("paginates, orders stably and applies literal email/fullName filters", async () => {
    const { auth } = await makeAdmin();
    const baseDate = new Date("2026-01-02T03:04:05.000Z");
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    for (const [index, id] of ids.entries()) {
      await createDirectUser({
        id,
        email: `listcase-${String.fromCharCode(97 + index)}@example.test`,
        fullName: `List Case ${index}`,
        createdAt: baseDate,
      });
    }

    const inactive = await createDirectUser({
      email: "filterfalse-inactive@example.test",
      fullName: "Filter False Inactive",
      isActive: false,
    });
    const active = await createDirectUser({
      email: "filterfalse-active@example.test",
      fullName: "Filter False Active",
    });

    const underscore = await createDirectUser({
      email: "literal_x@example.test",
      fullName: "Literal Underscore",
    });
    await createDirectUser({
      email: "literalAx@example.test",
      fullName: "Literal A",
    });
    const percent = await createDirectUser({
      email: "literal%x@example.test",
      fullName: "Literal Percent",
    });
    await createDirectUser({
      email: "literalZZx@example.test",
      fullName: "Literal Z",
    });
    const nameOnly = await createDirectUser({
      email: "search-name@example.test",
      fullName: "Searchable_Name",
    });

    const firstPage = await listUsers(app, auth.headers, "?limit=2&offset=0&q=listcase");
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(firstPage.json().items.map((item: { id: string }) => item.id)).toEqual([
      ids[0],
      ids[1],
    ]);
    expect(Object.keys(firstPage.json().items[0]).sort()).toEqual(
      ["createdAt", "email", "fullName", "id", "isActive", "role", "updatedAt"].sort(),
    );
    expect(firstPage.body).not.toContain("passwordHash");
    expect(firstPage.body).not.toContain("tokenVersion");

    const secondPage = await listUsers(app, auth.headers, "?limit=2&offset=1&q=listcase");
    expect(secondPage.json().items.map((item: { id: string }) => item.id)).toEqual([
      ids[1],
      ids[2],
    ]);

    const falseFilter = await listUsers(
      app,
      auth.headers,
      "?isActive=false&q=filterfalse",
    );
    expect(falseFilter.statusCode).toBe(200);
    expect(falseFilter.json().total).toBe(1);
    expect(falseFilter.json().items[0]).toMatchObject({
      id: inactive.id,
      isActive: false,
    });

    const trueFilter = await listUsers(app, auth.headers, "?isActive=true&q=filterfalse");
    expect(trueFilter.json().total).toBe(1);
    expect(trueFilter.json().items[0]).toMatchObject({ id: active.id, isActive: true });

    const underscoreFilter = await listUsers(
      app,
      auth.headers,
      `?q=${encodeURIComponent("literal_x")}`,
    );
    expect(underscoreFilter.json().total).toBe(1);
    expect(underscoreFilter.json().items[0].id).toBe(underscore.id);

    const percentFilter = await listUsers(
      app,
      auth.headers,
      `?q=${encodeURIComponent("literal%x")}`,
    );
    expect(percentFilter.json().total).toBe(1);
    expect(percentFilter.json().items[0].id).toBe(percent.id);

    const nameFilter = await listUsers(
      app,
      auth.headers,
      `?q=${encodeURIComponent("searchable_name")}`,
    );
    expect(nameFilter.json().total).toBe(1);
    expect(nameFilter.json().items[0].id).toBe(nameOnly.id);

    expect((await listUsers(app, auth.headers, "?limit=0")).statusCode).toBe(400);
    expect((await listUsers(app, auth.headers, "?offset=-1")).statusCode).toBe(400);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("returns legacy email/fullName as plain strings and a safe 404 for missing users", async () => {
    const { auth } = await makeAdmin();
    const legacy = await createDirectUser({
      email: "legacy@localhost",
      fullName: "Legacy User",
      role: "INVESTIGADOR",
    });

    const detail = await getDetail(app, legacy.id, auth.headers);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: legacy.id,
      email: "legacy@localhost",
      fullName: "Legacy User",
      role: "INVESTIGADOR",
      isActive: true,
    });
    expect(detail.json()).not.toHaveProperty("passwordHash");
    expect(detail.json()).not.toHaveProperty("tokenVersion");

    const search = await listUsers(
      app,
      auth.headers,
      `?q=${encodeURIComponent("legacy@localhost")}`,
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().total).toBe(1);
    expect(search.json().items[0].email).toBe("legacy@localhost");

    expect((await getDetail(app, "not-a-uuid", auth.headers)).statusCode).toBe(400);
    expect(
      (await patchUser(app, "not-a-uuid", { fullName: "Name" }, auth.headers)).statusCode,
    ).toBe(400);

    const credentials = await createUnrevokedCredentials(
      legacy.id,
      legacy.tokenVersion,
      "legacy-repair",
    );
    const repaired = await patchUser(
      app,
      legacy.id,
      { email: "legacy-repaired@example.test" },
      auth.headers,
    );
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().email).toBe("legacy-repaired@example.test");
    const legacyAfter = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyAfter.tokenVersion).toBe(legacy.tokenVersion + 1);
    expect(await unrevokedCounts(legacy.id)).toEqual({
      sessions: 0,
      refreshTokens: 0,
      resetTokens: 0,
    });
    expect(credentials.session.id).toBeTypeOf("string");

    const missing = await getDetail(
      app,
      "99999999-9999-4999-8999-999999999999",
      auth.headers,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: "NotFound",
      message: "User not found",
      statusCode: 404,
    });
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("fails closed with a safe 503 when the read store is unavailable", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: userReadFailureClient(prisma, new Error(canary)),
    });
    await failingApp.ready();
    try {
      const response = await getDetail(failingApp, target.id, auth.headers);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
      expect(response.body).not.toContain(target.email);
    } finally {
      await failingApp.close();
    }
  });
});

describe("PATCH /admin/users lifecycle", () => {
  it("updates fullName only without bumping/revoking, and preserves updatedAt on noop", async () => {
    const { user: admin, auth } = await makeAdmin();
    const target = await makeTarget();
    const credentials = await createUnrevokedCredentials(target.id, target.tokenVersion, "fullname");
    const targetToken = app.jwt.sign({
      sub: target.id,
      role: target.role,
      sessionId: credentials.session.id,
      tokenVersion: target.tokenVersion,
    });
    const beforeMe = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${targetToken}` },
    });
    expect(beforeMe.statusCode).toBe(200);

    const response = await patchUser(app, target.id, { fullName: "  Renamed Target  " }, auth.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ fullName: "Renamed Target", role: "OFTALMOLOGO" });
    expect(Object.keys(response.json()).sort()).toEqual(
      ["createdAt", "email", "fullName", "id", "isActive", "role", "updatedAt"].sort(),
    );
    expect(response.body).not.toContain("tokenVersion");
    expect(response.body).not.toContain("passwordHash");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.fullName).toBe("Renamed Target");
    expect(after.tokenVersion).toBe(target.tokenVersion);
    expect(await unrevokedCounts(target.id)).toEqual({
      sessions: 1,
      refreshTokens: 1,
      resetTokens: 1,
    });
    const afterMe = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${targetToken}` },
    });
    expect(afterMe.statusCode).toBe(200);

    const audits = await prisma.auditEvent.findMany({
      where: { action: "USER_UPDATED", targetUserId: target.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "USER",
      actorUserId: admin.id,
      targetType: "USER",
      targetUserId: target.id,
      outcome: "SUCCESS",
      metadata: { channel: "admin-api", changedFields: ["fullName"] },
    });
    expect(JSON.stringify(audits[0])).not.toContain("Renamed Target");

    const beforeNoop = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    const noop = await patchUser(app, target.id, { fullName: "Renamed Target" }, auth.headers);
    expect(noop.statusCode).toBe(200);
    const afterNoop = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterNoop.updatedAt.getTime()).toBe(beforeNoop.updatedAt.getTime());
    expect(afterNoop.tokenVersion).toBe(target.tokenVersion);
    expect(await unrevokedCounts(target.id)).toEqual({
      sessions: 1,
      refreshTokens: 1,
      resetTokens: 1,
    });
    const noopAudits = await prisma.auditEvent.findMany({
      where: { action: "USER_UPDATED", targetUserId: target.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(noopAudits).toHaveLength(2);
    expect(noopAudits[1]?.metadata).toMatchObject({ changedFields: [] });

    expect(credentials.session.id).toBeTypeOf("string");
  });

  it("revokes every credential family on email/role/deactivation/reactivation and never revives old tokens", async () => {
    const admin = await makeAdmin();
    const target = await makeTarget();
    const pre = await createPreRevokedCredentials(target.id, target.tokenVersion, "pre-revoked");
    const preSessionRevokedAt = (await prisma.userSession.findUniqueOrThrow({
      where: { id: pre.session.id },
    })).revokedAt?.toISOString();
    const preRefreshRevokedAt = (await prisma.refreshToken.findUniqueOrThrow({
      where: { id: pre.refresh.id },
    })).revokedAt?.toISOString();
    const preResetRevokedAt = (await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: pre.reset.id },
    })).revokedAt?.toISOString();

    const study = await makeStudy(prisma, { doctorId: target.id });
    const feedback = await prisma.clinicalFeedback.create({
      data: {
        consultationId: study.consultation.id,
        inferenceId: study.inference.id,
        doctorId: target.id,
        predictedClass: 1,
        validatedClass: 1,
        isGoldStandard: false,
      },
    });

    let expectedVersion = target.tokenVersion;
    const assertRevoked = async (oldAuth: AuthContext) => {
      expect(await unrevokedCounts(target.id)).toEqual({
        sessions: 0,
        refreshTokens: 0,
        resetTokens: 0,
      });
      const revokedSessions = await prisma.userSession.count({
        where: { userId: target.id, reasonCode: "ACCOUNT_UPDATED" },
      });
      expect(revokedSessions).toBeGreaterThan(0);
      const oldMe = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: oldAuth.headers,
      });
      expect(oldMe.statusCode).toBe(401);
    };

    let auth = await authFor(app, target);
    await createUnrevokedCredentials(target.id, target.tokenVersion, "email");
    let response = await patchUser(
      app,
      target.id,
      { email: "lifecycle-target@example.test" },
      admin.auth.headers,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("accessToken");
    expectedVersion += 1;
    let current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(current.tokenVersion).toBe(expectedVersion);
    await assertRevoked(auth);

    auth = await authFor(app, current);
    await createUnrevokedCredentials(target.id, current.tokenVersion, "role-admin");
    response = await patchUser(app, target.id, { role: "ADMIN" }, admin.auth.headers);
    expect(response.statusCode).toBe(200);
    expectedVersion += 1;
    current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(current.tokenVersion).toBe(expectedVersion);
    await assertRevoked(auth);

    auth = await authFor(app, current);
    await createUnrevokedCredentials(target.id, current.tokenVersion, "role-doctor");
    response = await patchUser(app, target.id, { role: "OFTALMOLOGO" }, admin.auth.headers);
    expect(response.statusCode).toBe(200);
    expectedVersion += 1;
    current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(current.tokenVersion).toBe(expectedVersion);
    await assertRevoked(auth);

    const deactAuth = await authFor(app, current);
    await createUnrevokedCredentials(target.id, current.tokenVersion, "deactivate");
    response = await patchUser(app, target.id, { isActive: false }, admin.auth.headers);
    expect(response.statusCode).toBe(200);
    expectedVersion += 1;
    current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(current.tokenVersion).toBe(expectedVersion);
    expect(current.isActive).toBe(false);
    await assertRevoked(deactAuth);

    response = await patchUser(app, target.id, { isActive: true }, admin.auth.headers);
    expect(response.statusCode).toBe(200);
    expectedVersion += 1;
    current = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(current.tokenVersion).toBe(expectedVersion);
    expect(current.isActive).toBe(true);
    const stillDead = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: deactAuth.headers,
    });
    expect(stillDead.statusCode).toBe(401);
    expect(await unrevokedCounts(target.id)).toEqual({
      sessions: 0,
      refreshTokens: 0,
      resetTokens: 0,
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "lifecycle-target@example.test", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: target.id, email: "lifecycle-target@example.test" });

    expect(
      (await prisma.userSession.findUniqueOrThrow({ where: { id: pre.session.id } })).revokedAt?.toISOString(),
    ).toBe(preSessionRevokedAt);
    expect(
      (await prisma.refreshToken.findUniqueOrThrow({ where: { id: pre.refresh.id } })).revokedAt?.toISOString(),
    ).toBe(preRefreshRevokedAt);
    expect(
      (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: pre.reset.id } })).revokedAt?.toISOString(),
    ).toBe(preResetRevokedAt);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: study.consultation.id },
    });
    const inference = await prisma.inference.findUniqueOrThrow({
      where: { id: study.inference.id },
    });
    const feedbackAfter = await prisma.clinicalFeedback.findUniqueOrThrow({
      where: { id: feedback.id },
    });
    expect(consultation.doctorId).toBe(target.id);
    expect(inference.id).toBe(study.inference.id);
    expect(feedbackAfter.doctorId).toBe(target.id);
  });

  it("rejects an email already owned by another account with 409 and no changes", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    const other = await createDirectUser({
      email: "taken@example.test",
      fullName: "Taken User",
    });
    await createUnrevokedCredentials(target.id, target.tokenVersion, "conflict");
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    const countsBefore = await unrevokedCounts(target.id);

    const response = await patchUser(
      app,
      target.id,
      { email: "TAKEN@EXAMPLE.TEST" },
      auth.headers,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("taken@example.test");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({
      email: before.email,
      tokenVersion: before.tokenVersion,
      updatedAt: before.updatedAt,
    });
    const otherAfter = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherAfter.email).toBe("taken@example.test");
    expect(await unrevokedCounts(target.id)).toEqual(countsBefore);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("protects the last active admin from deactivation/demotion, but allows a role noop", async () => {
    const admin = await makeAdmin();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });
    const sessionBefore = await prisma.userSession.findUniqueOrThrow({
      where: { id: admin.auth.sessionId },
    });

    for (const body of [
      { fullName: "Contact Change", isActive: false },
      { fullName: "Contact Change", role: "OFTALMOLOGO" as const },
    ]) {
      const response = await patchUser(app, admin.user.id, body, admin.auth.headers);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "Conflict",
        message: "At least one active administrator is required",
        statusCode: 409,
      });
    }

    const afterDenied = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });
    expect(afterDenied).toMatchObject({
      email: before.email,
      fullName: before.fullName,
      role: before.role,
      isActive: before.isActive,
      tokenVersion: before.tokenVersion,
      updatedAt: before.updatedAt,
    });
    expect(await prisma.userSession.count({ where: { userId: admin.user.id, revokedAt: null } })).toBe(1);
    const deniedAudits = await prisma.auditEvent.findMany({
      where: { action: "USER_UPDATE_DENIED", targetUserId: admin.user.id },
    });
    expect(deniedAudits).toHaveLength(2);
    for (const audit of deniedAudits) {
      expect(audit).toMatchObject({
        outcome: "DENIED",
        metadata: { channel: "admin-api", reasonCode: "LAST_ACTIVE_ADMIN" },
      });
    }
    const sessionAfterDenied = await prisma.userSession.findUniqueOrThrow({
      where: { id: sessionBefore.id },
    });
    expect(sessionAfterDenied.revokedAt).toBeNull();

    const noop = await patchUser(app, admin.user.id, { role: "ADMIN" }, admin.auth.headers);
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toMatchObject({ role: "ADMIN", isActive: true });
    const afterNoop = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });
    expect(afterNoop.tokenVersion).toBe(before.tokenVersion);
    expect(afterNoop.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const noopAudit = await prisma.auditEvent.findFirst({
      where: { action: "USER_UPDATED", targetUserId: admin.user.id, outcome: "SUCCESS" },
      orderBy: { occurredAt: "desc" },
    });
    expect(noopAudit?.metadata).toMatchObject({ changedFields: [] });
  });

  it("cleans legacy unrevoked credentials on repeated deactivation exactly once", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    const credentials = await createUnrevokedCredentials(target.id, target.tokenVersion, "stale-deact");
    await prisma.user.update({ where: { id: target.id }, data: { isActive: false } });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const first = await patchUser(app, target.id, { isActive: false }, auth.headers);
    expect(first.statusCode).toBe(200);
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterFirst.tokenVersion).toBe(before.tokenVersion + 1);
    expect(await unrevokedCounts(target.id)).toEqual({
      sessions: 0,
      refreshTokens: 0,
      resetTokens: 0,
    });
    expect(credentials.session.id).toBeTypeOf("string");

    const second = await patchUser(app, target.id, { isActive: false }, auth.headers);
    expect(second.statusCode).toBe(200);
    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterSecond.tokenVersion).toBe(afterFirst.tokenVersion);
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());

    const noCredentialTarget = await createDirectUser({
      email: "already-inactive@example.test",
      fullName: "Already Inactive",
      isActive: false,
    });
    const noCredentialBefore = await prisma.user.findUniqueOrThrow({
      where: { id: noCredentialTarget.id },
    });
    const noop = await patchUser(app, noCredentialTarget.id, { isActive: false }, auth.headers);
    expect(noop.statusCode).toBe(200);
    const noCredentialAfter = await prisma.user.findUniqueOrThrow({
      where: { id: noCredentialTarget.id },
    });
    expect(noCredentialAfter.tokenVersion).toBe(noCredentialBefore.tokenVersion);
    expect(noCredentialAfter.updatedAt.getTime()).toBe(noCredentialBefore.updatedAt.getTime());
  });

  it("allows self-deactivation or self-demotion when another active admin remains, revoking the current JWT", async () => {
    for (const body of [
      { isActive: false },
      { role: "OFTALMOLOGO" as const },
    ]) {
      await resetDb(prisma);
      const actor = await makeUser(prisma, "ADMIN", { passwordHash });
      const other = await makeUser(prisma, "ADMIN", { passwordHash });
      const auth = await authFor(app, actor);

      const response = await patchUser(app, actor.id, body, auth.headers);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("accessToken");

      const actorAfter = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
      expect(actorAfter.tokenVersion).toBe(actor.tokenVersion + 1);
      if ("isActive" in body) {
        expect(actorAfter.isActive).toBe(false);
      } else {
        expect(actorAfter.role).toBe("OFTALMOLOGO");
      }
      expect(await prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);

      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: auth.headers,
      });
      expect(me.statusCode).toBe(401);
      const otherAfter = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
      expect(otherAfter.isActive).toBe(true);
      expect(otherAfter.role).toBe("ADMIN");
    }
  });

  it("denies an actor whose role/version/session changes between middleware and the transaction", async () => {
    const mutations: Array<{
      label: string;
      mutate: (actorUserId: string, sessionId: string) => Promise<unknown>;
    }> = [
      {
        label: "role",
        mutate: (userId) =>
          prisma.user.update({ where: { id: userId }, data: { role: "OFTALMOLOGO" } }),
      },
      {
        label: "version",
        mutate: (userId) =>
          prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
      },
      {
        label: "revoked session",
        mutate: (_userId, sessionId) =>
          prisma.userSession.update({
            where: { id: sessionId },
            data: { revokedAt: new Date(), reasonCode: "QA_REVOKED" },
          }),
      },
    ];

    for (const mutation of mutations) {
      await resetDb(prisma);
      const actor = await makeUser(prisma, "ADMIN", { passwordHash });
      const target = await makeTarget();
      const auth = await authFor(app, actor);
      const racingApp = await buildApp({
        env: TEST_ENV,
        prisma: beforeTransactionClient(prisma, () =>
          mutation.mutate(actor.id, auth.sessionId),
        ),
      });
      await racingApp.ready();
      try {
        const response = await patchUser(
          racingApp,
          target.id,
          { fullName: "Should Not Apply" },
          auth.headers,
        );
        expect(response.statusCode, mutation.label).toBe(403);
        expect(response.body).not.toContain(actor.email);
        const targetAfter = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        expect(targetAfter.fullName, mutation.label).toBe(target.fullName);
        expect(await prisma.auditEvent.count(), mutation.label).toBe(0);
      } finally {
        await racingApp.close();
      }
    }
  });

  it("returns 403 for a stale actor with a missing target and 404 for a valid admin", async () => {
    const actor = await makeUser(prisma, "ADMIN", { passwordHash });
    const auth = await authFor(app, actor);
    const missingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    const control = await patchUser(app, missingId, { fullName: "Name" }, auth.headers);
    expect(control.statusCode).toBe(404);
    expect(control.json()).toEqual({
      error: "NotFound",
      message: "User not found",
      statusCode: 404,
    });

    // Regression for the old ordering: target miss used to be checked before
    // the fresh actor read, so a stale actor with an unknown UUID leaked 404.
    const racingApp = await buildApp({
      env: TEST_ENV,
      prisma: beforeTransactionClient(prisma, () =>
        prisma.user.update({ where: { id: actor.id }, data: { isActive: false } }),
      ),
    });
    await racingApp.ready();
    try {
      const stale = await patchUser(racingApp, missingId, { fullName: "Name" }, auth.headers);
      expect(stale.statusCode).toBe(403);
      expect(stale.body).not.toContain(actor.email);
      expect(stale.body).not.toContain("User not found");
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await racingApp.close();
    }
  });

  it("rolls back profile/version/session/refresh/reset changes when audit fails", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    await createUnrevokedCredentials(target.id, target.tokenVersion, "audit-failure");
    const pre = await createPreRevokedCredentials(target.id, target.tokenVersion, "audit-pre");
    const preSessionRevokedAt = (await prisma.userSession.findUniqueOrThrow({
      where: { id: pre.session.id },
    })).revokedAt?.toISOString();
    const preRefreshRevokedAt = (await prisma.refreshToken.findUniqueOrThrow({
      where: { id: pre.refresh.id },
    })).revokedAt?.toISOString();
    const preResetRevokedAt = (await prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: pre.reset.id },
    })).revokedAt?.toISOString();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    const countsBefore = await unrevokedCounts(target.id);
    const auditCountBefore = await prisma.auditEvent.count();

    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await failingApp.ready();
    try {
      const response = await patchUser(
        failingApp,
        target.id,
        { role: "INVESTIGADOR" },
        auth.headers,
      );
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain(target.email);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after).toMatchObject({
        role: before.role,
        tokenVersion: before.tokenVersion,
        updatedAt: before.updatedAt,
      });
      expect(await unrevokedCounts(target.id)).toEqual(countsBefore);
      expect(await prisma.auditEvent.count()).toBe(auditCountBefore);
      expect(
        (await prisma.userSession.findUniqueOrThrow({ where: { id: pre.session.id } })).revokedAt?.toISOString(),
      ).toBe(preSessionRevokedAt);
      expect(
        (await prisma.refreshToken.findUniqueOrThrow({ where: { id: pre.refresh.id } })).revokedAt?.toISOString(),
      ).toBe(preRefreshRevokedAt);
      expect(
        (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: pre.reset.id } })).revokedAt?.toISOString(),
      ).toBe(preResetRevokedAt);
    } finally {
      await failingApp.close();
    }
  });
});

describe("admin lifecycle concurrency", () => {
  it("serializes two admin deactivations on distinct connections and never leaves zero active admins", async () => {
    const adminA = await makeUser(prisma, "ADMIN", { passwordHash });
    const adminB = await makeUser(prisma, "ADMIN", { passwordHash });
    const sessionA = await makeSession(prisma, { id: adminA.id, tokenVersion: adminA.tokenVersion });
    const sessionB = await makeSession(prisma, { id: adminB.id, tokenVersion: adminB.tokenVersion });
    const actorA = {
      userId: adminA.id,
      role: "ADMIN" as const,
      sessionId: sessionA.id,
      tokenVersion: adminA.tokenVersion,
    };
    const actorB = {
      userId: adminB.id,
      role: "ADMIN" as const,
      sessionId: sessionB.id,
      tokenVersion: adminB.tokenVersion,
    };

    const clientA = createTestPrisma();
    const clientB = createTestPrisma();
    const serviceA = createAdminUsersService(clientA);
    const serviceB = createAdminUsersService(clientB);

    try {
      let started = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const start = (service: ReturnType<typeof createAdminUsersService>, actor: typeof actorA, targetId: string) => {
        started += 1;
        if (started === 2) {
          release();
        }
        return gate.then(() => service.updateUser(targetId, { isActive: false }, actor));
      };

      const settled = await Promise.race([
        Promise.allSettled([
          start(serviceA, actorA, adminB.id),
          start(serviceB, actorB, adminA.id),
        ]),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("bounded concurrency barrier timed out")), 20_000),
        ),
      ]);

      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as {
        code?: string;
      };
      expect(reason.code).toBe("ADMIN_ACCESS_DENIED");
      expect(await prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
      const activeAdmins = await prisma.user.findMany({
        where: { role: "ADMIN", isActive: true },
        select: { id: true },
      });
      expect([adminA.id, adminB.id]).toContain(activeAdmins[0]?.id);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });
});

describe("DELETE and restricted-role lifecycle", () => {
  it("does not expose DELETE and preserves clinical history", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    const study = await makeStudy(prisma, { doctorId: target.id });

    const response = await app.inject({
      method: "DELETE",
      url: `/admin/users/${target.id}`,
      headers: auth.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(
      await prisma.consultation.findUnique({ where: { id: study.consultation.id } }),
    ).not.toBeNull();
    expect(await prisma.inference.findUnique({ where: { id: study.inference.id } })).not.toBeNull();
  });

  it("runs PATCH as clearsight_app with audit insert and still denies DELETE/TRUNCATE", async () => {
    const ownerIdentity = await prisma.$queryRawUnsafe<
      Array<{ current_user: string; session_user: string }>
    >("SELECT current_user, session_user");
    const ownerSessionUser = ownerIdentity[0]?.session_user;
    expect(ownerSessionUser).toBeTypeOf("string");

    const actor = await makeUser(prisma, "ADMIN", { passwordHash });
    const actorSession = await makeSession(prisma, {
      id: actor.id,
      tokenVersion: actor.tokenVersion,
    });
    const target = await makeTarget();
    await makeSession(prisma, { id: target.id, tokenVersion: target.tokenVersion });

    const rolePrisma = new GeneratedPrismaClient({
      adapter: new PrismaPg(
        { connectionString: testDatabaseUrl(), options: "-c role=clearsight_app" },
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

      const token = roleApp.jwt.sign({
        sub: actor.id,
        role: "ADMIN" as UserRole,
        sessionId: actorSession.id,
        tokenVersion: actor.tokenVersion,
      });
      const response = await patchUser(
        roleApp,
        target.id,
        { role: "INVESTIGADOR" },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("passwordHash");
      const targetAfter = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(targetAfter.role).toBe("INVESTIGADOR");
      expect(targetAfter.tokenVersion).toBe(target.tokenVersion + 1);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: "USER_UPDATED", targetUserId: target.id },
      });
      expect(audit).toMatchObject({
        actorKind: "USER",
        actorUserId: actor.id,
        outcome: "SUCCESS",
        metadata: { channel: "admin-api", changedFields: ["role"] },
      });

      const after = await rolePrisma.$queryRawUnsafe<Array<{ current_user: string }>>(
        "SELECT current_user",
      );
      expect(after).toEqual([{ current_user: "clearsight_app" }]);

      const usersBefore = await prisma.user.count();
      await expect(
        rolePrisma.$executeRawUnsafe("DELETE FROM public.users WHERE id = $1::uuid", target.id),
      ).rejects.toThrow(/permission denied/i);
      await expect(rolePrisma.$executeRawUnsafe("TRUNCATE TABLE public.users")).rejects.toThrow(
        /permission denied/i,
      );
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    } finally {
      await roleApp?.close();
      await rolePrisma.$disconnect();
    }
  });
});

describe("QA adversarial lifecycle invariants", () => {
  it("denies self-deactivation when the only other administrators are inactive", async () => {
    const admin = await makeUser(prisma, "ADMIN", { passwordHash });
    const auth = await authFor(app, admin);
    // Inactive administrators must not count toward the active-admin guard.
    await makeUser(prisma, "ADMIN", { passwordHash, isActive: false });
    await makeUser(prisma, "ADMIN", { passwordHash, isActive: false });
    await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    const response = await patchUser(app, admin.id, { isActive: false }, auth.headers);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Conflict",
      message: "At least one active administrator is required",
      statusCode: 409,
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(after.isActive).toBe(true);
    expect(after.tokenVersion).toBe(admin.tokenVersion);
    expect(await prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
    const denied = await prisma.auditEvent.findMany({ where: { action: "USER_UPDATE_DENIED" } });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({
      changedFields: ["isActive"],
      reasonCode: "LAST_ACTIVE_ADMIN",
    });
  });

  it("denies a combined role+isActive removal atomically before any write", async () => {
    const admin = await makeUser(prisma, "ADMIN", { passwordHash });
    const auth = await authFor(app, admin);
    await createUnrevokedCredentials(admin.id, admin.tokenVersion, "combined-guard");
    const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    const countsBefore = await unrevokedCounts(admin.id);

    const response = await patchUser(
      app,
      admin.id,
      { fullName: "QA Renamed", role: "OFTALMOLOGO", isActive: false },
      auth.headers,
    );
    expect(response.statusCode).toBe(409);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(after).toMatchObject({
      fullName: before.fullName,
      role: "ADMIN",
      isActive: true,
      tokenVersion: before.tokenVersion,
      updatedAt: before.updatedAt,
    });
    expect(await unrevokedCounts(admin.id)).toEqual(countsBefore);
    const denied = await prisma.auditEvent.findMany({
      where: { action: "USER_UPDATE_DENIED", targetUserId: admin.id },
    });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({
      changedFields: ["fullName", "role", "isActive"],
      reasonCode: "LAST_ACTIVE_ADMIN",
    });
  });

  it("serializes concurrent self-deactivations on two connections and never leaves zero active admins", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resetDb(prisma);
      const adminA = await makeUser(prisma, "ADMIN", { passwordHash });
      const adminB = await makeUser(prisma, "ADMIN", { passwordHash });
      const sessionA = await makeSession(prisma, {
        id: adminA.id,
        tokenVersion: adminA.tokenVersion,
      });
      const sessionB = await makeSession(prisma, {
        id: adminB.id,
        tokenVersion: adminB.tokenVersion,
      });
      const actorA = {
        userId: adminA.id,
        role: "ADMIN" as const,
        sessionId: sessionA.id,
        tokenVersion: adminA.tokenVersion,
      };
      const actorB = {
        userId: adminB.id,
        role: "ADMIN" as const,
        sessionId: sessionB.id,
        tokenVersion: adminB.tokenVersion,
      };

      const clientA = createTestPrisma();
      const clientB = createTestPrisma();
      const serviceA = createAdminUsersService(clientA);
      const serviceB = createAdminUsersService(clientB);

      try {
        let started = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        // Each admin deactivates themself: the two transactions touch disjoint
        // rows, so only the shared global lock can serialize the active-admin
        // count. The invariant is "never zero active admins", not lock state.
        const start = (
          service: ReturnType<typeof createAdminUsersService>,
          actor: typeof actorA,
        ) => {
          started += 1;
          if (started === 2) {
            release();
          }
          return gate.then(() => service.updateUser(actor.userId, { isActive: false }, actor));
        };

        const settled = await Promise.race([
          Promise.allSettled([start(serviceA, actorA), start(serviceB, actorB)]),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("bounded concurrency barrier timed out")), 20_000),
          ),
        ]);

        const fulfilled = settled.filter((result) => result.status === "fulfilled");
        const rejected = settled.filter((result) => result.status === "rejected");
        expect(fulfilled, `attempt ${attempt}`).toHaveLength(1);
        expect(rejected, `attempt ${attempt}`).toHaveLength(1);
        const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
        expect(reason.code, `attempt ${attempt}`).toBe("ADMIN_LAST_ACTIVE_ADMIN");
        expect(
          await prisma.user.count({ where: { role: "ADMIN", isActive: true } }),
          `attempt ${attempt}`,
        ).toBe(1);
        expect(
          await prisma.auditEvent.count({ where: { action: "USER_UPDATED", outcome: "SUCCESS" } }),
          `attempt ${attempt}`,
        ).toBe(1);
        expect(
          await prisma.auditEvent.count({
            where: { action: "USER_UPDATE_DENIED", outcome: "DENIED" },
          }),
          `attempt ${attempt}`,
        ).toBe(1);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    }
  });

  it("maps tokenVersion integer overflow to a safe 503 and rolls back every write", async () => {
    const { auth } = await makeAdmin();
    const target = await makeTarget();
    await prisma.user.update({ where: { id: target.id }, data: { tokenVersion: 2147483647 } });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    await createUnrevokedCredentials(target.id, before.tokenVersion, "overflow");
    const countsBefore = await unrevokedCounts(target.id);

    const response = await patchUser(app, target.id, { role: "INVESTIGADOR" }, auth.headers);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "service_unavailable",
      message: "User administration is temporarily unavailable",
      statusCode: 503,
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({
      role: before.role,
      tokenVersion: 2147483647,
      updatedAt: before.updatedAt,
    });
    expect(await unrevokedCounts(target.id)).toEqual(countsBefore);
    expect(
      await prisma.auditEvent.count({ where: { action: "USER_UPDATED", targetUserId: target.id } }),
    ).toBe(0);
  });

  it("keeps HU01 lockout counters and locks intact across lifecycle changes", async () => {
    const { auth } = await makeAdmin();
    const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      passwordHash,
      fullName: "Locked Target",
      lockedUntil,
    });
    await prisma.user.update({ where: { id: target.id }, data: { failedLoginCount: 3 } });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const response = await patchUser(
      app,
      target.id,
      { email: "qa-locked-target@example.test" },
      auth.headers,
    );
    expect(response.statusCode).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.email).toBe("qa-locked-target@example.test");
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect(after.lockedUntil?.toISOString()).toBe(lockedUntil.toISOString());
    expect(after.failedLoginCount).toBe(3);

    // The security lock survives the lifecycle change: a correct password on
    // the locked account stays throttled with the uniform generic body.
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "qa-locked-target@example.test", password: PASSWORD },
    });
    expect(login.statusCode).toBe(429);
    expect(login.headers["retry-after"]).toBeDefined();
    expect(login.json()).toEqual({
      error: "Too Many Requests",
      message: "Too many login attempts",
      statusCode: 429,
    });
    expect(login.body).not.toContain("qa-locked-target");

    // SUCCESS audit metadata carries field names only, never email values.
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "USER_UPDATED", targetUserId: target.id },
    });
    expect(audit.metadata).toMatchObject({ changedFields: ["email"] });
    expect(JSON.stringify(audit)).not.toContain("@");
    expect(JSON.stringify(audit)).not.toContain("qa-locked-target");
    expect(JSON.stringify(audit)).not.toContain(target.email);
  });

  it("applies the full actor-session truth map before any mutation", async () => {
    const service = createAdminUsersService(prisma);

    // Positive control: every truth-map condition satisfied must mutate.
    const freshActorUser = await makeUser(prisma, "ADMIN", { passwordHash, tokenVersion: 1 });
    const freshSession = await makeSession(prisma, { id: freshActorUser.id, tokenVersion: 1 });
    const freshTarget = await makeTarget();
    const ok = await service.updateUser(
      freshTarget.id,
      { fullName: "Truth Map Applied" },
      { userId: freshActorUser.id, role: "ADMIN", sessionId: freshSession.id, tokenVersion: 1 },
    );
    expect(ok.fullName).toBe("Truth Map Applied");

    const expiredActorUser = await makeUser(prisma, "ADMIN", { passwordHash, tokenVersion: 1 });
    const expiredSession = await makeSession(
      prisma,
      { id: expiredActorUser.id, tokenVersion: 1 },
      new Date(Date.now() - 10 * 60 * 1000),
      { expiresAt: new Date(Date.now() - 60 * 1000) },
    );
    const staleIssuedUser = await makeUser(prisma, "ADMIN", { passwordHash, tokenVersion: 0 });
    const staleIssuedSession = await makeSession(prisma, {
      id: staleIssuedUser.id,
      tokenVersion: 0,
    });
    // Simulate a legacy/out-of-band state: the user version moved forward while
    // the durable session kept its old issued version. The schema trigger only
    // enforces the pairing at session-write time, so the service truth map is
    // the guard that must reject this actor.
    await prisma.user.update({ where: { id: staleIssuedUser.id }, data: { tokenVersion: 1 } });
    const foreignSessionOwner = await makeUser(prisma, "ADMIN", { passwordHash });
    const foreignSession = await makeSession(prisma, {
      id: foreignSessionOwner.id,
      tokenVersion: foreignSessionOwner.tokenVersion,
    });
    const foreignClaimUser = await makeUser(prisma, "ADMIN", { passwordHash });
    const inactiveActorUser = await makeUser(prisma, "ADMIN", {
      passwordHash,
    });
    const inactiveSession = await makeSession(prisma, {
      id: inactiveActorUser.id,
      tokenVersion: inactiveActorUser.tokenVersion,
    });
    // Deactivate after the session exists: the trigger only guards session
    // writes, so this legacy state must be rejected by the service truth map.
    await prisma.user.update({ where: { id: inactiveActorUser.id }, data: { isActive: false } });

    const denials: Array<{ label: string; actor: unknown }> = [
      {
        label: "expired session",
        actor: {
          userId: expiredActorUser.id,
          role: "ADMIN",
          sessionId: expiredSession.id,
          tokenVersion: 1,
        },
      },
      {
        label: "stale issued token version",
        actor: {
          userId: staleIssuedUser.id,
          role: "ADMIN",
          sessionId: staleIssuedSession.id,
          tokenVersion: 1,
        },
      },
      {
        label: "session owned by another user",
        actor: {
          userId: foreignClaimUser.id,
          role: "ADMIN",
          sessionId: foreignSession.id,
          tokenVersion: foreignClaimUser.tokenVersion,
        },
      },
      {
        label: "inactive actor user",
        actor: {
          userId: inactiveActorUser.id,
          role: "ADMIN",
          sessionId: inactiveSession.id,
          tokenVersion: inactiveActorUser.tokenVersion,
        },
      },
    ];

    for (const { label, actor } of denials) {
      const target = await makeTarget();
      await expect(
        service.updateUser(target.id, { fullName: "Should Not Apply" }, actor),
        label,
      ).rejects.toMatchObject({ code: "ADMIN_ACCESS_DENIED" });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.fullName, label).toBe(target.fullName);
      expect(after.tokenVersion, label).toBe(target.tokenVersion);
      expect(await prisma.auditEvent.count({ where: { targetUserId: target.id } }), label).toBe(0);
    }
  });

  it("orders results by createdAt descending and rejects NaN pagination over HTTP", async () => {
    const { auth } = await makeAdmin();
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-02-01T00:00:00.000Z");
    const t3 = new Date("2026-03-01T00:00:00.000Z");
    // Inserted out of chronological order; sorting must be by createdAt DESC.
    const oldest = await createDirectUser({
      email: "qa-order-oldest@example.test",
      fullName: "QA Order Oldest",
      createdAt: t1,
    });
    const newest = await createDirectUser({
      email: "qa-order-newest@example.test",
      fullName: "QA Order Newest",
      createdAt: t3,
    });
    const middle = await createDirectUser({
      email: "qa-order-middle@example.test",
      fullName: "QA Order Middle",
      createdAt: t2,
    });

    const page = await listUsers(app, auth.headers, "?limit=10&q=qa-order");
    expect(page.statusCode).toBe(200);
    expect(page.json().total).toBe(3);
    expect(page.json().items.map((item: { id: string }) => item.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);

    const detail = await getDetail(app, newest.id, auth.headers);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().createdAt).toBe(t3.toISOString());

    for (const query of ["?limit=abc", "?limit=NaN", "?limit=Infinity", "?offset=1e999"]) {
      expect((await listUsers(app, auth.headers, query)).statusCode, query).toBe(400);
    }
  });
});
