import { isPlausibleRefreshToken } from "./refresh-tokens.js";

/**
 * Browser refresh cookie (D19).
 *
 * The public contract is `/api/auth/*`; the backend itself runs behind a proxy
 * that strips `/api` and exposes `/auth/*` internally. The cookie is therefore
 * scoped to the public path, host-only (no Domain) and always Secure.
 *
 * The parser is intentionally strict: a missing, repeated, empty or malformed
 * `clearsight_refresh` cookie yields `null` instead of an ambiguous value.
 */
export const REFRESH_COOKIE_NAME = "clearsight_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REFRESH_COOKIE_SAME_SITE = "Lax";
const CLEAR_EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";

export interface CookieHeaderCarrier {
  readonly cookie?: string | string[] | undefined;
}

function cookieAttributes(): string {
  return `Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=${REFRESH_COOKIE_SAME_SITE}`;
}

function normalizedMaxAge(maxAgeSeconds: number): number {
  if (!Number.isFinite(maxAgeSeconds)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxAgeSeconds));
}

/** Serializes a successful refresh cookie. The value must never be logged. */
export function serializeRefreshCookie(token: string, maxAgeSeconds: number): string {
  const maxAge = normalizedMaxAge(maxAgeSeconds);
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return (
    `${REFRESH_COOKIE_NAME}=${token}; Max-Age=${maxAge}; Expires=${expires}; ` +
    cookieAttributes()
  );
}

/** Clears the cookie with exactly the same path/security attributes. */
export function serializeRefreshCookieClear(): string {
  return (
    `${REFRESH_COOKIE_NAME}=; Max-Age=0; Expires=${CLEAR_EXPIRES}; ` +
    cookieAttributes()
  );
}

/**
 * Reads exactly one well-formed refresh cookie. Any ambiguity (repeated name,
 * missing separator, empty value, wrong alphabet/length) is rejected as absent.
 */
export function readRefreshCookie(headers: CookieHeaderCarrier): string | null {
  const raw = headers.cookie;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  const prefix = `${REFRESH_COOKIE_NAME}=`;
  const matches: string[] = [];
  for (const part of raw.split(";")) {
    const candidate = part.trim();
    if (candidate.startsWith(prefix)) {
      matches.push(candidate.slice(prefix.length));
    }
  }

  if (matches.length !== 1) {
    return null;
  }
  const token = matches[0];
  if (token === undefined || !isPlausibleRefreshToken(token)) {
    return null;
  }
  return token;
}
