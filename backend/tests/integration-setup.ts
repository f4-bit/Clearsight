import { inject } from "vitest";

/**
 * Runs in every integration worker before test modules (and therefore before
 * `src/config/env.ts`). Binding DATABASE_URL to the injected container URL
 * prevents any module that still reads the env singleton from falling back to
 * a development database. dotenv does not override an existing variable.
 */
const databaseUrl = inject("databaseUrl");

if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
  throw new Error("Integration test context is missing the ephemeral database URL");
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";
