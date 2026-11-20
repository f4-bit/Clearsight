/**
 * Pino redaction paths for credential-bearing request/response data.
 *
 * The raw refresh token, the access bearer, the cookie header and password
 * fields must never reach application logs. This is a logger-level guard; it
 * does not replace keeping the values out of audit metadata and JSON bodies.
 */
export const AUTH_LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.refreshToken',
  'req.body.token',
  'req.body.email',
] as const;
