import { describe, expect, it } from "vitest";
import {
  assertProductionExportHmacSecret,
  KNOWN_DEV_EXPORT_HMAC_SECRET,
  MIN_EXPORT_HMAC_SECRET_LENGTH,
} from "../../src/services/export-policy.js";

/**
 * HMAC is pseudonymization, never anonymization: the production boundaries
 * (config, HTTP app, offline CLI) must fail closed on a known development
 * secret, a placeholder, or a short secret. Synthetic development keys stay
 * allowed outside production.
 */
describe("assertProductionExportHmacSecret", () => {
  const LONG_ENOUGH_SECRET = "q7Xk2Vb9pL4mN8rT1yW6zA3sD5fG0hJ2";

  it("rejects the known development secret in production", () => {
    expect(() =>
      assertProductionExportHmacSecret(KNOWN_DEV_EXPORT_HMAC_SECRET, "production"),
    ).toThrow(
      "EXPORT_HMAC_SECRET must be an explicit secret of at least 32 characters in production",
    );
  });

  it("rejects placeholder and short secrets in production", () => {
    for (const secret of [
      "replace-me-with-a-real-secret-of-32-chars",
      "change-in-prod-xxxxxxxxxxxxxxxxxxxxxxxx",
      "REPLACE_ME_xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "x".repeat(MIN_EXPORT_HMAC_SECRET_LENGTH - 1), // 31 chars
      "",
    ]) {
      expect(
        () => assertProductionExportHmacSecret(secret, "production"),
        secret,
      ).toThrow(/at least 32 characters in production/);
    }
    for (const nonString of [undefined, null, 42, { length: 64 }]) {
      expect(
        () => assertProductionExportHmacSecret(nonString, "production"),
        String(nonString),
      ).toThrow(/at least 32 characters in production/);
    }
  });

  it("accepts an explicit 32+ character secret in production", () => {
    expect(LONG_ENOUGH_SECRET.length).toBeGreaterThanOrEqual(MIN_EXPORT_HMAC_SECRET_LENGTH);
    expect(() => assertProductionExportHmacSecret(LONG_ENOUGH_SECRET, "production")).not.toThrow();
  });

  it("keeps synthetic development keys allowed outside production", () => {
    for (const nodeEnv of [undefined, "test", "development", "staging"]) {
      expect(() => assertProductionExportHmacSecret(KNOWN_DEV_EXPORT_HMAC_SECRET, nodeEnv)).not.toThrow();
      expect(() => assertProductionExportHmacSecret("short", nodeEnv)).not.toThrow();
    }
  });
});
