import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import {
  AuditWriteError,
  type AuditContext,
  withAuditedTransaction,
  writeAuditEvent,
} from "../../src/services/audit.js";

/**
 * QA adversarial layer for hito 5.5 (writeAuditEvent / withAuditedTransaction).
 *
 * Complements tests/unit/audit.test.ts with the contract clauses it does not
 * pin: no runtime context brand, clone rejection while the transaction is
 * live, context deactivation on the error path, strict boundary inputs and the
 * swallowed-validation abort. Every assertion targets observable behavior of
 * the public wrapper API.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

const INPUT_INVALID_MESSAGE = "audit input is invalid";
const TRANSACTION_REQUIRED_MESSAGE =
  "audit writes require an active audited transaction context";

type CreateAudit = (args: { data: Record<string, unknown> }) => Promise<unknown>;

function makeTx(create: CreateAudit = vi.fn(async () => ({}))) {
  const tx = { auditEvent: { create } } as unknown as Prisma.TransactionClient;
  return { tx, create: create as ReturnType<typeof vi.fn> };
}

function makeRootDb(tx: Record<string, unknown>) {
  return {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
}

function runWithAuditContext<T>(
  tx: Record<string, unknown>,
  work: (context: AuditContext) => Promise<T>,
): Promise<T> {
  return withAuditedTransaction(makeRootDb(tx), work, { isolationLevel: "ReadCommitted" });
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    actorKind: "USER",
    actorUserId: ACTOR_ID,
    targetType: "USER",
    targetUserId: TARGET_ID,
    targetId: null,
    action: "ADMIN_USER_UPDATED",
    outcome: "SUCCESS",
    metadata: { channel: "admin-api" },
    ...overrides,
  };
}

async function expectInputRejected(input: unknown): Promise<void> {
  const { tx, create } = makeTx();
  let caught: unknown;
  try {
    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(context, input);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AuditWriteError);
  expect((caught as AuditWriteError).code).toBe("AUDIT_INPUT_INVALID");
  expect((caught as Error).message).toBe(INPUT_INVALID_MESSAGE);
  expect(create).not.toHaveBeenCalled();
}

describe("AuditContext runtime surface", () => {
  it("mints a frozen context exposing only the real tx: no keys beyond tx and no runtime brand symbol", async () => {
    const { tx } = makeTx();
    let context!: AuditContext;
    let txSeenByCallback: unknown;

    await runWithAuditContext(tx, async (inner) => {
      context = inner;
      txSeenByCallback = inner.tx;
      await writeAuditEvent(inner, validInput());
    });

    expect(Object.keys(context)).toEqual(["tx"]);
    // A WeakMap proves membership; a runtime symbol flag would be forgeable.
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(Object.isFrozen(context)).toBe(true);
    // `.tx` is the real interactive-transaction client, not a wrapper object.
    expect(txSeenByCallback).toBe(tx);
    expect(context.tx).toBe(tx);
    expect(context).not.toHaveProperty("numEventsWritten");
    expect(context).not.toHaveProperty("firstAuditFailure");
    expect(context).not.toHaveProperty("closed");
  });

  it("refuses to reassign the exposed tx on the frozen context", async () => {
    const { tx } = makeTx();
    const replacement = { auditEvent: { create: vi.fn(async () => ({})) } };

    await runWithAuditContext(tx, async (context) => {
      expect(() => {
        (context as { tx: unknown }).tx = replacement;
      }).toThrow(TypeError);
      expect(context.tx).toBe(tx);
      await writeAuditEvent(context, validInput());
    });
  });

  it("rejects a shallow clone of a live context before any create and keeps the real context usable", async () => {
    const { tx, create } = makeTx();

    await runWithAuditContext(tx, async (context) => {
      const clone = { ...context } as unknown as AuditContext;

      let caught: unknown;
      try {
        await writeAuditEvent(clone, validInput());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuditWriteError);
      expect((caught as AuditWriteError).code).toBe("AUDIT_TRANSACTION_REQUIRED");
      expect((caught as Error).message).toBe(TRANSACTION_REQUIRED_MESSAGE);
      expect(create).not.toHaveBeenCalled();

      // Identity, not shape, is the credential: the original still writes.
      await writeAuditEvent(context, validInput());
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the context inactive after the callback fails and preserves the domain error", async () => {
    const { tx, create } = makeTx();
    let captured: AuditContext | undefined;
    const domainError = new AuditWriteError("AUDIT_INPUT_INVALID", "domain failure");

    let caught: unknown;
    try {
      await runWithAuditContext(tx, async (context) => {
        captured = context;
        throw domainError;
      });
    } catch (error) {
      caught = error;
    }

    // The domain error propagates unchanged: no overwrite with a missing-audit
    // verdict, even though zero events were written.
    expect(caught).toBe(domainError);

    expect(captured).toBeDefined();
    await expect(writeAuditEvent(captured!, validInput())).rejects.toMatchObject({
      code: "AUDIT_TRANSACTION_REQUIRED",
      message: TRANSACTION_REQUIRED_MESSAGE,
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("writeAuditEvent strict input boundaries", () => {
  it("rejects non-object and empty inputs before any create", async () => {
    for (const input of [null, undefined, 42, "audit-input", [], {}, true]) {
      await expectInputRejected(input);
    }
  });

  it("rejects misspelled outcomes and actor kinds", async () => {
    await expectInputRejected(validInput({ outcome: "Success" }));
    await expectInputRejected(validInput({ outcome: "OK" }));
    await expectInputRejected(validInput({ outcome: "success" }));
    await expectInputRejected(validInput({ actorKind: "Admin" }));
    await expectInputRejected(validInput({ actorKind: "user" }));
  });

  it("rejects whitespace-flavored codes and metadata values", async () => {
    await expectInputRejected(validInput({ action: " ADMIN_BOOTSTRAP" }));
    await expectInputRejected(validInput({ action: "ADMIN BOOTSTRAP" }));
    await expectInputRejected(validInput({ targetType: " USER" }));
    await expectInputRejected(validInput({ metadata: { channel: " password" } }));
    await expectInputRejected(validInput({ metadata: { reasonCode: " ADMIN_ROLE_CHANGE" } }));
    await expectInputRejected(validInput({ metadata: { reasonCode: " " } }));
    await expectInputRejected(validInput({ metadata: { changedFields: [" email"] } }));
    await expectInputRejected(validInput({ metadata: { changedFields: ["email "] } }));
  });

  it("rejects an explicit null requestId instead of treating it as absent", async () => {
    await expectInputRejected(validInput({ requestId: null }));
  });

  it("rejects non-UUID metadata sessionId values", async () => {
    await expectInputRejected(validInput({ metadata: { sessionId: "session-1" } }));
    await expectInputRejected(validInput({ metadata: { sessionId: 42 } }));
  });
});

describe("swallowed validation failure still aborts", () => {
  it("throws the safe validation failure when the callback hides it and returns success", async () => {
    const { tx, create } = makeTx();

    let caught: unknown;
    try {
      await runWithAuditContext(tx, async (context) => {
        try {
          await writeAuditEvent(context, validInput({ action: "not_uppercase" }));
        } catch {
          // Deliberately hidden; the wrapper must still abort.
        }
        return "false-success";
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditWriteError);
    expect((caught as AuditWriteError).code).toBe("AUDIT_INPUT_INVALID");
    expect((caught as Error).message).toBe(INPUT_INVALID_MESSAGE);
    expect(create).not.toHaveBeenCalled();
  });
});
