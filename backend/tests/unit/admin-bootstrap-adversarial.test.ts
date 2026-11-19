import { describe, expect, it } from "vitest";
import {
  ADMIN_LIFECYCLE_LOCK_KEY,
  BootstrapAdminError,
  bootstrapAdmin,
  validateBootstrapAdminInput,
} from "../../src/services/admin-bootstrap.js";
import { runBootstrapAdminCli } from "../../scripts/bootstrap-admin.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

/**
 * QA adversarial coverage for task 1.6 (inline contract):
 * hostile input shapes, verdict precedence, safe error constants and the
 * validate-before-network property of the CLI. The unit runner denies sockets,
 * so any connection attempt would surface as a different failure code.
 */

const VALID = {
  email: "qa-adversarial@clearsight.test",
  fullName: "QA Adversarial Admin",
  password: "synthetic-password-123",
};

function fakeClient(tx: Record<string, unknown>) {
  return {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
}

describe("validateBootstrapAdminInput hostile boundaries", () => {
  it("rejects every partial object missing exactly one required field", () => {
    const partials: unknown[] = [
      { email: VALID.email },
      { fullName: VALID.fullName },
      { password: VALID.password },
      { email: VALID.email, fullName: VALID.fullName },
      { email: VALID.email, password: VALID.password },
      { fullName: VALID.fullName, password: VALID.password },
    ];
    for (const input of partials) {
      expect(() => validateBootstrapAdminInput(input)).toThrow(BootstrapAdminError);
    }
  });

  it("rejects whitespace-only and structurally invalid emails without echoing them", () => {
    for (const email of ["   ", "\t\n", "plain", "a@", "@b", "a@b@c.d", "a b@c.d", "a\nb@c.d", "a@b c"]) {
      let message = "";
      try {
        validateBootstrapAdminInput({ ...VALID, email });
        expect.unreachable(`email ${JSON.stringify(email)} must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(BootstrapAdminError);
        expect((error as BootstrapAdminError).code).toBe("BOOTSTRAP_INPUT_INVALID");
        message = (error as Error).message;
      }
      expect(message).not.toContain(email);
    }
  });

  it("enforces the 255/256 email boundary after trim+lowercase normalization", () => {
    const at255 = `${"a".repeat(250)}@x.yz`;
    const at256 = `${"a".repeat(251)}@x.yz`;
    expect(at255).toHaveLength(255);
    expect(at256).toHaveLength(256);
    expect(validateBootstrapAdminInput({ ...VALID, email: at255 }).email).toBe(at255);
    expect(() => validateBootstrapAdminInput({ ...VALID, email: at256 })).toThrow(/255/);
    // Untrimmed input is bounded on the normalized value, not the raw string.
    expect(validateBootstrapAdminInput({ ...VALID, email: `  ${at255}  ` }).email).toBe(at255);
    expect(() => validateBootstrapAdminInput({ ...VALID, email: `  ${at256}  ` })).toThrow(/255/);
  });

  it("normalizes Unicode case in the email and trims Unicode whitespace in the full name", () => {
    const parsed = validateBootstrapAdminInput({
      email: "  ÄÖÜ@EXAMPLE.test ",
      fullName: "\u00a0 QA \u2028 Name \u00a0",
      password: VALID.password,
    });
    expect(parsed.email).toBe("äöü@example.test");
    expect(parsed.fullName).toBe("QA \u2028 Name");
  });

  it("drops untrusted extra fields instead of forwarding them to persistence", () => {
    const parsed = validateBootstrapAdminInput({
      ...VALID,
      role: "ADMIN",
      isAdmin: true,
      isActive: false,
      id: "99999999-9999-4999-8999-999999999999",
    });
    expect(parsed).toEqual({
      email: VALID.email,
      fullName: VALID.fullName,
      password: VALID.password,
    });
    expect(parsed).not.toHaveProperty("role");
    expect(parsed).not.toHaveProperty("isAdmin");
  });
});

describe("bootstrapAdmin adversarial control flow", () => {
  it("verdicts BOOTSTRAP_ALREADY_INITIALIZED before the email conflict when both apply", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      $queryRawUnsafe: async () => {
        calls.push("lock");
        return [{ locked: 1 }];
      },
      user: {
        findFirst: async (args: { where: { role?: string } }) => {
          calls.push(args.where.role === "ADMIN" ? "find-admin" : "find-email");
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

  it("ignores an untrusted role field and always creates an active ADMIN", async () => {
    let createData: Record<string, unknown> | undefined;
    const client = fakeClient({
      $queryRawUnsafe: async () => [{ locked: 1 }],
      user: {
        findFirst: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          createData = args.data;
          return { id: "33333333-3333-4333-8333-333333333333", role: "ADMIN", createdAt: new Date() };
        },
      },
      auditEvent: { create: async () => ({}) },
    });

    const result = await bootstrapAdmin(client, {
      ...VALID,
      role: "OFTALMOLOGO",
      isActive: false,
    });
    expect(result.role).toBe("ADMIN");
    expect(createData).toMatchObject({ role: "ADMIN", isActive: true });
    expect(createData).not.toHaveProperty("isActive", false);
  });

  it("maps unique violations to a constant conflict without echoing the driver detail", async () => {
    for (const code of ["P2002", "23505"]) {
      const client = fakeClient({
        $queryRawUnsafe: async () => [{ locked: 1 }],
        user: {
          findFirst: async () => null,
          create: async () => {
            const violation = new Error("canary-unique-detail for key (email)") as Error & {
              code?: string;
            };
            violation.code = code;
            throw violation;
          },
        },
        auditEvent: { create: async () => ({}) },
      });

      let caught: unknown;
      try {
        await bootstrapAdmin(client, VALID);
        expect.unreachable("unique violation must be rejected");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BootstrapAdminError);
      expect((caught as BootstrapAdminError).code).toBe("BOOTSTRAP_EMAIL_CONFLICT");
      expect((caught as Error).message).toBe("a user with this email already exists");
      expect((caught as Error).message).not.toContain("canary-unique-detail");
    }
  });

  it("wraps unknown database failures in a constant message with no raw driver text", async () => {
    const client = fakeClient({
      $queryRawUnsafe: async () => [{ locked: 1 }],
      user: {
        findFirst: async () => null,
        create: async () => {
          throw new Error("canary-raw-driver-error relation users does not exist");
        },
      },
      auditEvent: { create: async () => ({}) },
    });

    let caught: unknown;
    try {
      await bootstrapAdmin(client, VALID);
      expect.unreachable("database failure must be rejected");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BootstrapAdminError);
    expect((caught as BootstrapAdminError).code).toBe("BOOTSTRAP_DATABASE_FAILED");
    expect((caught as Error).message).toBe("the bootstrap transaction could not be completed");
    expect((caught as Error).message).not.toContain("canary-raw-driver-error");
  });

  it("pins ReadCommitted isolation and the parameterized advisory-lock acquisition", async () => {
    const rawCalls: Array<{ sql: string; params: unknown[] }> = [];
    let txOptions: unknown;
    const tx = {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        rawCalls.push({ sql, params });
        return [{ locked: 1 }];
      },
      user: {
        findFirst: async () => null,
        create: async () => ({
          id: "55555555-5555-4555-8555-555555555555",
          role: "ADMIN",
          createdAt: new Date("2026-11-18T00:00:00.000Z"),
        }),
      },
      auditEvent: { create: async () => ({}) },
    };
    const client = {
      $transaction: async (callback: (client: unknown) => Promise<unknown>, options?: unknown) => {
        txOptions = options;
        return callback(tx);
      },
    } as unknown as PrismaClient;

    const result = await bootstrapAdmin(client, VALID);
    expect(result.role).toBe("ADMIN");
    expect(txOptions).toEqual({ isolationLevel: "ReadCommitted" });

    expect(rawCalls).toHaveLength(1);
    const lock = rawCalls[0]!;
    // The void-returning lock needs a supported outer projection and must be
    // bound as a parameter, never interpolated into the SQL text.
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.sql).toContain("hashtextextended");
    expect(lock.sql).not.toContain(ADMIN_LIFECYCLE_LOCK_KEY);
    expect(lock.sql).not.toContain("clearsight:admin-lifecycle");
    expect(lock.params).toEqual([ADMIN_LIFECYCLE_LOCK_KEY]);
  });
});

describe("runBootstrapAdminCli validates before any connection", () => {
  function captureWriters() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      writers: {
        out: (line: string) => void out.push(line),
        err: (line: string) => void err.push(line),
      },
    };
  }

  it("fails closed with BOOTSTRAP_CONFIG_INVALID and prints nothing when the URL is missing", async () => {
    const capture = captureWriters();
    const code = await runBootstrapAdminCli(
      {
        BOOTSTRAP_ADMIN_EMAIL: VALID.email,
        BOOTSTRAP_ADMIN_FULL_NAME: VALID.fullName,
        BOOTSTRAP_ADMIN_PASSWORD: VALID.password,
      },
      capture.writers,
    );

    expect(code).toBe(1);
    expect(capture.out).toEqual([]);
    expect(capture.err).toHaveLength(1);
    expect(capture.err[0]).toContain("BOOTSTRAP_CONFIG_INVALID");
    expect(capture.err[0]).not.toContain(VALID.email);
    expect(capture.err[0]).not.toContain(VALID.password);
  });

  it("fails closed on a malformed URL without echoing the DSN canary", async () => {
    const capture = captureWriters();
    const canaryUrl = "postgresql://qa-user:canary-dsn-secret@db.internal:notaport/app";
    const code = await runBootstrapAdminCli(
      {
        MIGRATION_DATABASE_URL: canaryUrl,
        BOOTSTRAP_ADMIN_EMAIL: VALID.email,
        BOOTSTRAP_ADMIN_FULL_NAME: VALID.fullName,
        BOOTSTRAP_ADMIN_PASSWORD: VALID.password,
      },
      capture.writers,
    );

    expect(code).toBe(1);
    expect(capture.out).toEqual([]);
    expect(capture.err).toHaveLength(1);
    expect(capture.err[0]).toContain("BOOTSTRAP_CONFIG_INVALID");
    expect(capture.err[0]).not.toContain("canary-dsn-secret");
    expect(capture.err[0]).not.toContain("notaport");
    expect(capture.err[0]).not.toContain(canaryUrl);
  });

  it("rejects invalid input before constructing any client (no socket is opened)", async () => {
    const capture = captureWriters();
    // A syntactically valid owned URL: validation must fail before any connect.
    // The unit network guard turns any connect attempt into a thrown error,
    // which would surface as BOOTSTRAP_DATABASE_FAILED instead.
    const code = await runBootstrapAdminCli(
      {
        MIGRATION_DATABASE_URL: "postgresql://qa-user:qa-pass@127.0.0.1:5432/qa_owned",
        BOOTSTRAP_ADMIN_EMAIL: "canary-invalid-input@clearsight.test",
        BOOTSTRAP_ADMIN_FULL_NAME: "",
        BOOTSTRAP_ADMIN_PASSWORD: "canary-short",
      },
      capture.writers,
    );

    expect(code).toBe(1);
    expect(capture.out).toEqual([]);
    expect(capture.err).toHaveLength(1);
    expect(capture.err[0]).toContain("BOOTSTRAP_INPUT_INVALID");
    expect(capture.err[0]).not.toContain("canary-invalid-input");
    expect(capture.err[0]).not.toContain("canary-short");
    expect(capture.err[0]).not.toContain("qa-pass");
  });

  it("rejects a missing password even when every other value is valid", async () => {
    const capture = captureWriters();
    const code = await runBootstrapAdminCli(
      {
        MIGRATION_DATABASE_URL: "postgresql://qa-user:qa-pass@127.0.0.1:5432/qa_owned",
        BOOTSTRAP_ADMIN_EMAIL: VALID.email,
        BOOTSTRAP_ADMIN_FULL_NAME: VALID.fullName,
      },
      capture.writers,
    );

    expect(code).toBe(1);
    expect(capture.err).toHaveLength(1);
    expect(capture.err[0]).toContain("BOOTSTRAP_INPUT_INVALID");
    expect(capture.err[0]).toContain("password");
  });
});
