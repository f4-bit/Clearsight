import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import {
  AuditWriteError,
  type AuditContext,
  withAuditedTransaction,
  writeAuditEvent,
} from "../../src/services/audit.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const INPUT_INVALID_MESSAGE = "audit input is invalid";
const TRANSACTION_REQUIRED_MESSAGE = "audit writes require an active audited transaction context";
const STORE_UNAVAILABLE_MESSAGE = "the audit record could not be written";
const EVENT_REQUIRED_MESSAGE = "a sensitive transaction must write at least one audit event";

type CreateAudit = (args: { data: Record<string, unknown> }) => Promise<unknown>;

function makeTx(create: CreateAudit = vi.fn(async () => ({}))) {
  const tx = { auditEvent: { create } } as unknown as Prisma.TransactionClient;
  return { tx, create: create as ReturnType<typeof vi.fn> };
}

function makeRootDb(tx: Record<string, unknown>, onTransaction?: (options: unknown) => void) {
  return {
    $transaction: async (
      callback: (client: unknown) => Promise<unknown>,
      options?: unknown,
    ) => {
      onTransaction?.(options);
      return callback(tx);
    },
  } as unknown as PrismaClient;
}

function runWithAuditContext<T>(
  tx: Record<string, unknown>,
  work: (context: AuditContext) => Promise<T>,
): Promise<T> {
  return withAuditedTransaction(makeRootDb(tx), work, { isolationLevel: "ReadCommitted" });
}

function validBootstrapInput(overrides: Record<string, unknown> = {}) {
  return {
    actorKind: "SYSTEM",
    actorUserId: null,
    targetType: "USER",
    targetUserId: TARGET_ID,
    targetId: null,
    action: "ADMIN_BOOTSTRAP",
    outcome: "SUCCESS",
    metadata: { channel: "bootstrap-cli" },
    ...overrides,
  };
}

async function expectInputRejected(input: unknown): Promise<Error> {
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
  return caught as Error;
}

