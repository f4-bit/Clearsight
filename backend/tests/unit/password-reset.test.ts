import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/lib/prisma.js";
import {
  adminCreateUserRequestSchema,
  forgotPasswordRequestSchema,
  resetPasswordRequestSchema,
} from "../../src/schemas/auth.js";
import {
  createPasswordResetService,
  generatePasswordResetToken,
  hashPasswordResetToken,
  isPlausiblePasswordResetToken,
  PASSWORD_RESET_TOKEN_LENGTH,
  PASSWORD_RESET_TOKEN_TTL_MS,
  PasswordResetError,
} from "../../src/services/password-reset.js";
import {
  createDisabledPasswordResetDelivery,
  createMemoryPasswordResetDelivery,
  PasswordResetDeliveryError,
} from "../../src/services/password-reset-delivery.js";
import {
  PasswordRecoveryQuotaStoreError,
  type PasswordRecoveryQuotaGuard,
} from "../../src/services/password-recovery-quota.js";

const SECRET = "unit-password-reset-secret-at-least-32-bytes";
const EXPIRES_AT = new Date("2026-11-19T00:30:00.000Z");

function trapDb(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched in this unit case");
      },
    },
  ) as PrismaClient;
}

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

function trapGuard(): PasswordRecoveryQuotaGuard {
  const fail = () => {
    throw new Error("quota guard must not be touched for invalid input");
  };
  return {
    async reserveForgotIp() {
      return fail();
    },
    async reserveForgotEmail() {
      return fail();
    },
    async reserveResetIp() {
      return fail();
    },
  };
}

describe("password reset token primitive", () => {
  it("generates 32-byte base64url tokens, hashes lowercase SHA-256 and pins 30 minutes", () => {
    expect(PASSWORD_RESET_TOKEN_LENGTH).toBe(43);
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);

    const tokens = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const token = generatePasswordResetToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isPlausiblePasswordResetToken(token)).toBe(true);
      tokens.add(token);
    }
    expect(tokens.size).toBe(100);

    const token = generatePasswordResetToken();
    const hash = hashPasswordResetToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashPasswordResetToken(token)).toBe(hash);

    for (const invalid of ["", "short", "x".repeat(42), "x".repeat(44), null, 42]) {
      expect(isPlausiblePasswordResetToken(invalid)).toBe(false);
    }
  });
});

