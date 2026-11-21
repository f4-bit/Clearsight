import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationDeploymentError,
  advisoryLockKeys,
  baselineMetadataMatches,
  buildPrismaCliArgs,
  canonicalBaselineMetadata,
  isPrismaHistoryShapeValid,
  planMigrationDeployment,
  runMigrationDeployment,
  safeMigrationFailure,
  validateHistoryRows,
  type BaselineMetadata,
  type DatabaseState,
  type HistoryRow,
  type HistoryTableShape,
  type MigrationRuntime,
} from "../../src/services/migration-deployment.js";
import {
  assertManifestSourceHash,
  readMigrationInventory,
  resolveMigrationDatabaseUrl,
  sha256File,
  validateBaselineManifest,
} from "../../scripts/helpers/migration-preflight.js";
import { stripSchemaQualifier } from "../../scripts/helpers/postgres-migration-introspection.js";

const ROOT = join(import.meta.dirname, "..", "..");
const inventory = readMigrationInventory(ROOT);
const { manifest, migrations: expected } = inventory;

const VALID_HISTORY_SHAPE: HistoryTableShape = {
  exists: true,
  isTable: true,
  columns: [
    { name: "id", type: "character varying(36)", nullable: false },
    { name: "checksum", type: "character varying(64)", nullable: false },
    { name: "finished_at", type: "timestamp with time zone", nullable: true },
    { name: "migration_name", type: "character varying(255)", nullable: false },
    { name: "logs", type: "text", nullable: true },
    { name: "rolled_back_at", type: "timestamp with time zone", nullable: true },
    { name: "started_at", type: "timestamp with time zone", nullable: false },
    { name: "applied_steps_count", type: "integer", nullable: false },
  ],
};

function metadata(): BaselineMetadata {
  return structuredClone({
    tables: manifest.tables,
    enums: manifest.enums,
    unexpectedObjects: manifest.unexpectedObjects,
  });
}

function emptyState(): DatabaseState {
  return {
    serverVersionNum: 160_000,
    userTables: [],
    metadata: { tables: [], enums: [], unexpectedObjects: [] },
    historyTable: { exists: false, isTable: false, columns: [] },
    historyRows: [],
  };
}

function baselineState(): DatabaseState {
  return {
    serverVersionNum: 160_000,
    userTables: manifest.tables.map((table) => table.name),
    metadata: metadata(),
    historyTable: { exists: false, isTable: false, columns: [] },
    historyRows: [],
  };
}

function divergentState(): DatabaseState {
  const state = baselineState();
  return {
    ...state,
    userTables: [...state.userTables, "rogue_table"],
    metadata: {
      ...state.metadata,
      tables: [
        ...state.metadata.tables,
        { ...structuredClone(manifest.tables[0]!), name: "rogue_table" },
      ],
    },
  };
}

function historyRows(): HistoryRow[] {
  return expected.map((migration) => ({
    migrationName: migration.name,
    checksum: migration.checksum,
    finishedAt: new Date("2026-11-18T00:00:00.000Z"),
    rolledBackAt: null,
    appliedStepsCount: 1,
  }));
}

function historyState(rows: readonly HistoryRow[] = historyRows()): DatabaseState {
  return {
    serverVersionNum: 160_000,
    userTables: manifest.tables.map((table) => table.name),
    metadata: metadata(),
    historyTable: VALID_HISTORY_SHAPE,
    historyRows: rows,
  };
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationDeploymentError);
    return (error as MigrationDeploymentError).code;
  }
  throw new Error("expected the action to throw");
}

interface FakeOptions {
  readonly deployExit?: number;
  readonly resolveExit?: number;
  readonly acquireError?: Error;
  readonly inspectError?: Error;
  readonly releaseError?: Error;
}

