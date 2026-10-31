import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    // All DB tests share one ephemeral Postgres and truncate between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    // First run may need to pull the postgres image.
    hookTimeout: 180_000,
  },
});
