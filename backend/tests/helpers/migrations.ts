import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "prisma", "migrations");

export function migrationNames(): string[] {
  // Prisma applies migrations in lexicographic order of the folder name.
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** Equivalent of `prisma migrate deploy`, minus the _prisma_migrations bookkeeping. */
export async function applyMigrations(client: Client): Promise<void> {
  for (const name of migrationNames()) {
    await client.query(migrationSql(name));
  }
}
