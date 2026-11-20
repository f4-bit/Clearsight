import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PrismaClient as GeneratedPrismaClient } from "../src/generated/prisma/client.js";
import type { UserRole } from "../src/generated/prisma/enums.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { ADMIN_LIFECYCLE_LOCK_KEY, bootstrapAdmin } from "../src/services/admin-bootstrap.js";
import { bearer, buildTestApp, TEST_AUTH_ORIGIN, TEST_ENV } from "./helpers/app.js";
import {
  createTestPrisma,
  hashPassword,
  makeSession,
  makeUser,
  resetDb,
  testDatabaseUrl,
} from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

const PASSWORD = "synthetic-admin-created-password-123";
const AUTH_ORIGIN = { origin: TEST_AUTH_ORIGIN };
const CREATED_EMAIL = "admin-created@clearsight.test";
const FULL_NAME = "Dra. Muñoz";

let actorPasswordHash: string;

beforeAll(async () => {
  actorPasswordHash = await hashPassword(PASSWORD);
  app = await buildTestApp(prisma);
});

beforeEach(() => resetDb(prisma));

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
  const user = await makeUser(prisma, "ADMIN", { passwordHash: actorPasswordHash });
  return { user, auth: await authFor(app, user) };
}

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: CREATED_EMAIL,
    password: PASSWORD,
    fullName: FULL_NAME,
    ...overrides,
  };
}

async function createUserRequest(
  target: FastifyInstance,
  headers: { authorization?: string },
  payload: InjectOptions["payload"] = createPayload(),
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: "POST",
    url: "/admin/users",
    headers,
    payload,
  });
}

/** Mutates after the middleware but before the service transaction begins. */
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

