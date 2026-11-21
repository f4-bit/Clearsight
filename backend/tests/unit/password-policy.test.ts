import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_BCRYPT_COST } from "../../src/services/admin-bootstrap.js";
import {
  PASSWORD_BCRYPT_COST,
  PASSWORD_DUMMY_CANARY,
  PASSWORD_DUMMY_HASH,
} from "../../src/services/password-policy.js";

describe("shared password policy", () => {
  it("uses cost 12 for every current writer alias", () => {
    expect(PASSWORD_BCRYPT_COST).toBe(12);
    expect(BOOTSTRAP_BCRYPT_COST).toBe(PASSWORD_BCRYPT_COST);
  });

  it("ships a fully valid precomputed dummy hash at the current cost", async () => {
    // getRounds proves the prefix; compare proves the full hash length/format.
    expect(bcrypt.getRounds(PASSWORD_DUMMY_HASH)).toBe(PASSWORD_BCRYPT_COST);
    await expect(bcrypt.compare(PASSWORD_DUMMY_CANARY, PASSWORD_DUMMY_HASH)).resolves.toBe(true);
    await expect(
      bcrypt.compare("clearsight-dummy-login-password-wrong", PASSWORD_DUMMY_HASH),
    ).resolves.toBe(false);
  });
});
