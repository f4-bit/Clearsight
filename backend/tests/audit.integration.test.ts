import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import {
  AuditWriteError,
  withAuditedTransaction,
  writeAuditEvent,
} from "../src/services/audit.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

/** Legitimate DI seam: only the audit delegate of the real transaction fails. */
function auditFailingRoot(base: PrismaClient, canary: string): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = target.$transaction.bind(target) as (
          callback: (tx: unknown) => Promise<unknown>,
          options?: unknown,
        ) => Promise<unknown>;

        return async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          transaction(async (tx) => {
            const guardedTx = new Proxy(tx as object, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === "auditEvent") {
                  return {
                    create: async () => {
                      throw new Error(canary);
                    },
                  };
                }
                const value = Reflect.get(txTarget, txProperty, txReceiver);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            });
            return callback(guardedTx);
          }, options);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("withAuditedTransaction / writeAuditEvent against PostgreSQL", () => {
  it("writes a USER-target row in the wrapper transaction with exact fields and a DB timestamp", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-actor-${randomUUID()}@clearsight.test`,
    });

    const before = Date.now();
    let createdId: string | undefined;
    await withAuditedTransaction(
      prisma,
      async (context) => {
        const created = await context.tx.user.create({
          data: {
            email: `audit-target-${randomUUID()}@clearsight.test`,
            passwordHash: "x",
            fullName: "Synthetic Audit Target",
            role: "OFTALMOLOGO",
          },
          select: { id: true },
        });
        createdId = created.id;

        await writeAuditEvent(context, {
          actorKind: "USER",
          actorUserId: actor.id,
          targetType: "USER",
          targetUserId: created.id,
          targetId: null,
          action: "ADMIN_USER_CREATED",
          outcome: "SUCCESS",
          requestId: REQUEST_ID,
          metadata: {
            channel: "admin-api",
            assignedRole: "OFTALMOLOGO",
            newIsActive: true,
            changedFields: ["role", "isActive"],
            reasonCode: "ADMIN_USER_CREATED",
          },
        });
      },
      { isolationLevel: "ReadCommitted" },
    );
    const after = Date.now();

    expect(await prisma.user.count()).toBe(2);

    const rows = await prisma.$queryRawUnsafe<
      Array<{
        actor_kind: string;
        actor_user_id: string | null;
        target_type: string;
        target_id: string | null;
        target_user_id: string | null;
        action: string;
        outcome: string;
        request_id: string | null;
        metadata: Record<string, unknown>;
        occurred_at: Date;
      }>
    >(
      "SELECT actor_kind, actor_user_id, target_type, target_id, target_user_id, " +
        "action, outcome, request_id, metadata, occurred_at FROM audit_events",
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_kind).toBe("USER");
    expect(row.actor_user_id).toBe(actor.id);
    expect(row.target_type).toBe("USER");
    expect(row.target_user_id).toBe(createdId);
    expect(row.target_id).toBeNull();
    expect(row.action).toBe("ADMIN_USER_CREATED");
    expect(row.outcome).toBe("SUCCESS");
    expect(row.request_id).toBe(REQUEST_ID);
    expect(row.metadata).toEqual({
      channel: "admin-api",
      assignedRole: "OFTALMOLOGO",
      newIsActive: true,
      changedFields: ["role", "isActive"],
      reasonCode: "ADMIN_USER_CREATED",
    });
    expect(row.occurred_at).toBeInstanceOf(Date);
    expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.occurred_at.getTime()).toBeLessThanOrEqual(after + 1_000);
  });

  it("persists an update and its SESSION-target audit in the same committed transaction", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-updater-${randomUUID()}@clearsight.test`,
    });
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-updated-${randomUUID()}@clearsight.test`,
      fullName: "Before Update",
    });
    const session = await prisma.userSession.create({
      data: {
        userId: target.id,
        issuedTokenVersion: target.tokenVersion,
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    await withAuditedTransaction(
      prisma,
      async (context) => {
        await context.tx.user.update({
          where: { id: target.id },
          data: { fullName: "After Update" },
        });

        await writeAuditEvent(context, {
          actorKind: "USER",
          actorUserId: actor.id,
          targetType: "SESSION",
          targetUserId: null,
          targetId: session.id,
          action: "AUTH_SESSION_CREATED",
          outcome: "SUCCESS",
          metadata: { channel: "password", sessionId: session.id },
        });
      },
      { isolationLevel: "ReadCommitted" },
    );

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.fullName).toBe("After Update");

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorKind).toBe("USER");
    expect(audit.actorUserId).toBe(actor.id);
    expect(audit.targetType).toBe("SESSION");
    expect(audit.targetId).toBe(session.id);
    expect(audit.targetUserId).toBeNull();
    expect(audit.action).toBe("AUTH_SESSION_CREATED");
    expect(audit.outcome).toBe("SUCCESS");
    expect(audit.requestId).toBeNull();
    expect(audit.metadata).toEqual({ channel: "password", sessionId: session.id });
  });

  it("rolls back a preceding user create when the audit input is invalid", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-invalid-actor-${randomUUID()}@clearsight.test`,
    });

    await expect(
      withAuditedTransaction(
        prisma,
        async (context) => {
          await context.tx.user.create({
            data: {
              email: `audit-phantom-${randomUUID()}@clearsight.test`,
              passwordHash: "x",
              fullName: "Phantom Target",
              role: "OFTALMOLOGO",
            },
          });

          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.id,
            // Lowercase target type is invalid and must fail before any insert.
            targetType: "user",
            targetUserId: actor.id,
            targetId: null,
            action: "ADMIN_USER_CREATED",
            outcome: "SUCCESS",
            metadata: { channel: "admin-api" },
          });
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_INPUT_INVALID",
      message: "audit input is invalid",
    });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back a preceding user create when the audit store fails", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-store-actor-${randomUUID()}@clearsight.test`,
    });
    const canary = "canary-integration-audit-store-failure";
    const failing = auditFailingRoot(prisma, canary);

    await expect(
      withAuditedTransaction(
        failing,
        async (context) => {
          const created = await context.tx.user.create({
            data: {
              email: `audit-store-phantom-${randomUUID()}@clearsight.test`,
              passwordHash: "x",
              fullName: "Phantom Store Target",
              role: "OFTALMOLOGO",
            },
            select: { id: true },
          });

          await writeAuditEvent(context, {
            actorKind: "SYSTEM",
            actorUserId: null,
            targetType: "USER",
            targetUserId: created.id,
            targetId: null,
            action: "ADMIN_USER_CREATED",
            outcome: "SUCCESS",
            metadata: { channel: "admin-api" },
          });
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_STORE_UNAVAILABLE",
      message: "the audit record could not be written",
    });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("audit_events append-only enforcement", () => {
  it("rejects UPDATE and DELETE and leaves the stored row unchanged", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-immutable-actor-${randomUUID()}@clearsight.test`,
    });
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-immutable-target-${randomUUID()}@clearsight.test`,
    });

    await withAuditedTransaction(
      prisma,
      async (context) => {
        await writeAuditEvent(context, {
          actorKind: "USER",
          actorUserId: actor.id,
          targetType: "USER",
          targetUserId: target.id,
          targetId: null,
          action: "ADMIN_USER_UPDATED",
          outcome: "SUCCESS",
          metadata: { channel: "admin-api", changedFields: ["fullName"] },
        });
      },
      { isolationLevel: "ReadCommitted" },
    );

    const before = await prisma.auditEvent.findFirstOrThrow();

    await expect(
      prisma.$executeRawUnsafe("UPDATE audit_events SET action = 'TAMPERED'"),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe("DELETE FROM audit_events")).rejects.toThrow(
      /append-only/,
    );

    const after = await prisma.auditEvent.findMany();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
    expect(after[0]!.action).toBe("ADMIN_USER_UPDATED");
  });

  it("surfaces writeAuditEvent store failures without leaking the driver cause", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-safe-error-actor-${randomUUID()}@clearsight.test`,
    });
    const canary = "canary postgresql://user:secret@host/db";
    const failing = auditFailingRoot(prisma, canary);

    let caught: unknown;
    try {
      await withAuditedTransaction(
        failing,
        async (context) => {
          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.id,
            targetType: "USER",
            targetUserId: actor.id,
            targetId: null,
            action: "ADMIN_USER_UPDATED",
            outcome: "SUCCESS",
            metadata: { channel: "admin-api" },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditWriteError);
    expect((caught as AuditWriteError).code).toBe("AUDIT_STORE_UNAVAILABLE");
    expect((caught as Error).message).toBe("the audit record could not be written");
    expect((caught as Error).message).not.toContain("canary");
    expect((caught as Error).message).not.toContain("postgresql://");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("aborts a successful callback that wrote no audit event", async () => {
    const email = `audit-no-event-${randomUUID()}@clearsight.test`;

    await expect(
      withAuditedTransaction(
        prisma,
        async (context) => {
          await context.tx.user.create({
            data: {
              email,
              passwordHash: "x",
              fullName: "No Event Target",
              role: "OFTALMOLOGO",
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_EVENT_REQUIRED",
      message: "a sensitive transaction must write at least one audit event",
    });

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("contract 5.5 rollback matrix (QA adversarial)", () => {
  it("rolls back a preceding user create when the callback swallows the audit failure and returns success", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-swallow-actor-${randomUUID()}@clearsight.test`,
    });
    const canary = "canary-swallowed-integration-store-failure";
    const failing = auditFailingRoot(prisma, canary);

    let caught: unknown;
    try {
      await withAuditedTransaction(
        failing,
        async (context) => {
          await context.tx.user.create({
            data: {
              email: `audit-swallow-phantom-${randomUUID()}@clearsight.test`,
              passwordHash: "x",
              fullName: "Phantom Swallowed Target",
              role: "OFTALMOLOGO",
            },
          });
          try {
            await writeAuditEvent(context, {
              actorKind: "SYSTEM",
              actorUserId: null,
              targetType: "USER",
              targetUserId: actor.id,
              targetId: null,
              action: "ADMIN_USER_CREATED",
              outcome: "SUCCESS",
              metadata: { channel: "admin-api" },
            });
          } catch {
            // Deliberately hidden from the wrapper; the transaction must still abort.
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
    expect((caught as Error).message).toBe("the audit record could not be written");
    expect((caught as Error).message).not.toContain(canary);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back a preceding fullName update when the audit input is invalid", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-update-invalid-actor-${randomUUID()}@clearsight.test`,
    });
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-update-invalid-target-${randomUUID()}@clearsight.test`,
      fullName: "Before Invalid Audit",
    });

    await expect(
      withAuditedTransaction(
        prisma,
        async (context) => {
          await context.tx.user.update({
            where: { id: target.id },
            data: { fullName: "After Invalid Audit" },
          });
          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.id,
            targetType: "user",
            targetUserId: target.id,
            targetId: null,
            action: "ADMIN_USER_UPDATED",
            outcome: "SUCCESS",
            metadata: { channel: "admin-api", changedFields: ["fullName"] },
          });
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_INPUT_INVALID",
      message: "audit input is invalid",
    });

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted.fullName).toBe("Before Invalid Audit");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back a preceding fullName update when the audit store fails", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-update-store-actor-${randomUUID()}@clearsight.test`,
    });
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-update-store-target-${randomUUID()}@clearsight.test`,
      fullName: "Before Store Audit",
    });
    const canary = "canary-update-store-failure";
    const failing = auditFailingRoot(prisma, canary);

    await expect(
      withAuditedTransaction(
        failing,
        async (context) => {
          await context.tx.user.update({
            where: { id: target.id },
            data: { fullName: "After Store Audit" },
          });
          await writeAuditEvent(context, {
            actorKind: "USER",
            actorUserId: actor.id,
            targetType: "USER",
            targetUserId: target.id,
            targetId: null,
            action: "ADMIN_USER_UPDATED",
            outcome: "SUCCESS",
            metadata: { channel: "admin-api", changedFields: ["fullName"] },
          });
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_STORE_UNAVAILABLE",
      message: "the audit record could not be written",
    });

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted.fullName).toBe("Before Store Audit");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back a preceding fullName update when the callback swallows the audit failure", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-update-swallow-actor-${randomUUID()}@clearsight.test`,
    });
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-update-swallow-target-${randomUUID()}@clearsight.test`,
      fullName: "Before Swallowed Audit",
    });
    const canary = "canary-update-swallow-failure";
    const failing = auditFailingRoot(prisma, canary);

    let caught: unknown;
    try {
      await withAuditedTransaction(
        failing,
        async (context) => {
          await context.tx.user.update({
            where: { id: target.id },
            data: { fullName: "After Swallowed Audit" },
          });
          try {
            await writeAuditEvent(context, {
              actorKind: "USER",
              actorUserId: actor.id,
              targetType: "USER",
              targetUserId: target.id,
              targetId: null,
              action: "ADMIN_USER_UPDATED",
              outcome: "SUCCESS",
              metadata: { channel: "admin-api", changedFields: ["fullName"] },
            });
          } catch {
            // Deliberately hidden; the wrapper must still abort the transaction.
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
    expect((caught as Error).message).not.toContain(canary);
    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted.fullName).toBe("Before Swallowed Audit");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back a preceding fullName update when the callback writes no audit event", async () => {
    const target = await makeUser(prisma, "OFTALMOLOGO", {
      email: `audit-update-missing-target-${randomUUID()}@clearsight.test`,
      fullName: "Before Missing Audit",
    });

    await expect(
      withAuditedTransaction(
        prisma,
        async (context) => {
          await context.tx.user.update({
            where: { id: target.id },
            data: { fullName: "After Missing Audit" },
          });
          return "success-without-audit";
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toMatchObject({
      code: "AUDIT_EVENT_REQUIRED",
      message: "a sensitive transaction must write at least one audit event",
    });

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted.fullName).toBe("Before Missing Audit");
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("schema defense-in-depth for audit metadata (QA adversarial)", () => {
  it("rejects a whitespace-spaced secret key in metadata via the SQL no-secrets check", async () => {
    const actor = await makeUser(prisma, "ADMIN", {
      email: `audit-sql-canary-${randomUUID()}@clearsight.test`,
    });

    await expect(
      prisma.$executeRawUnsafe(
        "INSERT INTO audit_events " +
          "(actor_kind, actor_user_id, target_type, target_user_id, target_id, action, outcome, metadata) " +
          `VALUES ('USER', '${actor.id}', 'USER', '${actor.id}', NULL, ` +
          "'ADMIN_USER_UPDATED', 'SUCCESS', '{\"sig\" : \"canary-secret\"}')",
      ),
    ).rejects.toThrow(/audit_events_metadata_no_secrets/);

    expect(await prisma.auditEvent.count()).toBe(0);
  });
});
