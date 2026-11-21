import { HttpError } from "../lib/http-error.js";

/**
 * Public-origin policy for the web credential endpoints (login/refresh/logout).
 *
 * The only trusted source is the explicitly configured `AUTH_PUBLIC_ORIGIN`.
 * The policy never derives an origin from `Host`, `X-Forwarded-*` or a CORS
 * wildcard. Missing configuration fails closed for the cookie endpoints; an
 * invalid configuration aborts startup instead of falling back to something
 * permissive.
 */

export const INVALID_PUBLIC_ORIGIN_MESSAGE =
  "AUTH_PUBLIC_ORIGIN must be a normalized http(s) origin without wildcard, credentials, path, query or hash";

const ORIGIN_FORBIDDEN_MESSAGE = "Request origin is not allowed";
const ORIGIN_UNAVAILABLE_MESSAGE = "Authentication is temporarily unavailable";
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type WebEnvironment = "development" | "test" | "production";

export interface WebOriginHeaders {
  readonly origin?: string | string[] | undefined;
  readonly "sec-fetch-site"?: string | string[] | undefined;
}

/** 403 for an absent/mismatched/cross-site origin; 503 for missing config. */
export class WebOriginError extends HttpError {
  constructor(statusCode: 403 | 503) {
    if (statusCode === 503) {
      super(503, "service_unavailable", ORIGIN_UNAVAILABLE_MESSAGE);
    } else {
      super(403, "origin_forbidden", ORIGIN_FORBIDDEN_MESSAGE);
    }
    this.name = "WebOriginError";
  }
}

/**
 * Parses and normalizes the configured origin. Empty/whitespace is treated as
 * missing (null) so a blank `.env` value cannot look configured.
 */
export function parseAuthPublicOrigin(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (
    trimmed === "*" ||
    trimmed.includes(",") ||
    trimmed.includes(" ") ||
    trimmed.includes("\t")
  ) {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(INVALID_PUBLIC_ORIGIN_MESSAGE);
  }

  return url.origin;
}

/**
 * Production requires HTTPS. Plain HTTP is only accepted for an explicit
 * non-production localhost configuration; the cookie remains Secure anyway.
 */
export function assertPublicOriginForEnvironment(
  origin: string,
  nodeEnv: WebEnvironment,
): void {
  const url = new URL(origin);
  if (nodeEnv === "production") {
    if (url.protocol !== "https:") {
      throw new Error(
        "AUTH_PUBLIC_ORIGIN must use https in production; http is not allowed",
      );
    }
    return;
  }

  if (url.protocol === "http:" && !LOCAL_HTTP_HOSTS.has(url.hostname)) {
    throw new Error(
      "AUTH_PUBLIC_ORIGIN may use http only for an explicit non-production localhost origin",
    );
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function rejectIfCrossSite(headers: WebOriginHeaders): void {
  const site = singleHeader(headers["sec-fetch-site"])?.trim().toLowerCase();
  if (site === "cross-site") {
    throw new WebOriginError(403);
  }
}

function assertConfiguredOrigin(publicOrigin: string, headers: WebOriginHeaders): void {
  rejectIfCrossSite(headers);

  const rawOrigin = singleHeader(headers.origin);
  if (rawOrigin === null || rawOrigin === "null") {
    throw new WebOriginError(403);
  }
  // A browser sends exactly one serialized origin. Commas/spaces indicate an
  // ambiguous or forged multi-value header and are rejected rather than parsed
  // leniently.
  if (rawOrigin.includes(",") || /\s/.test(rawOrigin)) {
    throw new WebOriginError(403);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new WebOriginError(403);
  }
  if (parsed.origin !== publicOrigin) {
    throw new WebOriginError(403);
  }
}

export interface WebAuthPolicy {
  readonly configured: boolean;
  readonly publicOrigin: string | null;
  /** Login/refresh: configuration and Origin are mandatory. */
  assertRequiredOrigin(headers: WebOriginHeaders): void;
  /** Logout: only an Origin that is actually present is validated. */
  assertOptionalOrigin(headers: WebOriginHeaders): void;
}

export interface WebAuthPolicyOptions {
  readonly publicOrigin?: string;
  readonly nodeEnv: WebEnvironment;
}

export function createWebAuthPolicy(options: WebAuthPolicyOptions): WebAuthPolicy {
  const publicOrigin = parseAuthPublicOrigin(options.publicOrigin);
  if (publicOrigin !== null) {
    assertPublicOriginForEnvironment(publicOrigin, options.nodeEnv);
  }

  return {
    configured: publicOrigin !== null,
    publicOrigin,
    assertRequiredOrigin(headers) {
      if (publicOrigin === null) {
        throw new WebOriginError(503);
      }
      assertConfiguredOrigin(publicOrigin, headers);
    },
    assertOptionalOrigin(headers) {
      if (headers.origin === undefined) {
        return;
      }
      if (publicOrigin === null) {
        throw new WebOriginError(503);
      }
      assertConfiguredOrigin(publicOrigin, headers);
    },
  };
}
