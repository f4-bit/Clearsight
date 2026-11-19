import { describe, expect, it } from "vitest";
import {
  assertProductionJwtSecret,
  KNOWN_DEV_JWT_SECRET,
  parseAccessTtl,
  parseVerifiedAccessTokenClaims,
} from "../../src/services/auth-policy.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const principal = {
  sub: USER_ID,
  role: "OFTALMOLOGO",
  sessionId: SESSION_ID,
  tokenVersion: 0,
} as const;

describe("access-token lifetime policy", () => {
  it("defaults to 900 seconds and accepts bounded values", () => {
    expect(parseAccessTtl(undefined)).toEqual({ seconds: 900, label: "15m" });
    expect(parseAccessTtl("14m")).toEqual({ seconds: 840, label: "14m" });
    expect(parseAccessTtl("900s")).toEqual({ seconds: 900, label: "900s" });
    expect(parseAccessTtl("1m")).toEqual({ seconds: 60, label: "1m" });
  });

  it.each(["8h", "1h", "901s", "0s", "0m", "-1m", "1ms", "15", "abc", ""])(
    "rejects an out-of-policy or ambiguous value: %s",
    (value) => {
      expect(() => parseAccessTtl(value)).toThrow(
        "JWT_EXPIRES_IN must be a positive duration of at most 900 seconds",
      );
    },
  );
});

describe("production JWT secret guard", () => {
  it("rejects the known development placeholder and short secrets in production", () => {
    for (const secret of [KNOWN_DEV_JWT_SECRET, "short"]) {
      let message = "";
      try {
        assertProductionJwtSecret(secret, "production");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(
        "JWT_SECRET must be a non-default value of at least 32 characters in production",
      );
      expect(message).not.toContain(secret);
    }
    expect(() => assertProductionJwtSecret("a".repeat(32), "production")).not.toThrow();
  });

  it.each([
    ["root example key", "replace-me-with-at-least-32-characters"],
    ["backend example key", "replace-me-with-at-least-32-characters-of-randomness"],
    ["whitespace-only value", " ".repeat(40)],
    ["padded short value", "  short-secret  "],
    ["padded known development key", `  ${KNOWN_DEV_JWT_SECRET}  `],
    ["Change-Me variant", "Change-Me-with-at-least-32-characters"],
    ["CHANGE-ME variant", "CHANGE-ME-with-at-least-32-characters"],
    ["Changeme variant", "Changeme-with-at-least-32-characters"],
    ["changeme variant", "changeme-with-at-least-32-characters"],
  ])("rejects public placeholder or blank-like production secret: %s", (_label, secret) => {
    let message = "";
    try {
      assertProductionJwtSecret(secret, "production");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "JWT_SECRET must be a non-default value of at least 32 characters in production",
    );
  });

  it("accepts a non-placeholder random-looking 32+ character secret", () => {
    expect(() =>
      assertProductionJwtSecret("N9f3k2Lm7Qp8Rt5Vx1Za4Bc6De0Fg2Hj", "production"),
    ).not.toThrow();
  });

  it("does not enforce production rules outside production", () => {
    expect(() => assertProductionJwtSecret(KNOWN_DEV_JWT_SECRET, "test")).not.toThrow();
    expect(() => assertProductionJwtSecret("short", "development")).not.toThrow();
    expect(() =>
      assertProductionJwtSecret("replace-me-with-at-least-32-characters", "test"),
    ).not.toThrow();
  });
});

describe("verified access-token claims", () => {
  it("accepts the four principal claims plus required temporal claims", () => {
    const now = 1_800_000_000;
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, iat: now, exp: now + 900 }, now, 900),
    ).toEqual(principal);
  });

  it("returns only the principal claims, stripping exp/iat", () => {
    const now = 1_800_000_000;
    const claims = parseVerifiedAccessTokenClaims(
      { ...principal, iat: now, exp: now + 60, extra: "ignored" },
      now,
      900,
    );
    expect(claims).toEqual(principal);
    expect(claims).not.toHaveProperty("iat");
    expect(claims).not.toHaveProperty("exp");
  });

  it.each([
    ["missing sessionId", { ...principal, sessionId: undefined }],
    ["missing tokenVersion", { ...principal, tokenVersion: undefined }],
    ["negative tokenVersion", { ...principal, tokenVersion: -1 }],
    ["non-uuid subject", { ...principal, sub: "not-a-uuid" }],
    ["unknown role", { ...principal, role: "DOCTOR" }],
  ])("rejects invalid principal claims: %s", (_label, value) => {
    const now = 1_800_000_000;
    expect(
      parseVerifiedAccessTokenClaims({ ...value, iat: now, exp: now + 900 }, now, 900),
    ).toBeNull();
  });

  it.each([
    ["missing exp", { iat: 1_800_000_000 }],
    ["string exp", { iat: 1_800_000_000, exp: "1800000900" }],
    ["fractional exp", { iat: 1_800_000_000, exp: 1_800_000_900.5 }],
    ["expired exp", { iat: 1_800_000_000, exp: 1_800_000_000 }],
    ["missing iat", { exp: 1_800_000_900 }],
    ["future iat", { iat: 1_800_001_000, exp: 1_800_001_900 }],
    ["lifetime over policy", { iat: 1_800_000_000, exp: 1_800_000_901 }],
    ["exp before iat", { iat: 1_800_000_900, exp: 1_800_000_800 }],
  ])("rejects invalid temporal claims: %s", (_label, temporal) => {
    const now = 1_800_000_000;
    expect(
      parseVerifiedAccessTokenClaims({ ...principal, ...temporal }, now, 900),
    ).toBeNull();
  });
});
