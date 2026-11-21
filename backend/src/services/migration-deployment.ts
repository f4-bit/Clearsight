import { createHash } from "node:crypto";

/**
 * Deterministic, auditable migration deployment.
 *
 * This module is intentionally free of PostgreSQL, Prisma and filesystem
 * access. The CLI adapter injects those dependencies so the decision logic can
 * be unit-tested without a database or network.
 */

export type MigrationPhase =
  | "preflight"
  | "lock"
  | "inspect"
  | "resolve"
  | "deploy"
  | "complete";

export type MigrationErrorCode =
  | "MIGRATION_URL_MISSING"
  | "MIGRATION_URL_INVALID"
  | "MIGRATION_SCHEMA_DUPLICATE"
  | "MIGRATION_SCHEMA_INVALID"
  | "MIGRATION_MANIFEST_INVALID"
  | "MIGRATION_MANIFEST_SOURCE_MISMATCH"
  | "MIGRATION_INVENTORY_INVALID"
  | "MIGRATION_CONFIG_MISSING"
  | "MIGRATION_CLI_MISSING"
  | "MIGRATION_CONNECTION_FAILED"
  | "MIGRATION_LOCK_FAILED"
  | "MIGRATION_LOCK_RELEASE_FAILED"
  | "MIGRATION_INTROSPECTION_FAILED"
  | "MIGRATION_POSTGRES_VERSION_UNSUPPORTED"
  | "MIGRATION_HISTORY_INVALID"
  | "MIGRATION_HISTORY_INCOMPLETE"
  | "MIGRATION_BASELINE_DIVERGENT"
  | "MIGRATION_CLI_FAILED";

/**
 * Errors carry a stable code and phase for logs. Their message is deliberately
 * constant and never includes the DSN, credentials, host or driver output.
 */
export class MigrationDeploymentError extends Error {
  readonly code: MigrationErrorCode;
  readonly phase: MigrationPhase;

  constructor(code: MigrationErrorCode, phase: MigrationPhase, message: string) {
    super(message);
    this.name = "MigrationDeploymentError";
    this.code = code;
    this.phase = phase;
  }
}

export interface ExpectedMigration {
  readonly name: string;
  /** Canonical LF checksum of the checked-in migration source. */
  readonly checksum: string;
  /**
   * Explicit allowlist of engine hashes for the same canonical source. Prisma
   * hashes the file bytes it reads, so a CRLF checkout can record a different
   * value than an LF clone. Only these two renderings are ever accepted.
   */
  readonly acceptedChecksums?: readonly string[];
}

export interface BaselineColumn {
  readonly ordinal: number;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly identity: string;
  readonly generated: string;
}

export interface BaselineConstraint {
  readonly type: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string | null;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: string | null;
  readonly onDelete: string | null;
  readonly matchType: string | null;
  readonly deferrable: boolean;
  readonly deferred: boolean;
  readonly definition: string | null;
}

export interface BaselineIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly method: string;
  readonly definition: string;
}

export interface BaselineTrigger {
  readonly name: string;
  readonly enabled: string;
  readonly definition: string;
}

export interface BaselineTable {
  readonly name: string;
  readonly columns: readonly BaselineColumn[];
  readonly constraints: readonly BaselineConstraint[];
  readonly indexes: readonly BaselineIndex[];
  readonly triggers: readonly BaselineTrigger[];
}

export interface BaselineEnumType {
  readonly name: string;
  readonly labels: readonly string[];
}

export interface UnexpectedObject {
  readonly kind: string;
  readonly name: string;
}

export interface BaselineMetadata {
  readonly tables: readonly BaselineTable[];
  readonly enums: readonly BaselineEnumType[];
  /**
   * Objects outside the five baseline tables and their direct artifacts.
   * Optional for legacy synthetic fixtures; real introspection always supplies
   * the complete array and the baseline manifest pins it as empty.
   */
  readonly unexpectedObjects?: readonly UnexpectedObject[];
}

export interface BaselineManifest extends BaselineMetadata {
  readonly sourceMigration: "0_init";
  readonly sourceSha256: string;
}

export interface HistoryColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface HistoryTableShape {
  readonly exists: boolean;
  readonly isTable: boolean;
  readonly columns: readonly HistoryColumn[];
}

