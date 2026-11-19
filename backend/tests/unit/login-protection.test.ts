import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  computeLoginBucketHash,
  createAuthLoginProtection,
  DEFAULT_IP_RATE_LIMIT,
  DEFAULT_IP_RATE_WINDOW_SECONDS,
  deriveLoginProtectionKey,
  FIXED_LOGIN_FAILURE_THRESHOLD,
  FIXED_LOGIN_LOCKOUT_MS,
  INTERNAL_CLIENT_BUCKET,
  LOGIN_BUCKET_KINDS,
  LOGIN_PROTECTION_PURPOSE,
  MAX_IP_RATE_LIMIT,
  MAX_IP_RATE_WINDOW_SECONDS,
  normalizeLoginIdentifier,
  normalizeLoginIp,
  transitionIdentifierFailure,
  transitionIpWindowAttempt,
} from "../../src/services/login-guard.js";

const SECRET = "unit-login-protection-secret-at-least-32-bytes";
const NOW = new Date("2026-11-19T00:00:00.000Z");

function trapDb(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched during construction");
      },
    },
  ) as PrismaClient;
}

describe("login protection HMAC fingerprints", () => {
  it("derives a deterministic 32-byte purpose subkey and rejects short secrets", () => {
    const key = deriveLoginProtectionKey(SECRET);
    expect(key).toHaveLength(32);
    expect(deriveLoginProtectionKey(SECRET).equals(key)).toBe(true);
    expect(deriveLoginProtectionKey(`${SECRET}-different`).equals(key)).toBe(false);

    for (const invalid of ["", "short", "x".repeat(31)]) {
      expect(() => deriveLoginProtectionKey(invalid), JSON.stringify(invalid)).toThrow(
        /requires a JWT secret of at least 32 bytes/,
      );
    }
    expect(() => deriveLoginProtectionKey(undefined as unknown as string)).toThrow(
      /requires a JWT secret of at least 32 bytes/,
    );
  });

  it("emits fixed lowercase 64-hex hashes that never equal the raw identifier", () => {
    const key = deriveLoginProtectionKey(SECRET);
    const email = "  Doctor.One@Clinic.TEST  ";
    const hash = computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, normalizeLoginIdentifier(email));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("doctor");
    expect(hash).not.toContain("@");
    expect(normalizeLoginIdentifier(email)).toBe("doctor.one@clinic.test");
    expect(
      computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, normalizeLoginIdentifier("doctor.one@clinic.test")),
    ).toBe(hash);
  });

  it("keeps kinds disjoint so an identifier hash cannot collide with an IP hash", () => {
    const key = deriveLoginProtectionKey(SECRET);
    const value = "same-value";
    const identifier = computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, value);
    const ip = computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, value);
    expect(identifier).not.toBe(ip);
  });

  it("matches independent Python HMAC vectors for purpose, derived key and buckets", () => {
    // Vectors generated offline by the architect with Python hmac/hashlib over
    // the public synthetic secret below; never a real credential or env value.
    // They pin the purpose literal, the NUL separator and the kind prefix
    // independently of this implementation. This test is intentionally not an
    // oracle built by calling the source derivation for the bucket vectors:
    // the key is reconstructed from the expected hex.
    const secret = "qa-login-protection-key-32-bytes-example";
    const derivedHex = "137c397e17ba150c4f45a844cbb7bce100358e93ce2b3a8b0699d08f2ba6940d";

    expect(LOGIN_PROTECTION_PURPOSE).toBe("clearsight:auth-login-protection:v1");
    expect(deriveLoginProtectionKey(secret).toString("hex")).toBe(derivedHex);

    const key = Buffer.from(derivedHex, "hex");
    expect(computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IDENTIFIER, "doctor@example.test")).toBe(
      "fd9b6bcbbda458860d2b19868674afa6bff54b56b8cce72dff5ed5f2bf35c1f3",
    );
    expect(computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, "127.0.0.1")).toBe(
      "b2376afa1ee3e67139873be95a691d9a72798f9cff8e2fab2fada5e58a470058",
    );
  });

  it("maps missing request metadata to the explicit INTERNAL quota bucket", () => {
    for (const missing of [null, undefined, "", "   "]) {
      expect(normalizeLoginIp(missing as string | null)).toBe(INTERNAL_CLIENT_BUCKET);
    }
    expect(normalizeLoginIp("203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("identifier lockout transition (HU01)", () => {
  const state = (failureCount: number, lockedUntil: Date | null = null) => ({
    failureCount,
    lockedUntil,
  });

  it("allows four failures, locks on the fifth for fifteen minutes", () => {
    expect(FIXED_LOGIN_FAILURE_THRESHOLD).toBe(5);
    expect(FIXED_LOGIN_LOCKOUT_MS).toBe(15 * 60 * 1000);

    for (let count = 0; count < 4; count += 1) {
      const next = transitionIdentifierFailure(state(count), NOW);
      expect(next.blocked, `failure ${count + 1}`).toBe(false);
      expect(next.failureCount).toBe(count + 1);
      expect(next.lockedUntil).toBeNull();
    }

    const fifth = transitionIdentifierFailure(state(4), NOW);
    expect(fifth.blocked).toBe(true);
    expect(fifth.failureCount).toBe(5);
    expect(fifth.lockedUntil?.getTime()).toBe(NOW.getTime() + FIXED_LOGIN_LOCKOUT_MS);
    expect(fifth.retryAfterSeconds).toBe(900);
  });

  it("never increments or extends while an active lockout is in force", () => {
    const lockedUntil = new Date(NOW.getTime() + 5 * 60 * 1000);
    const attempt = transitionIdentifierFailure(state(5, lockedUntil), NOW);
    expect(attempt).toMatchObject({ blocked: true, failureCount: 5, lockedUntil });
    expect(attempt.retryAfterSeconds).toBe(300);

    const later = transitionIdentifierFailure(
      state(5, lockedUntil),
      new Date(NOW.getTime() + 60 * 1000),
    );
    expect(later.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    expect(later.failureCount).toBe(5);
    expect(later.retryAfterSeconds).toBe(240);
  });

  it("permits a new attempt at the exact expiry boundary and restarts the count", () => {
    const expired = new Date(NOW.getTime());
    const next = transitionIdentifierFailure(state(5, expired), NOW);
    expect(next.blocked).toBe(false);
    expect(next.failureCount).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it("restarts after a stale count that already reached the threshold", () => {
    const next = transitionIdentifierFailure(state(9, null), NOW);
    expect(next.blocked).toBe(false);
    expect(next.failureCount).toBe(1);
  });
});

describe("complementary IP window transition", () => {
  const window = (attemptCount: number, windowStartedAt: Date | null = null) => ({
    attemptCount,
    windowStartedAt,
  });

  it("allows the configured attempts then blocks without extending the window", () => {
    const start = NOW;
    let attemptCount = 0;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const next = transitionIpWindowAttempt(window(attemptCount, start), NOW, 3, 60);
      expect(next.allowed, `attempt ${attempt}`).toBe(true);
      attemptCount = next.attemptCount;
      expect(next.windowStartedAt.getTime()).toBe(start.getTime());
    }

    const blocked = transitionIpWindowAttempt(window(3, start), NOW, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.attemptCount).toBe(3);
    expect(blocked.windowStartedAt.getTime()).toBe(start.getTime());
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("resets the window after it elapses instead of extending it", () => {
    const start = new Date(NOW.getTime() - 61_000);
    const next = transitionIpWindowAttempt(window(3, start), NOW, 3, 60);
    expect(next.allowed).toBe(true);
    expect(next.attemptCount).toBe(1);
    expect(next.windowStartedAt.getTime()).toBe(NOW.getTime());
  });

  it("counts blocked attempts without growing the stored count", () => {
    const start = NOW;
    const blocked = transitionIpWindowAttempt(window(100, start), NOW, 100, 60);
    const again = transitionIpWindowAttempt(window(100, start), new Date(NOW.getTime() + 1_000), 100, 60);
    expect(blocked.attemptCount).toBe(100);
    expect(again.attemptCount).toBe(100);
    expect(again.windowStartedAt.getTime()).toBe(start.getTime());
  });
});

describe("login protection configuration matrix", () => {
  const base = { jwtSecret: SECRET };

  it("constructs lazily with the documented defaults and trusted overrides", () => {
    expect(DEFAULT_IP_RATE_LIMIT).toBe(100);
    expect(DEFAULT_IP_RATE_WINDOW_SECONDS).toBe(60);
    expect(() => createAuthLoginProtection(trapDb(), base)).not.toThrow();
    expect(() =>
      createAuthLoginProtection(trapDb(), { ...base, ipRateLimit: 3, ipRateWindowSeconds: 5 }),
    ).not.toThrow();
    expect(() =>
      createAuthLoginProtection(trapDb(), { ...base, ipRateLimit: MAX_IP_RATE_LIMIT }),
    ).not.toThrow();
    expect(() =>
      createAuthLoginProtection(trapDb(), { ...base, ipRateWindowSeconds: MAX_IP_RATE_WINDOW_SECONDS }),
    ).not.toThrow();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["over the trusted bound", MAX_IP_RATE_LIMIT + 1],
  ])("rejects an invalid IP attempt limit: %s", (_label, ipRateLimit) => {
    expect(() => createAuthLoginProtection(trapDb(), { ...base, ipRateLimit })).toThrow(
      "ipRateLimit must be a positive integer within the trusted bound",
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["over the trusted bound", MAX_IP_RATE_WINDOW_SECONDS + 1],
  ])("rejects an invalid IP window: %s", (_label, ipRateWindowSeconds) => {
    expect(() => createAuthLoginProtection(trapDb(), { ...base, ipRateWindowSeconds })).toThrow(
      "ipRateWindowSeconds must be a positive integer within the trusted bound",
    );
  });

  it.each([
    ["empty", ""],
    ["blank", " "],
    ["leading digit", "1bad"],
    ["dash", "bad-name"],
    ["quote", 'bad"name'],
    ["semicolon", "bad;drop"],
    ["NUL", "bad\0name"],
    ["non-ASCII", "público"],
    ["over 63 bytes", "a".repeat(64)],
  ])("rejects an invalid database schema: %s", (_label, databaseSchema) => {
    expect(() => createAuthLoginProtection(trapDb(), { ...base, databaseSchema })).toThrow(
      "databaseSchema must be a valid PostgreSQL identifier",
    );
  });

  it("rejects secrets below the 32-byte entropy floor before any database work", () => {
    expect(() => createAuthLoginProtection(trapDb(), { jwtSecret: "too-short" })).toThrow(
      /requires a JWT secret of at least 32 bytes/,
    );
  });
});

describe("contract-pinned operational bounds", () => {
  it("pins the IP quota caps at ten thousand attempts and one day", () => {
    expect(MAX_IP_RATE_LIMIT).toBe(10_000);
    expect(MAX_IP_RATE_WINDOW_SECONDS).toBe(86_400);
  });

  it("pins the HU01 threshold and lockout window", () => {
    expect(FIXED_LOGIN_FAILURE_THRESHOLD).toBe(5);
    expect(FIXED_LOGIN_LOCKOUT_MS).toBe(15 * 60 * 1000);
    expect(INTERNAL_CLIENT_BUCKET).toBe("INTERNAL");
  });
});
