import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { UserRole } from "../generated/prisma/enums.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type { JwtPayload } from "../schemas/auth.js";
import { AuditWriteError, withAuditedTransaction, writeAuditEvent } from "./audit.js";
import {
  type AccessTokenIssuer,
  AuthSessionError,
  type SafePrincipal,
} from "./session.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  isPlausibleRefreshToken,
} from "./refresh-tokens.js";

/**
 * Opaque refresh-token rotation and logout.
 *
 * The service shares the injected Prisma client, explicit schema and clock with
 * the access-session service. All mutations run inside `withAuditedTransaction`
 * so a failed audit rolls the mutation back.
 *
 * Lock order is always user -> session -> refresh. This matches the
 * administrative lifecycle (user lock first) and avoids the inversion that a
 * session-first lock would create. An initial unlocked read only yields the
 * candidate ids; every authoritative decision re-reads fresh rows after locks.
 */

const REFRESH_ROTATED_ACTION = "AUTH_REFRESH_ROTATED";
const REFRESH_REUSED_ACTION = "AUTH_REFRESH_REUSED";
const LOGOUT_ACTION = "AUTH_LOGOUT";
const REFRESH_REUSE_REASON = "REFRESH_REUSE";
const LOGOUT_REASON = "LOGOUT";
const REFRESH_CHANNEL = "refresh";
const LOGOUT_CHANNEL = "logout";
const INVALID_SESSION_MESSAGE = "Invalid or expired session";
const STORE_UNAVAILABLE_MESSAGE = "Authentication store is temporarily unavailable";
const TOKEN_ISSUE_MESSAGE = "Access token could not be issued";
const INVALID_ACCESS_TTL_MESSAGE =
  "accessTtl.seconds must be a positive integer no greater than 900";

const MAX_ACCESS_TTL_SECONDS = 900;

const REFRESH_SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
} as const;

const SESSION_SELECT = {
  id: true,
  userId: true,
  issuedTokenVersion: true,
  expiresAt: true,
  revokedAt: true,
} as const;

const USER_SELECT = {
  id: true,
  role: true,
  isActive: true,
  tokenVersion: true,
} as const;

