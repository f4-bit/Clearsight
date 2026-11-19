import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MigrationDeploymentError,
  type BaselineEnumType,
  type BaselineManifest,
  type BaselineTable,
  type ExpectedMigration,
  type UnexpectedObject,
} from "../../src/services/migration-deployment.js";

export const BASELINE_MIGRATION_NAME = "0_init";
export const MIGRATION_CONFIG_FILE = "prisma.migrate.config.ts";
export const MIGRATIONS_DIRECTORY = join("prisma", "migrations");
export const BASELINE_MANIFEST_FILE = join("prisma", "baseline", "0_init.baseline.json");

export interface MigrationTarget {
  /** The raw DSN. Never log or place this value in argv. */
  readonly url: string;
  readonly database: string;
  readonly schema: string;
  readonly source: "MIGRATION_DATABASE_URL" | "DATABASE_URL";
}

export interface MigrationInventory {
  readonly migrations: readonly ExpectedMigration[];
  readonly manifest: BaselineManifest;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function safeUrlError(code: "MIGRATION_URL_MISSING" | "MIGRATION_URL_INVALID", message: string): never {
  throw new MigrationDeploymentError(code, "preflight", message);
}

/**
 * MIGRATION_DATABASE_URL is preferred; DATABASE_URL is the explicit fallback.
 * There is no localhost default and this module never loads dotenv.
 */
export function resolveMigrationDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): MigrationTarget {
  const preferred = nonEmptyEnv(environment.MIGRATION_DATABASE_URL);
  const fallback = nonEmptyEnv(environment.DATABASE_URL);
  const raw = preferred ?? fallback;

  if (raw === undefined) {
    return safeUrlError(
      "MIGRATION_URL_MISSING",
      "set MIGRATION_DATABASE_URL (preferred) or DATABASE_URL for migrations",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL is malformed");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL uses an unsupported protocol");
  }

  if (parsed.hostname.length === 0) {
    return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL is missing a host");
  }

  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL has an invalid database name");
  }

  if (database.length === 0 || database.includes("/")) {
    return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL is missing a valid database name");
  }

  if (parsed.port.length > 0) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return safeUrlError("MIGRATION_URL_INVALID", "the migration database URL has an invalid port");
    }
  }

  const schemaValues = parsed.searchParams.getAll("schema");
  if (schemaValues.length > 1) {
    throw new MigrationDeploymentError(
      "MIGRATION_SCHEMA_DUPLICATE",
      "preflight",
      "the migration database URL contains more than one schema parameter",
    );
  }

  const schema = schemaValues[0] ?? "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new MigrationDeploymentError(
      "MIGRATION_SCHEMA_INVALID",
      "preflight",
      "the migration schema must be a simple PostgreSQL identifier",
    );
  }

  return {
    url: raw,
    database,
    schema,
    source: preferred === undefined ? "DATABASE_URL" : "MIGRATION_DATABASE_URL",
  };
}

/**
 * Strict line-ending canonicalization for SQL sources. Only CRLF becomes LF;
 * there is no trim, BOM removal, whitespace normalization or SQL rewriting.
 */
