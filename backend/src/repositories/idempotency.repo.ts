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
     * `accepted_at >= created_at`.
     */
    async markAccepted(
      id: string,
      responseBody: AcceptedIdempotencyResponseBody,
    ): Promise<number> {
      return db.$executeRawUnsafe(
        `UPDATE "${databaseSchema}".idempotency_records
            SET state = 'ACCEPTED',
                response_status = 202,
                response_body = $2::jsonb,
                accepted_at = GREATEST(created_at, pg_catalog.statement_timestamp())
          WHERE id = $1::uuid
            AND state = 'PENDING'`,
        id,
        JSON.stringify(responseBody),
      );
    },
  };
}
export type IdempotencyRepository = ReturnType<typeof createIdempotencyRepository>;