interface RefreshRow {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly issuedTokenVersion: number;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface UserRow {
  readonly id: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly tokenVersion: number;
}

export interface RefreshSecret {
  readonly refreshToken: string;
  readonly refreshMaxAgeSeconds: number;
}

export interface RefreshResult extends RefreshSecret {
  readonly accessToken: string;
  readonly tokenType: "bearer";
  readonly expiresIn: string;
}

export interface AuthWebSessionService {
  refresh(rawRefreshToken: string, issueAccessToken: AccessTokenIssuer): Promise<RefreshResult>;
  logout(principal: SafePrincipal): Promise<void>;
}

export interface AuthWebSessionServiceOptions {
  readonly accessTtl: { readonly seconds: number; readonly label: string };
  readonly databaseSchema?: string;
  readonly now?: () => Date;
}

type RotationOutcome =
  | {
      readonly kind: "rotated";
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly refreshMaxAgeSeconds: number;
    }
  | { readonly kind: "reuse" };

const invalidSession = () =>
  new AuthSessionError("AUTH_SESSION_INVALID", INVALID_SESSION_MESSAGE);
const storeUnavailable = () =>
  new AuthSessionError("AUTH_STORE_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
const tokenIssueFailed = () =>
  new AuthSessionError("AUTH_TOKEN_ISSUE_FAILED", TOKEN_ISSUE_MESSAGE);

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

function maxAgeSeconds(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
}

export function createAuthWebSessionService(
  db: PrismaClient,
  options: AuthWebSessionServiceOptions,
): AuthWebSessionService {
  const accessTtlSeconds = options.accessTtl.seconds;
  const accessTtlLabel = options.accessTtl.label;
  if (
    !Number.isInteger(accessTtlSeconds) ||
    accessTtlSeconds <= 0 ||
    accessTtlSeconds > MAX_ACCESS_TTL_SECONDS
  ) {
    throw new Error(INVALID_ACCESS_TTL_MESSAGE);
  }

  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const now = options.now ?? (() => new Date());

  const usersTable = `"${databaseSchema}"."users"`;
  const sessionsTable = `"${databaseSchema}"."user_sessions"`;
  const refreshTable = `"${databaseSchema}"."refresh_tokens"`;

  async function lockRow(
    tx: Prisma.TransactionClient,
    table: string,
    id: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
      id,
    );
    return rows.length === 1;
  }

  async function revokeFamilyInTransaction(
    context: Parameters<typeof writeAuditEvent>[0],
    tx: Prisma.TransactionClient,
    user: UserRow,
    session: SessionRow,
    revokedAt: Date,
  ): Promise<void> {
    if (session.revokedAt === null) {
      await tx.userSession.update({
        where: { id: session.id },
        data: { revokedAt, reasonCode: REFRESH_REUSE_REASON },
      });
    }
    await tx.refreshToken.updateMany({
      where: { sessionId: session.id, revokedAt: null },
      data: { revokedAt },
    });

    await writeAuditEvent(context, {
      actorKind: "USER",
      actorUserId: user.id,
      targetType: "SESSION",
      targetId: session.id,
      targetUserId: null,
      action: REFRESH_REUSED_ACTION,
      outcome: "DENIED",
      metadata: {
        channel: REFRESH_CHANNEL,
        reasonCode: REFRESH_REUSE_REASON,
        sessionId: session.id,
      },
    });
  }

  async function rotate(
    seed: RefreshRow,
    issueAccessToken: AccessTokenIssuer,
  ): Promise<RefreshResult> {
    try {
      const outcome = await withAuditedTransaction<RotationOutcome>(
        db,
        async (context) => {
          const tx = context.tx;

          if (!(await lockRow(tx, usersTable, seed.userId))) {
            throw invalidSession();
          }
          if (!(await lockRow(tx, sessionsTable, seed.sessionId))) {
            throw invalidSession();
          }
          if (!(await lockRow(tx, refreshTable, seed.id))) {
            throw invalidSession();
          }

          const user = await tx.user.findUnique({
            where: { id: seed.userId },
            select: USER_SELECT,
          });
          const session = await tx.userSession.findUnique({
            where: { id: seed.sessionId },
            select: SESSION_SELECT,
          });
          const token = await tx.refreshToken.findUnique({
            where: { id: seed.id },
            select: REFRESH_SELECT,
          });

          if (user === null || session === null || token === null) {
            throw invalidSession();
          }

          const checkedAt = now();
          if (
            !user.isActive ||
            session.revokedAt !== null ||
            session.expiresAt.getTime() <= checkedAt.getTime() ||
            session.userId !== user.id ||
            session.issuedTokenVersion !== user.tokenVersion ||
            token.userId !== user.id ||
            token.sessionId !== session.id ||
            token.expiresAt.getTime() <= checkedAt.getTime()
          ) {
            throw invalidSession();
          }

          // The initial read was unlocked. Another request may have consumed or
          // revoked the token before this transaction acquired the locks.
          if (token.consumedAt !== null || token.revokedAt !== null) {
            await revokeFamilyInTransaction(context, tx, user, session, checkedAt);
            return { kind: "reuse" };
          }

          const nextRaw = generateRefreshToken();
          const childExpiresAt = session.expiresAt;

          await tx.refreshToken.create({
            data: {
              userId: user.id,
              sessionId: session.id,
              parentTokenId: token.id,
              tokenHash: hashRefreshToken(nextRaw),
              createdAt: checkedAt,
              expiresAt: childExpiresAt,
            },
          });
          await tx.refreshToken.update({
            where: { id: token.id },
            data: { consumedAt: checkedAt },
          });

          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: user.id,
            targetType: "SESSION",
            targetId: session.id,
            targetUserId: null,
            action: REFRESH_ROTATED_ACTION,
            outcome: "SUCCESS",
            metadata: {
              channel: REFRESH_CHANNEL,
              sessionId: session.id,
            },
          });

          const claims: JwtPayload = {
            sub: user.id,
            role: user.role,
            sessionId: session.id,
            tokenVersion: user.tokenVersion,
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

          return {
            kind: "rotated",
            accessToken,
            refreshToken: nextRaw,
            refreshMaxAgeSeconds: maxAgeSeconds(childExpiresAt, checkedAt),
          };
        },
        { isolationLevel: "ReadCommitted" },
      );

      if (outcome.kind === "reuse") {
        // The revocation and its audit row are already committed; only now the
        // caller receives the generic 401. Throwing inside the transaction here
        // would roll the revocation back.
        throw invalidSession();
      }

      return {
        accessToken: outcome.accessToken,
        tokenType: "bearer",
        expiresIn: accessTtlLabel,
        refreshToken: outcome.refreshToken,
        refreshMaxAgeSeconds: outcome.refreshMaxAgeSeconds,
      };
    } catch (error) {
      if (error instanceof AuthSessionError) {
        throw error;
      }
      if (error instanceof AuditWriteError) {
        throw storeUnavailable();
      }
      if (isUniqueViolation(error)) {
        // A second successor for the same parent is never created; the unique
        // parent pointer turns the race into a generic invalid session.
        throw invalidSession();
      }
      throw storeUnavailable();
    }
  }

