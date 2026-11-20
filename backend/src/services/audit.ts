import { z } from "zod";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/**
 * Shared write path for append-only audit records.
 *
 * The module owns both sides of the contract: `withAuditedTransaction` opens a
 * public Prisma interactive transaction and mints an opaque context, and
 * `writeAuditEvent` accepts only a context that is registered as active. The
 * writer never opens a transaction of its own, so the audit row commits with
 * the sensitive operation or the whole transaction rolls back.
 *
 * No Prisma internals, private symbols, environment flags or test-only bypasses
 * are involved. The wrapper uses the public `$transaction` callback API.
 */

export const AUDIT_ACTOR_KINDS = ["USER", "SYSTEM", "ANONYMOUS"] as const;
export const AUDIT_OUTCOMES = ["SUCCESS", "DENIED", "FAILURE"] as const;

/**
 * Reserved channel labels for the current and future sensitive operations.
 * They are stable identifiers, not a claim that every label is implemented.
 */
export const AUDIT_CHANNELS = [
  "bootstrap-cli",
  "password",
  "admin-api",
  "password-reset",
  "refresh",
  "logout",
] as const;

/** Profile fields an admin mutation may describe without exporting values. */
export const AUDIT_CHANGED_FIELDS = ["email", "fullName", "role", "isActive"] as const;

const AUDIT_USER_ROLES = ["ADMIN", "OFTALMOLOGO", "INVESTIGADOR"] as const;

/** Mirrors the SQL check: uppercase code, start letter, at most 64 chars. */
const AUDIT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const AUDIT_CODE_MESSAGE = "must be an uppercase code of at most 64 characters";

export type AuditWriteErrorCode =
  | "AUDIT_INPUT_INVALID"
  | "AUDIT_TRANSACTION_REQUIRED"
  | "AUDIT_STORE_UNAVAILABLE"
  | "AUDIT_EVENT_REQUIRED";

const AUDIT_INPUT_INVALID_MESSAGE = "audit input is invalid";
const AUDIT_TRANSACTION_REQUIRED_MESSAGE =
  "audit writes require an active audited transaction context";
const AUDIT_STORE_UNAVAILABLE_MESSAGE = "the audit record could not be written";
const AUDIT_EVENT_REQUIRED_MESSAGE =
  "a sensitive transaction must write at least one audit event";

/**
 * Stable, caller-safe error surface. Messages are constants and never include
 * raw Zod issues, caller input, driver output or the underlying cause.
 */
export class AuditWriteError extends Error {
  readonly code: AuditWriteErrorCode;

  constructor(code: AuditWriteErrorCode, message: string) {
    super(message);
    this.name = "AuditWriteError";
    this.code = code;
  }
}

/**
 * Metadata allowlist. It intentionally exposes structured security-relevant
 * facts only; raw email, IP, username, password, hashes, tokens, SAS/URLs,
 * diagnostic dumps and clinical notes have no field and unknown nested keys are
 * rejected. This is a positive allowlist, not a universal PII detector.
 */
const auditMetadataSchema = z
  .object({
    channel: z.enum(AUDIT_CHANNELS).optional(),
    assignedRole: z.enum(AUDIT_USER_ROLES).optional(),
    previousRole: z.enum(AUDIT_USER_ROLES).optional(),
    newRole: z.enum(AUDIT_USER_ROLES).optional(),
    previousIsActive: z.boolean().optional(),
    newIsActive: z.boolean().optional(),
    changedFields: z
      .array(z.enum(AUDIT_CHANGED_FIELDS))
      .max(AUDIT_CHANGED_FIELDS.length)
      .refine((fields) => new Set(fields).size === fields.length, {
        message: "changedFields must be unique",
      })
      .optional(),
    reasonCode: z.string().regex(AUDIT_CODE_PATTERN, AUDIT_CODE_MESSAGE).optional(),
    sessionId: z.uuid().optional(),
  })
  .strict();

export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const auditWriteInputSchema = z
  .object({
    actorKind: z.enum(AUDIT_ACTOR_KINDS),
    actorUserId: z.uuid().nullish(),
    targetType: z.string().regex(AUDIT_CODE_PATTERN, AUDIT_CODE_MESSAGE),
    targetUserId: z.uuid().nullish(),
    targetId: z.uuid().nullish(),
    action: z.string().regex(AUDIT_CODE_PATTERN, AUDIT_CODE_MESSAGE),
    outcome: z.enum(AUDIT_OUTCOMES),
    requestId: z.uuid().optional(),
    metadata: auditMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actorKind === "USER") {
      if (value.actorUserId === null || value.actorUserId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["actorUserId"],
          message: "actorUserId is required when actorKind is USER",
        });
      }
    } else if (value.actorUserId !== null && value.actorUserId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["actorUserId"],
        message: "actorUserId must be null unless actorKind is USER",
      });
    }

    if (value.targetType === "USER") {
      if (value.targetUserId === null || value.targetUserId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["targetUserId"],
          message: "targetUserId is required when targetType is USER",
        });
      }
      if (value.targetId !== null && value.targetId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["targetId"],
          message: "targetId must be null when targetType is USER",
        });
      }
    } else if (value.targetUserId !== null && value.targetUserId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["targetUserId"],
        message: "targetUserId must be null unless targetType is USER",
      });
    }
  });

