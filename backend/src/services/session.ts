import bcrypt from "bcryptjs";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { UserRole } from "../generated/prisma/enums.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type { JwtPayload } from "../schemas/auth.js";
import { MAX_ACCESS_TTL_SECONDS } from "./auth-policy.js";
import {
  type AuthLoginProtection,
  LoginProtectionThrottledError,
} from "./login-guard.js";
import { PASSWORD_DUMMY_HASH } from "./password-policy.js";

export { assertValidDatabaseSchema, DEFAULT_DATABASE_SCHEMA };

/** Access token policy is owned by `auth-policy`; the service only consumes it. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LOGIN_PASSWORD_UTF8_BYTES = 72;

const LOGIN_AUDIT_ACTION = "AUTH_SESSION_CREATED";
const LOGIN_AUDIT_METADATA = { channel: "password" } as const;
const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials";
const LOGIN_THROTTLED_MESSAGE = "Too many login attempts";
const INVALID_SESSION_MESSAGE = "Invalid or expired session";
const STORE_UNAVAILABLE_MESSAGE = "Authentication store is temporarily unavailable";
const TOKEN_ISSUE_MESSAGE = "Access token could not be issued";
const INVALID_ACCESS_TTL_MESSAGE = "accessTtl.seconds must be a positive integer no greater than 900";
const INVALID_SESSION_TTL_MESSAGE =
  "sessionTtlMs must be a positive integer no greater than seven days";
const MISSING_LOGIN_PROTECTION_MESSAGE =
  "loginProtection is required; the auth service never falls back to an unprotected path";

const USER_AUTH_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  lockedUntil: true,
  tokenVersion: true,
  passwordHash: true,
} as const;

interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly lockedUntil: Date | null;
  readonly tokenVersion: number;
  readonly passwordHash: string;
}

interface SessionWithUser {
  readonly id: string;
  readonly userId: string;
  readonly issuedTokenVersion: number;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
    readonly isActive: boolean;
    readonly tokenVersion: number;
  };
}

export type AuthSessionErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_LOGIN_THROTTLED"
  | "AUTH_SESSION_INVALID"
  | "AUTH_STORE_UNAVAILABLE"
  | "AUTH_TOKEN_ISSUE_FAILED";

/** Stable service error surface; messages never include account or store details. */
export class AuthSessionError extends Error {
  readonly code: AuthSessionErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: AuthSessionErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AuthSessionError";
    this.code = code;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

const invalidCredentials = () =>
  new AuthSessionError("AUTH_INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
const loginThrottled = (retryAfterSeconds: number) =>
  new AuthSessionError("AUTH_LOGIN_THROTTLED", LOGIN_THROTTLED_MESSAGE, retryAfterSeconds);
const invalidSession = () => new AuthSessionError("AUTH_SESSION_INVALID", INVALID_SESSION_MESSAGE);
const storeUnavailable = () =>
  new AuthSessionError("AUTH_STORE_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
const tokenIssueFailed = () =>
  new AuthSessionError("AUTH_TOKEN_ISSUE_FAILED", TOKEN_ISSUE_MESSAGE);

export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

/** Optional request context; direct callers get the synthetic internal IP bucket. */
export interface LoginRequestMetadata {
  readonly clientIp?: string;
}

export interface LoginUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly tokenType: "bearer";
  readonly expiresIn: string;
  readonly user: LoginUser;
}

export interface SafePrincipal extends LoginUser {
  readonly sessionId: string;
  readonly tokenVersion: number;
}

/**
 * Pure token issuer seam. The route injects `app.jwt.sign`; the service never
 * knows about Fastify or the JWT secret and never performs database work here.
 */
export type AccessTokenIssuer = (
  claims: JwtPayload,
  expiresInSeconds: number,
) => string | Promise<string>;

export interface AuthSessionServiceOptions {
  readonly accessTtl: { readonly seconds: number; readonly label: string };
  /**
   * Schema used by the Prisma client for the raw user-row lock. It must match
   * the client's configured schema; defaults to `public`. It is never inferred
   * from the connection search_path or from private Prisma internals.
   */
  readonly databaseSchema?: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  /** Mandatory durable guard; there is no no-op or NODE_ENV test bypass. */
  readonly loginProtection: AuthLoginProtection;
}

export interface AuthSessionService {
  readonly accessTtlSeconds: number;
  readonly accessTtlLabel: string;
  login(
    credentials: LoginCredentials,
    issueAccessToken: AccessTokenIssuer,
    metadata?: LoginRequestMetadata,
  ): Promise<LoginResult>;
  verifySession(claims: JwtPayload): Promise<SafePrincipal>;
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 255) {
    return null;
  }
  return normalized;
}

function isPasswordWithinBcryptBound(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length > 0 &&
    Buffer.byteLength(password, "utf8") <= MAX_LOGIN_PASSWORD_UTF8_BYTES
  );
}

