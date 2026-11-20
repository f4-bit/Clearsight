import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/lib/prisma.js";
import {
  computeLoginBucketHash,
  deriveLoginProtectionKey,
  LOGIN_BUCKET_KINDS,
  LOGIN_PROTECTION_PURPOSE,
} from "../../src/services/login-guard.js";
import {
  computePasswordRecoveryBucketHash,
  createPasswordRecoveryQuotaGuard,
  derivePasswordRecoveryKey,
  FORGOT_EMAIL_LIMIT,
  FORGOT_EMAIL_WINDOW_SECONDS,
  FORGOT_IP_LIMIT,
  FORGOT_IP_WINDOW_SECONDS,
  INTERNAL_RECOVERY_BUCKET,
  normalizeRecoveryEmail,
  normalizeRecoveryIp,
  PASSWORD_RECOVERY_HMAC_PURPOSE,
  PASSWORD_RECOVERY_QUOTA_KINDS,
  PasswordRecoveryQuotaInputError,
  PasswordRecoveryQuotaStoreError,
  RESET_IP_LIMIT,
  RESET_IP_WINDOW_SECONDS,
  transitionRecoveryWindow,
} from "../../src/services/password-recovery-quota.js";

const SECRET = "unit-password-recovery-secret-at-least-32-bytes";
const START = new Date("2026-11-19T00:00:00.000Z");

function trapDb(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched before input validation");
      },
    },
  ) as PrismaClient;
}

describe("password recovery quota constants", () => {
  it("pins the approved fixed windows and purpose-separated kinds", () => {
    expect(FORGOT_EMAIL_LIMIT).toBe(3);
    expect(FORGOT_EMAIL_WINDOW_SECONDS).toBe(3600);
    expect(FORGOT_IP_LIMIT).toBe(20);
    expect(FORGOT_IP_WINDOW_SECONDS).toBe(3600);
    expect(RESET_IP_LIMIT).toBe(20);
    expect(RESET_IP_WINDOW_SECONDS).toBe(900);
    expect(Object.values(PASSWORD_RECOVERY_QUOTA_KINDS).sort()).toEqual([
      "FORGOT_EMAIL",
      "FORGOT_IP",
      "RESET_IP",
    ]);
  });
});