function fakeRuntime(state: DatabaseState, options: FakeOptions = {}) {
  const calls: string[] = [];
  const runtime: MigrationRuntime = {
    async acquireLock() {
      calls.push("lock");
      if (options.acquireError) {
        throw options.acquireError;
      }
    },
    async inspect() {
      calls.push("inspect");
      if (options.inspectError) {
        throw options.inspectError;
      }
      return state;
    },
    async resolveApplied(name) {
      calls.push(`resolve:${name}`);
      return { exitCode: options.resolveExit ?? 0 };
    },
    async deploy() {
      calls.push("deploy");
      return { exitCode: options.deployExit ?? 0 };
    },
    async releaseLock() {
      calls.push("release");
      if (options.releaseError) {
        throw options.releaseError;
      }
    },
  };
  return { runtime, calls };
}

describe("migration database URL resolution", () => {
  it("requires an explicit URL instead of falling back to localhost", () => {
    expect(errorCode(() => resolveMigrationDatabaseUrl({}))).toBe("MIGRATION_URL_MISSING");
  });

  it("prefers MIGRATION_DATABASE_URL over DATABASE_URL", () => {
    const target = resolveMigrationDatabaseUrl({
      MIGRATION_DATABASE_URL: "postgresql://migration:secret@db.internal/app?schema=clinical",
      DATABASE_URL: "postgresql://app:secret@db.internal/app?schema=public",
    });
    expect(target.source).toBe("MIGRATION_DATABASE_URL");
    expect(target.database).toBe("app");
    expect(target.schema).toBe("clinical");
  });

  it("accepts the explicit DATABASE_URL fallback", () => {
    const target = resolveMigrationDatabaseUrl({
      DATABASE_URL: "postgresql://app:secret@db.internal/app",
    });
    expect(target.source).toBe("DATABASE_URL");
    expect(target.schema).toBe("public");
  });

  it("rejects malformed, unsupported and incomplete URLs without echoing them", () => {
    const canary = "url-canary-do-not-print";
    const cases = [
      "not a url",
      `mysql://user:${canary}@db.internal/app`,
      `postgresql://user:${canary}@:5432/app`,
      `postgresql://user:${canary}@db.internal:notaport/app`,
      `postgresql://user:${canary}@db.internal`,
    ];

    for (const value of cases) {
      try {
        resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: value });
        throw new Error("expected the URL to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationDeploymentError);
        expect((error as MigrationDeploymentError).code).toBe("MIGRATION_URL_INVALID");
        expect(String(error)).not.toContain(canary);
        expect(String(error)).not.toContain("db.internal");
      }
    }
  });

  it("rejects duplicate or unsafe schema parameters", () => {
    expect(
      errorCode(() =>
        resolveMigrationDatabaseUrl({
          MIGRATION_DATABASE_URL: "postgresql://user:secret@db.internal/app?schema=public&schema=other",
        }),
      ),
    ).toBe("MIGRATION_SCHEMA_DUPLICATE");

    expect(
      errorCode(() =>
        resolveMigrationDatabaseUrl({
          MIGRATION_DATABASE_URL: "postgresql://user:secret@db.internal/app?schema=bad-schema-name",
        }),
      ),
    ).toBe("MIGRATION_SCHEMA_INVALID");
  });
});