export interface HistoryRow {
  readonly migrationName: string;
  readonly checksum: string;
  readonly finishedAt: Date | string | null;
  readonly rolledBackAt: Date | string | null;
  readonly appliedStepsCount: number;
}

export interface DatabaseState {
  readonly serverVersionNum: number;
  readonly userTables: readonly string[];
  readonly metadata: BaselineMetadata;
  readonly historyTable: HistoryTableShape;
  readonly historyRows: readonly HistoryRow[];
}

export type MigrationStep = "resolve-0-init" | "deploy";
export type MigrationPlanKind = "empty" | "baseline-only" | "history";

export interface MigrationPlan {
  readonly kind: MigrationPlanKind;
  readonly steps: readonly MigrationStep[];
}

export interface CliExecution {
  readonly exitCode: number | null;
}

/**
 * Runtime boundary. The PostgreSQL/CLI implementation holds the advisory lock
 * until after the Prisma command has completed; the service only orchestrates.
 */
export interface MigrationRuntime {
  acquireLock(): Promise<void>;
  inspect(): Promise<DatabaseState>;
  resolveApplied(migrationName: string): Promise<CliExecution>;
  deploy(): Promise<CliExecution>;
  releaseLock(): Promise<void>;
}

export interface MigrationAction {
  readonly kind: MigrationStep;
  readonly result: "ok";
}

export interface MigrationDeploymentResult {
  readonly plan: MigrationPlanKind;
  readonly actions: readonly MigrationAction[];
  readonly migrationCount: number;
}

export interface SafeMigrationFailure {
  readonly code: MigrationErrorCode | "MIGRATION_UNEXPECTED";
  readonly phase: MigrationPhase | "unknown";
  readonly message: string;
}

const PRISMA_HISTORY_COLUMNS: readonly HistoryColumn[] = [
  { name: "applied_steps_count", type: "integer", nullable: false },
  { name: "checksum", type: "character varying(64)", nullable: false },
  { name: "finished_at", type: "timestamp with time zone", nullable: true },
  { name: "id", type: "character varying(36)", nullable: false },
  { name: "logs", type: "text", nullable: true },
  { name: "migration_name", type: "character varying(255)", nullable: false },
  { name: "rolled_back_at", type: "timestamp with time zone", nullable: true },
  { name: "started_at", type: "timestamp with time zone", nullable: false },
];

const MINIMUM_POSTGRES_VERSION_NUM = 130_000;

function byName<T extends { readonly name: string }>(left: T, right: T): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function canonicalStringArray(values: readonly string[]): string[] {
  return [...values];
}

function canonicalColumn(column: BaselineColumn): BaselineColumn {
  return {
    ordinal: column.ordinal,
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    default: column.default,
    identity: column.identity,
    generated: column.generated,
  };
}

function canonicalConstraint(constraint: BaselineConstraint): BaselineConstraint {
  return {
    type: constraint.type,
    name: constraint.name,
    columns: canonicalStringArray(constraint.columns),
    referencedTable: constraint.referencedTable,
    referencedColumns: canonicalStringArray(constraint.referencedColumns),
    onUpdate: constraint.onUpdate,
    onDelete: constraint.onDelete,
    matchType: constraint.matchType,
    deferrable: constraint.deferrable,
    deferred: constraint.deferred,
    definition: constraint.definition,
  };
}

function canonicalIndex(index: BaselineIndex): BaselineIndex {
  return {
    name: index.name,
    unique: index.unique,
    primary: index.primary,
    method: index.method,
    definition: index.definition,
  };
}

function canonicalTrigger(trigger: BaselineTrigger): BaselineTrigger {
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    definition: trigger.definition,
  };
}

function canonicalTable(table: BaselineTable): BaselineTable {
  return {
    name: table.name,
    columns: [...table.columns]
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      )
      .map(canonicalColumn),
    constraints: [...table.constraints].sort(byName).map(canonicalConstraint),
    indexes: [...table.indexes].sort(byName).map(canonicalIndex),
    triggers: [...table.triggers].sort(byName).map(canonicalTrigger),
  };
}

function canonicalUnexpectedObject(object: UnexpectedObject): UnexpectedObject {
  return { kind: object.kind, name: object.name };
}

/**
 * Canonical order is structural only; it never drops a semantic field.
 * Every object is projected through an explicit fixed field order so a JSON
 * key reordering cannot create a false divergence.
 */
