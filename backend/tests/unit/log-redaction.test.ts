import { describe, expect, it } from "vitest";
import { AUTH_LOG_REDACT_PATHS } from "../../src/lib/log-redaction.js";

describe("credential log redaction", () => {
  it("redacts cookie, bearer, set-cookie and credential body fields", () => {
    const paths = new Set(AUTH_LOG_REDACT_PATHS);
    expect(paths.has("req.headers.authorization")).toBe(true);
    expect(paths.has("req.headers.cookie")).toBe(true);
    expect(paths.has('res.headers["set-cookie"]')).toBe(true);
    expect(paths.has("req.body.password")).toBe(true);
    expect(paths.has("req.body.refreshToken")).toBe(true);
  });
});
