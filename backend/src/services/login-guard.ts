import { createHmac } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";

/**
 * Purpose-scoped subkey derivation for login-protection fingerprints.
 *
 * The JWT secret is never stored on the guard or in bucket rows: only a derived
 * HMAC subkey is kept in the factory closure. Fingerprints are pseudonymous
 * bucket keys, not anonymization of the underlying identifier.
 */
export const LOGIN_PROTECTION_PURPOSE = "clearsight:auth-login-protection:v1";

export const LOGIN_BUCKET_KINDS = {
  IDENTIFIER: "IDENTIFIER",
  IP: "IP",
} as const;
export type LoginBucketKind =
  (typeof LOGIN_BUCKET_KINDS)[keyof typeof LOGIN_BUCKET_KINDS];

/** Direct service calls without request metadata still consume this bucket. */
export const INTERNAL_CLIENT_BUCKET = "INTERNAL";

export const FIXED_LOGIN_FAILURE_THRESHOLD = 5;
export const FIXED_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
export const DEFAULT_IP_RATE_LIMIT = 100;
export const DEFAULT_IP_RATE_WINDOW_SECONDS = 60;
/** Trusted operational bound; large enough for a shared NAT, far below DoS fuel. */
export const MAX_IP_RATE_LIMIT = 10_000;
export const MAX_IP_RATE_WINDOW_SECONDS = 86_400;

const MIN_HMAC_SECRET_BYTES = 32;
const INVALID_SECRET_MESSAGE = "login protection requires a JWT secret of at least 32 bytes";
const INVALID_IP_LIMIT_MESSAGE = "ipRateLimit must be a positive integer within the trusted bound";
const INVALID_IP_WINDOW_MESSAGE =
  "ipRateWindowSeconds must be a positive integer within the trusted bound";

export interface LoginProtectionDecision {
  readonly blocked: boolean;
  readonly retryAfterSeconds?: number;
}

export interface AuthLoginProtection {
  /** Counts a valid-schema credential attempt before any password KDF runs. */
  reserveIpAttempt(clientIp: string | null): Promise<LoginProtectionDecision>;
  /** Cheap identifier/user lock check performed before bcrypt. */
  precheckIdentifier(
    email: string,
    userLockedUntil: Date | null,
  ): Promise<LoginProtectionDecision>;
  /** Records one failed credential proof and serializes concurrent failures. */
  recordFailure(email: string): Promise<LoginProtectionDecision>;
  /** Resets counters only after a successful proof, inside the login transaction. */
  assertAndResetForSuccess(
    tx: Prisma.TransactionClient,
    email: string,
    userId: string,
  ): Promise<void>;
}

export interface AuthLoginProtectionOptions {
  readonly jwtSecret: string;
  readonly databaseSchema?: string;
  readonly now?: () => Date;
  readonly ipRateLimit?: number;
  readonly ipRateWindowSeconds?: number;
}

/** Thrown inside the login transaction when an inherited lock is still active. */
export class LoginProtectionThrottledError extends Error {
  readonly code = "AUTH_LOGIN_THROTTLED" as const;

  constructor(readonly retryAfterSeconds: number) {
    super("Too many login attempts");
    this.name = "LoginProtectionThrottledError";
  }
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

function positiveIntegerWithin(
  value: number,
  maximum: number,
  message: string,
): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(message);
  }
  return value;
}

export function deriveLoginProtectionKey(jwtSecret: string): Buffer {
  if (
    typeof jwtSecret !== "string" ||
    Buffer.byteLength(jwtSecret, "utf8") < MIN_HMAC_SECRET_BYTES
  ) {
    throw new Error(INVALID_SECRET_MESSAGE);
  }
  return createHmac("sha256", jwtSecret)
    .update(LOGIN_PROTECTION_PURPOSE, "utf8")
    .digest();
}

/** HMAC-SHA256(subkey, kind || NUL || normalizedValue) as lowercase hex. */
export function computeLoginBucketHash(
  key: Buffer,
  kind: LoginBucketKind,
  normalizedValue: string,
): string {
  return createHmac("sha256", key)
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(normalizedValue, "utf8")
    .digest("hex");
}

/** Mirrors the auth service email normalization; no raw email is persisted. */
export function normalizeLoginIdentifier(email: string): string {
  return email.trim().toLowerCase();
}

/** Missing metadata is an explicit synthetic bucket, never an unprotected path. */
export function normalizeLoginIp(clientIp: string | null): string {
  if (typeof clientIp !== "string" || clientIp.trim().length === 0) {
    return INTERNAL_CLIENT_BUCKET;
  }
  return clientIp.trim();
}

