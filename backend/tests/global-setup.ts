import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { TestProject } from "vitest/node";
import { applyMigrations } from "./helpers/migrations.js";
import {
  assertNoExternalDatabaseUrl,
  assertOwnershipRunId,
  TEST_OWNERSHIP_LABEL,
  TEST_OWNERSHIP_TABLE,
} from "./helpers/ownership.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    databaseOwnership: string;
  }
}

type ContainerLike = {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
};

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function closeClient(client: Client | undefined): Promise<void> {
  if (client) {
    await client.end();
  }
}

async function stopContainer(container: ContainerLike | undefined): Promise<void> {
  if (container) {
    await container.stop();
  }
}

async function writeOwnershipMarker(client: Client, runId: string): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TEST_OWNERSHIP_TABLE} ` +
      "(run_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())",
  );
  await client.query(`INSERT INTO ${TEST_OWNERSHIP_TABLE} (run_id) VALUES ($1)`, [runId]);

  const marker = await client.query(`SELECT run_id FROM ${TEST_OWNERSHIP_TABLE}`);
  assertOwnershipRunId(marker.rows, runId);
}

/**
 * Ephemeral PostgreSQL for the explicit integration runner.
 *
 * The run always creates its own uniquely named container with an ownership
 * label; external/adopted URLs are deliberately unsupported. The fresh
 * database is migrated in place (no DROP SCHEMA) and gets a `test_meta` marker
 * that the test helpers must verify before truncating.
 *
 * Cleanup closes the client and stops the container for failures after the
 * container handle is acquired (connect, migrations, ownership marker,
 * project.provide). If `container.start()` rejects before a handle exists,
 * cleanup relies on Testcontainers' own reaper; that path is not exercised here
 * because the local Docker daemon is unavailable.
 */
export default async function setup(project: TestProject) {
  assertNoExternalDatabaseUrl();

  const runId = randomUUID();
  const databaseName = `clearsight_test_${runId.replaceAll("-", "")}`;
  let container: ContainerLike | undefined;
  let client: Client | undefined;

  try {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const startedContainer = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase(databaseName)
      .withLabels({
        [TEST_OWNERSHIP_LABEL]: runId,
        "com.clearsight.test.owner": "backend-integration",
      })
      .start();
    container = startedContainer;

    const url = startedContainer.getConnectionUri();
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Testcontainers returned an empty PostgreSQL connection URI");
    }

    const { Client: PgClient } = await import("pg");
    client = new PgClient({ connectionString: url });

    let operationError: unknown;
    try {
      await client.connect();
      await applyMigrations(client);
      await writeOwnershipMarker(client, runId);
    } catch (error) {
      operationError = error;
    }

    try {
      await client.end();
    } catch (endError) {
      client = undefined;
      if (operationError) {
        throw new AggregateError(
          [toError(operationError), toError(endError)],
          "Integration test database setup and client cleanup both failed",
        );
      }
      throw endError;
    }
    client = undefined;

    if (operationError) {
      throw operationError;
    }

    project.provide("databaseUrl", url);
    project.provide("databaseOwnership", runId);

    let tornDown = false;
    return async () => {
      if (tornDown) {
        return;
      }
      await closeClient(client);
      await stopContainer(container);
      tornDown = true;
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await closeClient(client);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await stopContainer(container);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    client = undefined;
    container = undefined;

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [toError(error), ...cleanupErrors.map(toError)],
        "Integration test setup failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}