describe("checked-in baseline manifest", () => {
  it("pins the 0_init source and matches docker/init.sql", () => {
    expect(manifest.sourceSha256).toBe(
      sha256File(join(ROOT, "prisma", "migrations", "0_init", "migration.sql")),
    );
    expect(sha256File(join(ROOT, "..", "docker", "init.sql"))).toBe(manifest.sourceSha256);
  });

  it("aborts on a source hash mismatch before any runtime is created", () => {
    expect(errorCode(() => assertManifestSourceHash(manifest, "0".repeat(64)))).toBe(
      "MIGRATION_MANIFEST_SOURCE_MISMATCH",
    );
  });

  it("rejects a malformed manifest", () => {
    expect(errorCode(() => validateBaselineManifest({}))).toBe("MIGRATION_MANIFEST_INVALID");
    expect(errorCode(() => validateBaselineManifest({ sourceMigration: "0_init" }))).toBe(
      "MIGRATION_MANIFEST_INVALID",
    );
  });

  it("canonicalizes only by structure and preserves every semantic field", () => {
    const canonical = canonicalBaselineMetadata(metadata());
    expect(baselineMetadataMatches(canonical, manifest)).toBe(true);
    expect(canonical.tables.map((table) => table.name)).toEqual([
      "clinical_feedback",
      "consultations",
      "images",
      "inferences",
      "patients",
    ]);
  });

  it("normalizes only structural schema qualifiers", () => {
    expect(stripSchemaQualifier("CREATE INDEX idx ON public.patients USING btree (id)", "public")).toBe(
      "CREATE INDEX idx ON patients USING btree (id)",
    );
    expect(
      stripSchemaQualifier('REFERENCES "public".consultations(id)', "public"),
    ).toBe("REFERENCES consultations(id)");
    expect(stripSchemaQualifier("SELECT 'public.patients'::text", "public")).toBe(
      "SELECT 'public.patients'::text",
    );
    expect(stripSchemaQualifier('SELECT "public.patients"', "public")).toBe(
      'SELECT "public.patients"',
    );
  });

  it("ignores JSON property order in nested metadata", () => {
    const left = metadata();
    const reordered: BaselineMetadata = {
      unexpectedObjects: [],
      enums: left.enums.map((enumType) => ({ labels: [...enumType.labels], name: enumType.name })),
      tables: left.tables.map((table) => ({
        triggers: table.triggers.map((trigger) => ({
          definition: trigger.definition,
          enabled: trigger.enabled,
          name: trigger.name,
        })),
        indexes: table.indexes.map((index) => ({
          definition: index.definition,
          method: index.method,
          primary: index.primary,
          unique: index.unique,
          name: index.name,
        })),
        constraints: table.constraints.map((constraint) => ({
          definition: constraint.definition,
          deferred: constraint.deferred,
          deferrable: constraint.deferrable,
          matchType: constraint.matchType,
          onDelete: constraint.onDelete,
          onUpdate: constraint.onUpdate,
          referencedColumns: [...constraint.referencedColumns],
          referencedTable: constraint.referencedTable,
          columns: [...constraint.columns],
          name: constraint.name,
          type: constraint.type,
        })),
        columns: table.columns.map((column) => ({
          generated: column.generated,
          identity: column.identity,
          default: column.default,
          nullable: column.nullable,
          type: column.type,
          name: column.name,
          ordinal: column.ordinal,
        })),
        name: table.name,
      })),
    };

    expect(baselineMetadataMatches(left, reordered)).toBe(true);
  });

  it("still rejects changed values and semantic ordering", () => {
    const base = metadata();
    const withSyntheticConstraint: BaselineMetadata = {
      ...base,
      tables: base.tables.map((table) =>
        table.name === "patients"
          ? {
              ...table,
              constraints: [
                ...table.constraints,
                {
                  type: "u",
                  name: "synthetic_unique",
                  columns: ["age", "gender"],
                  referencedTable: null,
                  referencedColumns: [],
                  onUpdate: null,
                  onDelete: null,
                  matchType: null,
                  deferrable: false,
                  deferred: false,
                  definition: null,
                },
              ],
            }
          : table,
      ),
    };
    const reversedConstraint: BaselineMetadata = {
      ...withSyntheticConstraint,
      tables: withSyntheticConstraint.tables.map((table) =>
        table.name === "patients"
          ? {
              ...table,
              constraints: table.constraints.map((constraint) =>
                constraint.name === "synthetic_unique"
                  ? { ...constraint, columns: ["gender", "age"] }
                  : constraint,
              ),
            }
          : table,
      ),
    };
    const reversedLabels: BaselineMetadata = {
      ...base,
      enums: [{ name: "synthetic_enum", labels: ["B", "A"] }],
    };
    const orderedLabels: BaselineMetadata = {
      ...base,
      enums: [{ name: "synthetic_enum", labels: ["A", "B"] }],
    };
    const changedType: BaselineMetadata = {
      ...base,
      tables: base.tables.map((table) =>
        table.name === "patients"
          ? {
              ...table,
              columns: table.columns.map((column) =>
                column.name === "age" ? { ...column, type: "text" } : column,
              ),
            }
          : table,
      ),
    };

    expect(baselineMetadataMatches(withSyntheticConstraint, reversedConstraint)).toBe(false);
    expect(baselineMetadataMatches(orderedLabels, reversedLabels)).toBe(false);
    expect(baselineMetadataMatches(base, changedType)).toBe(false);
  });
});

