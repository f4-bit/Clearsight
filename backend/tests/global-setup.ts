import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { applyMigrations } from "./helpers/migrations.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Ephemeral PostgreSQL for the whole run.
 *
 * - Default: a throw-away `postgres:16-alpine` container (needs Docker), the same
 *   major version as docker-compose.
 * - `TEST_DATABASE_URL`: use an existing server instead (CI service container,
 *   local Postgres). The database name MUST contain "test": its `public`
 *   schema is dropped and rebuilt from prisma/migrations.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (url) {
    const dbName = new URL(url).pathname.replace(/^\//, "");
    if (!dbName.includes("test")) {
      throw new Error(`Refusing to reset "${dbName}": TEST_DATABASE_URL must point to a database whose name contains "test"`);
    }
  } else {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("clearsight_test")
      .start();
    url = container.getConnectionUri();
    stop = async () => {
      await container.stop();
    };
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await applyMigrations(client);
  } finally {
    await client.end();
  }

  project.provide("databaseUrl", url);
  return async () => {
    await stop?.();
  };
}