export interface IdentifierFailureState {
  readonly failureCount: number;
  readonly lockedUntil: Date | null;
}

export interface IdentifierFailureTransition extends IdentifierFailureState {
  readonly blocked: boolean;
  readonly retryAfterSeconds?: number;
}

/**
 * Pure HU01 transition: five consecutive failures lock for 15 minutes, active
 * blocks never increment/extend, and an expired lock restarts the count.
 */
export function transitionIdentifierFailure(
  state: IdentifierFailureState,
  now: Date,
): IdentifierFailureTransition {
  if (state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()) {
    return {
      blocked: true,
      failureCount: state.failureCount,
      lockedUntil: state.lockedUntil,
      retryAfterSeconds: secondsUntil(state.lockedUntil, now),
    };
  }

  const baseCount =
    state.lockedUntil !== null || state.failureCount >= FIXED_LOGIN_FAILURE_THRESHOLD
      ? 0
      : Math.max(0, state.failureCount);
  const failureCount = Math.min(
    baseCount + 1,
    FIXED_LOGIN_FAILURE_THRESHOLD,
  );
  const lockedUntil =
    failureCount >= FIXED_LOGIN_FAILURE_THRESHOLD
      ? new Date(now.getTime() + FIXED_LOGIN_LOCKOUT_MS)
      : null;

  return {
    blocked: lockedUntil !== null,
    failureCount,
    lockedUntil,
    ...(lockedUntil === null
      ? {}
      : { retryAfterSeconds: secondsUntil(lockedUntil, now) }),
  };
}

export interface IpWindowState {
  readonly attemptCount: number;
  readonly windowStartedAt: Date | null;
}

export interface IpWindowTransition {
  readonly allowed: boolean;
  readonly attemptCount: number;
  readonly windowStartedAt: Date;
  readonly retryAfterSeconds?: number;
}

