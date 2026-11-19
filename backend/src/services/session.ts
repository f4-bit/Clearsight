import bcrypt from "bcryptjs";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { UserRole } from "../generated/prisma/enums.js";
import type { JwtPayload } from "../schemas/auth.js";
import { MAX_ACCESS_TTL_SECONDS } from "./auth-policy.js";
import { PASSWORD_DUMMY_HASH } from "./password-policy.js";

/** Access token policy is owned by `auth-policy`; the service only consumes it. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LOGIN_PASSWORD_UTF8_BYTES = 72;
export const DEFAULT_DATABASE_SCHEMA = "public";

const LOGIN_AUDIT_ACTION = "AUTH_SESSION_CREATED";
const LOGIN_AUDIT_METADATA = { channel: "password" } as const;
const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials";
const INVALID_SESSION_MESSAGE = "Invalid or expired session";
const STORE_UNAVAILABLE_MESSAGE = "Authentication store is temporarily unavailable";
const TOKEN_ISSUE_MESSAGE = "Access token could not be issued";
const INVALID_ACCESS_TTL_MESSAGE = "accessTtl.seconds must be a positive integer no greater than 900";
const INVALID_SESSION_TTL_MESSAGE =
  "sessionTtlMs must be a positive integer no greater than seven days";
const INVALID_DATABASE_SCHEMA_MESSAGE = "databaseSchema must be a valid PostgreSQL identifier";
const POSTGRES_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;

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
  | "AUTH_SESSION_INVALID"
  | "AUTH_STORE_UNAVAILABLE"
  | "AUTH_TOKEN_ISSUE_FAILED";

/** Stable service error surface; messages never include account or store details. */
export class AuthSessionError extends Error {
  readonly code: AuthSessionErrorCode;

  constructor(code: AuthSessionErrorCode, message: string) {
    super(message);
    this.name = "AuthSessionError";
    this.code = code;
  }
}

const invalidCredentials = () =>
  new AuthSessionError("AUTH_INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
const invalidSession = () => new AuthSessionError("AUTH_SESSION_INVALID", INVALID_SESSION_MESSAGE);
const storeUnavailable = () =>
  new AuthSessionError("AUTH_STORE_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
const tokenIssueFailed = () =>
  new AuthSessionError("AUTH_TOKEN_ISSUE_FAILED", TOKEN_ISSUE_MESSAGE);

export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
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
}

export interface AuthSessionService {
  readonly accessTtlSeconds: number;
  readonly accessTtlLabel: string;
  login(credentials: LoginCredentials, issueAccessToken: AccessTokenIssuer): Promise<LoginResult>;
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
 * Validates a schema name before it is embedded in a qualified raw query.
 * Only ASCII PostgreSQL identifiers of at most 63 bytes are accepted, which
 * excludes NUL, quotes, semicolons and other injection/truncation cases.
 */
export function assertValidDatabaseSchema(schema: string): void {
  if (
    typeof schema !== "string" ||
    schema.length === 0 ||
    Buffer.byteLength(schema, "utf8") > MAX_POSTGRES_IDENTIFIER_BYTES ||
    !POSTGRES_IDENTIFIER_PATTERN.test(schema)
  ) {
    throw new Error(INVALID_DATABASE_SCHEMA_MESSAGE);
  }
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

  async function login(
    credentials: LoginCredentials,
    issueAccessToken: AccessTokenIssuer,
  ): Promise<LoginResult> {
    const issuedAt = now();
    const email = normalizeEmail(credentials?.email);
    if (email === null || !isPasswordWithinBcryptBound(credentials?.password)) {
      throw invalidCredentials();
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

    if (initial === null) {
      // Unknown accounts compare against a precomputed current-policy hash.
      // This approximates the cost-12 path only; malformed/disabled legacy rows
      // and older-cost hashes may differ, so no universal timing-oracle
      // guarantee is claimed.
      await bcrypt.compare(credentials.password, PASSWORD_DUMMY_HASH).catch(() => false);
      throw invalidCredentials();
    }

    const passwordMatches = await bcrypt
      .compare(credentials.password, initial.passwordHash)
      .catch(() => false);
    if (!passwordMatches) {
      throw invalidCredentials();
    }
    if (!initial.isActive) {
      throw invalidCredentials();
    }
    if (initial.lockedUntil !== null && initial.lockedUntil.getTime() > issuedAt.getTime()) {
      throw invalidCredentials();
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
          if (current.lockedUntil !== null && current.lockedUntil.getTime() > issuedAt.getTime()) {
            throw invalidCredentials();
          }
          if (
            current.passwordHash !== initial.passwordHash ||
            current.tokenVersion !== initial.tokenVersion ||
            current.role !== initial.role
          ) {
            throw invalidCredentials();
          }

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
      if (error instanceof AuthSessionError) {
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
