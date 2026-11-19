import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { canonicalizeEmail, escapeLiteralLike } from "../lib/canonical-email.js";
import { withAuditedTransaction, writeAuditEvent } from "./audit.js";
import { PASSWORD_BCRYPT_COST } from "./password-policy.js";

/**
 * Controlled first-administrator bootstrap.
 *
 * This module is dependency-injected and intentionally free of the env
 * singleton, dotenv and the process-wide Prisma client. The CLI adapter owns
 * those concerns so the business rules can be unit-tested and the real
 * transaction can be exercised against an ephemeral database.
 */

/** Shared lifecycle lock for the first-admin and future admin mutations. */
export const ADMIN_LIFECYCLE_LOCK_KEY = "clearsight:admin-lifecycle:v1";
/** Backwards-compatible alias for the shared current provisioning cost. */
export const BOOTSTRAP_BCRYPT_COST = PASSWORD_BCRYPT_COST;
export const BOOTSTRAP_MIN_PASSWORD_CODEPOINTS = 12;
export const BOOTSTRAP_MAX_PASSWORD_UTF8_BYTES = 72;
export const BOOTSTRAP_MAX_FULL_NAME_LENGTH = 255;

const BOOTSTRAP_AUDIT_ACTION = "ADMIN_BOOTSTRAP";
const BOOTSTRAP_AUDIT_METADATA = { channel: "bootstrap-cli" } as const;

export type BootstrapAdminErrorCode =
  | "BOOTSTRAP_INPUT_INVALID"
  | "BOOTSTRAP_CONFIG_INVALID"
  | "BOOTSTRAP_ALREADY_INITIALIZED"
  | "BOOTSTRAP_EMAIL_CONFLICT"
  | "BOOTSTRAP_AUDIT_FAILED"
  | "BOOTSTRAP_DATABASE_FAILED"
  | "BOOTSTRAP_DISCONNECT_FAILED"
  | "BOOTSTRAP_UNEXPECTED";

/**
 * Stable error surface. Messages are constant and never include the email,
 * password, hash, DSN or raw driver output.
 */
export class BootstrapAdminError extends Error {
  readonly code: BootstrapAdminErrorCode;

  constructor(code: BootstrapAdminErrorCode, message: string) {
    super(message);
    this.name = "BootstrapAdminError";
    this.code = code;
  }
}

export interface BootstrapAdminInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

export interface NormalizedBootstrapAdminInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

/** Public result deliberately omits the email and every credential. */
export interface BootstrapAdminResult {
  readonly id: string;
  readonly role: "ADMIN";
  readonly createdAt: Date;
}

