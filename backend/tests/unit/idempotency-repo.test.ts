import { describe, expect, it } from "vitest";
import type { Db } from "../../src/repositories/types.js";
import { createIdempotencyRepository } from "../../src/repositories/idempotency.repo.js";

interface RawCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeDb() {
  const calls: RawCall[] = [];
  const db = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return [{ pg_advisory_xact_lock: null }];
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return 1;
    },
  } as unknown as Db;
  return { db, calls };
}

function fakeDispatchDb(options: {
  claimed?: unknown[];
  inferenceId?: string | null;
}) {
  const calls: RawCall[] = [];
  const db = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return options.claimed ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return 1;
    },
    idempotencyRecord: {
      findUnique: async () =>
        options.inferenceId === null || options.inferenceId === undefined
          ? null
          : { inferenceId: options.inferenceId },
    },
  } as unknown as Db;
  return { db, calls };
}

describe("idempotency repository raw SQL", () => {
  it("binds the advisory lock value and keeps the raw key out of SQL", async () => {
    const { db, calls } = fakeDb();
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    await repo.lock(
      "11111111-1111-4111-8111-111111111111",
      "inferences:create:v1",
      "raw.key:value",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(calls[0]!.sql).toContain("pg_catalog.hashtext");
    expect(calls[0]!.sql).not.toContain("raw.key:value");
    expect(calls[0]!.params).toEqual([
      "inferences:create:v1:lock",
      "custom_schema:11111111-1111-4111-8111-111111111111:inferences:create:v1:raw.key:value",
    ]);
  });

  it("schema-qualifies the conditional accepted transition and binds the body", async () => {
    const { db, calls } = fakeDb();
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    const affected = await repo.markAccepted(
      "22222222-2222-4222-8222-222222222222",
      {
        inferenceId: "33333333-3333-4333-8333-333333333333",
        jobId: "33333333-3333-4333-8333-333333333333",
        status: "QUEUED",
      },
    );

    expect(affected).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('"custom_schema".idempotency_records');
    expect(calls[0]!.sql).toContain("state = 'PENDING'");
    expect(calls[0]!.sql).toContain(
      "GREATEST(created_at, pg_catalog.statement_timestamp())",
    );
    expect(calls[0]!.sql).toContain("lease_until = NULL");
    expect(calls[0]!.params[0]).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(JSON.parse(String(calls[0]!.params[1]))).toEqual({
      inferenceId: "33333333-3333-4333-8333-333333333333",
      jobId: "33333333-3333-4333-8333-333333333333",
      status: "QUEUED",
    });
  });

  it("fails closed on an invalid schema identifier before any raw query", () => {
    const { db } = fakeDb();
    expect(() =>
      createIdempotencyRepository(db, {
        databaseSchema: 'public"; DROP TABLE idempotency_records; --',
      }),
    ).toThrow("databaseSchema must be a valid PostgreSQL identifier");
  });

  it("claims due PENDING rows with a bounded lease and SKIP LOCKED", async () => {
    const claimed = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        inferenceId: "33333333-3333-4333-8333-333333333333",
        state: "PENDING",
      },
    ];
    const { db, calls } = fakeDispatchDb({ claimed });
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    const rows = await repo.claimPendingDispatchBatch(7);

    expect(rows).toEqual(claimed);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('"custom_schema".idempotency_records');
    expect(calls[0]!.sql).toContain("state = 'PENDING'");
    expect(calls[0]!.sql).toContain("lease_until < pg_catalog.statement_timestamp()");
    expect(calls[0]!.sql).toContain("next_dispatch_at <= pg_catalog.statement_timestamp()");
    expect(calls[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]!.sql).toContain("pg_catalog.make_interval");
    expect(calls[0]!.params).toEqual([7, 60]);
  });

  it("marks a successful dispatch accepted and clears the lease", async () => {
    const { db, calls } = fakeDispatchDb({
      inferenceId: "33333333-3333-4333-8333-333333333333",
    });
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    const affected = await repo.markDispatchOutcome(
      "22222222-2222-4222-8222-222222222222",
      { dispatched: true, lastErrorCode: null },
    );

    expect(affected).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("state = 'ACCEPTED'");
    expect(calls[0]!.sql).toContain("lease_until = NULL");
    expect(JSON.parse(String(calls[0]!.params[1]))).toEqual({
      inferenceId: "33333333-3333-4333-8333-333333333333",
      jobId: "33333333-3333-4333-8333-333333333333",
      status: "QUEUED",
    });
  });

  it("records a failed dispatch with attempts, bounded backoff and a safe code", async () => {
    const { db, calls } = fakeDispatchDb({ inferenceId: null });
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    const affected = await repo.markDispatchOutcome(
      "22222222-2222-4222-8222-222222222222",
      { dispatched: false, lastErrorCode: "enqueue_failed" },
    );

    expect(affected).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("dispatch_attempts = dispatch_attempts + 1");
    expect(calls[0]!.sql).toContain("pg_catalog.power(2, dispatch_attempts)");
    expect(calls[0]!.sql).toContain("LEAST(");
    expect(calls[0]!.sql).toContain("120");
    expect(calls[0]!.sql).toContain("lease_until = NULL");
    expect(calls[0]!.sql).toContain("last_error_code = $2");
    expect(calls[0]!.params).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "enqueue_failed",
    ]);
  });

  it("rejects an unsafe dispatch error code before SQL", async () => {
    const { db, calls } = fakeDispatchDb({ inferenceId: null });
    const repo = createIdempotencyRepository(db, { databaseSchema: "custom_schema" });

    await expect(
      repo.markDispatchOutcome(
        "22222222-2222-4222-8222-222222222222",
        { dispatched: false, lastErrorCode: "https://secret.example/x" },
      ),
    ).rejects.toThrow(/dispatch error code/);
    expect(calls).toEqual([]);
  });

  it("rejects invalid claim batch limits before any SQL", async () => {
    const { db, calls } = fakeDispatchDb({});
    const repo = createIdempotencyRepository(db, {
      databaseSchema: "custom_schema",
    });

    for (const limit of [0, -1, 1.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.claimPendingDispatchBatch(limit)).rejects.toThrow(
        /batch limit/,
      );
    }
    expect(calls).toEqual([]);

    await expect(repo.claimPendingDispatchBatch(2)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([2, 60]);
  });
});