/** Mutates before every transaction, one queued mutation per invocation. */
function queuedTransactionClient(
  base: PrismaClient,
  mutations: Array<() => Promise<unknown>>,
): PrismaClient {
  let index = 0;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = target.$transaction.bind(target) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (callback: unknown, options?: unknown) => {
          const mutate = mutations[index];
          index += 1;
          if (mutate) {
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

/** Fails one model operation inside the real transaction. */
function transactionModelFailureClient(
  base: PrismaClient,
  model: "user" | "userSession",
  operation: "findFirst" | "findUnique" | "create",
  error: Error,
): PrismaClient {
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
                if (txProperty === model) {
                  const delegate = Reflect.get(txTarget, txProperty, txReceiver) as Record<
                    string,
                    unknown
                  >;
                  return new Proxy(delegate, {
                    get(delegateTarget, delegateProperty, delegateReceiver) {
                      if (delegateProperty === operation) {
                        return async () => {
                          throw error;
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

describe("POST /admin/users authorization", () => {
  it("returns 401 for unauthenticated callers and 403 for non-admin roles without hashing or writes", async () => {
    const unauth = await createUserRequest(app, {});
    expect(unauth.statusCode).toBe(401);
    const unauthInvalid = await createUserRequest(app, {}, createPayload({ isActive: false }));
    expect(unauthInvalid.statusCode).toBe(401);

    const hash = vi.spyOn(bcrypt, "hash");
    try {
      for (const role of ["OFTALMOLOGO", "INVESTIGADOR"] as const) {
        const actor = await makeUser(prisma, role, { passwordHash: actorPasswordHash });
        const headers = await bearer(app, prisma, actor);
        const response = await createUserRequest(app, headers);
        expect(response.statusCode, role).toBe(403);
        expect(response.body).not.toContain("accessToken");
      }
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }

    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rejects mass-assignment fields with 400 before hashing or persistence", async () => {
    const { user: actor } = await makeAdmin();
    const auth = await authFor(app, actor);
    const hash = vi.spyOn(bcrypt, "hash");
    const response = await createUserRequest(
      app,
      auth.headers,
      createPayload({
        isActive: false,
        passwordHash: "canary-password-hash",
        actorUserId: randomUUID(),
        actorSessionId: auth.sessionId,
        tokenVersion: 99,
        failedLoginCount: 7,
      }),
    ).finally(() => {
      hash.mockRestore();
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "validation_error",
      message: "Request validation failed",
      statusCode: 400,
    });
    expect(response.body).not.toContain("canary-password-hash");
    expect(response.body).not.toContain(PASSWORD);
    expect(hash).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("POST /admin/users creation", () => {
  it("creates an active OFTALMOLOGO with cost 12, normalized data and one USER audit", async () => {
    const { user: actor, auth } = await makeAdmin();

    const response = await createUserRequest(
      app,
      auth.headers,
      createPayload({
        email: "  ADMIN-CREATED@EXAMPLE.TEST  ",
        fullName: "  Dra. Muñoz  ",
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(
      ["createdAt", "email", "fullName", "id", "isActive", "role", "updatedAt"].sort(),
    );
    expect(body).toMatchObject({
      email: "admin-created@example.test",
      fullName: FULL_NAME,
      role: "OFTALMOLOGO",
      isActive: true,
    });
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    expect(response.body).not.toContain("passwordHash");
    expect(response.body).not.toContain("tokenVersion");
    expect(response.body).not.toContain(PASSWORD);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: body.id } });
    expect(created).toMatchObject({
      email: "admin-created@example.test",
      fullName: FULL_NAME,
      role: "OFTALMOLOGO",
      isActive: true,
      tokenVersion: 0,
    });
    expect(created.passwordHash).not.toBe(PASSWORD);
    expect(bcrypt.getRounds(created.passwordHash)).toBe(12);
    expect(await bcrypt.compare(PASSWORD, created.passwordHash)).toBe(true);

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "USER",
      actorUserId: actor.id,
      targetType: "USER",
      targetUserId: created.id,
      targetId: null,
      action: "USER_CREATED",
      outcome: "SUCCESS",
      metadata: { channel: "admin-api", assignedRole: "OFTALMOLOGO" },
    });
    expect(JSON.stringify(audits[0])).not.toContain("admin-created@example.test");
    expect(JSON.stringify(audits[0])).not.toContain(PASSWORD);
  });

  it("allows INVESTIGADOR and ADMIN targets for an authenticated ADMIN", async () => {
    const { user: actor, auth } = await makeAdmin();

    for (const role of ["INVESTIGADOR", "ADMIN"] as const) {
      const response = await createUserRequest(
        app,
        auth.headers,
        createPayload({
          email: `created-${role.toLowerCase()}@clearsight.test`,
          role,
        }),
      );
      expect(response.statusCode, role).toBe(201);
      expect(response.json().role).toBe(role);
    }

    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(2);
    const actorAfter = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(actorAfter.role).toBe("ADMIN");
    expect(actorAfter.isActive).toBe(true);
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it("lets the newly created staff member log in and use /auth/me through the real auth service", async () => {
    const { auth } = await makeAdmin();

    const created = await createUserRequest(
      app,
      auth.headers,
      createPayload({
        email: "created-login@example.test",
        fullName: "Unicode Ñandú",
      }),
    );
    expect(created.statusCode).toBe(201);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: "  CREATED-LOGIN@EXAMPLE.TEST ", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;
    expect(login.json().user).toMatchObject({
      id: created.json().id,
      email: "created-login@example.test",
      role: "OFTALMOLOGO",
    });

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: created.json().id,
      email: "created-login@example.test",
      role: "OFTALMOLOGO",
    });
  });

  it("treats email matching as literal: `_` cannot create a false conflict", async () => {
    const { auth } = await makeAdmin();

    const wildcardLooking = await createUserRequest(
      app,
      auth.headers,
      createPayload({ email: "literalAx@example.test" }),
    );
    expect(wildcardLooking.statusCode).toBe(201);

    const underscored = await createUserRequest(
      app,
      auth.headers,
      createPayload({ email: "literal_x@example.test" }),
    );
    expect(underscored.statusCode).toBe(201);

    const duplicate = await createUserRequest(
      app,
      auth.headers,
      createPayload({ email: "LITERAL_X@EXAMPLE.TEST" }),
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).not.toContain("literal_x@example.test");

    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.auditEvent.count()).toBe(2);
    const role = await prisma.user.findUniqueOrThrow({
      where: { email: "literal_x@example.test" },
      select: { role: true, isActive: true },
    });
    expect(role).toEqual({ role: "OFTALMOLOGO", isActive: true });
  });

  it("serializes two same-email/case-variant creators into exactly one user and one audit", async () => {
    const { auth } = await makeAdmin();

    const responses = await Promise.all([
      createUserRequest(app, auth.headers, createPayload({ email: "race-same@example.test" })),
      createUserRequest(app, auth.headers, createPayload({ email: "RACE-SAME@EXAMPLE.TEST" })),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: { equals: "race-same@example.test", mode: "insensitive" } } })).toBe(1);
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("allows concurrent different emails, including two additional ADMINs, without mutating the last admin", async () => {
    const { user: actor, auth } = await makeAdmin();

    const responses = await Promise.all([
      createUserRequest(
        app,
        auth.headers,
        createPayload({ email: "race-a@example.test", role: "ADMIN" }),
      ),
      createUserRequest(
        app,
        auth.headers,
        createPayload({ email: "race-b@example.test", role: "ADMIN" }),
      ),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(3);
    const actorAfter = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(actorAfter.role).toBe("ADMIN");
    expect(actorAfter.isActive).toBe(true);
    expect(actorAfter.tokenVersion).toBe(actor.tokenVersion);
    expect(await prisma.auditEvent.count()).toBe(2);
  });
});

describe("POST /admin/users stale principal and audit/store failures", () => {
  const mutations: Array<{
    label: string;
    mutate: (userId: string, sessionId: string) => Promise<unknown>;
  }> = [
    {
      label: "role demotion after middleware",
      mutate: (userId) => prisma.user.update({ where: { id: userId }, data: { role: "OFTALMOLOGO" } }),
    },
    {
      label: "tokenVersion bump after middleware",
      mutate: (userId) =>
        prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    },
    {
      label: "deactivation after middleware",
      mutate: (userId) => prisma.user.update({ where: { id: userId }, data: { isActive: false } }),
    },
    {
      label: "session revocation after middleware",
      mutate: (_userId, sessionId) =>
        prisma.userSession.update({
          where: { id: sessionId },
          data: { revokedAt: new Date(), reasonCode: "QA_REVOKED" },
        }),
    },
  ];

  it.each(mutations)("denies a $label with a safe 403 and no sensitive writes", async ({ mutate }) => {
    const actor = await makeUser(prisma, "ADMIN", { passwordHash: actorPasswordHash });
    const auth = await authFor(app, actor);
    const racingApp = await buildApp({
      env: TEST_ENV,
      prisma: beforeTransactionClient(prisma, () => mutate(actor.id, auth.sessionId)),
    });
    await racingApp.ready();

    try {
      const response = await createUserRequest(racingApp, auth.headers);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(actor.email);
      expect(response.body).not.toContain(PASSWORD);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await racingApp.close();
    }
  });

  it("rolls the target user back when the audit insert fails", async () => {
    const { user: actor, auth } = await makeAdmin();
    const failingApp = await buildApp({ env: TEST_ENV, prisma: auditFailingClient(prisma) });
    await failingApp.ready();

    try {
      const response = await createUserRequest(failingApp, auth.headers);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain(actor.email);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });

  it("fails closed with a safe 503 when the user store fails", async () => {
    const { user: actor, auth } = await makeAdmin();
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: transactionModelFailureClient(prisma, "user", "create", new Error(canary)),
    });
    await failingApp.ready();

    try {
      const response = await createUserRequest(failingApp, auth.headers);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
      expect(response.body).not.toContain(actor.email);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });
});

describe("admin route OpenAPI", () => {
  it("publishes a valid POST /admin/users document without credential internals", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);
    const document = response.json() as {
      paths?: Record<string, { post?: unknown }>;
    };
    expect(document.paths?.["/admin/users"]?.post).toBeDefined();
    const serialized = JSON.stringify(document.paths?.["/admin/users"]);
    expect(serialized).toContain("OFTALMOLOGO");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("tokenVersion");
  });
});

describe("bootstrap and restricted application role", () => {
  it("bootstraps an ADMIN that can immediately log in through the HTTP API", async () => {
    const email = "bootstrap-login@clearsight.test";
    const result = await bootstrapAdmin(prisma, {
      email,
      fullName: "Bootstrap Ñandú",
      password: PASSWORD,
    });
    expect(result.role).toBe("ADMIN");

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: `  ${email.toUpperCase()}  `, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ id: result.id, email, role: "ADMIN" });

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: result.id, email, role: "ADMIN" });
  });

  it("runs the real create endpoint as clearsight_app with the owner fixture and audit grants", async () => {
    const ownerIdentity = await prisma.$queryRawUnsafe<
      Array<{ current_user: string; session_user: string }>
    >("SELECT current_user, session_user");
    const ownerSessionUser = ownerIdentity[0]?.session_user;
    expect(ownerSessionUser).toBeTypeOf("string");

    const actor = await makeUser(prisma, "ADMIN", { passwordHash: actorPasswordHash });
    const session = await makeSession(prisma, { id: actor.id, tokenVersion: actor.tokenVersion });

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

      const identity = await rolePrisma.$queryRawUnsafe<Array<{ current_user: string }>>(
        "SELECT current_user",
      );
      expect(identity).toEqual([{ current_user: "clearsight_app" }]);

      const token = roleApp.jwt.sign({
        sub: actor.id,
        role: "ADMIN" as UserRole,
        sessionId: session.id,
        tokenVersion: actor.tokenVersion,
      });
      const response = await createUserRequest(roleApp, { authorization: `Bearer ${token}` }, {
        email: "role-created@clearsight.test",
        password: PASSWORD,
        fullName: "Role Created",
      });
      expect(response.statusCode).toBe(201);

      const after = await rolePrisma.$queryRawUnsafe<Array<{ current_user: string }>>(
        "SELECT current_user",
      );
      expect(after).toEqual([{ current_user: "clearsight_app" }]);

      const created = await prisma.user.findUniqueOrThrow({
        where: { email: "role-created@clearsight.test" },
      });
      expect(created.role).toBe("OFTALMOLOGO");
      expect(created.isActive).toBe(true);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: "USER_CREATED", targetUserId: created.id },
      });
      expect(audit).toMatchObject({
        actorKind: "USER",
        actorUserId: actor.id,
        outcome: "SUCCESS",
        metadata: { channel: "admin-api", assignedRole: "OFTALMOLOGO" },
      });
    } finally {
      await roleApp?.close();
      await rolePrisma.$disconnect();
    }
  });
});

describe("POST /admin/users stale principal gaps (QA)", () => {
  // The `user_sessions_enforce_integrity` trigger (migration C) makes
  // user_id / issued_token_version / expires_at immutable after creation, so
  // ownership and version drift are unreachable at the DB level. Expiry drift
  // is reachable through the clock seam and is covered below.

  it("expires a session exactly at the checked instant and allows one millisecond before", async () => {
    const actor = await makeUser(prisma, "ADMIN", { passwordHash: actorPasswordHash });
    const fixed = new Date(Date.now() + 60_000);
    const session = await makeSession(
      prisma,
      { id: actor.id, tokenVersion: actor.tokenVersion },
      new Date(),
      { expiresAt: fixed },
    );
    const headers = {
      authorization: `Bearer ${app.jwt.sign({
        sub: actor.id,
        role: "ADMIN" as UserRole,
        sessionId: session.id,
        tokenVersion: actor.tokenVersion,
      })}`,
    };
    // Request order matters: the middleware runs before the queued mutation,
    // so both requests authenticate one millisecond before expiry. The first
    // request is then checked one millisecond before expiry (allowed) and the
    // second exactly at the checked instant, where `<=` must deny.
    const clock = { at: new Date(fixed.getTime() - 1) };
    const boundaryApp = await buildApp({
      env: TEST_ENV,
      prisma: queuedTransactionClient(prisma, [
        async () => {
          clock.at = new Date(fixed.getTime() - 1);
        },
        async () => {
          clock.at = fixed;
        },
      ]),
      now: () => clock.at,
    });
    await boundaryApp.ready();

    try {
      const valid = await createUserRequest(
        boundaryApp,
        headers,
        createPayload({ email: "boundary-valid@clearsight.test" }),
      );
      expect(valid.statusCode).toBe(201);

      const expired = await createUserRequest(
        boundaryApp,
        headers,
        createPayload({ email: "boundary-expired@clearsight.test" }),
      );
      expect(expired.statusCode).toBe(403);
      expect(expired.json()).toEqual({
        error: "forbidden",
        message: "Forbidden",
        statusCode: 403,
      });
      expect(expired.body).not.toContain(PASSWORD);
      expect(await prisma.user.findUnique({ where: { email: "boundary-expired@clearsight.test" } })).toBeNull();

      const users = await prisma.user.findMany({
        orderBy: { email: "asc" },
        select: { email: true },
      });
      expect(users).toEqual([{ email: actor.email }, { email: "boundary-valid@clearsight.test" }]);
      expect(await prisma.auditEvent.count()).toBe(1);
    } finally {
      await boundaryApp.close();
    }
  });

  it("maps a database unique violation to a constant 409 without leaking driver output", async () => {
    const { user: actor, auth } = await makeAdmin();
    const uniqueViolation = Object.assign(
      new Error(
        "Unique constraint failed on the fields: (`email`) (canary-raw@clearsight.test) P2002",
      ),
      { code: "P2002" },
    );
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: transactionModelFailureClient(prisma, "user", "create", uniqueViolation),
    });
    await failingApp.ready();

    try {
      const response = await createUserRequest(failingApp, auth.headers);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "Conflict",
        message: "A user with this email already exists",
        statusCode: 409,
      });
      expect(response.body).not.toContain("canary-raw");
      expect(response.body).not.toContain("P2002");
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain(actor.email);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });

  it("never promotes an existing ordinary user when the conflict request asks for ADMIN", async () => {
    const { auth } = await makeAdmin();
    const existing = await makeUser(prisma, "OFTALMOLOGO", {
      email: "existing-ordinary@clearsight.test",
      passwordHash: "x",
    });

    const response = await createUserRequest(
      app,
      auth.headers,
      createPayload({ email: "EXISTING-ORDINARY@CLEARSIGHT.TEST", role: "ADMIN" }),
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("existing-ordinary@clearsight.test");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.role).toBe("OFTALMOLOGO");
    expect(after.isActive).toBe(true);
    expect(after.passwordHash).toBe("x");
    expect(after.tokenVersion).toBe(0);
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("serializes admin creation on the shared admin lifecycle lock", async () => {
    const { auth } = await makeAdmin();
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolveGate) => {
      releaseHolder = resolveGate;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolveLocked) => {
      signalLocked = resolveLocked;
    });

    const holding = (async () => {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [ADMIN_LIFECYCLE_LOCK_KEY],
      );
      signalLocked();
      await holderGate;
      await holder.query("COMMIT");
      await holder.end();
    })();

    await locked;
    const pending = createUserRequest(app, auth.headers);
    const settledEarly = await Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>((resolveRace) => setTimeout(() => resolveRace(false), 800)),
    ]);
    expect(settledEarly).toBe(false);

    releaseHolder();
    await holding;
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
  });
});

