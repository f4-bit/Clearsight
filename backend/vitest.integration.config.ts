import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Explicit integration runner. It keeps every original non-pure test file in
 * the allowlist and always provisions an ephemeral Testcontainers PostgreSQL.
 * TEST_DATABASE_URL is rejected by the global setup before any external client
 * is created.
 */
export default defineConfig({
  root,
  test: {
    include: [
      "tests/repositories.test.ts",
      "tests/rbac.test.ts",
      "tests/migrations.test.ts",
      "tests/artifact-migrations.test.ts",
      "tests/identity-migrations.test.ts",
      "tests/integrity-migrations.test.ts",
      "tests/migration-deploy.integration.test.ts",
      "tests/admin-bootstrap.integration.test.ts",
      "tests/jwt.test.ts",
      "tests/auth-sessions.integration.test.ts",
      "tests/login-protection.integration.test.ts",
      "tests/feedback.route.test.ts",
      "tests/export.route.test.ts",
      "tests/etl.test.ts",
      "tests/health.test.ts",
      "tests/audit.integration.test.ts",
      "tests/user-admin.integration.test.ts",
      "tests/user-lifecycle.integration.test.ts",
    ],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/integration-setup.ts"],
    environment: "node",
    // All DB tests share one ephemeral Postgres and assert its ownership marker.
    fileParallelism: false,
    testTimeout: 30_000,
    // First run may need to pull the postgres image.
    hookTimeout: 180_000,
  },
});
