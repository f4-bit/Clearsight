import { describe, expect, it } from "vitest";
import { JwtPayload } from "../../src/schemas/auth.js";
import {
  assertProductionJwtSecret,
  parseAccessTtl,
  parseVerifiedAccessTokenClaims,
} from "../../src/services/auth-policy.js";

/**
 * Adversarial boundary suite for the access-token policy (pure, no store).
 * Complements tests/unit/auth-policy.test.ts with the hostile-input classes it
 * does not cover: zero/negative/NaN/Infinity/non-numeric temporal claims, JSON
 * NaN -> null round trips, integers beyond 2^53, clock-skew edges, duration
 * parsing corners and the production secret floor.
 */

const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  sub: USER_ID,
  role: "OFTALMOLOGO",
  sessionId: SESSION_ID,
  tokenVersion: 0,
} as const;

const NOW = 1_800_000_000;

describe("temporal claim garbage", () => {
  it.each([
    ["zero exp", { iat: NOW, exp: 0 }],
    ["zero iat", { iat: 0, exp: NOW + 500 }],
    ["negative exp", { iat: NOW, exp: -1 }],
    ["negative iat", { iat: -1, exp: NOW + 500 }],
    ["NaN exp", { iat: NOW, exp: NaN }],
    ["NaN iat", { iat: NaN, exp: NOW + 500 }],
    ["Infinity exp", { iat: NOW, exp: Infinity }],
    ["Infinity iat", { iat: Infinity, exp: NOW + 500 }],
    ["boolean exp", { iat: NOW, exp: true }],
    ["null exp", { iat: NOW, exp: null }],
    ["object exp", { iat: NOW, exp: { seconds: 900 } }],
    ["array exp", { iat: NOW, exp: [NOW + 500] }],
    ["string iat", { iat: `${NOW}`, exp: NOW + 500 }],
    ["huge exp beyond 2^53", { iat: NOW, exp: 2 ** 53 + 2 }],
    ["huge iat beyond 2^53", { iat: 2 ** 53, exp: 2 ** 53 + 900 }],
  ])("rejects %s", (_label, temporal) => {
    expect(parseVerifiedAccessTokenClaims({ ...principal, ...temporal }, NOW, 900)).toBeNull();
  });

  it("rejects the JSON NaN -> null round trip without reading any store", () => {
    // JSON.stringify turns NaN/Infinity into null; a decoded token can never
    // carry a real NaN, so the parser must reject the null it becomes.
    const roundTripped = JSON.parse(
      JSON.stringify({ ...principal, iat: NOW, exp: NaN, nbf: Infinity }),
    );
    expect(roundTripped.exp).toBeNull();
    expect(parseVerifiedAccessTokenClaims(roundTripped, NOW, 900)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "bearer-token"],
    ["number", 42],
    ["array", [principal]],
    ["empty object", {}],
  ])("rejects a non-conforming raw payload: %s", (_label, raw) => {
    expect(parseVerifiedAccessTokenClaims(raw, NOW, 900)).toBeNull();
  });
});

describe("clock skew boundary", () => {
  it("accepts iat exactly at the 5s skew and rejects 6s ahead", () => {
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, iat: NOW + 5, exp: NOW + 905 }, NOW, 900),
    ).toEqual(principal);
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, iat: NOW + 6, exp: NOW + 906 }, NOW, 900),
    ).toBeNull();
  });

  it("accepts a token whose lifetime equals the policy exactly", () => {
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, iat: NOW, exp: NOW + 900 }, NOW, 900),
    ).toEqual(principal);
  });
});

describe("tokenVersion integer safety", () => {
  it.each([
    ["2^53", 2 ** 53],
    ["2^53+2", 2 ** 53 + 2],
    ["1e300", 1e300],
    ["2.5", 2.5],
    ["NaN", NaN],
    ["-0.5", -0.5],
  ])("rejects tokenVersion %s (Zod 4 int = safe integer)", (_label, tokenVersion) => {
    expect(JwtPayload.safeParse({ ...principal, tokenVersion }).success).toBe(false);
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, tokenVersion, iat: NOW, exp: NOW + 900 }, NOW, 900),
    ).toBeNull();
  });

  it("accepts the maximum safe integer", () => {
    expect(JwtPayload.safeParse({ ...principal, tokenVersion: Number.MAX_SAFE_INTEGER }).success).toBe(
      true,
    );
  });
});

describe("access lifetime parsing corners", () => {
  it("trims surrounding whitespace before matching", () => {
    expect(parseAccessTtl(" 15m ")).toEqual({ seconds: 900, label: "15m" });
    expect(parseAccessTtl("\t900s\n")).toEqual({ seconds: 900, label: "900s" });
  });

  it.each(["1.5m", "1m30s", "15M", "1e3s", "0x10s", "  ", "m", "15 m", "900sm", "+15m"])(
    "rejects the ambiguous value %s",
    (value) => {
      expect(() => parseAccessTtl(value)).toThrow(
        "JWT_EXPIRES_IN must be a positive duration of at most 900 seconds",
      );
    },
  );

  it("accepts the exact upper bound and rejects one second above it", () => {
    expect(parseAccessTtl("900s").seconds).toBe(900);
    expect(parseAccessTtl("15m").seconds).toBe(900);
    expect(() => parseAccessTtl("901s")).toThrow(
      "JWT_EXPIRES_IN must be a positive duration of at most 900 seconds",
    );
    expect(() => parseAccessTtl("1h")).toThrow(
      "JWT_EXPIRES_IN must be a positive duration of at most 900 seconds",
    );
  });
});

describe("production secret floor", () => {
  it("rejects a secret one character below the 32-character floor", () => {
    const short = "a".repeat(31);
    let message = "";
    try {
      assertProductionJwtSecret(short, "production");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );
    expect(message).not.toContain(short);
  });

  it("accepts exactly 32 non-default characters", () => {
    expect(() => assertProductionJwtSecret("b".repeat(32), "production")).not.toThrow();
  });

  it("rejects the known development placeholder even though it is long enough", () => {
    // Guard against a length-only check replacing the placeholder comparison.
    const placeholder = "clearsight-dev-secret-change-in-prod-32chars!";
    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(() => assertProductionJwtSecret(placeholder, "production")).toThrow(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );
  });
});
