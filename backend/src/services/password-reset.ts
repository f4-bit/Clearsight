import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { canonicalizeEmail, escapeLiteralLike } from "../lib/canonical-email.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import { passwordSchema } from "../schemas/auth.js";
import { withAuditedTransaction, writeAuditEvent } from "./audit.js";
import { PASSWORD_BCRYPT_COST } from "./password-policy.js";
import {
  createPasswordRecoveryQuotaGuard,
  PasswordRecoveryQuotaInputError,
  PasswordRecoveryQuotaStoreError,
  type PasswordRecoveryQuotaGuard,
} from "./password-recovery-quota.js";
import {
  createDisabledPasswordResetDelivery,
  type PasswordResetDelivery,
} from "./password-reset-delivery.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  isPlausibleRefreshToken,
} from "./refresh-tokens.js";

/** Absolute password-reset lifetime from issuance; never extended. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TOKEN_LENGTH = 43;

const PASSWORD_RESET_AUDIT_CHANNEL = "password-reset";
const PASSWORD_RESET_AUDIT_REASON = "PASSWORD_RESET";
const DELIVERY_FAILURE_REASON = "DELIVERY_FAILED";
const FORGOT_AUDIT_ACTION = "PASSWORD_RESET_REQUESTED";
const RESET_AUDIT_ACTION = "PASSWORD_RESET_COMPLETED";
const DELIVERY_FAILURE_AUDIT_ACTION = "PASSWORD_RESET_DELIVERY_FAILED";

const INVALID_INPUT_MESSAGE = "Invalid password recovery request";
const INVALID_TOKEN_MESSAGE = "Invalid or expired reset token";
const THROTTLED_MESSAGE = "Too many password recovery attempts";
const STORE_UNAVAILABLE_MESSAGE = "Password recovery is temporarily unavailable";

export type PasswordResetErrorCode =
  | "PASSWORD_RESET_INVALID_INPUT"
  | "PASSWORD_RESET_INVALID_TOKEN"
  | "PASSWORD_RESET_THROTTLED"
  | "PASSWORD_RESET_STORE_UNAVAILABLE";

/** Stable service error surface; messages never include account/token details. */
export class PasswordResetError extends Error {
  readonly code: PasswordResetErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: PasswordResetErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "PasswordResetError";
    this.code = code;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export type PasswordResetOperationalFailureCode =
  | "FORGOT_LOOKUP_FAILED"
  | "FORGOT_ISSUANCE_FAILED"
  | "FORGOT_DELIVERY_FAILED"
  | "FORGOT_DELIVERY_COMPENSATION_FAILED";

export interface ForgotPasswordInput {
  readonly email: string;
  readonly clientIp?: string | null;
}

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
  readonly clientIp?: string | null;
}

export interface PasswordResetService {
  /**
   * Always resolves to the uniform 202 acknowledgment after the quota stage.
   * Only quota store failures or throttling are observable as errors.
   */
  forgot(input: ForgotPasswordInput): Promise<void>;
  /** Resolves after an audited reset commit; never creates a session/JWT. */
  reset(input: ResetPasswordInput): Promise<void>;
}

export interface PasswordResetServiceOptions {
  readonly jwtSecret: string;
  readonly databaseSchema?: string;
  readonly now?: () => Date;
  /** Safe default is DISABLED. Tests must explicitly inject the memory sink. */
  readonly delivery?: PasswordResetDelivery;
  /** Trusted seam; defaults to the R1 durable quota guard. */
  readonly quotaGuard?: PasswordRecoveryQuotaGuard;
  /** Safe code-only hook. It must never receive recipient/token/email values. */
  readonly onOperationalFailure?: (code: PasswordResetOperationalFailureCode) => void;
}

interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly tokenVersion: number;
}

interface ResetTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface InitialResetToken extends ResetTokenRecord {
  readonly user: UserRecord;
}

interface IssuedResetToken {
  readonly tokenId: string;
  readonly userId: string;
  readonly recipient: string;
  readonly rawToken: string;
  readonly expiresAt: Date;
}