export function canonicalBaselineMetadata(metadata: BaselineMetadata): BaselineMetadata {
  return {
    tables: [...metadata.tables].sort(byName).map(canonicalTable),
    enums: [...metadata.enums]
      .sort(byName)
      .map((enumType) => ({ name: enumType.name, labels: canonicalStringArray(enumType.labels) })),
    unexpectedObjects: [...(metadata.unexpectedObjects ?? [])]
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind < right.kind ? -1 : 1;
        }
        return byName(left, right);
      })
      .map(canonicalUnexpectedObject),
  };
}

export function baselineMetadataMatches(actual: BaselineMetadata, expected: BaselineMetadata): boolean {
  return JSON.stringify(canonicalBaselineMetadata(actual)) === JSON.stringify(canonicalBaselineMetadata(expected));
}

export function isPrismaHistoryShapeValid(shape: HistoryTableShape): boolean {
  if (!shape.exists || !shape.isTable) {
    return false;
  }

  const actualColumns = [...shape.columns].sort(byName);
  if (actualColumns.length !== PRISMA_HISTORY_COLUMNS.length) {
    return false;
  }

  return actualColumns.every((column, index) => {
    const expected = PRISMA_HISTORY_COLUMNS[index];
    return (
      expected !== undefined &&
      column.name === expected.name &&
      column.type === expected.type &&
      column.nullable === expected.nullable
    );
  });
}

export function validateHistoryTableShape(shape: HistoryTableShape): void {
  // A database without the bookkeeping table is the normal empty/baseline case.
  if (!shape.exists) {
    return;
  }
  if (!isPrismaHistoryShapeValid(shape)) {
    throw new MigrationDeploymentError(
      "MIGRATION_HISTORY_INVALID",
      "preflight",
      "the Prisma migration history table has an unexpected shape",
    );
  }
}

function isFinished(row: HistoryRow): boolean {
  return row.finishedAt !== null && row.finishedAt !== undefined;
}

export function validateHistoryRows(
  rows: readonly HistoryRow[],
  expectedMigrations: readonly ExpectedMigration[],
): void {
  if (rows.length > expectedMigrations.length) {
    throw new MigrationDeploymentError(
      "MIGRATION_HISTORY_INVALID",
      "preflight",
      "the Prisma migration history contains migrations that are not part of this checkout",
    );
  }

  for (const [index, row] of rows.entries()) {
    const expected = expectedMigrations[index];
    const accepted = expected?.acceptedChecksums ?? (expected ? [expected.checksum] : []);
    if (
      expected === undefined ||
      row.migrationName !== expected.name ||
      !accepted.includes(row.checksum)
    ) {
      throw new MigrationDeploymentError(
        "MIGRATION_HISTORY_INVALID",
        "preflight",
        "the Prisma migration history does not match the checked-in migrations",
      );
    }

    if (!isFinished(row) || row.rolledBackAt !== null) {
      throw new MigrationDeploymentError(
        "MIGRATION_HISTORY_INCOMPLETE",
        "preflight",
        "the Prisma migration history contains a failed, rolled back or unfinished migration",
      );
    }

    if (!Number.isInteger(row.appliedStepsCount) || row.appliedStepsCount < 0) {
      throw new MigrationDeploymentError(
        "MIGRATION_HISTORY_INVALID",
        "preflight",
        "the Prisma migration history contains an invalid applied step count",
      );
    }
  }
}

/**
 * Only three states are deployable:
 *  - empty schema with no history: plain `migrate deploy`;
 *  - exact checked-in baseline with no applied history: resolve `0_init` once,
 *    then `migrate deploy` once;
 *  - a complete prefix of known migrations with matching checksums: plain
 *    `migrate deploy`.
 *
 * Anything else fails closed before any resolve/deploy command runs.
 */