function inputError(message: string): BootstrapAdminError {
  return new BootstrapAdminError("BOOTSTRAP_INPUT_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalizes email/fullName and enforces the password storage constraints. */
export function validateBootstrapAdminInput(input: unknown): NormalizedBootstrapAdminInput {
  if (!isRecord(input)) {
    throw inputError("bootstrap input must be an object");
  }

  const { email, fullName, password } = input;

  if (typeof email !== "string") {
    throw inputError("email must be a string");
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length === 0 || normalizedEmail.length > 255) {
    throw inputError("email must be a non-empty value of at most 255 characters");
  }
  // Use the same canonical DTO as login: a first admin whose address the login
  // endpoint rejects would be created unusable, so reject it before any DB work.
  if (canonicalizeEmail(normalizedEmail) === null) {
    throw inputError("email must be a valid address");
  }

  if (typeof fullName !== "string") {
    throw inputError("fullName must be a string");
  }
  const normalizedFullName = fullName.trim();
  if (normalizedFullName.length === 0 || normalizedFullName.length > BOOTSTRAP_MAX_FULL_NAME_LENGTH) {
    throw inputError("fullName must be a non-empty value of at most 255 characters");
  }

  if (typeof password !== "string") {
    throw inputError("password must be a string");
  }
  // Bcrypt hashes at most 72 bytes; reject instead of silently truncating.
  if ([...password].length < BOOTSTRAP_MIN_PASSWORD_CODEPOINTS) {
    throw inputError("password must contain at least 12 Unicode code points");
  }
  if (Buffer.byteLength(password, "utf8") > BOOTSTRAP_MAX_PASSWORD_UTF8_BYTES) {
    throw inputError("password must be at most 72 UTF-8 bytes");
  }

  return { email: normalizedEmail, fullName: normalizedFullName, password };
}

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "23505";
}

/**
 * Creates the one and only bootstrap administrator.
 *
 * The password is hashed before the transaction so the secret never enters the
 * database round-trips. A global advisory lock serializes concurrent attempts;
 * under ReadCommitted each statement sees the winner's committed row after the
 * wait instead of a stale SERIALIZABLE snapshot. The user and its audit record
 * share the transaction, so a failed audit rolls the user back.
 */
export async function bootstrapAdmin(
  client: PrismaClient,
  input: unknown,
): Promise<BootstrapAdminResult> {
  const normalized = validateBootstrapAdminInput(input);
  const passwordHash = await bcrypt.hash(normalized.password, BOOTSTRAP_BCRYPT_COST);

  try {
    return await withAuditedTransaction(
      client,
      async (context) => {
        const tx = context.tx;
        // The advisory-lock function returns `void`, which Prisma cannot
        // deserialize. The outer projection keeps the lock side effect while
        // exposing a supported integer column.
        await tx.$queryRawUnsafe<Array<{ locked: number }>>(
          "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS acquired",
          ADMIN_LIFECYCLE_LOCK_KEY,
        );

        const existingAdmin = await tx.user.findFirst({
          where: { role: "ADMIN" },
          select: { id: true },
        });
        if (existingAdmin !== null) {
          throw new BootstrapAdminError(
            "BOOTSTRAP_ALREADY_INITIALIZED",
            "an administrator already exists; bootstrap only runs once",
          );
        }

        const emailOwner = await tx.user.findFirst({
          where: {
            email: {
              equals: escapeLiteralLike(normalized.email),
              mode: "insensitive",
            },
          },
          select: { id: true },
        });
        if (emailOwner !== null) {
          throw new BootstrapAdminError(
            "BOOTSTRAP_EMAIL_CONFLICT",
            "a user with this email already exists",
          );
        }

        const created = await tx.user.create({
          data: {
            email: normalized.email,
            passwordHash,
            fullName: normalized.fullName,
            role: "ADMIN",
            isActive: true,
          },
          select: { id: true, role: true, createdAt: true },
        });

        try {
          await writeAuditEvent(context, {
            actorKind: "SYSTEM",
            actorUserId: null,
            targetType: "USER",
            targetUserId: created.id,
            targetId: null,
            action: BOOTSTRAP_AUDIT_ACTION,
            outcome: "SUCCESS",
            metadata: BOOTSTRAP_AUDIT_METADATA,
          });
        } catch (error) {
          if (error instanceof BootstrapAdminError) {
            throw error;
          }
          throw new BootstrapAdminError(
            "BOOTSTRAP_AUDIT_FAILED",
            "the bootstrap audit record could not be written",
          );
        }

        return {
          id: created.id,
          role: created.role as "ADMIN",
          createdAt: created.createdAt,
        };
      },
      { isolationLevel: "ReadCommitted" },
    );
  } catch (error) {
    if (error instanceof BootstrapAdminError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      throw new BootstrapAdminError(
        "BOOTSTRAP_EMAIL_CONFLICT",
        "a user with this email already exists",
      );
    }
    throw new BootstrapAdminError(
      "BOOTSTRAP_DATABASE_FAILED",
      "the bootstrap transaction could not be completed",
    );
  }
}

export interface SafeBootstrapFailure {
  readonly code: BootstrapAdminErrorCode;
  readonly message: string;
}

/** CLI-facing formatter: stable code/message only, never raw driver text. */
export function safeBootstrapFailure(error: unknown): SafeBootstrapFailure {
  if (error instanceof BootstrapAdminError) {
    return { code: error.code, message: error.message };
  }
  return { code: "BOOTSTRAP_UNEXPECTED", message: "unexpected bootstrap failure" };
}
