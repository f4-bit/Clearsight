import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runMigrationDeployment,
  safeMigrationFailure,
  type MigrationDeploymentResult,
} from "../src/services/migration-deployment.js";
import {
  readMigrationInventory,
  resolveMigrationConfigPath,
  resolveMigrationDatabaseUrl,
  resolvePrismaCliPath,
} from "./helpers/migration-preflight.js";
import { createPostgresMigrationRuntime } from "./helpers/postgres-migration-runtime.js";

/**
 * Auditable replacement for the previous `prisma migrate deploy || resolve`
 * shell fallback. The preflight is read-only; only an exact 0_init baseline
 * without applied history is resolved, once, before a single deploy.
 */
export async function deployMigrations(
  rootDir: string = resolve(import.meta.dirname, ".."),
): Promise<MigrationDeploymentResult> {
  // Parse the DSN and verify the checked-in plan before opening any connection.
  const target = resolveMigrationDatabaseUrl(process.env);
  const inventory = readMigrationInventory(rootDir);
  const prismaCliPath = resolvePrismaCliPath(rootDir);
  const configPath = resolveMigrationConfigPath(rootDir);

  const runtime = createPostgresMigrationRuntime({
    target,
    rootDir,
    prismaCliPath,
    configPath,
  });

  return runMigrationDeployment({
    runtime,
    expectedMigrations: inventory.migrations,
    manifest: inventory.manifest,
  });
}

async function main(): Promise<void> {
  try {
    const result = await deployMigrations();
    const actions = result.actions.map((action) => action.kind).join(",") || "none";
    console.log(
      `[migrate] ok plan=${result.plan} actions=${actions} migrations=${result.migrationCount}`,
    );
    process.exitCode = 0;
  } catch (error) {
    const failure = safeMigrationFailure(error);
    console.error(`[migrate] failed code=${failure.code} phase=${failure.phase}`);
    console.error(`[migrate] ${failure.message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath !== undefined && resolve(invokedPath) === resolve(modulePath)) {
  void main();
}