describe("withAuditedTransaction", () => {
  it("opens one public $transaction with the requested options and exposes only the tx context", async () => {
    const { tx, create } = makeTx();
    const optionsSeen: unknown[] = [];
    let exposedKeys: string[] = [];

    await withAuditedTransaction(
      makeRootDb(tx, (options) => optionsSeen.push(options)),
      async (context) => {
        exposedKeys = Object.keys(context);
        await writeAuditEvent(context, validBootstrapInput());
      },
      { isolationLevel: "ReadCommitted" },
    );

    expect(optionsSeen).toEqual([{ isolationLevel: "ReadCommitted" }]);
    expect(exposedKeys).toEqual(["tx"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("requires at least one audit event for a successful callback", async () => {
    const { tx } = makeTx();

    await expect(
      withAuditedTransaction(makeRootDb(tx), async () => "success-without-audit", {
        isolationLevel: "ReadCommitted",
      }),
    ).rejects.toMatchObject({
      code: "AUDIT_EVENT_REQUIRED",
      message: EVENT_REQUIRED_MESSAGE,
    });
  });

  it("propagates a domain error thrown before any mutation or audit", async () => {
    const { tx } = makeTx();
    const domainError = new AuditWriteError("AUDIT_INPUT_INVALID", "domain failure");

    await expect(
      withAuditedTransaction(
        makeRootDb(tx),
        async () => {
          throw domainError;
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toBe(domainError);
  });

  it("aborts when the callback swallows an audit failure and returns a false success", async () => {
    const canary = "canary-swallowed-store-failure";
    const create: CreateAudit = async () => {
      throw new Error(canary);
    };
    const { tx } = makeTx(create);

    let caught: unknown;
    try {
      await withAuditedTransaction(
        makeRootDb(tx),
        async (context) => {
          try {
            await writeAuditEvent(context, validBootstrapInput());
          } catch {
            // Deliberately hidden from the wrapper; it must still abort.
          }
          return "false-success";
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditWriteError);
    expect((caught as AuditWriteError).code).toBe("AUDIT_STORE_UNAVAILABLE");
    expect((caught as Error).message).toBe(STORE_UNAVAILABLE_MESSAGE);
    expect((caught as Error).message).not.toContain(canary);
  });

  it("rejects a context captured after the callback finished", async () => {
    const { tx } = makeTx();
    let captured: AuditContext | undefined;

    await runWithAuditContext(tx, async (context) => {
      captured = context;
      await writeAuditEvent(context, validBootstrapInput());
    });

    expect(captured).toBeDefined();
    await expect(writeAuditEvent(captured!, validBootstrapInput())).rejects.toMatchObject({
      code: "AUDIT_TRANSACTION_REQUIRED",
      message: TRANSACTION_REQUIRED_MESSAGE,
    });
  });
});

describe("writeAuditEvent valid mapping", () => {
  it("maps a SYSTEM bootstrap event to the existing flat create shape and returns void", async () => {
    const { tx, create } = makeTx();

    await runWithAuditContext(tx, async (context) => {
      await expect(writeAuditEvent(context, validBootstrapInput())).resolves.toBeUndefined();
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        actorKind: "SYSTEM",
        actorUserId: null,
        targetType: "USER",
        targetUserId: TARGET_ID,
        targetId: null,
        action: "ADMIN_BOOTSTRAP",
        outcome: "SUCCESS",
        metadata: { channel: "bootstrap-cli" },
      },
    });
    expect(create.mock.calls[0]![0].data).not.toHaveProperty("requestId");
  });

  it("maps a USER session event with the server-supplied request id", async () => {
    const { tx, create } = makeTx();

    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(context, {
        actorKind: "USER",
        actorUserId: ACTOR_ID,
        targetType: "SESSION",
        targetUserId: null,
        targetId: SESSION_ID,
        action: "AUTH_SESSION_CREATED",
        outcome: "SUCCESS",
        requestId: REQUEST_ID,
        metadata: { channel: "password" },
      });
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorKind: "USER",
        actorUserId: ACTOR_ID,
        targetType: "SESSION",
        targetUserId: null,
        targetId: SESSION_ID,
        action: "AUTH_SESSION_CREATED",
        outcome: "SUCCESS",
        requestId: REQUEST_ID,
        metadata: { channel: "password" },
      },
    });
  });

  it("accepts the full structured metadata allowlist", async () => {
    const { tx, create } = makeTx();

    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(context, {
        actorKind: "USER",
        actorUserId: ACTOR_ID,
        targetType: "USER",
        targetUserId: TARGET_ID,
        targetId: null,
        action: "ADMIN_USER_UPDATED",
        outcome: "DENIED",
        metadata: {
          channel: "admin-api",
          assignedRole: "ADMIN",
          previousRole: "OFTALMOLOGO",
          newRole: "ADMIN",
          previousIsActive: true,
          newIsActive: false,
          changedFields: ["role", "isActive"],
          reasonCode: "ADMIN_ROLE_CHANGE",
          sessionId: SESSION_ID,
        },
      });
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: {
          channel: "admin-api",
          assignedRole: "ADMIN",
          previousRole: "OFTALMOLOGO",
          newRole: "ADMIN",
          previousIsActive: true,
          newIsActive: false,
          changedFields: ["role", "isActive"],
          reasonCode: "ADMIN_ROLE_CHANGE",
          sessionId: SESSION_ID,
        },
      }),
    });
  });

  it("defaults omitted metadata to an empty object and omits undefined requestId", async () => {
    const { tx, create } = makeTx();

    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(context, validBootstrapInput({ metadata: undefined }));
    });

    const data = create.mock.calls[0]![0].data;
    expect(data.metadata).toEqual({});
    expect(data).not.toHaveProperty("requestId");
  });

  it("does not mutate the caller input", async () => {
    const { tx } = makeTx();
    const metadata = Object.freeze({ channel: "password", changedFields: Object.freeze(["email"]) });
    const input = Object.freeze({
      actorKind: "USER",
      actorUserId: ACTOR_ID,
      targetType: "USER",
      targetUserId: TARGET_ID,
      targetId: null,
      action: "ADMIN_USER_UPDATED",
      outcome: "SUCCESS",
      requestId: REQUEST_ID,
      metadata,
    });
    const snapshot = structuredClone(input);

    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(context, input);
    });

    expect(input).toEqual(snapshot);
    expect(input.metadata).toBe(metadata);
  });
});

