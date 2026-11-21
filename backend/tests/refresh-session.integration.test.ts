import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { REFRESH_COOKIE_NAME } from "../src/services/auth-cookies.js";
import { createAuthWebSessionService } from "../src/services/auth-web-session.js";
import { AuthSessionError } from "../src/services/session.js";
import {
  generateRefreshToken,
  hashRefreshToken,
} from "../src/services/refresh-tokens.js";
import { buildTestApp, TEST_AUTH_ORIGIN, TEST_ENV } from "./helpers/app.js";
import {
  createTestPrisma,
  hashPassword,
  makeSession,
  makeUser,
  resetDb,
} from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;
let passwordHash: string;

const PASSWORD = "synthetic-refresh-password-123";
const ORIGIN = TEST_AUTH_ORIGIN;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_SESSION = {
  error: "Unauthorized",
  message: "Invalid or expired session",
  statusCode: 401,
} as const;

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

function cookieHeader(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${token}`;
}

function login(target: FastifyInstance, email: string) {
  return target.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
}

function refresh(target: FastifyInstance, token: string, headers: Record<string, string> = {}) {
  return target.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { origin: ORIGIN, cookie: cookieHeader(token), ...headers },
  });
}

function refreshRawCookie(
  target: FastifyInstance,
  cookie: string,
  headers: Record<string, string> = {},
) {
  return target.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { origin: ORIGIN, cookie, ...headers },
  });
}

function logout(
  target: FastifyInstance,
  accessToken: string,
  headers: Record<string, string> = {},
) {
  return target.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { authorization: `Bearer ${accessToken}`, ...headers },
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

function claimsFromToken(target: FastifyInstance, token: string): Record<string, unknown> {
  const decoded = target.jwt.decode<Record<string, unknown>>(token);
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("token did not decode");
  }
  return decoded;
}

function trapPrisma(base: PrismaClient, onCall: () => void): PrismaClient {
  const trappedKeys = new Set([
    "user",
    "userSession",
    "refreshToken",
    "auditEvent",
    "$transaction",
    "$queryRawUnsafe",
    "$executeRawUnsafe",
  ]);

  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string" && trappedKeys.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            onCall();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (value !== null && typeof value === "object") {
          return new Proxy(value, {
            get(delegateTarget, delegateProperty, delegateReceiver) {
              const delegateValue = Reflect.get(
                delegateTarget,
                delegateProperty,
                delegateReceiver,
              ) as unknown;
              if (typeof delegateValue === "function") {
                return (...args: unknown[]) => {
                  onCall();
                  return (delegateValue as (...a: unknown[]) => unknown).apply(
                    delegateTarget,
                    args,
                  );
                };
              }
              return delegateValue;
            },
          });
        }
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;
}

function failingDelegateClient(
  base: PrismaClient,
  model: "refreshToken",
  operation: "findUnique",
  error: Error,
): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === model) {
        const delegate = target[model];
        return new Proxy(delegate, {
          get(delegateTarget, delegateProperty, delegateReceiver) {
            if (delegateProperty === operation) {
              return () => {
                throw error;
              };
            }
            const value = Reflect.get(
              delegateTarget,
              delegateProperty,
              delegateReceiver,
            );
            return typeof value === "function" ? value.bind(delegateTarget) : value;
          },
        });
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
                      const value = Reflect.get(
                        delegateTarget,
                        delegateProperty,
                        delegateReceiver,
                      );
                      return typeof value === "function"
                        ? value.bind(delegateTarget)
                        : value;
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

async function createUserWithRefreshToken() {
  const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
  const session = await makeSession(prisma, user);
  const raw = generateRefreshToken();
  const row = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      sessionId: session.id,
      parentTokenId: null,
      tokenHash: hashRefreshToken(raw),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
  });
  return { user, session, raw, row };
}

describe("5.8 login cookie", () => {
  it("keeps the current JSON and delivers the opaque refresh only in the cookie", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    const response = await login(app, user.email);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      "accessToken",
      "expiresIn",
      "tokenType",
      "user",
    ]);
    expect(body.user).toEqual({ id: user.id, email: user.email, role: user.role });
    expect(response.body).not.toContain("refreshToken");
    expect(response.headers["cache-control"]).toBe("no-store");

    const cookie = setCookieHeader(response);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain(`${REFRESH_COOKIE_NAME}=`);
    expect(cookie).toContain("Path=/api/auth");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");

    const raw = refreshTokenFromResponse(response);
    expect(raw).not.toBeNull();
    const stored = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(raw!) },
      include: { session: true },
    });
    const claims = claimsFromToken(app, body.accessToken);
    expect(stored.sessionId).toBe(claims.sessionId);
    expect(stored.userId).toBe(user.id);
    expect(stored.parentTokenId).toBeNull();
    expect(stored.expiresAt.getTime()).toBe(stored.session.expiresAt.getTime());
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(
      7 * DAY_MS,
    );
    expect(JSON.stringify(stored)).not.toContain(raw);

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "AUTH_SESSION_CREATED",
      targetId: claims.sessionId,
      metadata: { channel: "password" },
    });
    expect(JSON.stringify(audits)).not.toContain(raw);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: user.id, email: user.email, role: user.role });
  });

  it("sets no-store on credential validation rejections before the handler", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "not-an-email", password: "" },
    });
    expect([400, 422]).toContain(response.statusCode);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(setCookieHeader(response)).toBeNull();
  });

  it("rejects missing, null, mismatched or cross-site Origin before any store/KDF work", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    let calls = 0;
    const trappedApp = await buildApp({
      env: TEST_ENV,
      prisma: trapPrisma(prisma, () => {
        calls += 1;
      }),
    });
    await trappedApp.ready();

    try {
      const cases: Array<Record<string, string>> = [
        {},
        { origin: "null" },
        { origin: "https://evil.test" },
        { origin: ORIGIN, "sec-fetch-site": "cross-site" },
      ];

      for (const headers of cases) {
        const response = await trappedApp.inject({
          method: "POST",
          url: "/auth/login",
          headers,
          payload: { email: user.email, password: PASSWORD },
        });
        expect(response.statusCode, JSON.stringify(headers)).toBe(403);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(setCookieHeader(response)).toBeNull();
        expect(response.body).not.toContain("accessToken");
      }
      // The origin hook runs before body validation: even a malformed body
      // without an allowed origin is a 403 and never reaches the store.
      const invalidBody = await trappedApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "not-an-email" },
      });
      expect(invalidBody.statusCode).toBe(403);
      expect(calls).toBe(0);
    } finally {
      await trappedApp.close();
    }
  });

  it("fails closed for cookie endpoints when AUTH_PUBLIC_ORIGIN is absent", async () => {
    const noOriginApp = await buildApp({
      env: { ...TEST_ENV, AUTH_PUBLIC_ORIGIN: undefined },
      prisma,
    });
    await noOriginApp.ready();

    try {
      const loginResponse = await noOriginApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: ORIGIN },
        payload: { email: "any@clearsight.test", password: PASSWORD },
      });
      expect(loginResponse.statusCode).toBe(503);
      expect(loginResponse.headers["cache-control"]).toBe("no-store");

      const refreshResponse = await noOriginApp.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { origin: ORIGIN, cookie: cookieHeader(generateRefreshToken()) },
      });
      expect(refreshResponse.statusCode).toBe(503);

      // The retired register route stays 410 and never depends on the value.
      const registerResponse = await noOriginApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {},
      });
      expect(registerResponse.statusCode).toBe(410);

      // Logout without an Origin can still rely on Bearer; with an Origin the
      // missing configuration is a fail-closed 503 before authentication.
      const logoutWithOrigin = await noOriginApp.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { origin: ORIGIN },
      });
      expect(logoutWithOrigin.statusCode).toBe(503);
      const logoutWithoutOrigin = await noOriginApp.inject({
        method: "POST",
        url: "/auth/logout",
      });
      expect(logoutWithoutOrigin.statusCode).toBe(401);
    } finally {
      await noOriginApp.close();
    }
  });

  it("does not set the login cookie when auditing or signing fails", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    const auditApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await auditApp.ready();
    try {
      const auditResponse = await login(auditApp, user.email);
      expect(auditResponse.statusCode).toBe(503);
      expect(setCookieHeader(auditResponse)).toBeNull();
      expect(await prisma.userSession.count()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await auditApp.close();
    }

    const signingFailureApp = await buildApp({
      env: TEST_ENV,
      prisma,
      authService: {
        accessTtlSeconds: 900,
        accessTtlLabel: "15m",
        login: async () => {
          throw new AuthSessionError(
            "AUTH_TOKEN_ISSUE_FAILED",
            "Access token could not be issued",
          );
        },
        verifySession: async () => {
          throw new Error("unused");
        },
      },
    });
    await signingFailureApp.ready();
    try {
      const signingResponse = await login(signingFailureApp, user.email);
      expect(signingResponse.statusCode).toBe(503);
      expect(setCookieHeader(signingResponse)).toBeNull();
      expect(await prisma.userSession.count()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(0);
    } finally {
      await signingFailureApp.close();
    }
  });

  it("aborts startup for an invalid configured origin instead of falling back", async () => {
    await expect(
      buildApp({ env: { ...TEST_ENV, AUTH_PUBLIC_ORIGIN: "*" }, prisma }),
    ).rejects.toThrow(/AUTH_PUBLIC_ORIGIN/);
    await expect(
      buildApp({
        env: { ...TEST_ENV, AUTH_PUBLIC_ORIGIN: "http://app.clearsight.test" },
        prisma,
      }),
    ).rejects.toThrow(/localhost/);
  });
});

describe("5.8 refresh rotation and reuse", () => {
  it("rotates one successor, returns only access fields and revokes the family on reuse", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const access1 = loginResponse.json().accessToken as string;
    const cookie1 = refreshTokenFromResponse(loginResponse)!;

    const rotated = await refresh(app, cookie1);
    expect(rotated.statusCode).toBe(200);
    const body = rotated.json();
    expect(Object.keys(body).sort()).toEqual(["accessToken", "expiresIn", "tokenType"]);
    expect(rotated.body).not.toContain("refreshToken");
    expect(rotated.headers["cache-control"]).toBe("no-store");
    const cookie2 = refreshTokenFromResponse(rotated);
    expect(cookie2).not.toBeNull();
    expect(cookie2).not.toBe(cookie1);

    const parent = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie1) },
      include: { session: true },
    });
    const child = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie2!) },
    });
    expect(parent.consumedAt).not.toBeNull();
    expect(parent.revokedAt).toBeNull();
    expect(child.parentTokenId).toBe(parent.id);
    expect(child.sessionId).toBe(parent.sessionId);
    expect(child.revokedAt).toBeNull();
    expect(child.expiresAt.getTime()).toBeLessThanOrEqual(
      parent.session.expiresAt.getTime(),
    );
    expect(
      await prisma.refreshToken.count({ where: { parentTokenId: parent.id } }),
    ).toBe(1);

    const auditsAfterRotation = await prisma.auditEvent.findMany({
      orderBy: { occurredAt: "asc" },
    });
    expect(auditsAfterRotation.map((audit) => audit.action)).toContain(
      "AUTH_REFRESH_ROTATED",
    );
    expect(JSON.stringify(auditsAfterRotation)).not.toContain(cookie1);
    expect(JSON.stringify(auditsAfterRotation)).not.toContain(cookie2);

    const meWithRotated = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(meWithRotated.statusCode).toBe(200);

    const reused = await refresh(app, cookie1);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual(INVALID_SESSION);
    expect(reused.headers["cache-control"]).toBe("no-store");
    expect(setCookieHeader(reused)).toBeNull();

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: parent.sessionId },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({
        where: { sessionId: parent.sessionId, revokedAt: null },
      }),
    ).toBe(0);

    const auditsAfterReuse = await prisma.auditEvent.findMany({
      orderBy: { occurredAt: "asc" },
    });
    expect(auditsAfterReuse.map((audit) => audit.action)).toContain(
      "AUTH_REFRESH_REUSED",
    );
    const reuseAudit = auditsAfterReuse.find(
      (audit) => audit.action === "AUTH_REFRESH_REUSED",
    );
    expect(reuseAudit).toMatchObject({
      outcome: "DENIED",
      targetId: parent.sessionId,
      metadata: { channel: "refresh", reasonCode: "REFRESH_REUSE" },
    });
    expect(JSON.stringify(auditsAfterReuse)).not.toContain(cookie1);

    const meAfterReuse = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(meAfterReuse.statusCode).toBe(401);
  });

  it("allows exactly one successor when two requests race on the same token", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const cookie = refreshTokenFromResponse(loginResponse)!;

    const [first, second] = await Promise.all([refresh(app, cookie), refresh(app, cookie)]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    const parent = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie) },
      include: { session: true },
    });
    expect(parent.consumedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({ where: { parentTokenId: parent.id } }),
    ).toBe(1);
    expect(
      await prisma.refreshToken.count({ where: { sessionId: parent.sessionId } }),
    ).toBe(2);
    expect(
      await prisma.refreshToken.count({
        where: { sessionId: parent.sessionId, revokedAt: null },
      }),
    ).toBe(0);

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: parent.sessionId },
    });
    expect(session.revokedAt).not.toBeNull();

    const actions = (await prisma.auditEvent.findMany()).map((audit) => audit.action);
    expect(actions.filter((action) => action === "AUTH_REFRESH_ROTATED")).toHaveLength(1);
    expect(actions.filter((action) => action === "AUTH_REFRESH_REUSED")).toHaveLength(1);

    const winner = first.statusCode === 200 ? first : second;
    const access = winner.json().accessToken as string;
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("returns a generic 401 for malformed, unknown, expired, revoked, stale or inactive tokens", async () => {
    // Malformed and unknown tokens never touch the store.
    const malformed = await refreshRawCookie(app, `${REFRESH_COOKIE_NAME}=short`);
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toEqual(INVALID_SESSION);
    expect(setCookieHeader(malformed)).toBeNull();

    const unknown = await refresh(app, generateRefreshToken());
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(INVALID_SESSION);

    // Expired token and session.
    const expiredUser = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const createdAt = new Date(Date.now() - 8 * DAY_MS);
    const expiredAt = new Date(Date.now() - DAY_MS);
    const expiredSession = await makeSession(prisma, expiredUser, createdAt, {
      expiresAt: expiredAt,
    });
    const expiredRaw = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: expiredUser.id,
        sessionId: expiredSession.id,
        parentTokenId: null,
        tokenHash: hashRefreshToken(expiredRaw),
        createdAt,
        expiresAt: expiredAt,
      },
    });
    const expired = await refresh(app, expiredRaw);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual(INVALID_SESSION);
    expect(setCookieHeader(expired)).toBeNull();

    // Revoked session with an otherwise active token.
    const revokedToken = await createUserWithRefreshToken();
    await prisma.userSession.update({
      where: { id: revokedToken.session.id },
      data: { revokedAt: new Date(), reasonCode: "TEST_REVOKED" },
    });
    const revoked = await refresh(app, revokedToken.raw);
    expect(revoked.statusCode).toBe(401);
    expect(setCookieHeader(revoked)).toBeNull();

    // tokenVersion mismatch (role/password/deactivation bump).
    const stale = await createUserWithRefreshToken();
    await prisma.user.update({
      where: { id: stale.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    const staleResponse = await refresh(app, stale.raw);
    expect(staleResponse.statusCode).toBe(401);
    expect(setCookieHeader(staleResponse)).toBeNull();

    // Inactive user.
    const inactive = await createUserWithRefreshToken();
    await prisma.user.update({
      where: { id: inactive.user.id },
      data: { isActive: false },
    });
    const inactiveResponse = await refresh(app, inactive.raw);
    expect(inactiveResponse.statusCode).toBe(401);
    expect(setCookieHeader(inactiveResponse)).toBeNull();

    expect(
      await prisma.refreshToken.count({
        where: { userId: revokedToken.user.id, consumedAt: { not: null } },
      }),
    ).toBe(0);
  });

  it("fails closed with 503 when the refresh store read fails", async () => {
    const seeded = await createUserWithRefreshToken();
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: failingDelegateClient(
        prisma,
        "refreshToken",
        "findUnique",
        new Error(canary),
      ),
    });
    await failingApp.ready();

    try {
      const response = await refresh(failingApp, seeded.raw);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("canary");
      expect(response.body).not.toContain("postgresql");
      expect(setCookieHeader(response)).toBeNull();
      const parent = await prisma.refreshToken.findUniqueOrThrow({
        where: { id: seeded.row.id },
      });
      expect(parent.consumedAt).toBeNull();
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });

  it("does not consume the parent when signing fails", async () => {
    const seeded = await createUserWithRefreshToken();
    const service = createAuthWebSessionService(prisma, {
      accessTtl: { seconds: 900, label: "15m" },
    });

    await expect(
      service.refresh(seeded.raw, () => {
        throw new Error("signer canary");
      }),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_ISSUE_FAILED" });

    const parent = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: seeded.row.id },
    });
    expect(parent.consumedAt).toBeNull();
    expect(
      await prisma.refreshToken.count({ where: { parentTokenId: parent.id } }),
    ).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back and returns 503 when the refresh audit write fails", async () => {
    const seeded = await createUserWithRefreshToken();
    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await failingApp.ready();

    try {
      const response = await refresh(failingApp, seeded.raw);
      expect(response.statusCode).toBe(503);
      expect(setCookieHeader(response)).toBeNull();
      const parent = await prisma.refreshToken.findUniqueOrThrow({
        where: { id: seeded.row.id },
      });
      expect(parent.consumedAt).toBeNull();
      expect(
        await prisma.refreshToken.count({ where: { parentTokenId: parent.id } }),
      ).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });

  it("rolls back the reuse revocation and answers 503 when the reuse audit write fails", async () => {
    const seeded = await createUserWithRefreshToken();
    // Consume the parent on the healthy app so the next call is a reuse.
    const rotated = await refresh(app, seeded.raw);
    expect(rotated.statusCode).toBe(200);
    const childRaw = refreshTokenFromResponse(rotated);

    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await failingApp.ready();

    try {
      const reused = await refresh(failingApp, seeded.raw);
      expect(reused.statusCode).toBe(503);
      expect(setCookieHeader(reused)).toBeNull();

      // Revocation and its audit row are one transaction: both roll back.
      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: seeded.session.id },
      });
      expect(session.revokedAt).toBeNull();
      expect(
        await prisma.auditEvent.count({ where: { action: "AUTH_REFRESH_REUSED" } }),
      ).toBe(0);

      // The rotated child survives the rollback and still rotates.
      expect(childRaw).not.toBeNull();
      const survivor = await refresh(app, childRaw!);
      expect(survivor.statusCode).toBe(200);
    } finally {
      await failingApp.close();
    }
  });

  it("revokes only the reused session chain and leaves the user's other sessions active", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    // Session A: rotate once so the parent enters the reuse state.
    const loginA = await login(app, user.email);
    const accessA = loginA.json().accessToken as string;
    const cookieA = refreshTokenFromResponse(loginA)!;
    const claimsA = claimsFromToken(app, accessA);
    expect((await refresh(app, cookieA)).statusCode).toBe(200);

    // Session B: an independent, active session of the same user.
    const loginB = await login(app, user.email);
    const accessB = loginB.json().accessToken as string;
    const cookieB = refreshTokenFromResponse(loginB)!;
    const claimsB = claimsFromToken(app, accessB);

    const reused = await refresh(app, cookieA);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual(INVALID_SESSION);

    const sessionA = await prisma.userSession.findUniqueOrThrow({
      where: { id: claimsA.sessionId as string },
    });
    expect(sessionA.revokedAt).not.toBeNull();

    // The reuse revocation must not reach the user's other session.
    const sessionB = await prisma.userSession.findUniqueOrThrow({
      where: { id: claimsB.sessionId as string },
    });
    expect(sessionB.revokedAt).toBeNull();
    const rotatedB = await refresh(app, cookieB);
    expect(rotatedB.statusCode).toBe(200);
    const meB = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessB}` },
    });
    expect(meB.statusCode).toBe(200);
  });

  it("never authenticates refresh from a Bearer token or a body-carried secret", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const access = loginResponse.json().accessToken as string;
    const cookie = refreshTokenFromResponse(loginResponse)!;

    // A valid access Bearer without the cookie must not rotate anything.
    const bearerOnly = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { origin: ORIGIN, authorization: `Bearer ${access}` },
    });
    expect(bearerOnly.statusCode).toBe(401);
    expect(bearerOnly.json()).toEqual(INVALID_SESSION);
    expect(setCookieHeader(bearerOnly)).toBeNull();

    // A body-carried refresh secret is never used as a credential.
    const bodyOnly = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { origin: ORIGIN },
      payload: { refreshToken: cookie },
    });
    expect(bodyOnly.statusCode).toBe(401);
    expect(bodyOnly.json()).toEqual(INVALID_SESSION);
    expect(setCookieHeader(bodyOnly)).toBeNull();

    // Neither rejected request consumed the parent.
    const parent = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie) },
    });
    expect(parent.consumedAt).toBeNull();

    const rotated = await refresh(app, cookie);
    expect(rotated.statusCode).toBe(200);
  });
});

