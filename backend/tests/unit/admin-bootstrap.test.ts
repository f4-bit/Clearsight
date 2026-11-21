import { describe, expect, it } from "vitest";
import {
  ADMIN_LIFECYCLE_LOCK_KEY,
  BOOTSTRAP_BCRYPT_COST,
  BootstrapAdminError,
  bootstrapAdmin,
  safeBootstrapFailure,
  validateBootstrapAdminInput,
} from "../../src/services/admin-bootstrap.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

const VALID = {
  email: "  Admin@Example.TEST ",
  fullName: "  Bootstrap Admin  ",
  password: "synthetic-password-123",
};

describe("bootstrapAdmin input validation", () => {
  it("normalizes email and fullName without trimming the password", () => {
    const parsed = validateBootstrapAdminInput({ ...VALID, password: "  synthetic-password-123  " });
    expect(parsed.email).toBe("admin@example.test");
    expect(parsed.fullName).toBe("Bootstrap Admin");
    expect(parsed.password).toBe("  synthetic-password-123  ");
    expect(ADMIN_LIFECYCLE_LOCK_KEY).toBe("clearsight:admin-lifecycle:v1");
    expect(BOOTSTRAP_BCRYPT_COST).toBe(12);
  });

  it("rejects non-objects, missing fields and wrong types without echoing values", () => {
    for (const input of [null, undefined, [], "x", 3, {}, { ...VALID, email: 42 }, { ...VALID, fullName: null }, { ...VALID, password: 5 }]) {
      expect(() => validateBootstrapAdminInput(input)).toThrow(BootstrapAdminError);
    }
    try {
      validateBootstrapAdminInput({ ...VALID, email: "canary-not-an-email" });
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapAdminError);
      expect((error as Error).message).not.toContain("canary-not-an-email");
    }
  });

  it("rejects empty or oversized full names", () => {
    expect(() => validateBootstrapAdminInput({ ...VALID, fullName: "   " })).toThrow(/fullName/);
    expect(() => validateBootstrapAdminInput({ ...VALID, fullName: "a".repeat(256) })).toThrow(/fullName/);
  });

  it("enforces 12 Unicode code points", () => {
    expect(() => validateBootstrapAdminInput({ ...VALID, password: "a".repeat(11) })).toThrow(/12 Unicode/);
    expect(validateBootstrapAdminInput({ ...VALID, password: "a".repeat(12) }).password).toBe("a".repeat(12));
    expect(validateBootstrapAdminInput({ ...VALID, password: "😀".repeat(12) }).password).toBe("😀".repeat(12));
  });

  it("rejects passwords over 72 UTF-8 bytes instead of truncating", () => {
    expect(() => validateBootstrapAdminInput({ ...VALID, password: "a".repeat(73) })).toThrow(/72 UTF-8 bytes/);
    expect(validateBootstrapAdminInput({ ...VALID, password: "a".repeat(72) }).password).toBe("a".repeat(72));
    expect(validateBootstrapAdminInput({ ...VALID, password: "😀".repeat(18) }).password).toBe("😀".repeat(18));
    expect(() => validateBootstrapAdminInput({ ...VALID, password: "😀".repeat(19) })).toThrow(/72 UTF-8 bytes/);
  });
});

describe("safeBootstrapFailure", () => {
  it("returns the stable code/message for known failures", () => {
    const failure = safeBootstrapFailure(
      new BootstrapAdminError("BOOTSTRAP_AUDIT_FAILED", "the bootstrap audit record could not be written"),
    );
    expect(failure).toEqual({
      code: "BOOTSTRAP_AUDIT_FAILED",
      message: "the bootstrap audit record could not be written",
    });
  });

  it("never forwards raw driver text or canaries", () => {
    const failure = safeBootstrapFailure(new Error("canary-password postgresql://user:secret@host/db"));
    expect(failure.code).toBe("BOOTSTRAP_UNEXPECTED");
    expect(failure.message).toBe("unexpected bootstrap failure");
    expect(JSON.stringify(failure)).not.toContain("canary-password");
    expect(JSON.stringify(failure)).not.toContain("postgresql://");
  });
});