describe("migration plan", () => {
  it("deploys once for an empty schema without resolving", () => {
    expect(planMigrationDeployment(emptyState(), expected, manifest)).toEqual({
      kind: "empty",
      steps: ["deploy"],
    });
  });

  it("resolves an exact baseline once and then deploys", () => {
    expect(planMigrationDeployment(baselineState(), expected, manifest)).toEqual({
      kind: "baseline-only",
      steps: ["resolve-0-init", "deploy"],
    });
  });

  it("accepts an exact baseline with an empty Prisma history table", () => {
    const state: DatabaseState = { ...baselineState(), historyTable: VALID_HISTORY_SHAPE };
    expect(planMigrationDeployment(state, expected, manifest)).toEqual({
      kind: "baseline-only",
      steps: ["resolve-0-init", "deploy"],
    });
  });

  it("deploys normally for a known complete history without resolving", () => {
    expect(planMigrationDeployment(historyState(), expected, manifest)).toEqual({
      kind: "history",
      steps: ["deploy"],
    });
  });

  it("deploys normally for a known prefix of the history", () => {
    expect(planMigrationDeployment(historyState(historyRows().slice(0, 1)), expected, manifest)).toEqual({
      kind: "history",
      steps: ["deploy"],
    });
  });

  it("fails closed on unfinished or rolled back history rows", () => {
    const unfinished = historyRows().map((row, index) =>
      index === 1 ? { ...row, finishedAt: null } : row,
    );
    const rolledBack = historyRows().map((row, index) =>
      index === 1 ? { ...row, rolledBackAt: new Date() } : row,
    );
    expect(errorCode(() => planMigrationDeployment(historyState(unfinished), expected, manifest))).toBe(
      "MIGRATION_HISTORY_INCOMPLETE",
    );
    expect(errorCode(() => planMigrationDeployment(historyState(rolledBack), expected, manifest))).toBe(
      "MIGRATION_HISTORY_INCOMPLETE",
    );
  });

  it("fails closed on unknown names, checksum drift and malformed history shape", () => {
    const unknown = historyRows().map((row, index) =>
      index === 0 ? { ...row, migrationName: "99999999999999_unknown" } : row,
    );
    const drifted = historyRows().map((row, index) =>
      index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
    );
    const badShape: HistoryTableShape = {
      exists: true,
      isTable: true,
      columns: [{ name: "id", type: "text", nullable: false }],
    };

    expect(errorCode(() => planMigrationDeployment(historyState(unknown), expected, manifest))).toBe(
      "MIGRATION_HISTORY_INVALID",
    );
    expect(errorCode(() => planMigrationDeployment(historyState(drifted), expected, manifest))).toBe(
      "MIGRATION_HISTORY_INVALID",
    );
    expect(errorCode(() => validateHistoryRows(unknown, expected))).toBe("MIGRATION_HISTORY_INVALID");
    expect(errorCode(() => planMigrationDeployment({ ...baselineState(), historyTable: badShape }, expected, manifest))).toBe(
      "MIGRATION_HISTORY_INVALID",
    );
    expect(isPrismaHistoryShapeValid(badShape)).toBe(false);
  });

  it("rejects unsupported PostgreSQL versions", () => {
    expect(
      errorCode(() =>
        planMigrationDeployment({ ...emptyState(), serverVersionNum: 120_000 }, expected, manifest),
      ),
    ).toBe("MIGRATION_POSTGRES_VERSION_UNSUPPORTED");
  });

  it("rejects unexpected objects in an otherwise empty schema", () => {
    const state: DatabaseState = {
      ...emptyState(),
      metadata: {
        ...emptyState().metadata,
        unexpectedObjects: [{ kind: "view", name: "rogue_view" }],
      },
    };
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  it("rejects unexpected objects next to an exact baseline", () => {
    const state: DatabaseState = {
      ...baselineState(),
      metadata: {
        ...baselineState().metadata,
        unexpectedObjects: [{ kind: "sequence", name: "rogue_seq" }],
      },
    };
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  const divergentCases: ReadonlyArray<readonly [string, (state: DatabaseState) => DatabaseState]> = [
    [
      "an extra table",
      (state) => ({
        ...state,
        userTables: [...state.userTables, "rogue_table"],
        metadata: {
          ...state.metadata,
          tables: [...state.metadata.tables, { ...structuredClone(manifest.tables[0]!), name: "rogue_table" }],
        },
      }),
    ],
    [
      "an extra column",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.map((table) =>
            table.name === "patients"
              ? {
                  ...table,
                  columns: [
                    ...table.columns,
                    {
                      ordinal: 99,
                      name: "rogue_column",
                      type: "integer",
                      nullable: true,
                      default: null,
                      identity: "",
                      generated: "",
                    },
                  ],
                }
              : table,
          ),
        },
      }),
    ],
    [
      "a changed default",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.map((table) =>
            table.name === "patients"
              ? {
                  ...table,
                  columns: table.columns.map((column) =>
                    column.name === "age" ? { ...column, default: "42" } : column,
                  ),
                }
              : table,
          ),
        },
      }),
    ],
    [
      "an unexpected check constraint",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.map((table) =>
            table.name === "patients"
              ? {
                  ...table,
                  constraints: [
                    ...table.constraints,
                    {
                      type: "c",
                      name: "rogue_check",
                      columns: ["age"],
                      referencedTable: null,
                      referencedColumns: [],
                      onUpdate: null,
                      onDelete: null,
                      matchType: null,
                      deferrable: false,
                      deferred: false,
                      definition: "CHECK ((age > 0))",
                    },
                  ],
                }
              : table,
          ),
        },
      }),
    ],
    [
      "an unexpected index",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.map((table) =>
            table.name === "patients"
              ? {
                  ...table,
                  indexes: [
                    ...table.indexes,
                    {
                      name: "rogue_idx",
                      unique: false,
                      primary: false,
                      method: "btree",
                      definition: "CREATE INDEX rogue_idx ON patients USING btree (age)",
                    },
                  ],
                }
              : table,
          ),
        },
      }),
    ],
    [
      "an unexpected trigger",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.map((table) =>
            table.name === "patients"
              ? {
                  ...table,
                  triggers: [
                    ...table.triggers,
                    {
                      name: "rogue_trigger",
                      enabled: "O",
                      definition: "CREATE TRIGGER rogue_trigger BEFORE INSERT ON patients",
                    },
                  ],
                }
              : table,
          ),
        },
      }),
    ],
    [
      "a missing table",
      (state) => ({
        ...state,
        userTables: state.userTables.filter((name) => name !== "clinical_feedback"),
        metadata: {
          ...state.metadata,
          tables: state.metadata.tables.filter((table) => table.name !== "clinical_feedback"),
        },
      }),
    ],
    [
      "an unexpected enum type",
      (state) => ({
        ...state,
        metadata: {
          ...state.metadata,
          enums: [...state.metadata.enums, { name: "rogue_enum", labels: ["A", "B"] }],
        },
      }),
    ],
  ];

  for (const [name, mutate] of divergentCases) {
    it(`rejects a baseline with ${name}`, () => {
      expect(errorCode(() => planMigrationDeployment(mutate(baselineState()), expected, manifest))).toBe(
        "MIGRATION_BASELINE_DIVERGENT",
      );
    });
  }
});