describe("5.8 logout", () => {
  it("revokes the session/family, audits, clears the cookie and requires Bearer", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const access = loginResponse.json().accessToken as string;
    const cookie = refreshTokenFromResponse(loginResponse)!;
    const claims = claimsFromToken(app, access);

    const cookieOnly = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader(cookie) },
    });
    expect(cookieOnly.statusCode).toBe(401);
    const stillActive = await prisma.userSession.findUniqueOrThrow({
      where: { id: claims.sessionId as string },
    });
    expect(stillActive.revokedAt).toBeNull();

    const mismatchOrigin = await logout(app, access, { origin: "https://evil.test" });
    expect(mismatchOrigin.statusCode).toBe(403);
    expect(mismatchOrigin.headers["cache-control"]).toBe("no-store");
    const afterMismatch = await prisma.userSession.findUniqueOrThrow({
      where: { id: claims.sessionId as string },
    });
    expect(afterMismatch.revokedAt).toBeNull();

    const response = await logout(app, access);
    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    const clearCookie = setCookieHeader(response);
    expect(clearCookie).not.toBeNull();
    expect(clearCookie).toContain(`${REFRESH_COOKIE_NAME}=;`);
    expect(clearCookie).toContain("Max-Age=0");
    expect(clearCookie).toContain("Path=/api/auth");

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: claims.sessionId as string },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({
        where: { sessionId: session.id, revokedAt: null },
      }),
    ).toBe(0);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "AUTH_LOGOUT" },
    });
    expect(audit).toMatchObject({
      outcome: "SUCCESS",
      targetId: session.id,
      metadata: { channel: "logout", reasonCode: "LOGOUT" },
    });
    expect(JSON.stringify(audit)).not.toContain(cookie);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(401);

    const secondLogout = await logout(app, access);
    expect(secondLogout.statusCode).toBe(401);

    const refreshAfterLogout = await refresh(app, cookie);
    expect(refreshAfterLogout.statusCode).toBe(401);
  });

  it("accepts a present matching Origin and still clears the cookie", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const access = loginResponse.json().accessToken as string;

    const response = await logout(app, access, { origin: ORIGIN });
    expect(response.statusCode).toBe(204);
    expect(setCookieHeader(response)).toContain("Max-Age=0");
  });

  it("rolls back and returns 503 when the logout audit write fails", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const session = await makeSession(prisma, user);
    const access = app.jwt.sign({
      sub: user.id,
      role: user.role,
      sessionId: session.id,
      tokenVersion: user.tokenVersion,
    });

    const failingApp = await buildApp({
      env: TEST_ENV,
      prisma: auditFailingClient(prisma),
    });
    await failingApp.ready();

    try {
      const response = await logout(failingApp, access);
      expect(response.statusCode).toBe(503);
      expect(setCookieHeader(response)).toBeNull();
      const after = await prisma.userSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(after.revokedAt).toBeNull();
      expect(await prisma.auditEvent.count()).toBe(0);
    } finally {
      await failingApp.close();
    }
  });
});