describe("literal email identity across login and guard (QA)", () => {
  it("never authenticates a wildcard lookalike account at login", async () => {
    const victim = await makeUser(prisma, "OFTALMOLOGO", {
      email: "literalAx@clearsight.test",
      passwordHash: actorPasswordHash,
    });

    const wrongUser = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: "literal_x@clearsight.test", password: PASSWORD },
    });
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongUser.body).not.toContain("literalAx");
    expect(await prisma.userSession.count()).toBe(0);

    const control = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: "literalAx@clearsight.test", password: PASSWORD },
    });
    expect(control.statusCode).toBe(200);
    expect(control.json().user.id).toBe(victim.id);
    expect(control.json().user.email).toBe("literalAx@clearsight.test");
    expect(await prisma.userSession.count()).toBe(1);
  });

  it("never counts failures against a wildcard lookalike account in the login guard", async () => {
    const victim = await makeUser(prisma, "OFTALMOLOGO", {
      email: "literalAx@clearsight.test",
      passwordHash: actorPasswordHash,
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await app.inject({
        method: "POST",
        url: "/auth/login",
      headers: AUTH_ORIGIN,
        payload: { email: "literal_x@clearsight.test", password: "wrong-password-12345" },
      });
      statuses.push(failure.statusCode);
    }
    // HU01: the fifth consecutive failure locks the literal identifier only.
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();

    const control = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: AUTH_ORIGIN,
      payload: { email: "literalAx@clearsight.test", password: PASSWORD },
    });
    expect(control.statusCode).toBe(200);
  });

  it("bootstrap does not false-conflict on a wildcard lookalike address", async () => {
    const lookalike = await makeUser(prisma, "OFTALMOLOGO", {
      email: "literalAx@clearsight.test",
      passwordHash: "x",
    });

    const result = await bootstrapAdmin(prisma, {
      email: "literal_x@clearsight.test",
      fullName: "Wildcard Bootstrap",
      password: PASSWORD,
    });
    expect(result.role).toBe("ADMIN");

    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      select: { email: true, role: true },
    });
    expect(users).toEqual([
      { email: "literalAx@clearsight.test", role: "OFTALMOLOGO" },
      { email: "literal_x@clearsight.test", role: "ADMIN" },
    ]);
    expect(await prisma.user.findUnique({ where: { id: lookalike.id } })).not.toBeNull();
    expect(await prisma.auditEvent.count()).toBe(1);
  });
});
