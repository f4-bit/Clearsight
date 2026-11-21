import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationDeploymentError,
  planMigrationDeployment,
  runMigrationDeployment,
  type BaselineMetadata,
  type DatabaseState,
  type MigrationRuntime,
} from "../../src/services/migration-deployment.js";
import {
  readMigrationInventory,
  sha256File,
} from "../../scripts/helpers/migration-preflight.js";

/**
 * QA regression suite for the migration deployment wrapper.
 *
 * Focus: cross-platform trust of the pinned 0_init baseline hash (CRLF vs LF
 * checkouts), cleanup paths on lock acquisition failure, and divergence
 * classes (type/nullability/FK/enum) not covered by the maker matrix.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const inventory = readMigrationInventory(ROOT);
const { manifest, migrations: expected } = inventory;

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Strictly canonicalizes CRLF to LF. No semantic whitespace changes. */
function canonicalLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function gitBlob(pathFromRepoRoot: string): Buffer {
  const result = spawnSync("git", ["cat-file", "blob", `HEAD:${pathFromRepoRoot}`], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stdout === null) {
    throw new Error(
      `git cat-file blob HEAD:${pathFromRepoRoot} failed: ${result.stderr?.toString() ?? "no output"}`,
    );
  }
  return result.stdout;
}

function baselineState(): DatabaseState {
  return {
    serverVersionNum: 160_000,
    userTables: manifest.tables.map((table) => table.name),
    metadata: structuredClone({ tables: manifest.tables, enums: manifest.enums }),
    historyTable: { exists: false, isTable: false, columns: [] },
    historyRows: [],
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

describe("cross-platform baseline hash trust", () => {
  it("pins sourceSha256 to the canonical repository content (git blob) of 0_init", () => {
    // The golden oracle is the committed content (LF in the git object store),
    // not the host working tree. A raw working-tree pin drifts between a CRLF
    // checkout (Windows) and a fresh LF clone (Linux/CI) and would make every
    // `prisma:deploy` abort with MIGRATION_MANIFEST_SOURCE_MISMATCH off-Windows.
    const blob = gitBlob("backend/prisma/migrations/0_init/migration.sql");
    expect(manifest.sourceSha256).toBe(sha256(blob));
  });

  it("agrees with the workspace file after strictly CRLF to LF canonicalization", () => {
    const blob = gitBlob("backend/prisma/migrations/0_init/migration.sql");
    const workspace = readFileSync(join(ROOT, "prisma", "migrations", "0_init", "migration.sql"), "utf8");
    // Canonicalized workspace bytes must reproduce the git blob exactly; this
    // proves the canonicalization is line-ending-only, not semantic.
    expect(sha256(canonicalLf(workspace))).toBe(sha256(blob));
  });

  it("computes inventory checksums identically for CRLF and LF renderings of the same sources", () => {
    const canonicalPin = sha256(
      canonicalLf(readFileSync(join(ROOT, "prisma", "migrations", "0_init", "migration.sql"), "utf8")),
    );

    function fixtureRoot(render: (text: string) => string): string {
      const root = mkdtempSync(join(tmpdir(), "migrate-inv-"));
      cpSync(join(ROOT, "prisma", "migrations"), join(root, "prisma", "migrations"), {
        recursive: true,
      });
      for (const name of readdirSync(join(root, "prisma", "migrations"))) {
        const file = join(root, "prisma", "migrations", name, "migration.sql");
        writeFileSync(file, render(canonicalLf(readFileSync(file, "utf8"))));
      }
      mkdirSync(join(root, "prisma", "baseline"), { recursive: true });
      const manifestCopy = {
        ...JSON.parse(
          readFileSync(join(ROOT, "prisma", "baseline", "0_init.baseline.json"), "utf8"),
        ),
        sourceSha256: canonicalPin,
      };
      writeFileSync(
        join(root, "prisma", "baseline", "0_init.baseline.json"),
        JSON.stringify(manifestCopy, null, 2),
      );
      return root;
    }

    const lfRoot = fixtureRoot((text) => text);
    const crlfRoot = fixtureRoot((text) => text.replace(/\n/g, "\r\n"));
    try {
      const lf = readMigrationInventory(lfRoot);
      const crlf = readMigrationInventory(crlfRoot);
      expect(lf.migrations).toEqual(crlf.migrations);
      expect(lf.migrations[0]?.checksum).toBe(canonicalPin);
      expect(crlf.migrations[0]?.checksum).toBe(canonicalPin);
    } finally {
      rmSync(lfRoot, { recursive: true, force: true });
      rmSync(crlfRoot, { recursive: true, force: true });
    }
  });

  it("keeps the checked-in docker/init.sql identical to the 0_init migration source", () => {
    // Sources 0_init/init.sql must stay byte-identical modulo line endings.
    const initSql = readFileSync(join(ROOT, "..", "docker", "init.sql"), "utf8");
    const migrationSql = readFileSync(
      join(ROOT, "prisma", "migrations", "0_init", "migration.sql"),
      "utf8",
    );
    expect(canonicalLf(initSql)).toBe(canonicalLf(migrationSql));
    expect(sha256File(join(ROOT, "prisma", "migrations", "0_init", "migration.sql"))).toBe(
      inventory.migrations[0]?.checksum,
    );
  });
});

describe("cleanup paths", () => {
  function trackingRuntime(
    state: DatabaseState,
    options: { acquireError?: Error } = {},
  ): { runtime: MigrationRuntime; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      runtime: {
        async acquireLock() {
          calls.push("lock");
          if (options.acquireError) {
            throw options.acquireError;
          }
        },
        async inspect() {
          calls.push("inspect");
          return state;
        },
        async resolveApplied(name) {
          calls.push(`resolve:${name}`);
          return { exitCode: 0 };
        },
        async deploy() {
          calls.push("deploy");
          return { exitCode: 0 };
        },
        async releaseLock() {
          calls.push("release");
        },
      },
    };
  }

  it("still releases the runtime when lock acquisition fails and runs no CLI", async () => {
    const { runtime, calls } = trackingRuntime(baselineState(), {
      acquireError: new Error("lock boom"),
    });
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toThrow("lock boom");
    expect(calls).toEqual(["lock", "release"]);
    expect(calls.some((call) => call === "deploy" || call.startsWith("resolve"))).toBe(false);
  });

  it("releases the runtime when introspection fails and runs no CLI", async () => {
    const { runtime, calls } = trackingRuntime(baselineState());
    runtime.inspect = async () => {
      calls.push("inspect");
      throw new MigrationDeploymentError(
        "MIGRATION_INTROSPECTION_FAILED",
        "inspect",
        "read-only migration introspection failed",
      );
    };
    await expect(
      runMigrationDeployment({ runtime, expectedMigrations: expected, manifest }),
    ).rejects.toMatchObject({ code: "MIGRATION_INTROSPECTION_FAILED" });
    expect(calls).toEqual(["lock", "inspect", "release"]);
  });
});

describe("additional baseline divergence classes", () => {
  function mutatePatients(
    state: DatabaseState,
    mutate: (
      table: NonNullable<BaselineMetadata["tables"][number]>,
    ) => BaselineMetadata["tables"][number],
  ): DatabaseState {
    return {
      ...state,
      metadata: {
        ...state.metadata,
        tables: state.metadata.tables.map((table) =>
          table.name === "patients" ? mutate(table) : table,
        ),
      },
    };
  }

  it("rejects a baseline with a changed column type", () => {
    const state = mutatePatients(baselineState(), (table) => ({
      ...table,
      columns: table.columns.map((column) =>
        column.name === "age" ? { ...column, type: "text" } : column,
      ),
    }));
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  it("rejects a baseline with changed column nullability", () => {
    const state = mutatePatients(baselineState(), (table) => ({
      ...table,
      columns: table.columns.map((column) =>
        column.name === "external_code" ? { ...column, nullable: false } : column,
      ),
    }));
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  it("rejects a baseline with a dropped foreign key constraint", () => {
    const base = baselineState();
    const state: DatabaseState = {
      ...base,
      metadata: {
        ...base.metadata,
        tables: base.metadata.tables.map((table) =>
          table.name === "clinical_feedback"
            ? {
                ...table,
                constraints: table.constraints.filter(
                  (constraint) => constraint.name !== "clinical_feedback_consultation_id_fkey",
                ),
              }
            : table,
        ),
      },
    };
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  it("rejects a baseline with a changed foreign key delete action", () => {
    const base = baselineState();
    const state: DatabaseState = {
      ...base,
      metadata: {
        ...base.metadata,
        tables: base.metadata.tables.map((table) =>
          table.name === "consultations"
            ? {
                ...table,
                constraints: table.constraints.map((constraint) =>
                  constraint.name === "consultations_patient_id_fkey"
                    ? { ...constraint, onDelete: "SET NULL" }
                    : constraint,
                ),
              }
            : table,
        ),
      },
    };
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });

  it("rejects an empty schema carrying user-defined enum types", () => {
    const state: DatabaseState = {
      serverVersionNum: 160_000,
      userTables: [],
      metadata: { tables: [], enums: [{ name: "rogue_enum", labels: ["A"] }] },
      historyTable: { exists: false, isTable: false, columns: [] },
      historyRows: [],
    };
    expect(errorCode(() => planMigrationDeployment(state, expected, manifest))).toBe(
      "MIGRATION_BASELINE_DIVERGENT",
    );
  });
});
