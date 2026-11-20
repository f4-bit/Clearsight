import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { PrismaClient } from "../lib/prisma.js";
import { canonicalizeEmail } from "../lib/canonical-email.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";

/**
 * Durable fixed-window quotas for password recovery.
 *
 * The guard is intentionally independent from login protection/HU01:
 * - its HMAC purpose is different from `clearsight:auth-login-protection:v1`;
 * - it writes `auth_recovery_buckets`, never `auth_login_buckets`;
 * - it never locks users, hashes passwords or checks account existence.
 *
 * Only purpose-scoped HMAC-SHA256 bucket hashes are persisted. Raw email/IP,
 * tokens and secrets are never stored, logged or returned in errors.
 */

export const PASSWORD_RECOVERY_HMAC_PURPOSE = "clearsight:auth-password-recovery:v1";

export const PASSWORD_RECOVERY_QUOTA_KINDS = {
  FORGOT_EMAIL: "FORGOT_EMAIL",
  FORGOT_IP: "FORGOT_IP",
  RESET_IP: "RESET_IP",
} as const;
export type PasswordRecoveryQuotaKind =
  (typeof PASSWORD_RECOVERY_QUOTA_KINDS)[keyof typeof PASSWORD_RECOVERY_QUOTA_KINDS];

export const FORGOT_EMAIL_LIMIT = 3;
export const FORGOT_EMAIL_WINDOW_SECONDS = 60 * 60;
export const FORGOT_IP_LIMIT = 20;
export const FORGOT_IP_WINDOW_SECONDS = 60 * 60;
export const RESET_IP_LIMIT = 20;
export const RESET_IP_WINDOW_SECONDS = 15 * 60;

/** Direct service calls without request metadata still consume an explicit bucket. */
export const INTERNAL_RECOVERY_BUCKET = "INTERNAL";

const MIN_HMAC_SECRET_BYTES = 32;
const INVALID_SECRET_MESSAGE =
  "password recovery quotas require a JWT secret of at least 32 bytes";
const INVALID_INPUT_MESSAGE = "password recovery quota input is invalid";
const STORE_UNAVAILABLE_MESSAGE = "password recovery quota store is unavailable";

export type PasswordRecoveryQuotaErrorCode =
  | "PASSWORD_RECOVERY_QUOTA_INVALID_INPUT"
  | "PASSWORD_RECOVERY_QUOTA_STORE_UNAVAILABLE";

/** Cheap input rejection before any database transaction or query. */
export class PasswordRecoveryQuotaInputError extends Error {
  readonly code = "PASSWORD_RECOVERY_QUOTA_INVALID_INPUT" as const;

  constructor() {
    super(INVALID_INPUT_MESSAGE);
    this.name = "PasswordRecoveryQuotaInputError";
  }
}

/** Stable generic store failure. Never includes driver output or secrets. */
export class PasswordRecoveryQuotaStoreError extends Error {
  readonly code = "PASSWORD_RECOVERY_QUOTA_STORE_UNAVAILABLE" as const;

  constructor() {
    super(STORE_UNAVAILABLE_MESSAGE);
    this.name = "PasswordRecoveryQuotaStoreError";
  }
}

export type PasswordRecoveryQuotaDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface PasswordRecoveryQuotaGuard {
  /** Consumes one FORGOT_IP slot (20/hour) before the email lookup/quota. */
  reserveForgotIp(clientIp: string | null | undefined): Promise<PasswordRecoveryQuotaDecision>;
  /** Consumes one FORGOT_EMAIL slot (3/hour); call after reserveForgotIp. */
  reserveForgotEmail(email: string): Promise<PasswordRecoveryQuotaDecision>;
  /** Consumes one RESET_IP slot (20/15 min) before token lookup or bcrypt. */
  reserveResetIp(clientIp: string | null | undefined): Promise<PasswordRecoveryQuotaDecision>;
}

export interface PasswordRecoveryQuotaOptions {
  readonly jwtSecret: string;
  readonly databaseSchema?: string;
  readonly now?: () => Date;
}

export interface PasswordRecoveryWindowState {
  readonly attemptCount: number;
  readonly windowStartedAt: Date;
}

export interface PasswordRecoveryWindowAllowed {
  readonly allowed: true;
  readonly attemptCount: number;
  readonly windowStartedAt: Date;
}

export interface PasswordRecoveryWindowBlocked {
  readonly allowed: false;
  readonly attemptCount: number;
  readonly windowStartedAt: Date;
  readonly retryAfterSeconds: number;
}

export type PasswordRecoveryWindowTransition =
  | PasswordRecoveryWindowAllowed
  | PasswordRecoveryWindowBlocked;

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

export function derivePasswordRecoveryKey(jwtSecret: string): Buffer {
  if (
    typeof jwtSecret !== "string" ||
    Buffer.byteLength(jwtSecret, "utf8") < MIN_HMAC_SECRET_BYTES
  ) {
    throw new Error(INVALID_SECRET_MESSAGE);
  }
  return createHmac("sha256", jwtSecret)
    .update(PASSWORD_RECOVERY_HMAC_PURPOSE, "utf8")
    .digest();
}

/** HMAC-SHA256(subkey, kind || NUL || normalizedValue) as lowercase hex. */
export function computePasswordRecoveryBucketHash(
  key: Buffer,
  kind: PasswordRecoveryQuotaKind,
  normalizedValue: string,
): string {
  if (
    !Object.values(PASSWORD_RECOVERY_QUOTA_KINDS).includes(kind) ||
    typeof normalizedValue !== "string" ||
    normalizedValue.length === 0
  ) {
    throw new PasswordRecoveryQuotaInputError();
  }

  return createHmac("sha256", key)
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(normalizedValue, "utf8")
    .digest("hex");
}

