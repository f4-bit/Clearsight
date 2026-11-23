import { Prisma } from "../generated/prisma/client.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import {
  INFERENCE_PROCESS_CLAIM_LEASE_SECONDS,
  INFERENCE_PROCESS_RETRY_CAP_SECONDS,
} from "../workers/inference.contracts.js";
import type { Db } from "./types.js";

const MAX_CLAIM_BATCH = 1_000;

export interface ClaimedInference {
  readonly id: string;
  /** Failure count before this attempt; incremented by `markProcessRetry`. */
  readonly processAttempts: number;
}

export interface InferenceQueueRepository {
  /**
   * Makes a due QUEUED row ready only when no other poller holds a live lease.
   * A re-dispatch must never re-arm a row that is already being processed.
   */
  markReady(inferenceId: string): Promise<number>;
  /**
   * Atomically claims up to `limit` due, unleased QUEUED rows with SKIP LOCKED
   * and sets an explicit lease so concurrent pollers cannot overlap.
   */
  claimProcessBatch(limit: number): Promise<ClaimedInference[]>;
  /**
   * Consumes one retryable attempt: process_attempts++, exponential backoff and
   * clears the lease. Always executes for the claimed row; the caller decides
   * whether the returned count exhausted the attempts.
   */
  markProcessRetry(inferenceId: string): Promise<number | null>;
  /** Releases the lease after a terminal outcome (success or FAILED). */
  markProcessDone(inferenceId: string): Promise<number>;
}

export interface InferenceQueueRepositoryOptions {
  databaseSchema?: string;
}

function assertPositiveInteger(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer <= ${max}`);
  }
}

/**
 * Durable PostgreSQL queue over the existing `inferences` table. Values are
 * bound; the schema identifier is validated before it is embedded. The claim is
 * a single statement so the row locks are released immediately and processing
 * happens outside the transaction.
 */
export function createInferenceQueueRepository(
  db: Db,
  options: InferenceQueueRepositoryOptions = {},
): InferenceQueueRepository {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const inferencesTable = Prisma.raw(`"${databaseSchema}"."inferences"`);

  return {
    markReady: (inferenceId) =>
      db.$executeRaw(
        Prisma.sql`UPDATE ${inferencesTable}
          SET next_process_at = pg_catalog.statement_timestamp()
          WHERE id = ${inferenceId}::uuid
            AND status = 'QUEUED'
            AND (
              process_lease_until IS NULL
              OR process_lease_until < pg_catalog.statement_timestamp()
            )`,
      ),

    claimProcessBatch: async (limit) => {
      assertPositiveInteger(limit, "claim batch limit", MAX_CLAIM_BATCH);
      return db.$queryRaw<ClaimedInference[]>(
        Prisma.sql`WITH candidates AS (
            SELECT id
              FROM ${inferencesTable}
             WHERE status = 'QUEUED'
               AND next_process_at <= pg_catalog.statement_timestamp()
               AND (
                 process_lease_until IS NULL
                 OR process_lease_until < pg_catalog.statement_timestamp()
               )
             ORDER BY next_process_at ASC, created_at ASC
             LIMIT ${limit}
               FOR UPDATE SKIP LOCKED
          )
          UPDATE ${inferencesTable} AS inferences
             SET process_lease_until = pg_catalog.statement_timestamp()
                 + pg_catalog.make_interval(secs => ${INFERENCE_PROCESS_CLAIM_LEASE_SECONDS}::double precision)
            FROM candidates
           WHERE inferences.id = candidates.id
             AND inferences.status = 'QUEUED'
           RETURNING inferences.id AS "id",
                     inferences.process_attempts AS "processAttempts"`,
      );
    },

    markProcessRetry: async (inferenceId) => {
      // Mirrors idempotency dispatch exactly: PostgreSQL evaluates SET
      // expressions against the old row, so the first failure sees old
      // process_attempts=0 and schedules 2s * 2^0 = 2s (then 4s, 8s...).
      const rows = await db.$queryRaw<Array<{ processAttempts: number }>>(
        Prisma.sql`UPDATE ${inferencesTable}
          SET process_attempts = process_attempts + 1,
              next_process_at = pg_catalog.statement_timestamp()
                + pg_catalog.make_interval(
                    secs => LEAST(
                        2 * pg_catalog.power(2, process_attempts),
                        ${INFERENCE_PROCESS_RETRY_CAP_SECONDS}
                    )::double precision
                  ),
              process_lease_until = NULL
          WHERE id = ${inferenceId}::uuid
          RETURNING process_attempts AS "processAttempts"`,
      );
      return rows[0]?.processAttempts ?? null;
    },

    markProcessDone: (inferenceId) =>
      db.$executeRaw(
        Prisma.sql`UPDATE ${inferencesTable}
          SET process_lease_until = NULL
          WHERE id = ${inferenceId}::uuid`,
      ),
  };
}