/** Fixed-window complementary IP quota; the window starts on the first attempt. */
export function transitionIpWindowAttempt(
  state: IpWindowState,
  now: Date,
  limit: number,
  windowSeconds: number,
): IpWindowTransition {
  const windowMs = windowSeconds * 1000;
  let attemptCount = Math.max(0, state.attemptCount);
  let windowStartedAt = state.windowStartedAt;

  if (
    windowStartedAt === null ||
    now.getTime() - windowStartedAt.getTime() >= windowMs
  ) {
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

interface IdentifierBucketRow {
  readonly failure_count: number;
  readonly window_started_at: Date | null;
  readonly locked_until: Date | null;
}

interface LockedUserRow {
  readonly id: string;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
}

function latestActiveLock(
  now: Date,
  ...locks: Array<Date | null | undefined>
): Date | null {
  let latest: Date | null = null;
  for (const lock of locks) {
    if (
      lock !== null &&
      lock !== undefined &&
      lock.getTime() > now.getTime() &&
      (latest === null || lock.getTime() > latest.getTime())
    ) {
      latest = lock;
    }
  }
  return latest;
}

/**
 * Latest non-null stamp even if already expired. A finished lockout must reset
 * the consecutive count instead of relocking on a stale mirrored counter.
 */
function latestLockStamp(...locks: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const lock of locks) {
    if (lock !== null && lock !== undefined && (latest === null || lock.getTime() > latest.getTime())) {
      latest = lock;
    }
  }
  return latest;
}

/**
 * Creates the durable Postgres-backed login guard. Construction only derives
 * the HMAC subkey and validates options; no database connection is opened.
 */
export function createAuthLoginProtection(
  db: PrismaClient,
  options: AuthLoginProtectionOptions,
): AuthLoginProtection {
  const key = deriveLoginProtectionKey(options.jwtSecret);
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);

  const now = options.now ?? (() => new Date());
  const ipRateLimit = positiveIntegerWithin(
    options.ipRateLimit ?? DEFAULT_IP_RATE_LIMIT,
    MAX_IP_RATE_LIMIT,
    INVALID_IP_LIMIT_MESSAGE,
  );
  const ipRateWindowSeconds = positiveIntegerWithin(
    options.ipRateWindowSeconds ?? DEFAULT_IP_RATE_WINDOW_SECONDS,
    MAX_IP_RATE_WINDOW_SECONDS,
    INVALID_IP_WINDOW_MESSAGE,
  );

  const bucketsTable = `"${databaseSchema}"."auth_login_buckets"`;
  const usersTable = `"${databaseSchema}"."users"`;

  async function reserveIpAttempt(
    clientIp: string | null,
  ): Promise<LoginProtectionDecision> {
    const normalizedIp = normalizeLoginIp(clientIp);
    const keyHash = computeLoginBucketHash(key, LOGIN_BUCKET_KINDS.IP, normalizedIp);

    return db.$transaction(
      async (tx) => {
        const provisional = now();
        await tx.$executeRawUnsafe(
          `INSERT INTO ${bucketsTable} ` +
            "(kind, key_hash, failure_count, window_started_at, updated_at) " +
            "VALUES ($1, $2, 0, $3, $3) " +
            "ON CONFLICT (kind, key_hash) DO NOTHING",
          LOGIN_BUCKET_KINDS.IP,
          keyHash,
          provisional,
        );

        const rows = await tx.$queryRawUnsafe<IdentifierBucketRow[]>(
          `SELECT failure_count, window_started_at, locked_until ` +
            `FROM ${bucketsTable} ` +
            "WHERE kind = $1 AND key_hash = $2 FOR UPDATE",
          LOGIN_BUCKET_KINDS.IP,
          keyHash,
        );
        const row = rows[0];
        if (row === undefined) {
          throw new Error("login protection IP bucket disappeared during reservation");
        }

        const lockedAt = now();
        const transition = transitionIpWindowAttempt(
          {
            attemptCount: row.failure_count,
            windowStartedAt: row.window_started_at,
          },
          lockedAt,
          ipRateLimit,
          ipRateWindowSeconds,
        );

        if (!transition.allowed) {
          return {
            blocked: true,
            retryAfterSeconds: transition.retryAfterSeconds,
          };
        }

        await tx.$executeRawUnsafe(
          `UPDATE ${bucketsTable} ` +
            "SET failure_count = $3, window_started_at = $4, locked_until = NULL, updated_at = $5 " +
            "WHERE kind = $1 AND key_hash = $2",
          LOGIN_BUCKET_KINDS.IP,
          keyHash,
          transition.attemptCount,
          transition.windowStartedAt,
          lockedAt,
        );

        return { blocked: false };
      },
      { isolationLevel: "ReadCommitted" },
    );
  }

  async function precheckIdentifier(
    email: string,
    userLockedUntil: Date | null,
  ): Promise<LoginProtectionDecision> {
    const keyHash = computeLoginBucketHash(
      key,
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      normalizeLoginIdentifier(email),
    );

    const rows = await db.$queryRawUnsafe<IdentifierBucketRow[]>(
      `SELECT failure_count, window_started_at, locked_until ` +
        `FROM ${bucketsTable} ` +
        "WHERE kind = $1 AND key_hash = $2",
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      keyHash,
    );
    const row = rows[0];

    const checkedAt = now();
    const activeLock = latestActiveLock(
      checkedAt,
      userLockedUntil,
      row?.locked_until,
    );
    if (activeLock === null) {
      return { blocked: false };
    }
    return {
      blocked: true,
      retryAfterSeconds: secondsUntil(activeLock, checkedAt),
    };
  }

  async function recordFailure(email: string): Promise<LoginProtectionDecision> {
    const normalizedEmail = normalizeLoginIdentifier(email);
    const keyHash = computeLoginBucketHash(
      key,
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      normalizedEmail,
    );

    return db.$transaction(
      async (tx) => {
        // Consistent lock order for known identifiers: user row first, then the
        // identifier bucket. Unknown identifiers lock only the bucket; the IP
        // quota transaction was already committed and holds no user locks.
        const candidate = await tx.user.findFirst({
          where: { email: { equals: normalizedEmail, mode: "insensitive" } },
          select: { id: true },
        });

        let userRow: LockedUserRow | null = null;
        if (candidate !== null) {
          const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${usersTable} WHERE id = $1::uuid FOR UPDATE`,
            candidate.id,
          );
          if (locked.length === 1) {
            const rows = await tx.$queryRawUnsafe<LockedUserRow[]>(
              `SELECT id, failed_login_count, locked_until ` +
                `FROM ${usersTable} WHERE id = $1::uuid`,
              candidate.id,
            );
            userRow = rows[0] ?? null;
          }
        }

        const provisional = now();
        await tx.$executeRawUnsafe(
          `INSERT INTO ${bucketsTable} ` +
            "(kind, key_hash, failure_count, window_started_at, updated_at) " +
            "VALUES ($1, $2, 0, NULL, $3) " +
            "ON CONFLICT (kind, key_hash) DO NOTHING",
          LOGIN_BUCKET_KINDS.IDENTIFIER,
          keyHash,
          provisional,
        );

        const rows = await tx.$queryRawUnsafe<IdentifierBucketRow[]>(
          `SELECT failure_count, window_started_at, locked_until ` +
            `FROM ${bucketsTable} ` +
            "WHERE kind = $1 AND key_hash = $2 FOR UPDATE",
          LOGIN_BUCKET_KINDS.IDENTIFIER,
          keyHash,
        );
        const bucket = rows[0];
        if (bucket === undefined) {
          throw new Error("login protection identifier bucket disappeared during failure");
        }

        const lockedAt = now();
        const userLock = userRow?.locked_until ?? null;
        const bucketLock = bucket.locked_until;

        // A concurrent success/lock committed first: an active lock in either
        // row is authoritative. Do not increment, reset or extend it.
        const activeLock = latestActiveLock(lockedAt, userLock, bucketLock);
        if (activeLock !== null) {
          return {
            blocked: true,
            retryAfterSeconds: secondsUntil(activeLock, lockedAt),
          };
        }

        // A JWT rotation can orphan the bucket hash while the known user still
        // carries the consecutive count. Under the user row lock the
        // authoritative prior state is the max count plus the latest stamp, so
        // a completed lockout still resets instead of relocking on stale counts.
        const transition = transitionIdentifierFailure(
          {
            failureCount: Math.max(0, bucket.failure_count, userRow?.failed_login_count ?? 0),
            lockedUntil: latestLockStamp(userLock, bucketLock),
          },
          lockedAt,
        );

        await tx.$executeRawUnsafe(
          `UPDATE ${bucketsTable} ` +
            "SET failure_count = $3, locked_until = $4, updated_at = $5 " +
            "WHERE kind = $1 AND key_hash = $2",
          LOGIN_BUCKET_KINDS.IDENTIFIER,
          keyHash,
          transition.failureCount,
          transition.lockedUntil,
          lockedAt,
        );

        if (userRow !== null) {
          await tx.$executeRawUnsafe(
            `UPDATE ${usersTable} ` +
              "SET failed_login_count = $2, locked_until = $3, updated_at = $4 " +
              "WHERE id = $1::uuid",
            userRow.id,
            transition.failureCount,
            transition.lockedUntil,
            lockedAt,
          );
        }

        if (transition.blocked) {
          return {
            blocked: true,
            retryAfterSeconds: transition.retryAfterSeconds,
          };
        }

        return { blocked: false };
      },
      { isolationLevel: "ReadCommitted" },
    );
  }

  async function assertAndResetForSuccess(
    tx: Prisma.TransactionClient,
    email: string,
    userId: string,
  ): Promise<void> {
    const keyHash = computeLoginBucketHash(
      key,
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      normalizeLoginIdentifier(email),
    );

    // The login transaction already holds the user row lock; re-reading it with
    // FOR UPDATE is a no-op for the same transaction and keeps the global order
    // user first, identifier bucket second.
    const userRows = await tx.$queryRawUnsafe<
      Array<{ failed_login_count: number; locked_until: Date | null }>
    >(
      `SELECT failed_login_count, locked_until ` +
        `FROM ${usersTable} WHERE id = $1::uuid FOR UPDATE`,
      userId,
    );

    const bucketRows = await tx.$queryRawUnsafe<IdentifierBucketRow[]>(
      `SELECT failure_count, window_started_at, locked_until ` +
        `FROM ${bucketsTable} ` +
        "WHERE kind = $1 AND key_hash = $2 FOR UPDATE",
      LOGIN_BUCKET_KINDS.IDENTIFIER,
      keyHash,
    );

    const checkedAt = now();
    const user = userRows[0];
    const bucket = bucketRows[0];
    const activeLock = latestActiveLock(
      checkedAt,
      user?.locked_until,
      bucket?.locked_until,
    );
    if (activeLock !== null) {
      throw new LoginProtectionThrottledError(secondsUntil(activeLock, checkedAt));
    }

    if (bucket !== undefined) {
      await tx.$executeRawUnsafe(
        `UPDATE ${bucketsTable} ` +
          "SET failure_count = 0, locked_until = NULL, window_started_at = NULL, updated_at = $3 " +
          "WHERE kind = $1 AND key_hash = $2",
        LOGIN_BUCKET_KINDS.IDENTIFIER,
        keyHash,
        checkedAt,
      );
    }

    if (user !== undefined) {
      await tx.$executeRawUnsafe(
        `UPDATE ${usersTable} ` +
          "SET failed_login_count = 0, locked_until = NULL, updated_at = $2 " +
          "WHERE id = $1::uuid",
        userId,
        checkedAt,
      );
    }
  }

  return {
    reserveIpAttempt,
    precheckIdentifier,
    recordFailure,
    assertAndResetForSuccess,
  };
}