export function canonicalSql(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Checksum of the canonical LF source, independent of the checkout EOL. */
export function sha256File(path: string): string {
  return sha256Text(canonicalSql(readFileSync(path, "utf8")));
}

function acceptedChecksums(path: string): { checksum: string; accepted: string[] } {
  const canonical = canonicalSql(readFileSync(path, "utf8"));
  const lf = sha256Text(canonical);
  const crlf = sha256Text(canonical.replaceAll("\n", "\r\n"));
  return { checksum: lf, accepted: lf === crlf ? [lf] : [lf, crlf] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBaselineTable(value: unknown): value is BaselineTable {
  if (!isRecord(value) || typeof value.name !== "string") {
    return false;
  }

  return (
    Array.isArray(value.columns) &&
    Array.isArray(value.constraints) &&
    Array.isArray(value.indexes) &&
    Array.isArray(value.triggers)
  );
}

function isBaselineEnum(value: unknown): value is BaselineEnumType {
  return isRecord(value) && typeof value.name === "string" && isStringArray(value.labels);
}

function isUnexpectedObject(value: unknown): value is UnexpectedObject {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.name === "string"
  );
}

export function validateBaselineManifest(value: unknown): BaselineManifest {
  if (!isRecord(value)) {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest is not a JSON object",
    );
  }

  if (value.sourceMigration !== BASELINE_MIGRATION_NAME) {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest does not describe 0_init",
    );
  }

  if (typeof value.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceSha256)) {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest has an invalid source SHA-256",
    );
  }

  if (
    !Array.isArray(value.tables) ||
    value.tables.length === 0 ||
    !value.tables.every(isBaselineTable) ||
    !Array.isArray(value.enums) ||
    !value.enums.every(isBaselineEnum) ||
    !Array.isArray(value.unexpectedObjects) ||
    !value.unexpectedObjects.every(isUnexpectedObject)
  ) {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest has an invalid metadata shape",
    );
  }

  return value as unknown as BaselineManifest;
}

export function readBaselineManifest(rootDir: string): BaselineManifest {
  const manifestPath = join(rootDir, BASELINE_MANIFEST_FILE);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest is missing",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_INVALID",
      "preflight",
      "the checked-in baseline manifest is not valid JSON",
    );
  }

  return validateBaselineManifest(parsed);
}

export function assertManifestSourceHash(
  manifest: BaselineManifest,
  sourceChecksum: string,
): void {
  if (manifest.sourceSha256 !== sourceChecksum) {
    throw new MigrationDeploymentError(
      "MIGRATION_MANIFEST_SOURCE_MISMATCH",
      "preflight",
      "the checked-in baseline manifest does not match the 0_init migration source",
    );
  }
}

export function readMigrationInventory(rootDir: string): MigrationInventory {
  const migrationsRoot = join(rootDir, MIGRATIONS_DIRECTORY);
  let entries: string[];
  try {
    entries = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new MigrationDeploymentError(
      "MIGRATION_INVENTORY_INVALID",
      "preflight",
      "the checked-in migrations directory is missing",
    );
  }

  if (entries.length === 0 || entries[0] !== BASELINE_MIGRATION_NAME) {
    throw new MigrationDeploymentError(
      "MIGRATION_INVENTORY_INVALID",
      "preflight",
      "the checked-in migration inventory does not start with 0_init",
    );
  }

  const migrations: ExpectedMigration[] = [];
  for (const name of entries) {
    const migrationPath = join(migrationsRoot, name, "migration.sql");
    if (!existsSync(migrationPath)) {
      throw new MigrationDeploymentError(
        "MIGRATION_INVENTORY_INVALID",
        "preflight",
        "a checked-in migration is missing its migration.sql file",
      );
    }
    const { checksum, accepted } = acceptedChecksums(migrationPath);
    migrations.push({ name, checksum, acceptedChecksums: accepted });
  }

  const manifest = readBaselineManifest(rootDir);
  const sourceChecksum = migrations[0]?.checksum;
  if (sourceChecksum === undefined) {
    throw new MigrationDeploymentError(
      "MIGRATION_INVENTORY_INVALID",
      "preflight",
      "the checked-in migration inventory is empty",
    );
  }
  assertManifestSourceHash(manifest, sourceChecksum);

  return { migrations, manifest };
}

export function resolvePrismaCliPath(rootDir: string): string {
  const cliPath = join(rootDir, "node_modules", "prisma", "build", "index.js");
  if (!existsSync(cliPath)) {
    throw new MigrationDeploymentError(
      "MIGRATION_CLI_MISSING",
      "preflight",
      "the local Prisma CLI is not installed",
    );
  }
  return cliPath;
}

export function resolveMigrationConfigPath(rootDir: string): string {
  const configPath = join(rootDir, MIGRATION_CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new MigrationDeploymentError(
      "MIGRATION_CONFIG_MISSING",
      "preflight",
      "the dedicated migration Prisma config is missing",
    );
  }
  return configPath;
}
