import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  canonicalEmailSchema,
  canonicalizeEmail,
  escapeLiteralLike,
} from "../../src/lib/canonical-email.js";
import {
  adminCreateUserRequestSchema,
  loginRequestSchema,
} from "../../src/schemas/auth.js";
import {
  AdminUsersError,
  createAdminUsersService,
  type AdminUsersErrorCode,
} from "../../src/services/admin-users.js";

const VALID = {
  email: "admin-created@clearsight.test",
  password: "synthetic-password-123",
  fullName: "  Created User  ",
};

const ACTOR = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "ADMIN" as const,
  sessionId: "22222222-2222-4222-8222-222222222222",
  tokenVersion: 0,
};

function unusableClient(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get() {
      throw new Error("database must not be touched before validation");
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("canonical email contract", () => {
  it("matches the login DTO for compatible and incompatible addresses", () => {
    const addresses = [
      "admin@example.test",
      "  ADMIN@EXAMPLE.TEST  ",
      "user.name+tag@sub.example.test",
      "user_name@example.test",
      "admin@localhost",
      "ÄÖÜ@example.test",
      "plain",
      "a@b",
      "a b@example.test",
      "a".repeat(250) + "@x.yz",
      "a".repeat(251) + "@x.yz",
    ];

    for (const email of addresses) {
      const canonical = canonicalEmailSchema.safeParse(email).success;
      const login = loginRequestSchema.safeParse({ email, password: "synthetic-password-123" }).success;
      expect(login, email).toBe(canonical);
    }
  });

  it("normalizes trim/case and rejects values outside the shared format", () => {
    expect(canonicalizeEmail("  Admin@Example.TEST  ")).toBe("admin@example.test");
    expect(canonicalizeEmail("admin@localhost")).toBeNull();
    expect(canonicalizeEmail("ÄÖÜ@example.test")).toBeNull();
    expect(canonicalizeEmail(42)).toBeNull();
    expect(canonicalizeEmail(`${"a".repeat(251)}@x.yz`)).toBeNull();
  });

  it("escapes LIKE metacharacters without changing ordinary addresses", () => {
    expect(escapeLiteralLike("literal_x@example.test")).toBe("literal\\_x@example.test");
    expect(escapeLiteralLike("literal%@example.test")).toBe("literal\\%@example.test");
    expect(escapeLiteralLike("back\\slash@example.test")).toBe("back\\\\slash@example.test");
    expect(escapeLiteralLike("plain@example.test")).toBe("plain@example.test");
  });
});

describe("adminCreateUserRequestSchema", () => {
  it("defaults to OFTALMOLOGO, trims fullName and normalizes email", () => {
    const parsed = adminCreateUserRequestSchema.parse({
      ...VALID,
      email: "  ADMIN-CREATED@EXAMPLE.TEST  ",
    });
    expect(parsed).toEqual({
      email: "admin-created@example.test",
      password: VALID.password,
      fullName: "Created User",
      role: "OFTALMOLOGO",
    });
  });

  it("accepts the three canonical roles and rejects any other role", () => {
    for (const role of ["OFTALMOLOGO", "INVESTIGADOR", "ADMIN"] as const) {
      expect(adminCreateUserRequestSchema.safeParse({ ...VALID, role }).success).toBe(true);
    }
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, role: "DOCTOR" }).success).toBe(false);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, role: "RESEARCHER" }).success).toBe(false);
  });

  it("rejects mass-assignment fields instead of silently dropping them", () => {
    for (const extra of [
      { actorUserId: ACTOR.userId },
      { actorSessionId: ACTOR.sessionId },
      { isActive: false },
      { passwordHash: "canary-hash" },
      { tokenVersion: 99 },
      { failedLoginCount: 9 },
      { lockedUntil: new Date().toISOString() },
    ]) {
      expect(adminCreateUserRequestSchema.safeParse({ ...VALID, ...extra }).success, Object.keys(extra)[0]).toBe(
        false,
      );
    }
  });

  it("enforces 12 Unicode code points and the 72 UTF-8 byte bound", () => {
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "a".repeat(11) }).success).toBe(false);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "a".repeat(12) }).success).toBe(true);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "é".repeat(36) }).success).toBe(true);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "é".repeat(37) }).success).toBe(false);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "a".repeat(73) }).success).toBe(false);
  });

  it("rejects API-incompatible emails and empty full names", () => {
    for (const email of ["admin@localhost", "ÄÖÜ@example.test", "plain"]) {
      expect(adminCreateUserRequestSchema.safeParse({ ...VALID, email }).success, email).toBe(false);
    }
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, fullName: "   " }).success).toBe(false);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, fullName: "a".repeat(256) }).success).toBe(false);
  });

  it("rejects grant and assignment smuggling keys named in the contract", () => {
    for (const extra of [
      { grants: ["clinical:read"] },
      { datasetGrants: [] },
      { assignedRole: "ADMIN" },
    ]) {
      expect(
        adminCreateUserRequestSchema.safeParse({ ...VALID, ...extra }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });

  it("applies the 72 UTF-8 byte bound to astral code points", () => {
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "\u{1F600}".repeat(11) }).success).toBe(false);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "\u{1F600}".repeat(18) }).success).toBe(true);
    expect(adminCreateUserRequestSchema.safeParse({ ...VALID, password: "\u{1F600}".repeat(19) }).success).toBe(false);
  });
});

