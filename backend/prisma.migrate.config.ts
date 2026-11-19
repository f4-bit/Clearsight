import { defineConfig } from "prisma/config";

/**
 * Dedicated config for the audited migration wrapper.
 *
 * It deliberately does not import dotenv and has no localhost fallback. The
 * wrapper passes the already validated DSN through the child environment; every
 * script-side check resolves MIGRATION_DATABASE_URL first, then DATABASE_URL.
 */
const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
  throw new Error("A migration database URL is required");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url: databaseUrl },
});
