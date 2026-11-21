import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { Prisma } from "../src/generated/prisma/client.js";
import { createIdempotencyRepository } from "../src/repositories/idempotency.repo.js";
import { createInferenceDispatchService } from "../src/services/inference-dispatch.js";
import { createTestPrisma, makeUser, resetDb, testDatabaseUrl } from "./helpers/db.js";
import { FEATURES } from "./fixtures/clinical.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "./helpers/ml.js";
import { migrationNames, migrationSql } from "./helpers/migrations.js";
import { startDispatchReconciler } from "../src/workers/inference.reconciler.js";

const MIGRATION = "20261121000000_inference_dispatch";
const prisma = createTestPrisma();
const prepared = makePreparedSnapshot(FEATURES);
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
});

beforeEach(async () => {
  await resetDb(prisma);
});

afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

async function createPendingExecution(options: {
  status?: string;
} = {}) {
  const doctor = await makeUser(prisma, "OFTALMOLOGO");
  const patient = await prisma.patient.create({
    data: { ownerDoctorId: doctor.id },
  });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      status: "COMPLETED",
      clinicalData: FEATURES as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: "OD",
      storagePath: `2026/11/${randomUUID()}.jpg`,
    },
  });
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: consultation.id,
      rawPayload: {
        eyeSide: "OD",
        clinicalFeatures: FEATURES,
      } as Prisma.InputJsonValue,
      normalizedPayload: {
        ...prepared.normalizedPayload,
        eyeSide: "OD",
      } as Prisma.InputJsonValue,
      schemaVersion: "ml-zscore-f32-v1",
      modelVersions: prepared.modelVersions as Prisma.InputJsonValue,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide: "OD",
      snapshotId: snapshot.id,
      status: options.status ?? "QUEUED",
      modelVersion: FAKE_MANIFEST_VERSION,
    },
  });
  const record = await prisma.idempotencyRecord.create({
    data: {
      actorUserId: doctor.id,
      scope: "inferences:create:v1",
      key: `dispatch-${randomUUID()}`,
      payloadHash: "a".repeat(64),
      inferenceId: inference.id,
      resolvedModelVersions: prepared.modelVersions as Prisma.InputJsonValue,
      state: "PENDING",
    },
  });
  return { doctor, consultation, image, snapshot, inference, record };
}

function makeReconciler(enqueueError = false) {
  const repository = createIdempotencyRepository(prisma);
  const signMlDownloadUrl = vi.fn(
    async () => "https://signed.test/fresh.png",
  );
  const enqueue = vi.fn(async () => {
    if (enqueueError) throw new Error("queue down");
    return { id: randomUUID() };
  });
  const service = createInferenceDispatchService({
    prisma,
    repository,
    signMlDownloadUrl,
    enqueue,
  });
  const reconciler = startDispatchReconciler({
    repository,
    dispatch: (record) => service.dispatchPendingExecution(record),
    intervalMs: 0,
    batchSize: 10,
    logger: vi.fn(),
  });
  return { repository, signMlDownloadUrl, enqueue, reconciler };
}