  async function refresh(
    rawRefreshToken: string,
    issueAccessToken: AccessTokenIssuer,
  ): Promise<RefreshResult> {
    if (!isPlausibleRefreshToken(rawRefreshToken)) {
      throw invalidSession();
    }

    let seed: RefreshRow | null;
    try {
      seed = await db.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(rawRefreshToken) },
        select: REFRESH_SELECT,
      });
    } catch {
      throw storeUnavailable();
    }

    if (seed === null) {
      throw invalidSession();
    }

    const checkedAt = now();
    if (seed.expiresAt.getTime() <= checkedAt.getTime()) {
      throw invalidSession();
    }

    // A consumed/revoked token is a reuse signal. The revocation still runs a
    // transaction and commits before the caller sees 401.
    if (seed.consumedAt !== null || seed.revokedAt !== null) {
      try {
        const outcome = await withAuditedTransaction<"reuse">(
          db,
          async (context) => {
            const tx = context.tx;
            if (!(await lockRow(tx, usersTable, seed!.userId))) {
              throw invalidSession();
            }
            if (!(await lockRow(tx, sessionsTable, seed!.sessionId))) {
              throw invalidSession();
            }

            const user = await tx.user.findUnique({
              where: { id: seed!.userId },
              select: USER_SELECT,
            });
            const session = await tx.userSession.findUnique({
              where: { id: seed!.sessionId },
              select: SESSION_SELECT,
            });
            if (user === null || session === null || session.userId !== user.id) {
              throw invalidSession();
            }

            await revokeFamilyInTransaction(context, tx, user, session, now());
            return "reuse";
          },
          { isolationLevel: "ReadCommitted" },
        );
        if (outcome === "reuse") {
          throw invalidSession();
        }
      } catch (error) {
        if (error instanceof AuthSessionError) {
          throw error;
        }
        if (error instanceof AuditWriteError) {
          throw storeUnavailable();
        }
        throw storeUnavailable();
      }
    }

    return rotate(seed, issueAccessToken);
  }

  async function logout(principal: SafePrincipal): Promise<void> {
    const checkedAt = now();

    let initial: SessionRow | null;
    try {
      initial = await db.userSession.findUnique({
        where: { id: principal.sessionId },
        select: SESSION_SELECT,
      });
    } catch {
      throw storeUnavailable();
    }

    if (
      initial === null ||
      initial.userId !== principal.id ||
      initial.revokedAt !== null ||
      initial.expiresAt.getTime() <= checkedAt.getTime()
    ) {
      throw invalidSession();
    }

    try {
      await withAuditedTransaction(
        db,
        async (context) => {
          const tx = context.tx;

          if (!(await lockRow(tx, usersTable, principal.id))) {
            throw invalidSession();
          }
          if (!(await lockRow(tx, sessionsTable, principal.sessionId))) {
            throw invalidSession();
          }

          const user = await tx.user.findUnique({
            where: { id: principal.id },
            select: USER_SELECT,
          });
          const session = await tx.userSession.findUnique({
            where: { id: principal.sessionId },
            select: SESSION_SELECT,
          });

          const revokedAt = now();
          if (
            user === null ||
            session === null ||
            !user.isActive ||
            session.userId !== user.id ||
            session.revokedAt !== null ||
            session.expiresAt.getTime() <= revokedAt.getTime() ||
            session.issuedTokenVersion !== user.tokenVersion ||
            user.tokenVersion !== principal.tokenVersion ||
            user.role !== principal.role
          ) {
            throw invalidSession();
          }

          await tx.userSession.update({
            where: { id: session.id },
            data: { revokedAt, reasonCode: LOGOUT_REASON },
          });
          await tx.refreshToken.updateMany({
            where: { sessionId: session.id, revokedAt: null },
            data: { revokedAt },
          });

          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: user.id,
            targetType: "SESSION",
            targetId: session.id,
            targetUserId: null,
            action: LOGOUT_ACTION,
            outcome: "SUCCESS",
            metadata: {
              channel: LOGOUT_CHANNEL,
              reasonCode: LOGOUT_REASON,
              sessionId: session.id,
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof AuthSessionError) {
        throw error;
      }
      if (error instanceof AuditWriteError) {
        throw storeUnavailable();
      }
      throw storeUnavailable();
    }
  }

  return { refresh, logout };
}