export type AuditWriteInput = z.infer<typeof auditWriteInputSchema>;

const AUDIT_CONTEXT_BRAND: unique symbol = Symbol("clearsight.audit.context");

/**
 * Opaque context minted only by `withAuditedTransaction`. The brand keeps it
 * nominal in TypeScript; the private `WeakMap` keeps it unforgeable at runtime.
 * Only the live transaction client is exposed to the callback.
 */
export interface AuditContext {
  readonly tx: Prisma.TransactionClient;
  readonly [AUDIT_CONTEXT_BRAND]: true;
}

interface AuditContextState {
  readonly tx: Prisma.TransactionClient;
  numEventsWritten: number;
  firstAuditFailure: AuditWriteError | null;
  closed: boolean;
}

/** Identity registry: a context is valid only while its transaction callback runs. */
const activeContexts = new WeakMap<AuditContext, AuditContextState>();

function createAuditContext(tx: Prisma.TransactionClient): AuditContext {
  const context = Object.freeze({ tx }) as AuditContext;
  activeContexts.set(context, {
    tx,
    numEventsWritten: 0,
    firstAuditFailure: null,
    closed: false,
  });
  return context;
}

function transactionRequired(): AuditWriteError {
  return new AuditWriteError(
    "AUDIT_TRANSACTION_REQUIRED",
    AUDIT_TRANSACTION_REQUIRED_MESSAGE,
  );
}

function activeContextState(context: AuditContext): AuditContextState {
  const state = activeContexts.get(context);
  if (state === undefined || state.closed) {
    throw transactionRequired();
  }
  return state;
}

export interface AuditedTransactionOptions {
  readonly isolationLevel: Prisma.TransactionIsolationLevel;
  readonly maxWait?: number;
  readonly timeout?: number;
}

/**
 * Runs `work` inside a public Prisma interactive transaction and supplies the
 * only context the audit writer accepts.
 *
 * The transaction is aborted when:
 * - the callback throws (the domain error is propagated unchanged);
 * - an audit write failed and was swallowed into a false success;
 * - the callback returns success without writing any audit event.
 *
 * The context is unregistered in `finally`, so a context captured after the
 * callback can never write, even if the transaction is still committing.
 */
export async function withAuditedTransaction<T>(
  db: PrismaClient,
  work: (context: AuditContext) => Promise<T>,
  options?: AuditedTransactionOptions,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const context = createAuditContext(tx);
    const state = activeContexts.get(context)!;

    try {
      const result = await work(context);

      // A callback that swallowed a writer failure and returned a false success
      // must still abort: the audit row is mandatory for the sensitive work.
      if (state.firstAuditFailure !== null) {
        throw state.firstAuditFailure;
      }
      if (state.numEventsWritten === 0) {
        throw new AuditWriteError(
          "AUDIT_EVENT_REQUIRED",
          AUDIT_EVENT_REQUIRED_MESSAGE,
        );
      }

      return result;
    } finally {
      state.closed = true;
      activeContexts.delete(context);
    }
  }, options);
}

/**
 * Validates the input and appends one audit row through the wrapper-owned
 * transaction. Validation and store failures are recorded on the context so the
 * wrapper aborts the transaction even if the callback hides the error. Once a
 * context has failed, later writes rethrow the first safe failure instead of
 * retrying within the same doomed transaction.
 */
export async function writeAuditEvent(
  context: AuditContext,
  input: unknown,
): Promise<void> {
  const state = activeContextState(context);

  if (state.firstAuditFailure !== null) {
    throw state.firstAuditFailure;
  }

  let parsed: AuditWriteInput;
  try {
    parsed = auditWriteInputSchema.parse(input);
  } catch {
    const failure = new AuditWriteError("AUDIT_INPUT_INVALID", AUDIT_INPUT_INVALID_MESSAGE);
    state.firstAuditFailure = failure;
    throw failure;
  }

  const data: Prisma.AuditEventUncheckedCreateInput = {
    actorKind: parsed.actorKind,
    actorUserId: parsed.actorUserId ?? null,
    targetType: parsed.targetType,
    targetUserId: parsed.targetUserId ?? null,
    targetId: parsed.targetId ?? null,
    action: parsed.action,
    outcome: parsed.outcome,
    metadata: (parsed.metadata ?? {}) as Prisma.InputJsonValue,
    ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
  };

  try {
    await context.tx.auditEvent.create({ data });
  } catch {
    // The raw driver error may contain SQL, values or DSN fragments. It is
    // intentionally discarded; callers map this stable code to their own
    // transaction-level failure.
    const failure = new AuditWriteError(
      "AUDIT_STORE_UNAVAILABLE",
      AUDIT_STORE_UNAVAILABLE_MESSAGE,
    );
    state.firstAuditFailure = failure;
    throw failure;
  }

  state.numEventsWritten += 1;
}
