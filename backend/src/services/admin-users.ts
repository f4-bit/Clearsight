import bcrypt from "bcryptjs";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { UserRole } from "../generated/prisma/enums.js";
import { canonicalizeEmail, escapeLiteralLike } from "../lib/canonical-email.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import {
  adminCreateUserRequestSchema,
  roleEnum,
} from "../schemas/auth.js";
import { ADMIN_LIFECYCLE_LOCK_KEY } from "./admin-bootstrap.js";
import { AuditWriteError, withAuditedTransaction, writeAuditEvent } from "./audit.js";
import { PASSWORD_BCRYPT_COST } from "./password-policy.js";

/**
 * Controlled administrative provisioning (`POST /admin/users`).
 *
 * The module is dependency-injected, uses only the supplied Prisma client and
 * never reads the env singleton. The caller proves its identity through the
 * authenticated middleware; this service re-reads the fresh administrator and
 * session inside the same transaction that creates the target account, so a
 * principal that changes between middleware and transaction is rejected.
 */

const ADMIN_AUDIT_ACTION = "USER_CREATED";
const ADMIN_AUDIT_CHANNEL = "admin-api";

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AdminUsersErrorCode =
  | "ADMIN_INPUT_INVALID"
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_EMAIL_CONFLICT"
  | "ADMIN_STORE_UNAVAILABLE"
  | "ADMIN_AUDIT_FAILED";

const MESSAGES: Record<AdminUsersErrorCode, string> = {
  ADMIN_INPUT_INVALID: "user input is invalid",
  ADMIN_ACCESS_DENIED: "the administrator action is not authorized",
  ADMIN_EMAIL_CONFLICT: "a user with this email already exists",
  ADMIN_STORE_UNAVAILABLE: "the user administration store is temporarily unavailable",
  ADMIN_AUDIT_FAILED: "the user administration audit record could not be written",
};

/** Stable caller-safe error surface; no input, hash, token or driver output. */
export class AdminUsersError extends Error {
  readonly code: AdminUsersErrorCode;

  constructor(code: AdminUsersErrorCode) {
    super(MESSAGES[code]);
    this.name = "AdminUsersError";
    this.code = code;
  }
}

const inputInvalid = () => new AdminUsersError("ADMIN_INPUT_INVALID");
const accessDenied = () => new AdminUsersError("ADMIN_ACCESS_DENIED");
const emailConflict = () => new AdminUsersError("ADMIN_EMAIL_CONFLICT");
const storeUnavailable = () => new AdminUsersError("ADMIN_STORE_UNAVAILABLE");
const auditFailed = () => new AdminUsersError("ADMIN_AUDIT_FAILED");

const adminActorSchema = z
  .object({
    userId: z.uuid(),
    role: roleEnum,
    sessionId: z.uuid(),
    tokenVersion: z.number().int().min(0),
  })
  .strict();

export interface AdminActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
  readonly tokenVersion: number;
}

export interface AdminUserRecord {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminUsersServiceOptions {
  /** Must match the injected Prisma client schema; never inferred from search_path. */
  readonly databaseSchema?: string;
  readonly now?: () => Date;
}

export interface AdminUsersService {
  createUser(input: unknown, actor: unknown): Promise<AdminUserRecord>;
}

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

export function createAdminUsersService(
  db: PrismaClient,
  options: AdminUsersServiceOptions = {},
): AdminUsersService {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const usersTable = `"${databaseSchema}"."users"`;
  const sessionsTable = `"${databaseSchema}"."user_sessions"`;
  const now = options.now ?? (() => new Date());

  async function createUser(input: unknown, actorInput: unknown): Promise<AdminUserRecord> {
    const parsedInput = adminCreateUserRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw inputInvalid();
    }
    const parsedActor = adminActorSchema.safeParse(actorInput);
    if (!parsedActor.success) {
      throw accessDenied();
    }

    const data = parsedInput.data;
    const actor = parsedActor.data;
    const email = canonicalizeEmail(data.email);
    if (email === null) {
      // Defensive: the shared DTO already guaranteed this.
      throw inputInvalid();
    }

    // The KDF runs before the transaction and after pure validation. A caller
    // denied later never receives the hash and no partial row can exist.
    let passwordHash: string;
    try {
      passwordHash = await bcrypt.hash(data.password, PASSWORD_BCRYPT_COST);
    } catch {
      throw storeUnavailable();
    }

    try {
      return await withAuditedTransaction(
        db,
        async (context) => {
          const tx = context.tx;

          // Shared lock with the bootstrap CLI: two creators (or a creator and
          // bootstrap) serialize globally, so a case/duplicate race cannot
          // produce two accounts and bootstrap cannot miss a just-created admin.
          await tx.$queryRawUnsafe<Array<{ locked: number }>>(
            "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS acquired",
            ADMIN_LIFECYCLE_LOCK_KEY,
          );

          // Lock the actor row first, then its session. Reads after the locks
          // observe any concurrently committed role/version/deactivation/revoke.
          const actorUserLock = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${usersTable} WHERE id = $1::uuid FOR UPDATE`,
            actor.userId,
          );
          if (actorUserLock.length !== 1) {
            throw accessDenied();
          }

          const actorSessionLock = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${sessionsTable} WHERE id = $1::uuid FOR UPDATE`,
            actor.sessionId,
          );
          if (actorSessionLock.length !== 1) {
            throw accessDenied();
          }

          const actorUser = await tx.user.findUnique({
            where: { id: actor.userId },
            select: { id: true, role: true, isActive: true, tokenVersion: true },
          });
          if (
            actorUser === null ||
            !actorUser.isActive ||
            actorUser.role !== "ADMIN" ||
            actorUser.role !== actor.role ||
            actorUser.tokenVersion !== actor.tokenVersion
          ) {
            throw accessDenied();
          }

          const actorSession = await tx.userSession.findUnique({
            where: { id: actor.sessionId },
            select: {
              userId: true,
              issuedTokenVersion: true,
              revokedAt: true,
              expiresAt: true,
            },
          });
          const checkedAt = now();
          if (
            actorSession === null ||
            actorSession.userId !== actorUser.id ||
            actorSession.revokedAt !== null ||
            actorSession.expiresAt.getTime() <= checkedAt.getTime() ||
            actorSession.issuedTokenVersion !== actorUser.tokenVersion
          ) {
            throw accessDenied();
          }

          // Literal, case-insensitive match. Escaping prevents `_`/`%` in the
          // caller value from widening the match under the current provider.
          const existing = await tx.user.findFirst({
            where: {
              email: { equals: escapeLiteralLike(email), mode: "insensitive" },
            },
            select: { id: true },
          });
          if (existing !== null) {
            // No upsert and no role promotion of an existing ordinary user.
            throw emailConflict();
          }

          const created = await tx.user.create({
            data: {
              email,
              passwordHash,
              fullName: data.fullName,
              role: data.role,
              isActive: true,
            },
            select: ADMIN_USER_SELECT,
          });

          // Account creation never emits a JWT. The audit row shares this
          // transaction, so an audit failure aborts the target user as well.
          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.userId,
            targetType: "USER",
            targetUserId: created.id,
            targetId: null,
            action: ADMIN_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata: {
              channel: ADMIN_AUDIT_CHANNEL,
              assignedRole: data.role,
            },
          });

          return created;
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof AdminUsersError) {
        throw error;
      }
      if (error instanceof AuditWriteError) {
        throw auditFailed();
      }
      if (isUniqueViolation(error)) {
        throw emailConflict();
      }
      // Raw driver/database messages are intentionally never forwarded.
      throw storeUnavailable();
    }
  }

  return { createUser };
}