describe("admin users service validation and redaction", () => {
  it("rejects invalid input before hashing or touching the database", async () => {
    const hash = vi.spyOn(bcrypt, "hash");
    try {
      const service = createAdminUsersService(unusableClient());
      await expect(
        service.createUser({ ...VALID, email: "not-an-email" }, ACTOR),
      ).rejects.toMatchObject({ code: "ADMIN_INPUT_INVALID" });
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it("rejects an untrusted actor shape before hashing or touching the database", async () => {
    const hash = vi.spyOn(bcrypt, "hash");
    try {
      const service = createAdminUsersService(unusableClient());
      await expect(
        service.createUser(VALID, { ...ACTOR, tokenVersion: -1 }),
      ).rejects.toMatchObject({ code: "ADMIN_ACCESS_DENIED" });
      await expect(
        service.createUser(VALID, { ...ACTOR, role: "ADMIN", userId: "not-a-uuid" }),
      ).rejects.toMatchObject({ code: "ADMIN_ACCESS_DENIED" });
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it("only emits constant messages and never echoes caller canaries", async () => {
    const service = createAdminUsersService(unusableClient());
    const canaryEmail = "canary-secret-email@clearsight.test";
    const canaryPassword = "canary-secret-password";
    let caught: unknown;

    try {
      await service.createUser(
        { ...VALID, email: canaryEmail, password: canaryPassword, isActive: false },
        ACTOR,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdminUsersError);
    expect((caught as AdminUsersError).code).toBe("ADMIN_INPUT_INVALID");
    expect(errorMessage(caught)).toBe("user input is invalid");
    expect(errorMessage(caught)).not.toContain(canaryEmail);
    expect(errorMessage(caught)).not.toContain(canaryPassword);
    expect(errorMessage(caught)).not.toContain("postgresql://");
  });

  it("uses constant messages for every error code", () => {
    const codes: AdminUsersErrorCode[] = [
      "ADMIN_INPUT_INVALID",
      "ADMIN_ACCESS_DENIED",
      "ADMIN_EMAIL_CONFLICT",
      "ADMIN_STORE_UNAVAILABLE",
      "ADMIN_AUDIT_FAILED",
    ];
    for (const code of codes) {
      const error = new AdminUsersError(code);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("canary");
      expect(error.message).not.toContain("postgresql://");
    }
  });

  it("fails construction on an invalid explicit database schema", () => {
    expect(() =>
      createAdminUsersService(unusableClient(), { databaseSchema: 'public"; DROP SCHEMA public; --' }),
    ).toThrow(/databaseSchema must be a valid PostgreSQL identifier/);
  });
});