/** Canonical email shared with login/admin; direct invalid values fail cheap. */
export function normalizeRecoveryEmail(email: unknown): string {
  const canonical = canonicalizeEmail(email);
  if (canonical === null) {
    throw new PasswordRecoveryQuotaInputError();
  }
  return canonical;
}

/**
 * Trusted socket-IP normalization. It never parses X-Forwarded-For, resolves
 * DNS or accepts a hostname/multi-value header as an address.
 */
export function normalizeRecoveryIp(clientIp: unknown): string {
  if (clientIp === null || clientIp === undefined) {
    return INTERNAL_RECOVERY_BUCKET;
  }
  if (typeof clientIp !== "string") {
    throw new PasswordRecoveryQuotaInputError();
  }

  const trimmed = clientIp.trim();
  if (trimmed.length === 0) {
    return INTERNAL_RECOVERY_BUCKET;
  }
  if (isIP(trimmed) === 0) {
    throw new PasswordRecoveryQuotaInputError();
  }
  return trimmed.toLowerCase();
}

/**
 * Pure fixed-window transition. The window starts on the first attempt; the
 * exact boundary `windowStartedAt + windowMs` allows a new window and count 1.
 * A blocked decision never increments the counter.
 */
export function transitionRecoveryWindow(
  state: PasswordRecoveryWindowState,
  now: Date,
  limit: number,
  windowSeconds: number,
): PasswordRecoveryWindowTransition {
  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds <= 0
  ) {
    throw new Error("password recovery quota limits are invalid");
  }

  const windowMs = windowSeconds * 1000;
  let attemptCount = Math.max(0, state.attemptCount);
  let windowStartedAt = state.windowStartedAt;

  if (now.getTime() - windowStartedAt.getTime() >= windowMs) {
    windowStartedAt = now;
    attemptCount = 0;
  }

  if (attemptCount >= limit) {
    return {
      allowed: false,
      attemptCount,
      windowStartedAt,
      retryAfterSeconds: secondsUntil(
        new Date(windowStartedAt.getTime() + windowMs),
        now,
      ),
    };
  }

  return {
    allowed: true,
    attemptCount: attemptCount + 1,
    windowStartedAt,
  };
}

interface RecoveryBucketRow {
  readonly attempt_count: number;
  readonly window_started_at: Date;
}

/**
 * Creates the durable Postgres-backed recovery guard. Construction only derives
 * the HMAC subkey and validates options; no database connection is opened.
 */
export function createPasswordRecoveryQuotaGuard(
  db: PrismaClient,
  options: PasswordRecoveryQuotaOptions,
): PasswordRecoveryQuotaGuard {
  const key = derivePasswordRecoveryKey(options.jwtSecret);
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const now = options.now ?? (() => new Date());
  const table = `"${databaseSchema}"."auth_recovery_buckets"`;

  async function reserve(
    kind: PasswordRecoveryQuotaKind,
    normalizedValue: string,
    limit: number,
    windowSeconds: number,
  ): Promise<PasswordRecoveryQuotaDecision> {
    const keyHash = computePasswordRecoveryBucketHash(key, kind, normalizedValue);

    try {
      return await db.$transaction(
        async (tx) => {
          const provisional = now();
          await tx.$executeRawUnsafe(
            `INSERT INTO ${table} ` +
              "(kind, key_hash, attempt_count, window_started_at, updated_at) " +
              "VALUES ($1, $2, 0, $3, $3) " +
              "ON CONFLICT (kind, key_hash) DO NOTHING",
            kind,
            keyHash,
            provisional,
          );

          const rows = await tx.$queryRawUnsafe<RecoveryBucketRow[]>(
            `SELECT attempt_count, window_started_at ` +
              `FROM ${table} ` +
              "WHERE kind = $1 AND key_hash = $2 FOR UPDATE",
            kind,
            keyHash,
          );
          const row = rows[0];
          if (row === undefined) {
            throw new Error("password recovery bucket disappeared during reservation");
          }

          const checkedAt = now();
          const transition = transitionRecoveryWindow(
            {
              attemptCount: row.attempt_count,
              windowStartedAt: row.window_started_at,
            },
            checkedAt,
            limit,
            windowSeconds,
          );

          if (!transition.allowed) {
            return {
              allowed: false,
              retryAfterSeconds: transition.retryAfterSeconds,
            } as const;
          }

          await tx.$executeRawUnsafe(
            `UPDATE ${table} ` +
              "SET attempt_count = $3, window_started_at = $4, updated_at = $5 " +
              "WHERE kind = $1 AND key_hash = $2",
            kind,
            keyHash,
            transition.attemptCount,
            transition.windowStartedAt,
            checkedAt,
          );

          return { allowed: true } as const;
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof PasswordRecoveryQuotaInputError) {
        throw error;
      }
      throw new PasswordRecoveryQuotaStoreError();
    }
  }

  return {
    async reserveForgotIp(clientIp) {
      return reserve(
        PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_IP,
        normalizeRecoveryIp(clientIp),
        FORGOT_IP_LIMIT,
        FORGOT_IP_WINDOW_SECONDS,
      );
    },
    async reserveForgotEmail(email) {
      return reserve(
        PASSWORD_RECOVERY_QUOTA_KINDS.FORGOT_EMAIL,
        normalizeRecoveryEmail(email),
        FORGOT_EMAIL_LIMIT,
        FORGOT_EMAIL_WINDOW_SECONDS,
      );
    },
    async reserveResetIp(clientIp) {
      return reserve(
        PASSWORD_RECOVERY_QUOTA_KINDS.RESET_IP,
        normalizeRecoveryIp(clientIp),
        RESET_IP_LIMIT,
        RESET_IP_WINDOW_SECONDS,
      );
    },
  };
}
