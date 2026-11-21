import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { UserRole } from "../generated/prisma/enums.js";
import { canonicalizeEmail, escapeLiteralLike } from "../lib/canonical-email.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import {
  adminCreateUserRequestSchema,
  adminUpdateUserRequestSchema,
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
  roleEnum,
} from "../schemas/auth.js";
import { ADMIN_LIFECYCLE_LOCK_KEY } from "./admin-bootstrap.js";
import {
  AuditWriteError,
  withAuditedTransaction,
  writeAuditEvent,
  type AuditMetadata,
} from "./audit.js";
import { PASSWORD_BCRYPT_COST } from "./password-policy.js";

/**
 * Controlled administrative provisioning and account lifecycle.
 *
 * The module is dependency-injected, uses only the supplied Prisma client and
 * never reads the env singleton. The caller proves its identity through the
 * authenticated middleware; every mutation re-reads the fresh administrator
 * and session inside the transaction that changes the target account.
 */

const USER_CREATED_AUDIT_ACTION = "USER_CREATED";
const USER_UPDATED_AUDIT_ACTION = "USER_UPDATED";
const USER_UPDATE_DENIED_AUDIT_ACTION = "USER_UPDATE_DENIED";
const ADMIN_AUDIT_CHANNEL = "admin-api";
const ACCOUNT_UPDATED_REASON = "ACCOUNT_UPDATED";
const LAST_ACTIVE_ADMIN_REASON = "LAST_ACTIVE_ADMIN";

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ADMIN_USER_INTERNAL_SELECT = {
  ...ADMIN_USER_SELECT,
  tokenVersion: true,
} as const;

type AdminChangedField = "email" | "fullName" | "role" | "isActive";

export type AdminUsersErrorCode =
  | "ADMIN_INPUT_INVALID"
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_TARGET_NOT_FOUND"
  | "ADMIN_EMAIL_CONFLICT"
  | "ADMIN_LAST_ACTIVE_ADMIN"
  | "ADMIN_STORE_UNAVAILABLE"
  | "ADMIN_AUDIT_FAILED";

