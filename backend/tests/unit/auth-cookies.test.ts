import { describe, expect, it } from "vitest";
import {
  readRefreshCookie,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  serializeRefreshCookie,
  serializeRefreshCookieClear,
} from "../../src/services/auth-cookies.js";
import { generateRefreshToken } from "../../src/services/refresh-tokens.js";

describe("refresh cookie serialization", () => {
  it("sets the fixed name, path, security attributes and bounded expiry", () => {
    const token = generateRefreshToken();
    const cookie = serializeRefreshCookie(token, 3600);

    expect(cookie.startsWith(`${REFRESH_COOKIE_NAME}=${token};`)).toBe(true);
    expect(cookie).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain("Domain=");
  });

  it("clears the cookie with the same path and attributes", () => {
    const cookie = serializeRefreshCookieClear();

    expect(cookie.startsWith(`${REFRESH_COOKIE_NAME}=;`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
  });

  it("clamps a non-finite or negative max-age to zero", () => {
    const token = generateRefreshToken();
    expect(serializeRefreshCookie(token, -5)).toContain("Max-Age=0");
    expect(serializeRefreshCookie(token, Number.NaN)).toContain("Max-Age=0");
  });
});

describe("refresh cookie parsing", () => {
  it("reads exactly one well-formed cookie", () => {
    const token = generateRefreshToken();
    expect(readRefreshCookie({ cookie: `${REFRESH_COOKIE_NAME}=${token}` })).toBe(token);
    expect(
      readRefreshCookie({
        cookie: `theme=dark; ${REFRESH_COOKIE_NAME}=${token}; other=1`,
      }),
    ).toBe(token);
  });

  it("rejects a missing cookie", () => {
    expect(readRefreshCookie({})).toBeNull();
    expect(readRefreshCookie({ cookie: "" })).toBeNull();
    expect(readRefreshCookie({ cookie: "theme=dark" })).toBeNull();
  });

  it("rejects repeated cookies instead of choosing one", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(
      readRefreshCookie({
        cookie: `${REFRESH_COOKIE_NAME}=${a}; ${REFRESH_COOKIE_NAME}=${b}`,
      }),
    ).toBeNull();
    // Even a duplicated identical value is ambiguous and rejected.
    expect(
      readRefreshCookie({
        cookie: `${REFRESH_COOKIE_NAME}=${a}; ${REFRESH_COOKIE_NAME}=${a}`,
      }),
    ).toBeNull();
  });

  it("rejects empty, quoted, non-base64url and wrong-length values", () => {
    for (const value of [
      "",
      `"${generateRefreshToken()}"`,
      "short",
      "x".repeat(42),
      "x".repeat(44),
      "a".repeat(42) + "!",
    ]) {
      expect(readRefreshCookie({ cookie: `${REFRESH_COOKIE_NAME}=${value}` })).toBeNull();
    }
  });

  it("rejects array-valued cookie headers as ambiguous", () => {
    expect(
      readRefreshCookie({ cookie: [`${REFRESH_COOKIE_NAME}=${generateRefreshToken()}`] }),
    ).toBeNull();
  });
});