describe("password recovery HMAC fingerprints", () => {
  it("derives a deterministic 32-byte purpose subkey and rejects short secrets", () => {
    const key = derivePasswordRecoveryKey(SECRET);
    expect(key).toHaveLength(32);
    expect(derivePasswordRecoveryKey(SECRET).equals(key)).toBe(true);
    expect(derivePasswordRecoveryKey(`${SECRET}-different`).equals(key)).toBe(false);

    for (const invalid of ["", "short", "x".repeat(31)]) {
      expect(() => derivePasswordRecoveryKey(invalid), JSON.stringify(invalid)).toThrow(
        /at least 32 bytes/,
      );
    }
    expect(() => derivePasswordRecoveryKey(undefined as unknown as string)).toThrow(
      /at least 32 bytes/,
    );
  });

  it("matches independent Python HMAC vectors for purpose, key and buckets", () => {
    // Vectors generated offline with Python hmac/hashlib over the public
    // synthetic secret below. They pin the separate purpose literal, the NUL
    // separator and the kind prefix independently of this implementation.
    const secret = "qa-password-recovery-key-32-bytes-example";
    const derivedHex = "5afd52d580b80f1fe71d2a1457e69131e9a0bd745e4915cc766401e3ce31f055";

    expect(PASSWORD_RECOVERY_HMAC_PURPOSE).toBe("clearsight:auth-password-recovery:v1");
    expect(derivePasswordRecoveryKey(secret).toString("hex")).toBe(derivedHex);

    const key = Buffer.from(derivedHex, "hex");
    expect(
      computePasswordRecoveryBucketHash(
        key,
        PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_EMAIL,
        "doctor@example.test",
      ),
    ).toBe("c243311ab003dde19107c781c3b352d84d84b10d94319bac0fdaf6fd2c5211b3");
    expect(
      computePasswordRecoveryBucketHash(
        key,
        PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_IP,
        "127.0.0.1",
      ),
    ).toBe("f26df1b0d986f9de58b81b6558f1c00a9a98072c0bfb65725e771f2418b8c878");
    expect(
      computePasswordRecoveryBucketHash(
        key,
        PASSWORD_RECOVERY_QUOTA_KINDS.RESET_IP,
        "127.0.0.1",
      ),
    ).toBe("c4ba4a6ec2e4e9608e63efe1e5dc50ce02cce9732ace3ba0d08c69a9a68ee692");
  });

  it("uses a purpose distinct from login protection and disjoint kinds", () => {
    const recoveryKey = derivePasswordRecoveryKey(SECRET);
    const loginKey = deriveLoginProtectionKey(SECRET);
    expect(PASSWORD_RECOVERY_HMAC_PURPOSE).not.toBe(LOGIN_PROTECTION_PURPOSE);

    const recoveryIp = computePasswordRecoveryBucketHash(
      recoveryKey,
      PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_IP,
      "127.0.0.1",
    );
    const loginIp = computeLoginBucketHash(loginKey, LOGIN_BUCKET_KINDS.IP, "127.0.0.1");
    expect(recoveryIp).not.toBe(loginIp);

    const forgotEmail = computePasswordRecoveryBucketHash(
      recoveryKey,
      PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_EMAIL,
      "same-value",
    );
    const resetIp = computePasswordRecoveryBucketHash(
      recoveryKey,
      PASSWORD_RECOVERY_QUOTA_KINDS.RESET_IP,
      "same-value",
    );
    expect(forgotEmail).not.toBe(resetIp);
  });

  it("emits lowercase 64-hex hashes with no raw identifier in the value", () => {
    const key = derivePasswordRecoveryKey(SECRET);
    const email = "  Doctor.One@Clinic.TEST  ";
    const normalized = normalizeRecoveryEmail(email);
    const hash = computePasswordRecoveryBucketHash(
      key,
      PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_EMAIL,
      normalized,
    );

    expect(normalized).toBe("doctor.one@clinic.test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("doctor");
    expect(hash).not.toContain("@");
  });
});

describe("recovery identifier normalization", () => {
  it("canonicalizes email case/trim so hashes cannot vary by case", () => {
    expect(normalizeRecoveryEmail("  Doctor.One@Clinic.TEST  ")).toBe(
      "doctor.one@clinic.test",
    );
    expect(normalizeRecoveryEmail("doctor.one@clinic.test")).toBe(
      "doctor.one@clinic.test",
    );

    for (const invalid of ["", "   ", "not-an-email", null, undefined, 42]) {
      expect(() => normalizeRecoveryEmail(invalid), JSON.stringify(invalid)).toThrow(
        PasswordRecoveryQuotaInputError,
      );
    }
  });

  it("accepts only literal socket IPs, maps missing metadata to INTERNAL and never parses XFF", () => {
    for (const missing of [null, undefined, "", "   "]) {
      expect(normalizeRecoveryIp(missing)).toBe(INTERNAL_RECOVERY_BUCKET);
    }
    expect(normalizeRecoveryIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeRecoveryIp("::FFFF:192.0.2.1")).toBe("::ffff:192.0.2.1");

    for (const invalid of [
      "example.com",
      "203.0.113.1, 10.0.0.1",
      "203.0.113.1 10.0.0.1",
      "not an ip",
      42,
    ]) {
      expect(() => normalizeRecoveryIp(invalid), JSON.stringify(invalid)).toThrow(
        PasswordRecoveryQuotaInputError,
      );
    }
  });
});

describe("fixed-window transitions", () => {
  it("allows exactly the limit and blocks the next attempt without incrementing", () => {
    let state = { attemptCount: 0, windowStartedAt: START };

    for (let index = 0; index < FORGOT_EMAIL_LIMIT; index += 1) {
      const decision = transitionRecoveryWindow(
        state,
        START,
        FORGOT_EMAIL_LIMIT,
        FORGOT_EMAIL_WINDOW_SECONDS,
      );
      expect(decision.allowed, `attempt ${index + 1}`).toBe(true);
      if (decision.allowed) {
        state = {
          attemptCount: decision.attemptCount,
          windowStartedAt: decision.windowStartedAt,
        };
      }
    }

    const blocked = transitionRecoveryWindow(
      state,
      START,
      FORGOT_EMAIL_LIMIT,
      FORGOT_EMAIL_WINDOW_SECONDS,
    );
    expect(blocked).toMatchObject({
      allowed: false,
      attemptCount: FORGOT_EMAIL_LIMIT,
      retryAfterSeconds: FORGOT_EMAIL_WINDOW_SECONDS,
    });
  });

  it("uses the exact boundary: one millisecond before blocks, the boundary resets", () => {
    const state = { attemptCount: FORGOT_EMAIL_LIMIT, windowStartedAt: START };

    const before = transitionRecoveryWindow(
      state,
      new Date(START.getTime() + FORGOT_EMAIL_WINDOW_SECONDS * 1000 - 1),
      FORGOT_EMAIL_LIMIT,
      FORGOT_EMAIL_WINDOW_SECONDS,
    );
    expect(before).toMatchObject({ allowed: false, retryAfterSeconds: 1 });

    const boundary = new Date(START.getTime() + FORGOT_EMAIL_WINDOW_SECONDS * 1000);
    const reset = transitionRecoveryWindow(
      state,
      boundary,
      FORGOT_EMAIL_LIMIT,
      FORGOT_EMAIL_WINDOW_SECONDS,
    );
    expect(reset).toEqual({
      allowed: true,
      attemptCount: 1,
      windowStartedAt: boundary,
    });
  });

  it("applies the reset-IP window independently", () => {
    let state = { attemptCount: 0, windowStartedAt: START };
    for (let index = 0; index < RESET_IP_LIMIT; index += 1) {
      const decision = transitionRecoveryWindow(
        state,
        START,
        RESET_IP_LIMIT,
        RESET_IP_WINDOW_SECONDS,
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        state = {
          attemptCount: decision.attemptCount,
          windowStartedAt: decision.windowStartedAt,
        };
      }
    }

    expect(
      transitionRecoveryWindow(state, START, RESET_IP_LIMIT, RESET_IP_WINDOW_SECONDS),
    ).toMatchObject({
      allowed: false,
      attemptCount: RESET_IP_LIMIT,
      retryAfterSeconds: RESET_IP_WINDOW_SECONDS,
    });
  });
});

describe("guard construction and generic failures", () => {
  it("constructs without touching the database and rejects invalid direct values cheaply", async () => {
    const guard = createPasswordRecoveryQuotaGuard(trapDb(), { jwtSecret: SECRET });

    await expect(guard.reserveForgotEmail("not-an-email")).rejects.toBeInstanceOf(
      PasswordRecoveryQuotaInputError,
    );
    await expect(guard.reserveForgotIp("not an ip")).rejects.toBeInstanceOf(
      PasswordRecoveryQuotaInputError,
    );
    await expect(guard.reserveResetIp("example.com")).rejects.toBeInstanceOf(
      PasswordRecoveryQuotaInputError,
    );
  });

  it("wraps store failures in a stable generic error without driver details", async () => {
    const canary = "postgresql://canary:canary-secret@canary-host/clearsight";
    const failingDb = {
      $transaction: async () => {
        throw new Error(canary);
      },
    } as unknown as PrismaClient;
    const guard = createPasswordRecoveryQuotaGuard(failingDb, { jwtSecret: SECRET });

    let error: unknown;
    try {
      await guard.reserveForgotIp("127.0.0.1");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PasswordRecoveryQuotaStoreError);
    expect((error as Error).message).toBe("password recovery quota store is unavailable");
    expect((error as Error).message).not.toContain(canary);
    expect((error as Error).message).not.toContain("canary");
  });
});
