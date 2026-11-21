import { describe, expect, it } from "vitest";
import {
  generateRefreshToken,
  hashRefreshToken,
  isPlausibleRefreshToken,
  REFRESH_TOKEN_LENGTH,
} from "../../src/services/refresh-tokens.js";

describe("opaque refresh tokens", () => {
  it("generates 32-byte base64url tokens (43 chars) with CSPRNG entropy", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const token = generateRefreshToken();
      expect(token).toHaveLength(REFRESH_TOKEN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(64);
  });

  it("stores only a lowercase SHA-256 hex digest", () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashRefreshToken(token)).toBe(hash);
  });

  it("rejects non-canonical token shapes before any lookup", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "short",
      "x".repeat(42),
      "x".repeat(44),
      `${"a".repeat(42)}!`,
      ` ${"a".repeat(43)}`,
    ]) {
      expect(isPlausibleRefreshToken(value)).toBe(false);
    }
    expect(isPlausibleRefreshToken(generateRefreshToken())).toBe(true);
  });
});
