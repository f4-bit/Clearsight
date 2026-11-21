import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  adminUpdateUserRequestSchema,
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
} from "../../src/schemas/auth.js";
import {
  AdminUsersError,
  createAdminUsersService,
  type AdminUsersErrorCode,
} from "../../src/services/admin-users.js";

const ACTOR = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "ADMIN" as const,
  sessionId: "22222222-2222-4222-8222-222222222222",
  tokenVersion: 0,
};

const USER_ID = "33333333-3333-4333-8333-333333333333";

function unusableClient(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get() {
      throw new Error("database must not be touched before validation");
    },
  });
}

describe("adminUpdateUserRequestSchema", () => {
  it("accepts the supported fields alone and normalizes email/fullName", () => {
    expect(
      adminUpdateUserRequestSchema.parse({ email: "  New@Example.TEST " }),
    ).toEqual({ email: "new@example.test" });
    expect(adminUpdateUserRequestSchema.parse({ fullName: "  New Name  " })).toEqual({
      fullName: "New Name",
    });
    expect(adminUpdateUserRequestSchema.parse({ role: "INVESTIGADOR" })).toEqual({
      role: "INVESTIGADOR",
    });
    expect(adminUpdateUserRequestSchema.parse({ isActive: false })).toEqual({
      isActive: false,
    });
  });

  it("rejects credential, actor, counter and grant mass assignment fields", () => {
    for (const extra of [
      { password: "synthetic-password-123" },
      { passwordHash: "canary-hash" },
      { tokenVersion: 7 },
      { failedLoginCount: 3 },
      { lockedUntil: new Date().toISOString() },
      { actorUserId: ACTOR.userId },
      { actorSessionId: ACTOR.sessionId },
      { grants: ["clinical-dataset"] },
    ]) {
      expect(adminUpdateUserRequestSchema.safeParse(extra).success, Object.keys(extra)[0]).toBe(
        false,
      );
    }
  });

  it("rejects API-incompatible emails, invalid names and non-boolean activity", () => {
    for (const email of ["admin@localhost", "ÄÖÜ@example.test", "plain", "a@b"]) {
      expect(adminUpdateUserRequestSchema.safeParse({ email }).success, email).toBe(false);
    }
    expect(adminUpdateUserRequestSchema.safeParse({ fullName: "   " }).success).toBe(false);
    expect(
      adminUpdateUserRequestSchema.safeParse({ fullName: "a".repeat(256) }).success,
    ).toBe(false);
    expect(
      adminUpdateUserRequestSchema.safeParse({ isActive: "false" }).success,
    ).toBe(false);
    expect(adminUpdateUserRequestSchema.safeParse({ role: "DOCTOR" }).success).toBe(false);
  });

  it("allows an empty object at schema level; the service enforces at least one field", async () => {
    expect(adminUpdateUserRequestSchema.safeParse({}).success).toBe(true);
    const service = createAdminUsersService(unusableClient());
    await expect(service.updateUser(USER_ID, {}, ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
  });
});

describe("adminUserListQuerySchema", () => {
  it("applies default pagination and parses explicit bounds", () => {
    expect(adminUserListQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(adminUserListQuerySchema.parse({ limit: "1", offset: "0" })).toEqual({
      limit: 1,
      offset: 0,
    });
    expect(adminUserListQuerySchema.parse({ limit: "100", offset: "250" })).toEqual({
      limit: 100,
      offset: 250,
    });
  });

  it("rejects out-of-range pagination", () => {
    for (const query of [
      { limit: "0" },
      { limit: "101" },
      { limit: "1.5" },
      { offset: "-1" },
    ]) {
      expect(adminUserListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("parses isActive as literal true/false, never coercing 'false' to true", () => {
    expect(adminUserListQuerySchema.parse({ isActive: "true" }).isActive).toBe(true);
    expect(adminUserListQuerySchema.parse({ isActive: "false" }).isActive).toBe(false);
    for (const value of ["0", "1", "yes", ""]) {
      expect(adminUserListQuerySchema.safeParse({ isActive: value }).success, value).toBe(false);
    }
  });

  it("trims q, preserves literal LIKE metacharacters and enforces the 255 bound", () => {
    expect(adminUserListQuerySchema.parse({ q: "  literal_x  " }).q).toBe("literal_x");
    expect(adminUserListQuerySchema.parse({ q: "literal%value" }).q).toBe("literal%value");
    expect(adminUserListQuerySchema.parse({ q: "   " }).q).toBe("");
    expect(adminUserListQuerySchema.safeParse({ q: "a".repeat(256) }).success).toBe(false);
  });

  it("accepts role filters and rejects unknown query fields", () => {
    expect(adminUserListQuerySchema.parse({ role: "ADMIN" }).role).toBe("ADMIN");
    expect(adminUserListQuerySchema.safeParse({ role: "DOCTOR" }).success).toBe(false);
    expect(adminUserListQuerySchema.safeParse({ unexpected: "x" }).success).toBe(false);
  });
});

describe("adminUserIdParamsSchema", () => {
  it("accepts only UUID path parameters", () => {
    expect(adminUserIdParamsSchema.safeParse({ id: USER_ID }).success).toBe(true);
    for (const id of ["not-a-uuid", "1", "../users"]) {
      expect(adminUserIdParamsSchema.safeParse({ id }).success, id).toBe(false);
    }
  });
});

describe("lifecycle service validation before the database", () => {
  it("rejects invalid update/get/list inputs before touching the store", async () => {
    const service = createAdminUsersService(unusableClient());

    await expect(service.updateUser("not-a-uuid", { fullName: "Name" }, ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
    await expect(service.updateUser(USER_ID, { fullName: "Name" }, { ...ACTOR, tokenVersion: -1 })).rejects.toMatchObject({
      code: "ADMIN_ACCESS_DENIED",
    });
    await expect(service.getUser("not-a-uuid", ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
    await expect(service.getUser(USER_ID, { ...ACTOR, sessionId: "not-a-uuid" })).rejects.toMatchObject({
      code: "ADMIN_ACCESS_DENIED",
    });
    await expect(service.listUsers({ limit: "101" }, ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
    await expect(service.listUsers({}, { ...ACTOR, sessionId: "not-a-uuid" })).rejects.toMatchObject({
      code: "ADMIN_ACCESS_DENIED",
    });
  });

  it("rejects NaN and infinite pagination values before touching the store", async () => {
    for (const query of [
      { limit: "abc" },
      { limit: "NaN" },
      { limit: "Infinity" },
      { offset: "abc" },
      { offset: "1e999" },
    ]) {
      expect(adminUserListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
    // The unusable client proves rejection happens before any SQL is issued.
    const service = createAdminUsersService(unusableClient());
    await expect(service.listUsers({ limit: "abc" }, ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
    await expect(service.listUsers({ offset: "NaN" }, ACTOR)).rejects.toMatchObject({
      code: "ADMIN_INPUT_INVALID",
    });
  });

  it("uses constant safe messages for the new lifecycle errors", () => {
    const codes: AdminUsersErrorCode[] = [
      "ADMIN_TARGET_NOT_FOUND",
      "ADMIN_LAST_ACTIVE_ADMIN",
      "ADMIN_EMAIL_CONFLICT",
      "ADMIN_ACCESS_DENIED",
    ];
    for (const code of codes) {
      const error = new AdminUsersError(code);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("canary");
      expect(error.message).not.toContain("postgresql://");
      expect(error.message).not.toContain("@");
    }
  });
});

describe("QA adversarial schema boundaries", () => {
  it("parses isActive only as exact lowercase true/false literals", () => {
    for (const value of ["TRUE", "True", "FALSE", "False", "tRuE"]) {
      expect(adminUserListQuerySchema.safeParse({ isActive: value }).success, value).toBe(false);
    }
  });

  it("accepts boundary lengths at exactly 255 characters for q and fullName", () => {
    expect(adminUserListQuerySchema.parse({ q: "a".repeat(255) }).q).toHaveLength(255);
    expect(adminUpdateUserRequestSchema.parse({ fullName: "a".repeat(255) }).fullName).toHaveLength(
      255,
    );
    // Unicode code points are accepted up to the same bound.
    expect(
      adminUpdateUserRequestSchema.parse({ fullName: "\u00f1".repeat(255) }).fullName,
    ).toHaveLength(255);
  });

  it("rejects non-canonical email shapes in PATCH but keeps them readable elsewhere", () => {
    for (const email of ["user@localhost", "a..b@example.test", "user @example.test"]) {
      expect(adminUpdateUserRequestSchema.safeParse({ email }).success, email).toBe(false);
    }
  });
});
