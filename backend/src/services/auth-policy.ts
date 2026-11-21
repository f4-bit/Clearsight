import { JwtPayload } from "../schemas/auth.js";

/** Default and maximum access-token lifetime. A single policy value governs both. */
export const DEFAULT_JWT_ACCESS_TTL = "15m";
export const MAX_ACCESS_TTL_SECONDS = 900;

/** The public development placeholder must never be used in production. */
export const KNOWN_DEV_JWT_SECRET = "clearsight-dev-secret-change-in-prod-32chars!";
export const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

/**
 * An iat up to 5 seconds in the future is tolerated for minor clock skew.
 * Expiry remains strict: exp must still be strictly after the current time.
 */
const MAX_CLOCK_SKEW_SECONDS = 5;
const DURATION_PATTERN = /^(\d+)([smh])$/;
const INVALID_TTL_MESSAGE = "JWT_EXPIRES_IN must be a positive duration of at most 900 seconds";
const INVALID_PRODUCTION_SECRET_MESSAGE =
  "JWT_SECRET must be a non-default value of at least 32 characters in production";
/** Bounded, case-insensitive prefix check for public example placeholders. */
const PUBLIC_PLACEHOLDER_PATTERN = /^(?:replace-me|change-me|changeme)/i;

export interface AccessTtl {
  readonly seconds: number;
  readonly label: string;
}

/**
 * Parses the single configured access-token TTL. Only whole seconds, minutes or
 * hours are accepted; anything above fifteen minutes is rejected so a forged
 * token signed with the application secret cannot carry a longer lifetime.
 */
export function parseAccessTtl(value: string | undefined): AccessTtl {
  const label = (value ?? DEFAULT_JWT_ACCESS_TTL).trim();
  const match = DURATION_PATTERN.exec(label);
  if (match === null) {
    throw new Error(INVALID_TTL_MESSAGE);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : 3600;
  const seconds = amount * multiplier;

  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_ACCESS_TTL_SECONDS) {
    throw new Error(INVALID_TTL_MESSAGE);
  }

  return { seconds, label };
}

/**
 * Fails closed before serving traffic when production uses a known development
 * secret, a blank/short value or a public example placeholder.
 *
 * Leading/trailing whitespace is inspected only to validate length/placeholders;
 * the actual secret is never normalized or rewritten for signing.
 */
export function assertProductionJwtSecret(secret: string, nodeEnv: string | undefined): void {
  if (nodeEnv !== "production") {
    return;
  }

  const inspected = secret.trim();
  if (
    secret === KNOWN_DEV_JWT_SECRET ||
    inspected === KNOWN_DEV_JWT_SECRET ||
    inspected.length < MIN_PRODUCTION_JWT_SECRET_LENGTH ||
    PUBLIC_PLACEHOLDER_PATTERN.test(inspected)
  ) {
    throw new Error(INVALID_PRODUCTION_SECRET_MESSAGE);
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Validates the four principal claims plus the temporal claims that the
 * cryptographic verifier does not fully enforce. The token must carry an exp
 * present, numeric, integer and in the future; iat must be present and not in
 * the future; and the token lifetime cannot exceed the configured policy.
 * Returns only the four principal claims.
 */
export function parseVerifiedAccessTokenClaims(
  raw: unknown,
  nowSeconds: number,
  maxTtlSeconds: number,
): JwtPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const parsed = JwtPayload.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const exp = record.exp;
  const iat = record.iat;

  if (!isInteger(exp) || !isInteger(iat)) {
    return null;
  }
  if (exp <= nowSeconds) {
    return null;
  }
  if (iat < 0 || iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    return null;
  }
  if (exp <= iat) {
    return null;
  }
  if (exp - iat > maxTtlSeconds) {
    return null;
  }

  return parsed.data;
}
