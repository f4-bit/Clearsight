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
});