describe("shared password write policy", () => {
  it("keeps admin create and reset on the same 12-code-point / 72-byte contract", () => {
    const adminBase = {
      email: "policy@clearsight.test",
      fullName: "Policy User",
      role: "OFTALMOLOGO" as const,
    };
    const candidates = [
      "a".repeat(11),
      "a".repeat(12),
      "á".repeat(36),
      "á".repeat(37),
      "\u{1F600}".repeat(18),
      "\u{1F600}".repeat(19),
    ];

    for (const password of candidates) {
      const admin = adminCreateUserRequestSchema.safeParse({
        ...adminBase,
        password,
      }).success;
      const reset = resetPasswordRequestSchema.safeParse({
        token: "x".repeat(43),
        newPassword: password,
      }).success;
      expect(reset, JSON.stringify(password)).toBe(admin);
    }
  });

  it("rejects unknown fields and invalid transport values", () => {
    expect(
      forgotPasswordRequestSchema.safeParse({
        email: "  USER@Example.TEST ",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      forgotPasswordRequestSchema.safeParse({ email: "not-an-email" }).success,
    ).toBe(false);
    expect(
      resetPasswordRequestSchema.safeParse({
        token: "",
        newPassword: "valid-password-123",
      }).success,
    ).toBe(false);
    expect(
      resetPasswordRequestSchema.safeParse({
        token: "x".repeat(43),
        newPassword: "valid-password-123",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("password reset delivery ports", () => {
  it("keeps DISABLED inert and the memory sink local/test-only", async () => {
    const disabled = createDisabledPasswordResetDelivery();
    expect(disabled.mode).toBe("DISABLED");
    await expect(
      disabled.deliver({
        recipient: "user@example.test",
        rawToken: "x".repeat(43),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toBeInstanceOf(PasswordResetDeliveryError);

    const memory = createMemoryPasswordResetDelivery();
    expect(memory.mode).toBe("MEMORY");
    await memory.deliver({
      recipient: "user@example.test",
      rawToken: "x".repeat(43),
      expiresAt: EXPIRES_AT,
    });
    expect(memory.delivered).toEqual([
      {
        recipient: "user@example.test",
        rawToken: "x".repeat(43),
        expiresAt: EXPIRES_AT,
      },
    ]);

    memory.failNextDelivery();
    await expect(
      memory.deliver({
        recipient: "second@example.test",
        rawToken: "y".repeat(43),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toBeInstanceOf(PasswordResetDeliveryError);
    expect(memory.delivered).toHaveLength(1);

    const peer = createMemoryPasswordResetDelivery();
    expect(peer.delivered).toHaveLength(0);
    memory.clear();
    expect(memory.delivered).toHaveLength(0);
  });
});

describe("password reset service input/error boundaries", () => {
  it("does not touch the DB for DISABLED forgot after an allowed quota", async () => {
    const service = createPasswordResetService(trapDb(), {
      jwtSecret: SECRET,
      delivery: createDisabledPasswordResetDelivery(),
      quotaGuard: allowedGuard(),
    });

    await expect(
      service.forgot({ email: "user@example.test", clientIp: "203.0.113.1" }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid passwords before quota and invalid token shapes after it", async () => {
    const passwordService = createPasswordResetService(trapDb(), {
      jwtSecret: SECRET,
      delivery: createDisabledPasswordResetDelivery(),
      quotaGuard: trapGuard(),
    });

    await expect(
      passwordService.reset({
        token: "x".repeat(43),
        newPassword: "short",
        clientIp: "203.0.113.1",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID_INPUT" });

    // A well-formed body with an invalid token shape consumes the IP quota and
    // is rejected before any token lookup or KDF.
    const tokenService = createPasswordResetService(trapDb(), {
      jwtSecret: SECRET,
      delivery: createDisabledPasswordResetDelivery(),
      quotaGuard: allowedGuard(),
    });

    await expect(
      tokenService.reset({
        token: "not-a-valid-token",
        newPassword: "valid-password-123",
        clientIp: "203.0.113.1",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID_TOKEN" });
  });

  it("maps quota throttling and store failures to stable generic errors", async () => {
    const throttled = createPasswordResetService(trapDb(), {
      jwtSecret: SECRET,
      delivery: createDisabledPasswordResetDelivery(),
      quotaGuard: {
        async reserveForgotIp() {
          return { allowed: false, retryAfterSeconds: 7 };
        },
        async reserveForgotEmail() {
          return { allowed: true };
        },
        async reserveResetIp() {
          return { allowed: true };
        },
      },
    });

    await expect(
      throttled.forgot({ email: "user@example.test", clientIp: "203.0.113.1" }),
    ).rejects.toMatchObject({
      code: "PASSWORD_RESET_THROTTLED",
      retryAfterSeconds: 7,
    });

    const unavailable = createPasswordResetService(trapDb(), {
      jwtSecret: SECRET,
      delivery: createDisabledPasswordResetDelivery(),
      quotaGuard: {
        async reserveForgotIp() {
          throw new PasswordRecoveryQuotaStoreError();
        },
        async reserveForgotEmail() {
          return { allowed: true };
        },
        async reserveResetIp() {
          return { allowed: true };
        },
      },
    });

    let error: unknown;
    try {
      await unavailable.forgot({
        email: "user@example.test",
        clientIp: "203.0.113.1",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PasswordResetError);
    expect((error as PasswordResetError).code).toBe(
      "PASSWORD_RESET_STORE_UNAVAILABLE",
    );
    expect((error as Error).message).toBe(
      "Password recovery is temporarily unavailable",
    );
    expect((error as Error).message).not.toContain("203.0.113.1");
  });
});