describe("5.8 account changes and races", () => {
  it("does not revive old refresh sessions after role change, deactivation or reactivation", async () => {
    const admin = await makeUser(prisma, "ADMIN", { passwordHash });
    const target = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    const adminLogin = await login(app, admin.email);
    expect(adminLogin.statusCode).toBe(200);
    const adminAccess = adminLogin.json().accessToken as string;

    const targetLogin = await login(app, target.email);
    expect(targetLogin.statusCode).toBe(200);
    const targetCookie = refreshTokenFromResponse(targetLogin)!;

    const adminHeaders = { authorization: `Bearer ${adminAccess}` };
    const roleChange = await app.inject({
      method: "PATCH",
      url: `/admin/users/${target.id}`,
      headers: adminHeaders,
      payload: { role: "ADMIN" },
    });
    expect(roleChange.statusCode).toBe(200);
    expect((await refresh(app, targetCookie)).statusCode).toBe(401);

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/admin/users/${target.id}`,
      headers: adminHeaders,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);
    expect((await refresh(app, targetCookie)).statusCode).toBe(401);

    const reactivate = await app.inject({
      method: "PATCH",
      url: `/admin/users/${target.id}`,
      headers: adminHeaders,
      payload: { isActive: true },
    });
    expect(reactivate.statusCode).toBe(200);
    expect((await refresh(app, targetCookie)).statusCode).toBe(401);

    const freshLogin = await login(app, target.email);
    expect(freshLogin.statusCode).toBe(200);
    const freshCookie = refreshTokenFromResponse(freshLogin)!;
    const freshRefresh = await refresh(app, freshCookie);
    expect(freshRefresh.statusCode).toBe(200);
  });

  it("survives a concurrent refresh and role change without deadlock or revived tokens", async () => {
    const admin = await makeUser(prisma, "ADMIN", { passwordHash });
    const target = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });

    const adminLogin = await login(app, admin.email);
    const targetLogin = await login(app, target.email);
    const targetAccess = targetLogin.json().accessToken as string;
    const targetCookie = refreshTokenFromResponse(targetLogin)!;
    const targetClaims = claimsFromToken(app, targetAccess);

    const [refreshed, changed] = await Promise.all([
      refresh(app, targetCookie),
      app.inject({
        method: "PATCH",
        url: `/admin/users/${target.id}`,
        headers: { authorization: `Bearer ${adminLogin.json().accessToken}` },
        payload: { role: "ADMIN" },
      }),
    ]);

    expect(changed.statusCode).toBe(200);
    expect([200, 401]).toContain(refreshed.statusCode);
    expect(refreshed.statusCode).not.toBe(500);

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: targetClaims.sessionId as string },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({
        where: { sessionId: session.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it("survives a concurrent refresh/logout without deadlock and leaves the session revoked", async () => {
    const user = await makeUser(prisma, "OFTALMOLOGO", { passwordHash });
    const loginResponse = await login(app, user.email);
    const access = loginResponse.json().accessToken as string;
    const cookie = refreshTokenFromResponse(loginResponse)!;
    const claims = claimsFromToken(app, access);

    const [refreshed, loggedOut] = await Promise.all([
      refresh(app, cookie),
      logout(app, access),
    ]);

    expect([200, 401]).toContain(refreshed.statusCode);
    expect([204, 401]).toContain(loggedOut.statusCode);
    expect(refreshed.statusCode).not.toBe(500);
    expect(loggedOut.statusCode).not.toBe(500);

    const session = await prisma.userSession.findUniqueOrThrow({
      where: { id: claims.sessionId as string },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({
        where: { sessionId: session.id, revokedAt: null },
      }),
    ).toBe(0);
  });
});
