import { describe, expect, it } from "vitest";
import {
  assertPublicOriginForEnvironment,
  createWebAuthPolicy,
  INVALID_PUBLIC_ORIGIN_MESSAGE,
  parseAuthPublicOrigin,
  WebOriginError,
} from "../../src/services/web-auth-policy.js";

const ORIGIN = "https://app.clearsight.test";

function expectStatus(action: () => void, statusCode: 403 | 503): void {
  try {
    action();
    throw new Error("expected WebOriginError");
  } catch (error) {
    expect(error).toBeInstanceOf(WebOriginError);
    expect((error as WebOriginError).statusCode).toBe(statusCode);
  }
}

describe("AUTH_PUBLIC_ORIGIN parsing", () => {
  it("normalizes a plain https origin", () => {
    expect(parseAuthPublicOrigin("https://app.clearsight.test")).toBe(ORIGIN);
    expect(parseAuthPublicOrigin("https://APP.clearsight.test/")).toBe(ORIGIN);
    expect(parseAuthPublicOrigin("https://app.clearsight.test:443")).toBe(ORIGIN);
  });

  it("treats empty or missing as unconfigured", () => {
    expect(parseAuthPublicOrigin(undefined)).toBeNull();
    expect(parseAuthPublicOrigin("   ")).toBeNull();
  });

  it("rejects wildcard, credentials, paths, query, hash and non-http schemes", () => {
    for (const raw of [
      "*",
      "https://app.clearsight.test,https://evil.test",
      "https://user:pass@app.clearsight.test",
      "https://app.clearsight.test/api",
      "https://app.clearsight.test?x=1",
      "https://app.clearsight.test#fragment",
      "ftp://app.clearsight.test",
      "not a url",
    ]) {
      expect(() => parseAuthPublicOrigin(raw), raw).toThrow(
        INVALID_PUBLIC_ORIGIN_MESSAGE,
      );
    }
  });
});

describe("origin policy environment", () => {
  it("requires https in production", () => {
    expect(() =>
      assertPublicOriginForEnvironment("https://app.clearsight.test", "production"),
    ).not.toThrow();
    expect(() =>
      assertPublicOriginForEnvironment("http://localhost:8080", "production"),
    ).toThrow(/https in production/);
  });

  it("allows http only for an explicit non-production localhost origin", () => {
    for (const origin of [
      "http://localhost:8080",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(() => assertPublicOriginForEnvironment(origin, "test")).not.toThrow();
      expect(() => assertPublicOriginForEnvironment(origin, "development")).not.toThrow();
    }
    expect(() =>
      assertPublicOriginForEnvironment("http://app.clearsight.test", "test"),
    ).toThrow(/only for an explicit non-production localhost/);
  });
});

describe("web origin guard", () => {
  it("fails closed with 503 when the origin is not configured", () => {
    const policy = createWebAuthPolicy({ nodeEnv: "test" });
    expect(policy.configured).toBe(false);
    expectStatus(() => policy.assertRequiredOrigin({ origin: ORIGIN }), 503);
    expectStatus(() => policy.assertOptionalOrigin({ origin: ORIGIN }), 503);
    // Logout without an Origin can still rely on its Bearer authorization.
    expect(() => policy.assertOptionalOrigin({})).not.toThrow();
  });

  it("accepts only the exact configured origin", () => {
    const policy = createWebAuthPolicy({ publicOrigin: ORIGIN, nodeEnv: "test" });
    expect(policy.configured).toBe(true);
    expect(() => policy.assertRequiredOrigin({ origin: ORIGIN })).not.toThrow();
    expect(() => policy.assertRequiredOrigin({ origin: `${ORIGIN}/` })).not.toThrow();
    expect(() =>
      policy.assertRequiredOrigin({
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      }),
    ).not.toThrow();
  });

  it("rejects absent, null, mismatched, ambiguous and cross-site origins", () => {
    const policy = createWebAuthPolicy({ publicOrigin: ORIGIN, nodeEnv: "test" });
    expectStatus(() => policy.assertRequiredOrigin({}), 403);
    expectStatus(() => policy.assertRequiredOrigin({ origin: "null" }), 403);
    expectStatus(() => policy.assertRequiredOrigin({ origin: "https://evil.test" }), 403);
    expectStatus(
      () => policy.assertRequiredOrigin({ origin: `${ORIGIN},https://evil.test` }),
      403,
    );
    expectStatus(
      () => policy.assertRequiredOrigin({ origin: [ORIGIN] }),
      403,
    );
    expectStatus(
      () =>
        policy.assertRequiredOrigin({
          origin: ORIGIN,
          "sec-fetch-site": "cross-site",
        }),
      403,
    );
  });

  it("validates an optional origin only when it is present", () => {
    const policy = createWebAuthPolicy({ publicOrigin: ORIGIN, nodeEnv: "test" });
    expect(() => policy.assertOptionalOrigin({})).not.toThrow();
    expect(() => policy.assertOptionalOrigin({ origin: ORIGIN })).not.toThrow();
    expectStatus(() => policy.assertOptionalOrigin({ origin: "null" }), 403);
    expectStatus(() => policy.assertOptionalOrigin({ origin: "https://evil.test" }), 403);
  });

  it("aborts construction for an invalid configured origin", () => {
    expect(() =>
      createWebAuthPolicy({ publicOrigin: "*", nodeEnv: "test" }),
    ).toThrow(INVALID_PUBLIC_ORIGIN_MESSAGE);
    expect(() =>
      createWebAuthPolicy({
        publicOrigin: "http://app.clearsight.test",
        nodeEnv: "production",
      }),
    ).toThrow(/https in production/);
  });
});