export function planMigrationDeployment(
  state: DatabaseState,
  expectedMigrations: readonly ExpectedMigration[],
  manifest: BaselineManifest,
): MigrationPlan {
  if (state.serverVersionNum < MINIMUM_POSTGRES_VERSION_NUM) {
    throw new MigrationDeploymentError(
      "MIGRATION_POSTGRES_VERSION_UNSUPPORTED",
      "preflight",
      "PostgreSQL 13 or newer is required (the baseline uses core gen_random_uuid())",
    );
  }

  const baseline = expectedMigrations[0];
  if (baseline === undefined || baseline.name !== "0_init") {
    throw new MigrationDeploymentError(
      "MIGRATION_INVENTORY_INVALID",
      "preflight",
      "the checked-in migration inventory does not start with 0_init",
    );
  }

  validateHistoryTableShape(state.historyTable);

  if (state.historyRows.length > 0) {
    validateHistoryRows(state.historyRows, expectedMigrations);
    return { kind: "history", steps: ["deploy"] };
  }

  if (state.userTables.length === 0) {
    if (state.metadata.enums.length > 0 || (state.metadata.unexpectedObjects ?? []).length > 0) {
      throw new MigrationDeploymentError(
        "MIGRATION_BASELINE_DIVERGENT",
        "preflight",
        "the empty database contains unexpected user-defined objects",
      );
    }
    return { kind: "empty", steps: ["deploy"] };
  }

  if (!baselineMetadataMatches(state.metadata, manifest)) {
    throw new MigrationDeploymentError(
      "MIGRATION_BASELINE_DIVERGENT",
      "preflight",
      "the database schema does not exactly match the checked-in baseline",
    );
  }

  return { kind: "baseline-only", steps: ["resolve-0-init", "deploy"] };
}

export interface RunMigrationDeploymentOptions {
  readonly runtime: MigrationRuntime;
  readonly expectedMigrations: readonly ExpectedMigration[];
  readonly manifest: BaselineManifest;
}

export async function runMigrationDeployment(
  options: RunMigrationDeploymentOptions,
): Promise<MigrationDeploymentResult> {
  const { runtime, expectedMigrations, manifest } = options;
  const actions: MigrationAction[] = [];
  let primaryError: unknown;

  try {
    await runtime.acquireLock();
    const state = await runtime.inspect();
    const plan = planMigrationDeployment(state, expectedMigrations, manifest);

    for (const step of plan.steps) {
      if (step === "resolve-0-init") {
        const execution = await runtime.resolveApplied("0_init");
        if (execution.exitCode !== 0) {
          throw new MigrationDeploymentError(
            "MIGRATION_CLI_FAILED",
            "resolve",
            "prisma migrate resolve failed",
          );
        }
      } else {
        const execution = await runtime.deploy();
        if (execution.exitCode !== 0) {
          throw new MigrationDeploymentError(
            "MIGRATION_CLI_FAILED",
            "deploy",
            "prisma migrate deploy failed",
          );
        }
      }

      actions.push({ kind: step, result: "ok" });
    }

    return {
      plan: plan.kind,
      actions,
      migrationCount: expectedMigrations.length,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await runtime.releaseLock();
    } catch {
      if (primaryError === undefined) {
        throw new MigrationDeploymentError(
          "MIGRATION_LOCK_RELEASE_FAILED",
          "lock",
          "the migration advisory lock could not be released",
        );
      }
    }
  }
}

/** CLI-facing formatter: stable code/phase only, never driver or DSN text. */
export function safeMigrationFailure(error: unknown): SafeMigrationFailure {
  if (error instanceof MigrationDeploymentError) {
    return { code: error.code, phase: error.phase, message: error.message };
  }
  return {
    code: "MIGRATION_UNEXPECTED",
    phase: "unknown",
    message: "unexpected migration failure",
  };
}

/**
 * Two-key advisory lock in a namespace distinct from Prisma's own single-key
 * lock. Keys are stable per database/schema but never include credentials.
 */
export function advisoryLockKeys(database: string, schema: string): readonly [number, number] {
  const digest = createHash("sha256")
    .update(`clearsight:migrate-deploy:v1\u0000${database}\u0000${schema}`, "utf8")
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export type PrismaMigrationCommand = "deploy" | "resolve-0-init";

export interface PrismaCliPaths {
  readonly prismaCliPath: string;
  readonly configPath: string;
}

/** The DSN is passed only through the child environment, never through argv. */
export function buildPrismaCliArgs(command: PrismaMigrationCommand, paths: PrismaCliPaths): string[] {
  const action =
    command === "deploy"
      ? ["migrate", "deploy"]
      : ["migrate", "resolve", "--applied", "0_init"];

  return [paths.prismaCliPath, ...action, "--config", paths.configPath];
}