/**
 * Creates the durable-session auth service on top of an injected database
 * client. Construction is lazy: it never connects, so building the app (or
 * hitting a retired route) performs no database work.
 */
export function createAuthSessionService(
  db: PrismaClient,
  options: AuthSessionServiceOptions,
): AuthSessionService {
  const loginProtection = options.loginProtection;
  if (loginProtection === undefined || loginProtection === null) {
    throw new Error(MISSING_LOGIN_PROTECTION_MESSAGE);
  }

  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const accessTtlSeconds = options.accessTtl.seconds;
  const accessTtlLabel = options.accessTtl.label;
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const usersTable = `"${databaseSchema}"."users"`;

  if (
    !Number.isInteger(accessTtlSeconds) ||
    accessTtlSeconds <= 0 ||
    accessTtlSeconds > MAX_ACCESS_TTL_SECONDS
  ) {
    throw new Error(INVALID_ACCESS_TTL_MESSAGE);
  }
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0 || sessionTtlMs > SESSION_TTL_MS) {
    throw new Error(INVALID_SESSION_TTL_MESSAGE);
  }

  async function failWithGuard(email: string): Promise<never> {
    let decision;
    try {
      decision = await loginProtection.recordFailure(email);
    } catch {
      throw storeUnavailable();
    }
    if (decision.blocked) {
      throw loginThrottled(decision.retryAfterSeconds ?? 1);
    }
    throw invalidCredentials();
  }

  async function login(
    credentials: LoginCredentials,
    issueAccessToken: AccessTokenIssuer,
    metadata?: LoginRequestMetadata,
  ): Promise<LoginResult> {
    const issuedAt = now();
    const email = normalizeEmail(credentials?.email);
    // Malformed/non-string transport values stay a cheap generic 401 and never
    // touch the store or consume a bucket.
    if (email === null || typeof credentials?.password !== "string") {
      throw invalidCredentials();
    }

    // All valid-schema credential attempts consume the complementary IP quota
    // before any bcrypt work. It commits in its own short transaction first, so
    // no user/identifier lock is held while the KDF runs.
    let ipDecision;
    try {
      ipDecision = await loginProtection.reserveIpAttempt(metadata?.clientIp ?? null);
    } catch {
      throw storeUnavailable();
    }
    if (ipDecision.blocked) {
      throw loginThrottled(ipDecision.retryAfterSeconds ?? 1);
    }

    let initial: AuthUserRecord | null;
    try {
      initial = await db.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: USER_AUTH_SELECT,
      });
    } catch {
      throw storeUnavailable();
    }

    // Cheap precheck before bcrypt: the identifier bucket and any known user
    // lock share the same constant generic 429, so unknown and known accounts
    // follow the same observable sequence.
    let precheck;
    try {
      precheck = await loginProtection.precheckIdentifier(email, initial?.lockedUntil ?? null);
    } catch {
      throw storeUnavailable();
    }
    if (precheck.blocked) {
      throw loginThrottled(precheck.retryAfterSeconds ?? 1);
    }

    // A valid email with a password outside the bcrypt bound is still a failed
    // credential attempt and must count toward HU01.
    if (!isPasswordWithinBcryptBound(credentials.password)) {
      return failWithGuard(email);
    }

    if (initial === null) {
      // Unknown accounts compare against a precomputed current-policy hash.
      // This approximates the cost-12 path only; malformed/disabled legacy rows
      // and older-cost hashes may differ, so no universal timing-oracle
      // guarantee is claimed.
      await bcrypt.compare(credentials.password, PASSWORD_DUMMY_HASH).catch(() => false);
      return failWithGuard(email);
    }

    const passwordMatches = await bcrypt
      .compare(credentials.password, initial.passwordHash)
      .catch(() => false);
    if (!passwordMatches) {
      return failWithGuard(email);
    }
    if (!initial.isActive) {
      return failWithGuard(email);
    }

    try {
      return await db.$transaction(
        async (tx) => {
          // Lock the account row before re-reading it. A concurrent password or
          // role/version change committed after the bcrypt check is observed
          // here and the stale proof is rejected instead of reused.
          //
          // The table is schema-qualified with the caller-declared Prisma
          // schema so a connection search_path decoy cannot shadow `users`.
          const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${usersTable} WHERE id = $1::uuid FOR UPDATE`,
            initial.id,
          );
          if (locked.length !== 1) {
            throw invalidCredentials();
          }

          const current = await tx.user.findUnique({
            where: { id: initial.id },
            select: USER_AUTH_SELECT,
          });
          if (current === null) {
            throw invalidCredentials();
          }
          if (!current.isActive) {
            throw invalidCredentials();
          }
          if (
            current.passwordHash !== initial.passwordHash ||
            current.tokenVersion !== initial.tokenVersion ||
            current.role !== initial.role
          ) {
            throw invalidCredentials();
          }

          // The user row is already locked first; this locks the identifier
          // bucket second, rechecks any inherited lock and only then resets the
          // counters. A later audit/sign failure rolls the reset back.
          await loginProtection.assertAndResetForSuccess(tx, email, current.id);

          const session = await tx.userSession.create({
            data: {
              userId: current.id,
              issuedTokenVersion: current.tokenVersion,
              createdAt: issuedAt,
              expiresAt: new Date(issuedAt.getTime() + sessionTtlMs),
            },
            select: { id: true },
          });

          await tx.auditEvent.create({
            data: {
              actorKind: "USER",
              actorUserId: current.id,
              targetType: "SESSION",
              targetId: session.id,
              targetUserId: null,
              action: LOGIN_AUDIT_ACTION,
              outcome: "SUCCESS",
              metadata: LOGIN_AUDIT_METADATA,
            },
          });

          const claims: JwtPayload = {
            sub: current.id,
            role: current.role,
            sessionId: session.id,
            tokenVersion: current.tokenVersion,
          };

          let accessToken: string;
          try {
            accessToken = await issueAccessToken(claims, accessTtlSeconds);
          } catch {
            throw tokenIssueFailed();
          }
          if (typeof accessToken !== "string" || accessToken.length === 0) {
            throw tokenIssueFailed();
          }

          // Returned only after the transaction commits; a later rollback never
          // exposes this token to the caller.
          return {
            accessToken,
            tokenType: "bearer",
            expiresIn: accessTtlLabel,
            user: {
              id: current.id,
              email: current.email,
              role: current.role,
            },
          } satisfies LoginResult;
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof LoginProtectionThrottledError) {
        // Thrown inside the login transaction, so no session was committed and
        // the inherited lock is not reset or extended.
        throw loginThrottled(error.retryAfterSeconds);
      }
      if (error instanceof AuthSessionError) {
        if (error.code === "AUTH_INVALID_CREDENTIALS") {
          // A stale proof detected after the bcrypt check becomes exactly one
          // recorded failure in its own committed transaction.
          return failWithGuard(email);
        }
        throw error;
      }
      throw storeUnavailable();
    }
  }

  async function verifySession(claims: JwtPayload): Promise<SafePrincipal> {
    const checkedAt = now();

    let session: SessionWithUser | null;
    try {
      session = await db.userSession.findUnique({
        where: { id: claims.sessionId },
        include: { user: true },
      });
    } catch {
      throw storeUnavailable();
    }

    if (session === null) {
      throw invalidSession();
    }

    const user = session.user;

    if (session.userId !== claims.sub || user.id !== claims.sub) {
      throw invalidSession();
    }
    if (!user.isActive) {
      throw invalidSession();
    }
    if (session.revokedAt !== null) {
      throw invalidSession();
    }
    if (session.expiresAt.getTime() <= checkedAt.getTime()) {
      throw invalidSession();
    }
    if (
      session.issuedTokenVersion !== claims.tokenVersion ||
      user.tokenVersion !== claims.tokenVersion
    ) {
      throw invalidSession();
    }
    if (user.role !== claims.role) {
      throw invalidSession();
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      sessionId: session.id,
      tokenVersion: user.tokenVersion,
    };
  }

  return { accessTtlSeconds, accessTtlLabel, login, verifySession };
}