describe("bootstrapAdmin control flow", () => {
  function fakeClient(tx: Record<string, unknown>) {
    return {
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    } as unknown as PrismaClient;
  }

  it("takes the lock, rejects an existing admin (active or inactive) and writes nothing", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      $queryRawUnsafe: async () => {
        calls.push("lock");
        return [{ locked: null }];
      },
      user: {
        findFirst: async () => {
          calls.push("find-admin");
          return { id: "11111111-1111-4111-8111-111111111111" };
        },
        create: async () => {
          calls.push("create");
          throw new Error("must not create");
        },
      },
      auditEvent: { create: async () => calls.push("audit") },
    });

    await expect(bootstrapAdmin(client, VALID)).rejects.toMatchObject({
      code: "BOOTSTRAP_ALREADY_INITIALIZED",
    });
    expect(calls).toEqual(["lock", "find-admin"]);
  });

  it("rejects a case-insensitive email conflict without promotion", async () => {
    const calls: string[] = [];
    let emailFilter: unknown;
    const client = fakeClient({
      $queryRawUnsafe: async () => [{ locked: null }],
      user: {
        findFirst: async (args: { where: { role?: string; email?: unknown } }) => {
          if (args.where.role === "ADMIN") {
            calls.push("find-admin");
            return null;
          }
          calls.push("find-email");
          emailFilter = args.where.email;
          return { id: "22222222-2222-4222-8222-222222222222" };
        },
        create: async () => {
          calls.push("create");
          throw new Error("must not create");
        },
      },
      auditEvent: { create: async () => calls.push("audit") },
    });

    await expect(bootstrapAdmin(client, VALID)).rejects.toMatchObject({
      code: "BOOTSTRAP_EMAIL_CONFLICT",
    });
    expect(calls).toEqual(["find-admin", "find-email"]);
    expect(emailFilter).toEqual({ equals: "admin@example.test", mode: "insensitive" });
  });

  it("creates one active ADMIN with a fixed SYSTEM audit in the same transaction", async () => {
    const calls: string[] = [];
    let createData: Record<string, unknown> | undefined;
    let auditData: Record<string, unknown> | undefined;
    const createdAt = new Date("2026-11-18T00:00:00.000Z");
    const client = fakeClient({
      $queryRawUnsafe: async () => {
        calls.push("lock");
        return [{ locked: null }];
      },
      user: {
        findFirst: async (args: { where: { role?: string } }) => {
          calls.push(args.where.role === "ADMIN" ? "find-admin" : "find-email");
          return null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          calls.push("create");
          createData = args.data;
          return { id: "33333333-3333-4333-8333-333333333333", role: "ADMIN", createdAt };
        },
      },
      auditEvent: {
        create: async (args: { data: Record<string, unknown> }) => {
          calls.push("audit");
          auditData = args.data;
          return {};
        },
      },
    });

    const result = await bootstrapAdmin(client, VALID);
    expect(result).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      role: "ADMIN",
      createdAt,
    });
    expect(calls).toEqual(["lock", "find-admin", "find-email", "create", "audit"]);
    expect(createData).toMatchObject({
      email: "admin@example.test",
      fullName: "Bootstrap Admin",
      role: "ADMIN",
      isActive: true,
    });
    expect(createData).not.toHaveProperty("password");
    expect(auditData).toEqual({
      actorKind: "SYSTEM",
      actorUserId: null,
      targetType: "USER",
      targetUserId: "33333333-3333-4333-8333-333333333333",
      targetId: null,
      action: "ADMIN_BOOTSTRAP",
      outcome: "SUCCESS",
      metadata: { channel: "bootstrap-cli" },
    });
  });

  it("propagates a safe audit failure after the user insert", async () => {
    const client = fakeClient({
      $queryRawUnsafe: async () => [{ locked: null }],
      user: {
        findFirst: async () => null,
        create: async () => ({
          id: "44444444-4444-4444-8444-444444444444",
          role: "ADMIN",
          createdAt: new Date(),
        }),
      },
      auditEvent: {
        create: async () => {
          throw new Error("canary raw audit failure");
        },
      },
    });

    await expect(bootstrapAdmin(client, VALID)).rejects.toMatchObject({
      code: "BOOTSTRAP_AUDIT_FAILED",
      message: "the bootstrap audit record could not be written",
    });
  });
});
