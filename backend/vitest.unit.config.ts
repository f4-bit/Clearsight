import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Pure unit runner: no globalSetup, no database, no Redis, no network.
 * The include list is an allowlist on purpose. Vitest applies positional CLI
 * filters after this list, so a filter can only narrow the run, never widen it.
 */
export default defineConfig({
  root,
  test: {
    include: ["tests/schemas.test.ts", "tests/sanitizer.test.ts", "tests/unit/**/*.test.ts"],
    setupFiles: ["./tests/unit/network-guard.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
