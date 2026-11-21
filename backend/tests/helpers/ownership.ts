/**
 * Shared, side-effect free guards for the integration runner.
 *
 * Keeping them in their own module makes the ownership rules unit-testable
 * without importing Node's network modules, Prisma or Testcontainers.
 */
export const TEST_DATABASE_URL_VARIABLE = "TEST_DATABASE_URL";
export const TEST_OWNERSHIP_TABLE = "test_meta";
export const TEST_OWNERSHIP_LABEL = "com.clearsight.test.run-id";

/**
 * Integration runs only accept a container created by the run itself. Any
 * supplied external URL (even one whose database name contains "test") is
 * rejected before a client or container is created.
 */
export function assertNoExternalDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): void {
  if (Object.prototype.hasOwnProperty.call(environment, TEST_DATABASE_URL_VARIABLE)) {
    throw new Error(
      `${TEST_DATABASE_URL_VARIABLE} is not supported for backend integration tests; remove it. ` +
        "Integration tests always create an ephemeral Testcontainers PostgreSQL instance.",
    );
  }
}

/**
 * Verifies that the database marker row belongs to this run. It is called
 * before the first destructive statement (`TRUNCATE`) in the test helpers.
 */
export function assertOwnershipRunId(rows: readonly unknown[], expectedRunId: string): void {
  if (typeof expectedRunId !== "string" || expectedRunId.length === 0) {
    throw new Error("Integration test ownership run id is missing from the provided test context");
  }
  if (rows.length !== 1) {
    throw new Error(
      `Refusing test database reset: expected exactly one ownership marker row, found ${rows.length}`,
    );
  }

  const row = rows[0];
  const actualRunId =
    row !== null && typeof row === "object" && "run_id" in row
      ? (row as { run_id?: unknown }).run_id
      : undefined;

  if (actualRunId !== expectedRunId) {
    throw new Error("Refusing test database reset: ownership marker does not match the injected test run id");
  }
}