describe("migration orchestration", () => {
  it("runs deploy only for an empty schema", async () => {
    const { runtime, calls } = fakeRuntime(emptyState());
    const result = await runMigrationDeployment({ runtime, expectedMigrations: expected, manifest });
    expect(result).toMatchObject({ plan: "empty", actions: [{ kind: "deploy", result: "ok" }] });
    expect(calls).toEqual(["lock", "inspect", "deploy", "release"]);
  });

  it("runs resolve then deploy exactly once for an exact baseline", async () => {
    const { runtime, calls } = fakeRuntime(baselineState());
    const result = await runMigrationDeployment({ runtime, expectedMigrations: expected, manifest });
    expect(result.plan).toBe("baseline-only");
    expect(result.actions.map((action) => action.kind)).toEqual(["resolve-0-init", "deploy"]);
    expect(calls).toEqual(["lock", "inspect", "resolve:0_init", "deploy", "release"]);
  });

  it("does not resolve for a valid existing history", async () => {
    const { runtime, calls } = fakeRuntime(historyState());
    const result = await runMigrationDeployment({ runtime, expectedMigrations: expected, manifest });
    expect(result.plan).toBe("history");
    expect(calls).toEqual(["lock", "inspect", "deploy", "release"]);
    expect(calls.some((call) => call.startsWith("resolve"))).toBe(false);
  });

  it("does not add a second resolve or retry when deploy fails after resolve", async () => {
    const { runtime, calls } = fakeRuntime(baselineState(), { deployExit: 7 });
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toMatchObject({ code: "MIGRATION_CLI_FAILED", phase: "deploy" });
    expect(calls).toEqual(["lock", "inspect", "resolve:0_init", "deploy", "release"]);
    expect(calls.filter((call) => call === "deploy")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("resolve"))).toHaveLength(1);
  });

  it("does not run any CLI when introspection fails", async () => {
    const { runtime, calls } = fakeRuntime(baselineState(), { inspectError: new Error("boom") });
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual(["lock", "inspect", "release"]);
  });

  it("does not run any CLI when planning fails closed", async () => {
    const { runtime, calls } = fakeRuntime(divergentState());
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toMatchObject({ code: "MIGRATION_BASELINE_DIVERGENT" });
    expect(calls).toEqual(["lock", "inspect", "release"]);
  });

  it("reports a release failure after a successful deployment", async () => {
    const { runtime } = fakeRuntime(emptyState(), { releaseError: new Error("release boom") });
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toMatchObject({ code: "MIGRATION_LOCK_RELEASE_FAILED", phase: "lock" });
  });
});