describe("inference dispatch reconciliation", () => {
  it("replays the migration idempotently and verifies columns, index and grants", async () => {
    const sql = migrationSql(MIGRATION);
    await client.query(sql);
    await client.query(sql);

    const columns = await client.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'idempotency_records'
          AND column_name IN (
            'dispatch_attempts', 'next_dispatch_at', 'lease_until', 'last_error_code'
          )
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      {
        column_name: "dispatch_attempts",
        is_nullable: "NO",
        column_default: "0",
      },
      {
        column_name: "last_error_code",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "lease_until",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "next_dispatch_at",
        is_nullable: "NO",
        column_default: "now()",
      },
    ]);

    const index = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'idempotency_records'
          AND indexname = 'idx_idempotency_records_pending_dispatch'`,
    );
    expect(index.rows[0]?.indexdef).toContain("PENDING");
    expect(index.rows[0]?.indexdef).toContain("next_dispatch_at");

    const privileges = await client.query(
      `SELECT
         has_column_privilege('clearsight_app', 'idempotency_records', 'dispatch_attempts', 'UPDATE') AS attempts_update,
         has_column_privilege('clearsight_app', 'idempotency_records', 'next_dispatch_at', 'UPDATE') AS next_update,
         has_column_privilege('clearsight_app', 'idempotency_records', 'lease_until', 'UPDATE') AS lease_update,
         has_column_privilege('clearsight_app', 'idempotency_records', 'last_error_code', 'UPDATE') AS error_update,
         has_table_privilege('clearsight_app', 'idempotency_records', 'DELETE') AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      attempts_update: true,
      next_update: true,
      lease_update: true,
      error_update: true,
      can_delete: false,
    });
  });

  it("recovers an old PENDING record exactly once", async () => {
    const execution = await createPendingExecution();
    const harness = makeReconciler();

    await harness.reconciler.runOnce();
    await harness.reconciler.runOnce();
    harness.reconciler.stop();

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(harness.signMlDownloadUrl).toHaveBeenCalledWith(
      execution.image.storagePath,
    );
    const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: execution.record.id },
    });
    expect(stored.state).toBe("ACCEPTED");
    expect(stored.leaseUntil).toBeNull();
    expect(stored.dispatchAttempts).toBe(0);
    expect(stored.responseBody).toEqual({
      inferenceId: execution.inference.id,
      jobId: execution.inference.id,
      status: "QUEUED",
    });
  });

  it("marks an already terminal execution accepted without enqueueing", async () => {
    const execution = await createPendingExecution({ status: "COMPLETED" });
    const harness = makeReconciler();

    await harness.reconciler.runOnce();
    harness.reconciler.stop();

    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: execution.record.id },
    });
    expect(stored.state).toBe("ACCEPTED");
  });

  it("leaves a queue failure PENDING with attempts, backoff and no duplicate", async () => {
    const execution = await createPendingExecution();
    const harness = makeReconciler(true);

    await harness.reconciler.runOnce();
    harness.reconciler.stop();

    const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: execution.record.id },
    });
    expect(stored.state).toBe("PENDING");
    expect(stored.dispatchAttempts).toBe(1);
    expect(stored.leaseUntil).toBeNull();
    expect(stored.lastErrorCode).toBe("enqueue_failed");
    expect(stored.nextDispatchAt.getTime()).toBeGreaterThan(
      stored.createdAt.getTime(),
    );
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("claims every due row exactly once across two concurrent replicas", async () => {
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      rows.push(await createPendingExecution());
    }
    const repository = createIdempotencyRepository(prisma);

    const [first, second] = await Promise.all([
      repository.claimPendingDispatchBatch(3),
      repository.claimPendingDispatchBatch(3),
    ]);

    const claimedIds = [...first, ...second].map((row) => row.id);
    expect(claimedIds).toHaveLength(3);
    expect(new Set(claimedIds).size).toBe(3);
    for (const row of rows) {
      expect(claimedIds).toContain(row.record.id);
    }
  });

  it("holds the claim lease until expiry and reclaims only after it lapses", async () => {
    const execution = await createPendingExecution();
    const repository = createIdempotencyRepository(prisma);

    const first = await repository.claimPendingDispatchBatch(10);
    expect(first.map((row) => row.id)).toEqual([execution.record.id]);
    expect(first[0]!.leaseUntil).not.toBeNull();
    expect(first[0]!.leaseUntil!.getTime()).toBeGreaterThan(Date.now());

    // A second replica must not claim a row whose lease is still held.
    const second = await repository.claimPendingDispatchBatch(10);
    expect(second).toEqual([]);

    await prisma.idempotencyRecord.update({
      where: { id: execution.record.id },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    });
    const third = await repository.claimPendingDispatchBatch(10);
    expect(third.map((row) => row.id)).toEqual([execution.record.id]);
  });

  it("skips PENDING rows whose next_dispatch_at is not yet due", async () => {
    const execution = await createPendingExecution();
    await prisma.idempotencyRecord.update({
      where: { id: execution.record.id },
      data: { nextDispatchAt: new Date(Date.now() + 3_600_000) },
    });
    const repository = createIdempotencyRepository(prisma);

    expect(await repository.claimPendingDispatchBatch(10)).toEqual([]);

    const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: execution.record.id },
    });
    expect(stored.state).toBe("PENDING");
    expect(stored.dispatchAttempts).toBe(0);
  });

  it("applies 2s*2^attempts backoff capped at exactly 120 seconds", async () => {
    const execution = await createPendingExecution();
    const repository = createIdempotencyRepository(prisma);
    const id = execution.record.id;

    const measure = async (expectedMs: number) => {
      const before = (
        await client.query("SELECT pg_catalog.statement_timestamp() AS t")
      ).rows[0]!.t as Date;
      await repository.markDispatchOutcome(id, {
        dispatched: false,
        lastErrorCode: "enqueue_failed",
      });
      const after = (
        await client.query("SELECT pg_catalog.statement_timestamp() AS t")
      ).rows[0]!.t as Date;
      const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id },
      });
      const next = stored.nextDispatchAt.getTime();
      expect(next).toBeGreaterThanOrEqual(before.getTime() + expectedMs);
      expect(next).toBeLessThanOrEqual(after.getTime() + expectedMs);
      return stored;
    };

    // First failure: dispatch_attempts=0 -> 2s * 2^0 = 2s.
    let stored = await measure(2_000);
    expect(stored.dispatchAttempts).toBe(1);
    expect(stored.state).toBe("PENDING");
    expect(stored.leaseUntil).toBeNull();
    expect(stored.lastErrorCode).toBe("enqueue_failed");

    // Second failure: dispatch_attempts=1 -> 2s * 2^1 = 4s.
    stored = await measure(4_000);
    expect(stored.dispatchAttempts).toBe(2);

    // A deeply failed row is capped at exactly 120s, never 2s*2^attempts.
    await prisma.idempotencyRecord.update({
      where: { id },
      data: { dispatchAttempts: 20 },
    });
    stored = await measure(120_000);
    expect(stored.dispatchAttempts).toBe(21);
  });

  it("does not widen clearsight_app privileges beyond the verified columns", async () => {
    await client.query(migrationSql(MIGRATION));
    await client.query(migrationSql(MIGRATION));

    const forbidden = await client.query(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind = 'r'
          AND (
            has_table_privilege('clearsight_app', c.oid, 'DELETE')
            OR has_table_privilege('clearsight_app', c.oid, 'TRUNCATE')
            OR has_table_privilege('clearsight_app', c.oid, 'TRIGGER')
            OR has_table_privilege('clearsight_app', c.oid, 'REFERENCES')
          )`,
    );
    expect(forbidden.rows).toEqual([]);

    const usable = await client.query(
      `SELECT
         has_column_privilege('clearsight_app', 'idempotency_records', 'dispatch_attempts', 'SELECT') AS select_ok,
         has_column_privilege('clearsight_app', 'idempotency_records', 'last_error_code', 'UPDATE') AS update_ok,
         has_table_privilege('clearsight_app', 'idempotency_records', 'INSERT') AS insert_ok,
         has_table_privilege('clearsight_app', 'idempotency_records', 'UPDATE') AS table_update_ok`,
    );
    expect(usable.rows[0]).toEqual({
      select_ok: true,
      update_ok: true,
      insert_ok: true,
      table_update_ok: true,
    });
  });

  it("keeps the dispatch migration strictly additive over idempotency_records", () => {
    const sql = migrationSql(MIGRATION);
    const code = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // No destructive or privilege statement may start a line: the migration
    // only ALTERs/CREATEs idempotency_records and verifies effective grants.
    expect(code).not.toMatch(
      /^\s*(DROP|TRUNCATE|DELETE|UPDATE|GRANT|REVOKE)\b/gim,
    );
    const altered = [...sql.matchAll(/ALTER TABLE\s+([^\s;]+)/gi)].map(
      (match) => match[1],
    );
    expect(altered.length).toBeGreaterThan(0);
    for (const target of altered) {
      expect(target).toBe("idempotency_records");
    }
    const indexTarget = /CREATE INDEX[^;]*ON\s+([^\s(]+)/i.exec(sql)?.[1];
    expect(indexTarget).toBe("idempotency_records");
    expect(migrationNames()).toEqual(
      expect.arrayContaining([
        "0_init",
        "20261118020000_identity_audit",
        MIGRATION,
      ]),
    );
    expect(migrationNames()[0]).toBe("0_init");
  });
});
