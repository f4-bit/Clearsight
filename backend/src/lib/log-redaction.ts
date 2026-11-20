import type { Writable } from "node:stream";

/**
 * Pino redaction paths for credential-bearing request/response data.
 *
 * The raw refresh token, the access bearer, the cookie header and password
 * fields must never reach application logs. This is a logger-level guard; it
 * does not replace keeping the values out of audit metadata and JSON bodies.
 *
 * The whole request URL is censored instead of scrubbing known query keys:
 * signed URLs/SAS parameters are adversarial and arbitrarily encoded, so a
 * regex over the raw URL is both incomplete and easy to bypass. Operational
 * correlation keeps the request id, method and response status.
 */
export const AUTH_LOG_REDACT_PATHS = [
  'req.url',
  'req.originalUrl',
  'req.query',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["Proxy-Authorization"]',
  'req.headers["set-cookie"]',
  'req.headers["Set-Cookie"]',
  'res.headers["set-cookie"]',
  'res.headers["Set-Cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.refreshToken',
  'req.body.token',
  'req.body.email',
] as const;

export const LOG_REDACTION_CENSOR = "[REDACTED]";

export interface AppLoggerOptions {
  redact: {
    paths: string[];
    censor: string;
  };
  stream?: Writable;
}

/**
 * Single source of truth for the application logger. The production app and
 * the logger tests both consume this helper; the only injectable seam is a
 * trusted writable destination, never a way to disable redaction.
 */
export function buildLoggerOptions(destination?: Writable): AppLoggerOptions {
  return {
    redact: {
      paths: [...AUTH_LOG_REDACT_PATHS],
      censor: LOG_REDACTION_CENSOR,
    },
    ...(destination ? { stream: destination } : {}),
  };
}