describe("safe CLI surface", () => {
  it("passes the config path but never the DSN in argv", () => {
    const paths = {
      prismaCliPath: "/app/node_modules/prisma/build/index.js",
      configPath: "/app/prisma.migrate.config.ts",
    };
    const deployArgs = buildPrismaCliArgs("deploy", paths);
    const resolveArgs = buildPrismaCliArgs("resolve-0-init", paths);

    expect(deployArgs).toEqual([
      paths.prismaCliPath,
      "migrate",
      "deploy",
      "--config",
      paths.configPath,
    ]);
    expect(resolveArgs).toEqual([
      paths.prismaCliPath,
      "migrate",
      "resolve",
      "--applied",
      "0_init",
      "--config",
      paths.configPath,
    ]);
    expect([...deployArgs, ...resolveArgs].join(" ")).not.toContain("postgresql://");
  });

  it("uses distinct, stable advisory lock keys per database/schema", () => {
    const first = advisoryLockKeys("clearsight", "public");
    const second = advisoryLockKeys("clearsight", "public");
    const otherSchema = advisoryLockKeys("clearsight", "clinical");
    expect(second).toEqual(first);
    expect(otherSchema).not.toEqual(first);
    expect(first).toHaveLength(2);
  });

  it("redacts raw driver or DSN text from safe failures", () => {
    const canary = "safe-failure-canary";
    const failure = safeMigrationFailure(new Error(`postgresql://user:${canary}@db.internal/app`));
    expect(failure.code).toBe("MIGRATION_UNEXPECTED");
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain("db.internal");
  });

  it("prints only a stable error code for a malformed DSN", () => {
    const canary = "cli-stdout-canary";
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/migrate-deploy.ts"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: `postgresql://alice:${canary}@db.internal:notaport/app`,
          DATABASE_URL: "",
        },
      },
    );

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("MIGRATION_URL_INVALID");
    expect(output).not.toContain(canary);
    expect(output).not.toContain("db.internal");
  });
});