describe("writeAuditEvent actor and target pairing", () => {
  it("requires actorUserId when actorKind is USER", async () => {
    await expectInputRejected(validBootstrapInput({ actorKind: "USER", actorUserId: undefined }));
    await expectInputRejected(validBootstrapInput({ actorKind: "USER", actorUserId: null }));
  });

  it("rejects an actorUserId for SYSTEM and ANONYMOUS", async () => {
    await expectInputRejected(validBootstrapInput({ actorKind: "SYSTEM", actorUserId: ACTOR_ID }));
    await expectInputRejected(validBootstrapInput({ actorKind: "ANONYMOUS", actorUserId: ACTOR_ID }));
  });

  it("requires targetUserId and forbids targetId when targetType is USER", async () => {
    await expectInputRejected(validBootstrapInput({ targetUserId: undefined }));
    await expectInputRejected(validBootstrapInput({ targetUserId: null }));
    await expectInputRejected(validBootstrapInput({ targetId: SESSION_ID }));
  });

  it("rejects targetUserId for non-USER target types", async () => {
    await expectInputRejected(
      validBootstrapInput({
        targetType: "SESSION",
        targetId: SESSION_ID,
        targetUserId: TARGET_ID,
      }),
    );
  });

  it("accepts a non-USER target with targetId null", async () => {
    const { tx, create } = makeTx();
    await runWithAuditContext(tx, async (context) => {
      await writeAuditEvent(
        context,
        validBootstrapInput({ targetType: "SESSION", targetId: null, targetUserId: null }),
      );
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("writeAuditEvent input schema rejections", () => {
  it("enforces uppercase codes and 64-character bounds", async () => {
    await expectInputRejected(validBootstrapInput({ action: "admin_bootstrap" }));
    await expectInputRejected(validBootstrapInput({ targetType: "user" }));
    await expectInputRejected(validBootstrapInput({ action: "a".repeat(65) }));
    await expectInputRejected(validBootstrapInput({ targetType: `A${"B".repeat(64)}` }));
    await expectInputRejected(validBootstrapInput({ action: "_LEADING_UNDERSCORE" }));
  });

  it("rejects malformed UUIDs in every UUID field", async () => {
    await expectInputRejected(validBootstrapInput({ actorKind: "USER", actorUserId: "admin-id" }));
    await expectInputRejected(validBootstrapInput({ targetUserId: "admin-id" }));
    await expectInputRejected(
      validBootstrapInput({ targetType: "SESSION", targetId: "session-id" }),
    );
    await expectInputRejected(validBootstrapInput({ requestId: "request-1" }));
  });

  it("rejects caller-supplied identity and timestamp fields", async () => {
    await expectInputRejected(validBootstrapInput({ id: REQUEST_ID }));
    await expectInputRejected(validBootstrapInput({ occurredAt: new Date().toISOString() }));
    await expectInputRejected(validBootstrapInput({ time: Date.now() }));
  });

  it("rejects unknown metadata keys and nested objects", async () => {
    const canary = "canary-metadata-secret";
    for (const metadata of [
      { email: "canary@example.test" },
      { clientIp: "203.0.113.9" },
      { username: "canary-user" },
      { password: canary },
      { passwordHash: canary },
      { token: canary },
      { signedUrl: "https://example.test/?sig=canary" },
      { clinicalNotes: canary },
      { diagnostic: canary },
      { extra: { channel: "password", secret: canary } },
    ]) {
      const error = await expectInputRejected(validBootstrapInput({ metadata }));
      expect(error.message).not.toContain(canary);
      expect(error.message).not.toContain("canary@example.test");
    }
  });

  it("only accepts known channel labels without echoing the attempted value", async () => {
    const canary = "canary-channel-postgresql://user:secret@host/db";
    const error = await expectInputRejected(validBootstrapInput({ metadata: { channel: canary } }));
    expect(error.message).not.toContain(canary);
    expect(error.message).not.toContain("postgresql://");
  });

  it("validates changedFields values, uniqueness and length", async () => {
    await expectInputRejected(
      validBootstrapInput({ metadata: { changedFields: ["email", "email"] } }),
    );
    await expectInputRejected(
      validBootstrapInput({
        metadata: { changedFields: ["email", "fullName", "role", "isActive", "email"] },
      }),
    );
    await expectInputRejected(
      validBootstrapInput({ metadata: { changedFields: ["password"] } }),
    );
    await expectInputRejected(validBootstrapInput({ metadata: { changedFields: "email" } }));
  });

  it("validates metadata roles and reasonCode shape", async () => {
    await expectInputRejected(validBootstrapInput({ metadata: { assignedRole: "DOCTOR" } }));
    await expectInputRejected(validBootstrapInput({ metadata: { reasonCode: "lower_case" } }));
    await expectInputRejected(validBootstrapInput({ metadata: { reasonCode: "HAS-DASH" } }));
    await expectInputRejected(
      validBootstrapInput({ metadata: { reasonCode: `A${"B".repeat(64)}` } }),
    );
  });

  it("rejects metadata that is not an object", async () => {
    for (const metadata of [null, [], "canary-metadata", 42, true]) {
      await expectInputRejected(validBootstrapInput({ metadata }));
    }
  });
});

describe("writeAuditEvent context guard", () => {
  it("rejects a raw transaction client, root client or made-up object before any create", async () => {
    const { tx, create } = makeTx();
    const root = makeRootDb(tx);
    const madeUp = { tx };

    for (const candidate of [tx, root, madeUp, null, undefined, 42, "context"]) {
      let caught: unknown;
      try {
        await writeAuditEvent(
          candidate as unknown as AuditContext,
          validBootstrapInput(),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuditWriteError);
      expect((caught as AuditWriteError).code).toBe("AUDIT_TRANSACTION_REQUIRED");
      expect((caught as Error).message).toBe(TRANSACTION_REQUIRED_MESSAGE);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rethrows the first failure and never retries inside a failed context", async () => {
    const canary = "canary-first-failure";
    const create: CreateAudit = vi.fn(async () => {
      throw new Error(canary);
    });
    const { tx } = makeTx(create);
    let firstFailure: unknown;

    let caught: unknown;
    try {
      await runWithAuditContext(tx, async (context) => {
        try {
          await writeAuditEvent(context, validBootstrapInput());
        } catch (error) {
          firstFailure = error;
        }
        // A retry must not reach the store and must rethrow the first failure.
        await writeAuditEvent(context, validBootstrapInput());
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(firstFailure);
    expect((caught as AuditWriteError).code).toBe("AUDIT_STORE_UNAVAILABLE");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("writeAuditEvent store failure", () => {
  it("maps a create failure to a constant safe code without leaking the driver cause", async () => {
    const canary = "canary-driver-detail postgresql://user:secret@host/db";
    const create: CreateAudit = vi.fn(async () => {
      throw new Error(canary);
    });
    const { tx } = makeTx(create);

    let caught: unknown;
    try {
      await runWithAuditContext(tx, async (context) => {
        await writeAuditEvent(context, validBootstrapInput());
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditWriteError);
    expect((caught as AuditWriteError).code).toBe("AUDIT_STORE_UNAVAILABLE");
    expect((caught as Error).message).toBe(STORE_UNAVAILABLE_MESSAGE);
    expect((caught as Error).message).not.toContain("canary");
    expect((caught as Error).message).not.toContain("postgresql://");
    expect((caught as Error).cause).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