const MESSAGES: Record<AdminUsersErrorCode, string> = {
  ADMIN_INPUT_INVALID: "user input is invalid",
  ADMIN_ACCESS_DENIED: "the administrator action is not authorized",
  ADMIN_TARGET_NOT_FOUND: "the requested user does not exist",
  ADMIN_EMAIL_CONFLICT: "a user with this email already exists",
  ADMIN_LAST_ACTIVE_ADMIN: "at least one active administrator is required",
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
const targetNotFound = () => new AdminUsersError("ADMIN_TARGET_NOT_FOUND");
const emailConflict = () => new AdminUsersError("ADMIN_EMAIL_CONFLICT");
const lastActiveAdmin = () => new AdminUsersError("ADMIN_LAST_ACTIVE_ADMIN");
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

export interface AdminUserListResult {
  readonly items: AdminUserRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminUsersServiceOptions {
  /** Must match the injected Prisma client schema; never inferred from search_path. */
  readonly databaseSchema?: string;
  readonly now?: () => Date;
}

export interface AdminUsersService {
  createUser(input: unknown, actor: unknown): Promise<AdminUserRecord>;
  listUsers(query: unknown, actor: unknown): Promise<AdminUserListResult>;
  getUser(id: unknown, actor: unknown): Promise<AdminUserRecord>;
  updateUser(id: unknown, input: unknown, actor: unknown): Promise<AdminUserRecord>;
}

interface ActorUserRecord {
  readonly id: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly tokenVersion: number;
}

interface ActorSessionRecord {
  readonly userId: string;
  readonly issuedTokenVersion: number;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

type UpdateTransactionOutcome =
  | { readonly kind: "updated"; readonly user: AdminUserRecord }
  | { readonly kind: "last-admin-denied" };

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

function toAdminUserRecord(row: {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AdminUserRecord {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isFreshActor(
  actor: AdminActor,
  user: ActorUserRecord | null,
  session: ActorSessionRecord | null,
  checkedAt: Date,
): boolean {
  return (
    user !== null &&
    user.id === actor.userId &&
    user.isActive &&
    user.role === "ADMIN" &&
    user.role === actor.role &&
    user.tokenVersion === actor.tokenVersion &&
    session !== null &&
    session.userId === user.id &&
    session.revokedAt === null &&
    session.expiresAt.getTime() > checkedAt.getTime() &&
    session.issuedTokenVersion === user.tokenVersion
  );
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

  async function requireFreshActor(actorInput: unknown): Promise<AdminActor> {
    const parsed = adminActorSchema.safeParse(actorInput);
    if (!parsed.success) {
      throw accessDenied();
    }
    const actor = parsed.data;

    let user: ActorUserRecord | null;
    let session: ActorSessionRecord | null;
    try {
      user = await db.user.findUnique({
        where: { id: actor.userId },
        select: { id: true, role: true, isActive: true, tokenVersion: true },
      });
      session = await db.userSession.findUnique({
        where: { id: actor.sessionId },
        select: {
          userId: true,
          issuedTokenVersion: true,
          revokedAt: true,
          expiresAt: true,
        },
      });
    } catch {
      throw storeUnavailable();
    }

    if (!isFreshActor(actor, user, session, now())) {
      throw accessDenied();
    }
    return actor;
  }

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

          // Shared lock with bootstrap and account lifecycle mutations.
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
          const actorSession = await tx.userSession.findUnique({
            where: { id: actor.sessionId },
            select: {
              userId: true,
              issuedTokenVersion: true,
              revokedAt: true,
              expiresAt: true,
            },
          });
          if (!isFreshActor(actor, actorUser, actorSession, now())) {
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
            action: USER_CREATED_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata: {
              channel: ADMIN_AUDIT_CHANNEL,
              assignedRole: data.role,
            },
          });

          return toAdminUserRecord(created);
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

  async function listUsers(queryInput: unknown, actorInput: unknown): Promise<AdminUserListResult> {
    const parsedQuery = adminUserListQuerySchema.safeParse(queryInput);
    if (!parsedQuery.success) {
      throw inputInvalid();
    }
    await requireFreshActor(actorInput);

    const { limit, offset, role, isActive, q } = parsedQuery.data;
    const where: Prisma.UserWhereInput = {};
    if (role !== undefined) {
      where.role = role;
    }
    if (isActive !== undefined) {
      where.isActive = isActive;
    }
    if (q !== undefined && q.length > 0) {
      const literal = escapeLiteralLike(q);
      where.OR = [
        { email: { contains: literal, mode: "insensitive" } },
        { fullName: { contains: literal, mode: "insensitive" } },
      ];
    }

    try {
      const [items, total] = await Promise.all([
        db.user.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: limit,
          skip: offset,
          select: ADMIN_USER_SELECT,
        }),
        db.user.count({ where }),
      ]);
      return {
        items: items.map(toAdminUserRecord),
        total,
        limit,
        offset,
      };
    } catch {
      throw storeUnavailable();
    }
  }

  async function getUser(idInput: unknown, actorInput: unknown): Promise<AdminUserRecord> {
    const params = adminUserIdParamsSchema.safeParse({ id: idInput });
    if (!params.success) {
      throw inputInvalid();
    }
    await requireFreshActor(actorInput);

    try {
      const user = await db.user.findUnique({
        where: { id: params.data.id },
        select: ADMIN_USER_SELECT,
      });
      if (user === null) {
        throw targetNotFound();
      }
      return toAdminUserRecord(user);
    } catch (error) {
      if (error instanceof AdminUsersError) {
        throw error;
      }
      throw storeUnavailable();
    }
  }

  async function updateUser(
    idInput: unknown,
    input: unknown,
    actorInput: unknown,
  ): Promise<AdminUserRecord> {
    const params = adminUserIdParamsSchema.safeParse({ id: idInput });
    if (!params.success) {
      throw inputInvalid();
    }
    const parsedInput = adminUpdateUserRequestSchema.safeParse(input);
    if (!parsedInput.success || Object.keys(parsedInput.data).length === 0) {
      throw inputInvalid();
    }
    const parsedActor = adminActorSchema.safeParse(actorInput);
    if (!parsedActor.success) {
      throw accessDenied();
    }

    const targetId = params.data.id;
    const actor = parsedActor.data;
    const patch = parsedInput.data;

    try {
      const outcome = await withAuditedTransaction(
        db,
        async (context): Promise<UpdateTransactionOutcome> => {
          const tx = context.tx;

          // Global lifecycle lock first; create/bootstrap use the same key.
          await tx.$queryRawUnsafe<Array<{ locked: number }>>(
            "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS acquired",
            ADMIN_LIFECYCLE_LOCK_KEY,
          );

          // Lock actor and target together in UUID order to avoid deadlocks.
          const lockedRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${usersTable} WHERE id IN ($1::uuid, $2::uuid) ORDER BY id FOR UPDATE`,
            actor.userId,
            targetId,
          );
          const lockedIds = new Set(lockedRows.map((row) => row.id));
          if (!lockedIds.has(actor.userId)) {
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
          const actorSession = await tx.userSession.findUnique({
            where: { id: actor.sessionId },
            select: {
              userId: true,
              issuedTokenVersion: true,
              revokedAt: true,
              expiresAt: true,
            },
          });

          // Fresh clock after every lock/actor read, before any target entity
          // read. The target miss must not mask an actor that lost permissions
          // while this request waited on the lifecycle locks.
          const checkedAt = now();
          if (!isFreshActor(actor, actorUser, actorSession, checkedAt)) {
            throw accessDenied();
          }
          if (!lockedIds.has(targetId)) {
            throw targetNotFound();
          }

          const target = await tx.user.findUnique({
            where: { id: targetId },
            select: ADMIN_USER_INTERNAL_SELECT,
          });
          if (target === null) {
            throw targetNotFound();
          }

          const newEmail = patch.email ?? target.email;
          const newFullName = patch.fullName ?? target.fullName;
          const newRole = patch.role ?? target.role;
          const newIsActive = patch.isActive ?? target.isActive;

          const emailChanged = patch.email !== undefined && newEmail !== target.email;
          const fullNameChanged = patch.fullName !== undefined && newFullName !== target.fullName;
          const roleChanged = patch.role !== undefined && newRole !== target.role;
          const activeChanged = patch.isActive !== undefined && newIsActive !== target.isActive;

          const changedFields: AdminChangedField[] = [];
          if (emailChanged) changedFields.push("email");
          if (fullNameChanged) changedFields.push("fullName");
          if (roleChanged) changedFields.push("role");
          if (activeChanged) changedFields.push("isActive");

          if (emailChanged) {
            const owner = await tx.user.findFirst({
              where: {
                id: { not: target.id },
                email: {
                  equals: escapeLiteralLike(newEmail),
                  mode: "insensitive",
                },
              },
              select: { id: true },
            });
            if (owner !== null) {
              throw emailConflict();
            }
          }

          // The target leaves the active-admin set only when it is currently an
          // active ADMIN and the proposed state/role removes that status.
          const removesActiveAdmin =
            target.isActive &&
            target.role === "ADMIN" &&
            (!newIsActive || newRole !== "ADMIN");
          if (removesActiveAdmin) {
            const activeAdmins = await tx.user.count({
              where: { role: "ADMIN", isActive: true },
            });
            if (activeAdmins <= 1) {
              await writeAuditEvent(context, {
                actorKind: "USER",
                actorUserId: actor.userId,
                targetType: "USER",
                targetUserId: target.id,
                targetId: null,
                action: USER_UPDATE_DENIED_AUDIT_ACTION,
                outcome: "DENIED",
                metadata: {
                  channel: ADMIN_AUDIT_CHANNEL,
                  changedFields,
                  reasonCode: LAST_ACTIVE_ADMIN_REASON,
                },
              });
              return { kind: "last-admin-denied" };
            }
          }

          // Repeating a deactivation while the account already is inactive must
          // still clean up legacy unrevoked credentials exactly once.
          let cleanupStaleCredentials = false;
          if (
            !activeChanged &&
            patch.isActive === false &&
            target.isActive === false
          ) {
            const [sessions, refreshTokens, resetTokens] = await Promise.all([
              tx.userSession.count({
                where: { userId: target.id, revokedAt: null },
              }),
              tx.refreshToken.count({
                where: { userId: target.id, revokedAt: null },
              }),
              tx.passwordResetToken.count({
                where: { userId: target.id, revokedAt: null },
              }),
            ]);
            cleanupStaleCredentials = sessions + refreshTokens + resetTokens > 0;
          }

          const shouldRevoke =
            emailChanged || roleChanged || activeChanged || cleanupStaleCredentials;

          const updateData: Prisma.UserUpdateInput = {};
          if (emailChanged) updateData.email = newEmail;
          if (fullNameChanged) updateData.fullName = newFullName;
          if (roleChanged) updateData.role = newRole;
          if (activeChanged) updateData.isActive = newIsActive;
          if (shouldRevoke) updateData.tokenVersion = { increment: 1 };

          let updated = target;
          if (Object.keys(updateData).length > 0) {
            updated = await tx.user.update({
              where: { id: target.id },
              data: updateData,
              select: ADMIN_USER_INTERNAL_SELECT,
            });
          }

          if (shouldRevoke) {
            await tx.userSession.updateMany({
              where: { userId: target.id, revokedAt: null },
              data: { revokedAt: checkedAt, reasonCode: ACCOUNT_UPDATED_REASON },
            });
            await tx.refreshToken.updateMany({
              where: { userId: target.id, revokedAt: null },
              data: { revokedAt: checkedAt },
            });
            await tx.passwordResetToken.updateMany({
              where: { userId: target.id, revokedAt: null },
              data: { revokedAt: checkedAt },
            });
          }

          // Authorization change (role or active state in either direction)
          // revokes every outstanding dataset grant in the same transaction, so
          // a role change-back or reactivation can never revive an old approval.
          // Credential/email-only rotation is authentication-only and preserves
          // grants; no clinical inference id enters the account audit metadata.
          if (roleChanged || activeChanged) {
            await tx.inferenceAccessGrant.updateMany({
              where: { recipientUserId: target.id, revokedAt: null },
              data: { revokedAt: checkedAt },
            });
          }

          const metadata: AuditMetadata = {
            channel: ADMIN_AUDIT_CHANNEL,
            changedFields,
          };
          if (roleChanged) {
            metadata.previousRole = target.role;
            metadata.newRole = updated.role;
          }
          if (activeChanged) {
            metadata.previousIsActive = target.isActive;
            metadata.newIsActive = updated.isActive;
          }

          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.userId,
            targetType: "USER",
            targetUserId: target.id,
            targetId: null,
            action: USER_UPDATED_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata,
          });

          return { kind: "updated", user: toAdminUserRecord(updated) };
        },
        { isolationLevel: "ReadCommitted" },
      );

      if (outcome.kind === "last-admin-denied") {
        throw lastActiveAdmin();
      }
      return outcome.user;
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
      throw storeUnavailable();
    }
  }

  return { createUser, listUsers, getUser, updateUser };
}
