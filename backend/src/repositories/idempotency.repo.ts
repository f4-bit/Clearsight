import type { IdempotencyRecord } from "../generated/prisma/client.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type { Db, JsonObject } from "./types.js";

export interface IdempotencyRepositoryOptions {
  /** Explicit schema for the raw advisory lock and conditional UPDATE. */
  readonly databaseSchema?: string;
}

export interface CreatePendingIdempotencyRecordInput {
  readonly actorUserId: string;
  readonly scope: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly inferenceId: string;
  readonly resolvedModelVersions: JsonObject;
}

export interface AcceptedIdempotencyResponseBody {
  readonly inferenceId: string;
  readonly jobId: string;
  readonly status: "QUEUED";
}

export interface DispatchOutcomeInput {
  readonly dispatched: boolean;
  readonly lastErrorCode?: string | null;
}

const DISPATCH_CLAIM_LEASE_SECONDS = 60;
const DISPATCH_ERROR_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function assertDispatchErrorCode(code: string): void {
  if (!DISPATCH_ERROR_CODE_PATTERN.test(code)) {
    throw new Error("dispatch error code must be a safe 1..64 character code");
  }
}

async function markAcceptedRecord(
  db: Db,
  databaseSchema: string,
  id: string,
  responseBody: AcceptedIdempotencyResponseBody,
): Promise<number> {
  return db.$executeRawUnsafe(
    `UPDATE "${databaseSchema}".idempotency_records
        SET state = 'ACCEPTED',
            response_status = 202,
            response_body = $2::jsonb,
            accepted_at = GREATEST(created_at, pg_catalog.statement_timestamp()),
            lease_until = NULL
      WHERE id = $1::uuid
        AND state = 'PENDING'`,
    id,
    JSON.stringify(responseBody),
  );
}

/**
 * Durable idempotency access for task 4.4. The family/hash/execution identity
 * is immutable in SQL; the only allowed transition is PENDING -> ACCEPTED.
 * Raw SQL is schema-qualified and every value is bound; the schema identifier
 * is validated before it is embedded.
 */
export function createIdempotencyRepository(
  db: Db,
  options: IdempotencyRepositoryOptions = {},
) {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);

  return {
    findByActorScopeKey: (
      actorUserId: string,
      scope: string,
      key: string,
    ): Promise<IdempotencyRecord | null> =>
      db.idempotencyRecord.findUnique({
        where: { actorUserId_scope_key: { actorUserId, scope, key } },
      }),

    findById: (id: string): Promise<IdempotencyRecord | null> =>
      db.idempotencyRecord.findUnique({ where: { id } }),

    createPending: (
      input: CreatePendingIdempotencyRecordInput,
    ): Promise<IdempotencyRecord> =>
      db.idempotencyRecord.create({
        data: {
          actorUserId: input.actorUserId,
          scope: input.scope,
          key: input.key,
          payloadHash: input.payloadHash,
          inferenceId: input.inferenceId,
          resolvedModelVersions: input.resolvedModelVersions,
          state: "PENDING",
        },
      }),

    /**
     * Probabilistic mutex for the whole idempotent create for (actor, scope,
     * key). The two-int advisory key is derived through `hashtext`, so the
     * namespace is probabilistic, not structurally isolated. Correctness and
     * uniqueness are guaranteed by the unique (actor, scope, key) index plus
     * the compare-and-set transition; the lock only reduces duplicate work.
     * The raw key is bound, never interpolated into SQL.
     */
    async lock(actorUserId: string, scope: string, key: string): Promise<void> {
      const lockValue = `${databaseSchema}:${actorUserId}:${scope}:${key}`;
      await db.$queryRawUnsafe(
        "SELECT 1::int AS locked FROM (SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1), pg_catalog.hashtext($2))) AS advisory_lock",
        `${scope}:lock`,
        lockValue,
      );
    },

    /**
     * Conditional PENDING -> ACCEPTED transition. The timestamp is taken by
     * PostgreSQL (`pg_catalog.statement_timestamp()`), never by the app clock.
     * `GREATEST` is a SQL conditional expression, not a pg_catalog function, so
     * it stays unqualified (it cannot be shadowed); it keeps
     * `accepted_at >= created_at`. The dispatch lease is cleared on acceptance.
     */
    markAccepted: (
      id: string,
      responseBody: AcceptedIdempotencyResponseBody,
    ): Promise<number> =>
      markAcceptedRecord(db, databaseSchema, id, responseBody),

    async claimPendingDispatchBatch(limit: number): Promise<IdempotencyRecord[]> {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
        throw new Error("dispatch batch limit must be a positive integer <= 1000");
      }
      return db.$queryRawUnsafe<IdempotencyRecord[]>(
        `WITH candidates AS (
            SELECT id
              FROM "${databaseSchema}".idempotency_records
             WHERE state = 'PENDING'
               AND (lease_until IS NULL OR lease_until < pg_catalog.statement_timestamp())
               AND next_dispatch_at <= pg_catalog.statement_timestamp()
             ORDER BY next_dispatch_at ASC, created_at ASC
             LIMIT $1
               FOR UPDATE SKIP LOCKED
         )
         UPDATE "${databaseSchema}".idempotency_records AS records
            SET lease_until = pg_catalog.statement_timestamp()
                + pg_catalog.make_interval(secs => $2::double precision)
           FROM candidates
          WHERE records.id = candidates.id
            AND records.state = 'PENDING'
          RETURNING records.id,
                    records.actor_user_id AS "actorUserId",
                    records.scope,
                    records.key,
                    records.payload_hash AS "payloadHash",
                    records.inference_id AS "inferenceId",
                    records.resolved_model_versions AS "resolvedModelVersions",
                    records.state,
                    records.response_status AS "responseStatus",
                    records.response_body AS "responseBody",
                    records.accepted_at AS "acceptedAt",
                    records.created_at AS "createdAt",
                    records.dispatch_attempts AS "dispatchAttempts",
                    records.next_dispatch_at AS "nextDispatchAt",
                    records.lease_until AS "leaseUntil",
                    records.last_error_code AS "lastErrorCode"`,
        limit,
        DISPATCH_CLAIM_LEASE_SECONDS,
      );
    },

    async markDispatchOutcome(
      recordId: string,
      outcome: DispatchOutcomeInput,
    ): Promise<number> {
      if (outcome.dispatched) {
        const record = await db.idempotencyRecord.findUnique({
          where: { id: recordId },
          select: { inferenceId: true },
        });
        if (record === null) {
          return 0;
        }
        return markAcceptedRecord(db, databaseSchema, recordId, {
          inferenceId: record.inferenceId,
          jobId: record.inferenceId,
          status: "QUEUED",
        });
      }

      const errorCode = outcome.lastErrorCode ?? "dispatch_failed";
      assertDispatchErrorCode(errorCode);
      return db.$executeRawUnsafe(
        `UPDATE "${databaseSchema}".idempotency_records
            SET dispatch_attempts = dispatch_attempts + 1,
                next_dispatch_at = pg_catalog.statement_timestamp()
                  + pg_catalog.make_interval(
                      secs => LEAST(
                          2 * pg_catalog.power(2, dispatch_attempts),
                          120
                      )::double precision
                    ),
                lease_until = NULL,
                last_error_code = $2
          WHERE id = $1::uuid
            AND state = 'PENDING'`,
        recordId,
        errorCode,
      );
    },
  };
}
export type IdempotencyRepository = ReturnType<typeof createIdempotencyRepository>;