const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  tokenVersion: true,
} as const;

const RESET_TOKEN_SELECT = {
  id: true,
  userId: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
} as const;

const invalidInput = () =>
  new PasswordResetError("PASSWORD_RESET_INVALID_INPUT", INVALID_INPUT_MESSAGE);
const invalidToken = () =>
  new PasswordResetError("PASSWORD_RESET_INVALID_TOKEN", INVALID_TOKEN_MESSAGE);
const throttled = (retryAfterSeconds: number) =>
  new PasswordResetError("PASSWORD_RESET_THROTTLED", THROTTLED_MESSAGE, retryAfterSeconds);
const storeUnavailable = () =>
  new PasswordResetError("PASSWORD_RESET_STORE_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);

/** Internal control flow for a concurrent account change; never a user error. */
class ForgotAbortError extends Error {
  constructor() {
    super("password reset forgot aborted");
    this.name = "ForgotAbortError";
  }
}

export function generatePasswordResetToken(): string {
  // Reuse the audited opaque-token primitive: 32 CSPRNG bytes -> base64url 43.
  return generateRefreshToken();
}

export function hashPasswordResetToken(token: string): string {
  // Only lowercase SHA-256 is persisted; the raw value never leaves memory.
  return hashRefreshToken(token);
}

export function isPlausiblePasswordResetToken(token: unknown): token is string {
  return isPlausibleRefreshToken(token);
}

function mapQuotaFailure(error: unknown): never {
  if (error instanceof PasswordRecoveryQuotaInputError) {
    throw invalidInput();
  }
  if (error instanceof PasswordRecoveryQuotaStoreError) {
    throw storeUnavailable();
  }
  // Injection/store failures are generic; never expose driver details.
  throw storeUnavailable();
}

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

export function createPasswordResetService(
  db: PrismaClient,
  options: PasswordResetServiceOptions,
): PasswordResetService {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);

  const now = options.now ?? (() => new Date());
  const delivery = options.delivery ?? createDisabledPasswordResetDelivery();
  const quotaGuard =
    options.quotaGuard ??
    createPasswordRecoveryQuotaGuard(db, {
      jwtSecret: options.jwtSecret,
      databaseSchema,
      now,
    });
  const report = (code: PasswordResetOperationalFailureCode): void => {
    try {
      options.onOperationalFailure?.(code);
    } catch {
      // Operational logging must never change the public recovery outcome.
    }
  };

  const usersTable = `"${databaseSchema}"."users"`;
  const resetTokensTable = `"${databaseSchema}"."password_reset_tokens"`;

  async function compensateFailedDelivery(issued: IssuedResetToken): Promise<void> {
    try {
      await withAuditedTransaction(
        db,
        async (context) => {
          const tx = context.tx;
          const revokedAt = now();

          // Conditional, exact-token compensation. A newer token (or any other
          // token) is never touched, even if this delivery failed late. The
          // update is atomic so a concurrently consumed token is not revoked.
          await tx.passwordResetToken.updateMany({
            where: {
              id: issued.tokenId,
              userId: issued.userId,
              revokedAt: null,
              consumedAt: null,
            },
            data: { revokedAt },
          });

          await writeAuditEvent(context, {
            actorKind: "ANONYMOUS",
            actorUserId: null,
            targetType: "USER",
            targetUserId: issued.userId,
            targetId: null,
            action: DELIVERY_FAILURE_AUDIT_ACTION,
            outcome: "FAILURE",
            metadata: {
              channel: PASSWORD_RESET_AUDIT_CHANNEL,
              reasonCode: DELIVERY_FAILURE_REASON,
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch {
      report("FORGOT_DELIVERY_COMPENSATION_FAILED");
    }
  }

  async function forgot(input: ForgotPasswordInput): Promise<void> {
    const email = canonicalizeEmail(input?.email);
    if (email === null) {
      throw invalidInput();
    }

    // IP first and committed in its own transaction, even if email is exhausted.
    let ipDecision;
    try {
      ipDecision = await quotaGuard.reserveForgotIp(input?.clientIp ?? null);
    } catch (error) {
      mapQuotaFailure(error);
    }
    if (!ipDecision.allowed) {
      throw throttled(ipDecision.retryAfterSeconds);
    }

    let emailDecision;
    try {
      emailDecision = await quotaGuard.reserveForgotEmail(email);
    } catch (error) {
      mapQuotaFailure(error);
    }
    if (!emailDecision.allowed) {
      throw throttled(emailDecision.retryAfterSeconds);
    }

    // After both quotas, every delivery/issuance/lookup outcome is the same
    // acknowledgment. The default DISABLED port does not create credentials.
    if (delivery.mode === "DISABLED") {
      return;
    }

    let initial: UserRecord | null;
    try {
      initial = await db.user.findFirst({
        where: {
          email: {
            equals: escapeLiteralLike(email),
            mode: "insensitive",
          },
        },
        select: USER_SELECT,
      });
    } catch {
      report("FORGOT_LOOKUP_FAILED");
      return;
    }
    if (initial === null || !initial.isActive) {
      return;
    }

    let issued: IssuedResetToken;
    try {
      issued = await withAuditedTransaction(
        db,
        async (context) => {
          const tx = context.tx;

          // User first. A concurrent admin change (email/role/isActive) bumps
          // tokenVersion and revokes reset tokens; if it committed first this
          // request must not mint a token linked to the old credential.
          if (!(await lockRow(tx, usersTable, initial.id))) {
            throw new ForgotAbortError();
          }
          const current = await tx.user.findUnique({
            where: { id: initial.id },
            select: USER_SELECT,
          });
          if (
            current === null ||
            !current.isActive ||
            current.tokenVersion !== initial.tokenVersion ||
            current.email !== initial.email ||
            current.role !== initial.role
          ) {
            throw new ForgotAbortError();
          }

          const checkedAt = now();
          const rawToken = generatePasswordResetToken();
          const tokenHash = hashPasswordResetToken(rawToken);
          const expiresAt = new Date(
            checkedAt.getTime() + PASSWORD_RESET_TOKEN_TTL_MS,
          );

          const token = await tx.passwordResetToken.create({
            data: {
              userId: current.id,
              tokenHash,
              createdAt: checkedAt,
              expiresAt,
            },
            select: { id: true },
          });

          // The last token committed under the user lock is the only valid one.
          await tx.passwordResetToken.updateMany({
            where: {
              userId: current.id,
              revokedAt: null,
              id: { not: token.id },
            },
            data: { revokedAt: checkedAt },
          });

          await writeAuditEvent(context, {
            actorKind: "ANONYMOUS",
            actorUserId: null,
            targetType: "USER",
            targetUserId: current.id,
            targetId: null,
            action: FORGOT_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata: { channel: PASSWORD_RESET_AUDIT_CHANNEL },
          });

          return {
            tokenId: token.id,
            userId: current.id,
            recipient: current.email,
            rawToken,
            expiresAt,
          } satisfies IssuedResetToken;
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof ForgotAbortError) {
        return;
      }
      // This includes audit failure: the wrapper rolled the token creation and
      // previous-token revocation back, so nothing is delivered.
      report("FORGOT_ISSUANCE_FAILED");
      return;
    }

    try {
      await delivery.deliver({
        recipient: issued.recipient,
        rawToken: issued.rawToken,
        expiresAt: issued.expiresAt,
      });
    } catch {
      report("FORGOT_DELIVERY_FAILED");
      await compensateFailedDelivery(issued);
    }
  }

  async function reset(input: ResetPasswordInput): Promise<void> {
    if (typeof input?.token !== "string" || input.token.length === 0) {
      throw invalidInput();
    }
    const parsedPassword = passwordSchema.safeParse(input?.newPassword);
    if (!parsedPassword.success) {
      throw invalidInput();
    }

    let ipDecision;
    try {
      ipDecision = await quotaGuard.reserveResetIp(input?.clientIp ?? null);
    } catch (error) {
      mapQuotaFailure(error);
    }
    if (!ipDecision.allowed) {
      throw throttled(ipDecision.retryAfterSeconds);
    }

    if (!isPlausiblePasswordResetToken(input.token)) {
      throw invalidToken();
    }

    const tokenHash = hashPasswordResetToken(input.token);
    let initial: InitialResetToken | null;
    try {
      initial = await db.passwordResetToken.findUnique({
        where: { tokenHash },
        select: {
          ...RESET_TOKEN_SELECT,
          user: { select: USER_SELECT },
        },
      });
    } catch {
      throw storeUnavailable();
    }

    const initialCheckedAt = now();
    if (
      initial === null ||
      initial.user.id !== initial.userId ||
      !initial.user.isActive ||
      initial.consumedAt !== null ||
      initial.revokedAt !== null ||
      initial.expiresAt.getTime() <= initialCheckedAt.getTime()
    ) {
      throw invalidToken();
    }

    // The initial read is a cheap precheck only; it is revalidated under the
    // user and token locks inside the audited transaction.
    let newPasswordHash: string;
    try {
      newPasswordHash = await bcrypt.hash(
        parsedPassword.data,
        PASSWORD_BCRYPT_COST,
      );
    } catch {
      throw storeUnavailable();
    }

    try {
      await withAuditedTransaction(
        db,
        async (context) => {
          const tx = context.tx;

          if (!(await lockRow(tx, usersTable, initial.userId))) {
            throw invalidToken();
          }

          const currentUser = await tx.user.findUnique({
            where: { id: initial.userId },
            select: USER_SELECT,
          });
          if (
            currentUser === null ||
            !currentUser.isActive ||
            currentUser.tokenVersion !== initial.user.tokenVersion ||
            currentUser.email !== initial.user.email ||
            currentUser.role !== initial.user.role
          ) {
            // A concurrent admin/role/email/activation change must win closed.
            throw invalidToken();
          }

          // User -> reset token -> sessions/refresh. This is compatible with the
          // login/refresh and admin lifecycle user-first lock order.
          if (!(await lockRow(tx, resetTokensTable, initial.id))) {
            throw invalidToken();
          }

          const currentToken = await tx.passwordResetToken.findUnique({
            where: { id: initial.id },
            select: RESET_TOKEN_SELECT,
          });
          const checkedAt = now();
          if (
            currentToken === null ||
            currentToken.userId !== currentUser.id ||
            currentToken.consumedAt !== null ||
            currentToken.revokedAt !== null ||
            currentToken.expiresAt.getTime() <= checkedAt.getTime()
          ) {
            throw invalidToken();
          }

          await tx.user.update({
            where: { id: currentUser.id },
            data: {
              passwordHash: newPasswordHash,
              tokenVersion: { increment: 1 },
            },
            select: { id: true },
          });

          await tx.passwordResetToken.update({
            where: { id: currentToken.id },
            data: { consumedAt: checkedAt },
          });

          await tx.passwordResetToken.updateMany({
            where: {
              userId: currentUser.id,
              revokedAt: null,
              id: { not: currentToken.id },
            },
            data: { revokedAt: checkedAt },
          });

          await tx.userSession.updateMany({
            where: { userId: currentUser.id, revokedAt: null },
            data: {
              revokedAt: checkedAt,
              reasonCode: PASSWORD_RESET_AUDIT_REASON,
            },
          });

          await tx.refreshToken.updateMany({
            where: { userId: currentUser.id, revokedAt: null },
            data: { revokedAt: checkedAt },
          });

          await writeAuditEvent(context, {
            actorKind: "ANONYMOUS",
            actorUserId: null,
            targetType: "USER",
            targetUserId: currentUser.id,
            targetId: null,
            action: RESET_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata: {
              channel: PASSWORD_RESET_AUDIT_CHANNEL,
              reasonCode: PASSWORD_RESET_AUDIT_REASON,
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof PasswordResetError) {
        throw error;
      }
      // DB/audit/hash-adjacent failures: rollback already discarded every
      // password/token/session change; no token was consumed.
      throw storeUnavailable();
    }
  }

  return { forgot, reset };
}
