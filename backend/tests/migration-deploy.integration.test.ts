import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, inject } from "vitest";
import { Client } from "pg";
import {
  runMigrationDeployment,
  safeMigrationFailure,
  type MigrationRuntime,
} from "../src/services/migration-deployment.js";
import {
  readMigrationInventory,
  resolveMigrationConfigPath,
  resolveMigrationDatabaseUrl,
  resolvePrismaCliPath,
} from "../scripts/helpers/migration-preflight.js";
import { createPostgresMigrationRuntime } from "../scripts/helpers/postgres-migration-runtime.js";
import {
  inspectDatabase,
  quoteIdentifier,
} from "../scripts/helpers/postgres-migration-introspection.js";
import { migrationSql } from "./helpers/migrations.js";

const ROOT = join(import.meta.dirname, "..");
const inventory = readMigrationInventory(ROOT);
const createdSchemas = new Set<string>();

let admin: Client;

type HistoryRecord = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

beforeAll(async () => {
  admin = new Client({ connectionString: inject("databaseUrl") });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

afterEach(async () => {
  for (const schema of [...createdSchemas]) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    createdSchemas.delete(schema);
  }
});

function uniqueSchema(prefix: string): string {
  return `migrate_${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

async function createSchema(schema: string): Promise<void> {
  createdSchemas.add(schema);
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
}

function schemaUrl(schema: string): string {
  const url = new URL(inject("databaseUrl"));
  url.searchParams.set("schema", schema);
  return url.toString();
}

async function applyBaseline(
  schema: string,
  seed?: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await client.query(migrationSql("0_init"));
    await seed?.(client);
  } finally {
    await client.end();
  }
}

function runtimeFor(schema: string): MigrationRuntime {
  const target = resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: schemaUrl(schema) });
  return createPostgresMigrationRuntime({
    target,
    rootDir: ROOT,
    prismaCliPath: resolvePrismaCliPath(ROOT),
    configPath: resolveMigrationConfigPath(ROOT),
  });
}

function runtimeForTree(schema: string, treeRoot: string): MigrationRuntime {
  const target = resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: schemaUrl(schema) });
  return createPostgresMigrationRuntime({
    target,
    rootDir: treeRoot,
    prismaCliPath: resolvePrismaCliPath(ROOT),
    configPath: join(treeRoot, "prisma.migrate.config.ts"),
  });
}

function createMigrationTree(eol: "lf" | "crlf", mutate?: (root: string) => void): string {
  // Keep the temporary tree under backend/tests/fixtures so Node resolves the
  // real backend node_modules for `prisma/config`, then remove it in finally.
  const root = mkdtempSync(join(ROOT, "tests", "fixtures", "migrate-tree-"));
  cpSync(join(ROOT, "prisma", "migrations"), join(root, "prisma", "migrations"), {
    recursive: true,
  });
  mkdirSync(join(root, "prisma", "baseline"), { recursive: true });
  cpSync(
    join(ROOT, "prisma", "baseline", "0_init.baseline.json"),
    join(root, "prisma", "baseline", "0_init.baseline.json"),
  );
  cpSync(join(ROOT, "prisma", "schema.prisma"), join(root, "prisma", "schema.prisma"));
  cpSync(join(ROOT, "prisma.migrate.config.ts"), join(root, "prisma.migrate.config.ts"));

  for (const name of readdirSync(join(root, "prisma", "migrations"))) {
    const file = join(root, "prisma", "migrations", name, "migration.sql");
    const canonical = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    writeFileSync(file, eol === "crlf" ? canonical.replaceAll("\n", "\r\n") : canonical);
  }

  mutate?.(root);
  return root;
}

async function deployWithTree(schema: string, treeRoot: string) {
  const inventory = readMigrationInventory(treeRoot);
  const trackedRuntime = tracked(runtimeForTree(schema, treeRoot));
  const result = await runMigrationDeployment({
    runtime: trackedRuntime.runtime,
    expectedMigrations: inventory.migrations,
    manifest: inventory.manifest,
  });
  return { result, calls: trackedRuntime.calls, inventory };
}

async function deployFailureWithTree(
  schema: string,
  treeRoot: string,
): Promise<{ code: string; calls: string[] }> {
  const inventory = readMigrationInventory(treeRoot);
  const trackedRuntime = tracked(runtimeForTree(schema, treeRoot));
  try {
    await runMigrationDeployment({
      runtime: trackedRuntime.runtime,
      expectedMigrations: inventory.migrations,
      manifest: inventory.manifest,
    });
  } catch (error) {
    return { code: safeMigrationFailure(error).code, calls: trackedRuntime.calls };
  }
  throw new Error("expected the migration wrapper to fail");
}

function tracked(runtime: MigrationRuntime): { runtime: MigrationRuntime; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async acquireLock() {
        calls.push("lock");
        await runtime.acquireLock();
      },
      async inspect() {
        calls.push("inspect");
        return runtime.inspect();
      },
      async resolveApplied(name) {
        calls.push(`resolve:${name}`);
        return runtime.resolveApplied(name);
      },
      async deploy() {
        calls.push("deploy");
        return runtime.deploy();
      },
      async releaseLock() {
        calls.push("release");
        await runtime.releaseLock();
      },
    },
  };
}

async function deploy(schema: string) {
  const trackedRuntime = tracked(runtimeFor(schema));
  const result = await runMigrationDeployment({
    runtime: trackedRuntime.runtime,
    expectedMigrations: inventory.migrations,
    manifest: inventory.manifest,
  });
  return { result, calls: trackedRuntime.calls };
}

async function deployFailure(schema: string): Promise<{ code: string; calls: string[] }> {
  const trackedRuntime = tracked(runtimeFor(schema));
  try {
    await runMigrationDeployment({
      runtime: trackedRuntime.runtime,
      expectedMigrations: inventory.migrations,
      manifest: inventory.manifest,
    });
  } catch (error) {
    return { code: safeMigrationFailure(error).code, calls: trackedRuntime.calls };
  }
  throw new Error("expected the migration wrapper to fail");
}

async function history(schema: string): Promise<HistoryRecord[]> {
  const result = await admin.query<HistoryRecord>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
       FROM ${quoteIdentifier(schema)}.${quoteIdentifier("_prisma_migrations")}
      ORDER BY migration_name`,
  );
  return result.rows;
}

function expectAcceptedHistoryChecksums(rows: HistoryRecord[]): void {
  expect(rows.map((row) => row.migration_name)).toEqual(
    inventory.migrations.map((migration) => migration.name),
  );
  for (const [index, row] of rows.entries()) {
    const migration = inventory.migrations[index];
    expect(migration).toBeDefined();
    const accepted = migration?.acceptedChecksums ?? [migration?.checksum];
    expect(accepted).toContain(row.checksum);
  }
}

async function historyTableCount(schema: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2`,
    [schema, "_prisma_migrations"],
  );
  return result.rows[0]?.count ?? 0;
}

describe("migration deployment wrapper (real PostgreSQL + Prisma CLI)", () => {
  it("applies every migration exactly once to a fresh schema", async () => {
    const schema = uniqueSchema("fresh");
    await createSchema(schema);

    const { result, calls } = await deploy(schema);

    expect(result.plan).toBe("empty");
    expect(result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
    expect(calls).toEqual(["lock", "inspect", "deploy", "release"]);

    const rows = await history(schema);
    expectAcceptedHistoryChecksums(rows);
    expect(rows.every((row) => row.finished_at instanceof Date)).toBe(true);
    expect(rows.every((row) => row.rolled_back_at === null)).toBe(true);
  });

  it("resolves an exact populated baseline once and preserves legacy rows", async () => {
    const schema = uniqueSchema("baseline");
    const patientId = randomUUID();
    await createSchema(schema);
    await applyBaseline(schema, async (client) => {
      await client.query(
        "INSERT INTO patients (id, external_code, age, gender, clinical_data) VALUES ($1, $2, 64, 'F', $3::jsonb)",
        [patientId, "legacy-patient-1", JSON.stringify({ source: "legacy" })],
      );
    });

    const { result, calls } = await deploy(schema);

    expect(result.plan).toBe("baseline-only");
    expect(result.actions.map((action) => action.kind)).toEqual(["resolve-0-init", "deploy"]);
    expect(calls).toEqual(["lock", "inspect", "resolve:0_init", "deploy", "release"]);

    const rows = await history(schema);
    expect(rows.map((row) => row.migration_name)).toEqual(
      inventory.migrations.map((migration) => migration.name),
    );
    expect(rows.every((row) => row.finished_at instanceof Date)).toBe(true);

    const patient = await admin.query<{ external_code: string; age: number; clinical_data: unknown }>(
      `SELECT external_code, age, clinical_data FROM ${quoteIdentifier(schema)}.patients WHERE id = $1`,
      [patientId],
    );
    expect(patient.rows).toEqual([
      { external_code: "legacy-patient-1", age: 64, clinical_data: { source: "legacy" } },
    ]);
  });

  it("repeats a normal deploy without resolving an already applied schema", async () => {
    const schema = uniqueSchema("repeat");
    await createSchema(schema);
    await applyBaseline(schema);

    const first = await deploy(schema);
    expect(first.result.plan).toBe("baseline-only");
    expect(first.calls).toContain("resolve:0_init");

    const second = await deploy(schema);
    expect(second.result.plan).toBe("history");
    expect(second.result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
    expect(second.calls).toEqual(["lock", "inspect", "deploy", "release"]);
    expect(second.calls.some((call) => call.startsWith("resolve"))).toBe(false);

    expect(await history(schema)).toHaveLength(inventory.migrations.length);
  });

  it("fails closed on a failed history row without running the CLI", async () => {
    const schema = uniqueSchema("failedhistory");
    await createSchema(schema);
    await applyBaseline(schema);
    await deploy(schema);

    const failedMigration = inventory.migrations[2]?.name;
    expect(failedMigration).toBeDefined();
    await admin.query(
      `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("_prisma_migrations")}
          SET finished_at = NULL
        WHERE migration_name = $1`,
      [failedMigration],
    );

    const failure = await deployFailure(schema);
    expect(failure.code).toBe("MIGRATION_HISTORY_INCOMPLETE");
    expect(failure.calls).toEqual(["lock", "inspect", "release"]);

    const rows = await history(schema);
    expect(rows.find((row) => row.migration_name === failedMigration)?.finished_at).toBeNull();
  });

  it("fails closed on history checksum drift without running the CLI", async () => {
    const schema = uniqueSchema("checksum");
    await createSchema(schema);
    await applyBaseline(schema);
    await deploy(schema);

    await admin.query(
      `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("_prisma_migrations")}
          SET checksum = repeat('0', 64)
        WHERE migration_name = '0_init'`,
    );

    const failure = await deployFailure(schema);
    expect(failure.code).toBe("MIGRATION_HISTORY_INVALID");
    expect(failure.calls).toEqual(["lock", "inspect", "release"]);
  });

  const divergentCases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (schema: string) => Promise<void>;
  }> = [
    {
      name: "an extra table",
      mutate: async (schema) => {
        await admin.query(`CREATE TABLE ${quoteIdentifier(schema)}.rogue_table (id integer)`);
      },
    },
    {
      name: "an extra column",
      mutate: async (schema) => {
        await admin.query(`ALTER TABLE ${quoteIdentifier(schema)}.patients ADD COLUMN rogue_column integer`);
      },
    },
    {
      name: "a changed default",
      mutate: async (schema) => {
        await admin.query(`ALTER TABLE ${quoteIdentifier(schema)}.patients ALTER COLUMN age SET DEFAULT 42`);
      },
    },
    {
      name: "an unexpected check constraint",
      mutate: async (schema) => {
        await admin.query(
          `ALTER TABLE ${quoteIdentifier(schema)}.patients ADD CONSTRAINT rogue_check CHECK (age IS NULL OR age > 0)`,
        );
      },
    },
    {
      name: "an unexpected index",
      mutate: async (schema) => {
        await admin.query(`CREATE INDEX rogue_idx ON ${quoteIdentifier(schema)}.patients (age)`);
      },
    },
    {
      name: "an unexpected trigger",
      mutate: async (schema) => {
        await admin.query(
          `CREATE FUNCTION ${quoteIdentifier(schema)}.rogue_trigger() RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN
             RETURN NEW;
           END
           $fn$;
           CREATE TRIGGER rogue_trigger BEFORE INSERT ON ${quoteIdentifier(schema)}.patients
           FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.rogue_trigger();`,
        );
      },
    },
    {
      name: "a missing expected table",
      mutate: async (schema) => {
        await admin.query(`DROP TABLE ${quoteIdentifier(schema)}.clinical_feedback CASCADE`);
      },
    },
    {
      name: "a dropped foreign key constraint",
      mutate: async (schema) => {
        await admin.query(
          `ALTER TABLE ${quoteIdentifier(schema)}.clinical_feedback DROP CONSTRAINT clinical_feedback_consultation_id_fkey`,
        );
      },
    },
    {
      name: "a changed column type",
      mutate: async (schema) => {
        await admin.query(
          `ALTER TABLE ${quoteIdentifier(schema)}.patients ALTER COLUMN age TYPE text USING age::text`,
        );
      },
    },
    {
      name: "a changed column nullability",
      mutate: async (schema) => {
        await admin.query(
          `ALTER TABLE ${quoteIdentifier(schema)}.patients ALTER COLUMN external_code SET NOT NULL`,
        );
      },
    },
  ];

  it.each(divergentCases)("rejects $name before creating Prisma history", async ({ mutate }) => {
    const schema = uniqueSchema("divergent");
    await createSchema(schema);
    await applyBaseline(schema);
    await mutate(schema);

    const failure = await deployFailure(schema);

    expect(failure.code).toBe("MIGRATION_BASELINE_DIVERGENT");
    expect(failure.calls).toEqual(["lock", "inspect", "release"]);
    expect(await historyTableCount(schema)).toBe(0);
  });

  it("serializes concurrent wrappers through the advisory lock with a single resolve", async () => {
    const schema = uniqueSchema("parallel");
    await createSchema(schema);
    await applyBaseline(schema);

    const [first, second] = await Promise.all([deploy(schema), deploy(schema)]);

    const allCalls = [...first.calls, ...second.calls];
    expect(allCalls.filter((call) => call.startsWith("resolve"))).toEqual(["resolve:0_init"]);
    expect(allCalls.filter((call) => call === "deploy")).toHaveLength(2);
    expect([first.result.plan, second.result.plan].sort()).toEqual(["baseline-only", "history"]);

    const rows = await history(schema);
    expectAcceptedHistoryChecksums(rows);
  });

  describe("cross-EOL CLI portability", () => {
    it("deploys a CRLF migration tree and repeats from an LF tree", async () => {
      const schema = uniqueSchema("eol_crlf_lf");
      await createSchema(schema);
      const crlfTree = createMigrationTree("crlf");
      const lfTree = createMigrationTree("lf");
      try {
        const first = await deployWithTree(schema, crlfTree);
        expect(first.result.plan).toBe("empty");
        expect(first.result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
        expectAcceptedHistoryChecksums(await history(schema));

        const second = await deployWithTree(schema, lfTree);
        expect(second.result.plan).toBe("history");
        expect(second.result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
        expect(second.calls).toEqual(["lock", "inspect", "deploy", "release"]);
        expectAcceptedHistoryChecksums(await history(schema));
      } finally {
        rmSync(crlfTree, { recursive: true, force: true });
        rmSync(lfTree, { recursive: true, force: true });
      }
    });

    it("deploys an LF migration tree and repeats from a CRLF tree", async () => {
      const schema = uniqueSchema("eol_lf_crlf");
      await createSchema(schema);
      const lfTree = createMigrationTree("lf");
      const crlfTree = createMigrationTree("crlf");
      try {
        const first = await deployWithTree(schema, lfTree);
        expect(first.result.plan).toBe("empty");
        expect(first.result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
        expectAcceptedHistoryChecksums(await history(schema));

        const second = await deployWithTree(schema, crlfTree);
        expect(second.result.plan).toBe("history");
        expect(second.result.actions).toEqual([{ kind: "deploy", result: "ok" }]);
        expect(second.calls).toEqual(["lock", "inspect", "deploy", "release"]);
        expectAcceptedHistoryChecksums(await history(schema));
      } finally {
        rmSync(lfTree, { recursive: true, force: true });
        rmSync(crlfTree, { recursive: true, force: true });
      }
    });

    it.each(["lf", "crlf"] as const)(
      "rejects a semantically changed %s source even when EOL differs",
      async (eol) => {
        const schema = uniqueSchema(`eol_changed_${eol}`);
        await createSchema(schema);
        const originalTree = createMigrationTree(eol);
        const changedMigration = inventory.migrations[1]?.name;
        expect(changedMigration).toBeDefined();
        let changedTree: string | undefined;
        try {
          await deployWithTree(schema, originalTree);
          changedTree = createMigrationTree(eol, (root) => {
            appendFileSync(
              join(root, "prisma", "migrations", changedMigration as string, "migration.sql"),
              " ",
            );
          });

          const failure = await deployFailureWithTree(schema, changedTree);
          expect(failure.code).toBe("MIGRATION_HISTORY_INVALID");
          expect(failure.calls).toEqual(["lock", "inspect", "release"]);
        } finally {
          rmSync(originalTree, { recursive: true, force: true });
          if (changedTree !== undefined) {
            rmSync(changedTree, { recursive: true, force: true });
          }
        }
      },
    );
  });

  const unexpectedObjectCases: ReadonlyArray<{
    readonly name: string;
    readonly baseline: boolean;
    readonly mutate: (schema: string) => Promise<void>;
  }> = [
    {
      name: "a view in an otherwise empty schema",
      baseline: false,
      mutate: async (schema) => {
        await admin.query(`CREATE VIEW ${quoteIdentifier(schema)}.rogue_view AS SELECT 1 AS value`);
      },
    },
    {
      name: "a sequence next to the baseline",
      baseline: true,
      mutate: async (schema) => {
        await admin.query(`CREATE SEQUENCE ${quoteIdentifier(schema)}.rogue_seq`);
      },
    },
    {
      name: "a SECURITY DEFINER function",
      baseline: true,
      mutate: async (schema) => {
        await admin.query(
          `CREATE FUNCTION ${quoteIdentifier(schema)}.rogue_fn() RETURNS integer
           LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT 1 $fn$`,
        );
      },
    },
    {
      name: "a user domain",
      baseline: true,
      mutate: async (schema) => {
        await admin.query(`CREATE DOMAIN ${quoteIdentifier(schema)}.rogue_domain AS text`);
      },
    },
    {
      name: "a user composite type",
      baseline: true,
      mutate: async (schema) => {
        await admin.query(
          `CREATE TYPE ${quoteIdentifier(schema)}.rogue_composite AS (value integer)`,
        );
      },
    },
  ];

  it.each(unexpectedObjectCases)("rejects $name before any CLI", async ({ baseline, mutate }) => {
    const schema = uniqueSchema("unexpected");
    await createSchema(schema);
    if (baseline) {
      await applyBaseline(schema);
    }
    await mutate(schema);

    const failure = await deployFailure(schema);

    expect(failure.code).toBe("MIGRATION_BASELINE_DIVERGENT");
    expect(failure.calls).toEqual(["lock", "inspect", "release"]);
    expect(await historyTableCount(schema)).toBe(0);
  });

  it("captures a rogue domain exactly and excludes its implicit array type", async () => {
    // Concrete allowlist probe: CREATE DOMAIN implicitly creates the array
    // type `_rogue_domain` in the same schema. The capture must contain the
    // domain (under-capture bypass) and must NOT contain the implicit array
    // (over-capture): exact equality pins both directions.
    const schema = uniqueSchema("arrayprobe");
    await createSchema(schema);
    await applyBaseline(schema);
    await admin.query(`CREATE DOMAIN ${quoteIdentifier(schema)}.rogue_domain AS text`);

    const state = await inspectDatabase(admin, schema);
    expect(state.metadata.unexpectedObjects).toEqual([
      { kind: "domain", name: "rogue_domain" },
    ]);
  });

  it("inspects only the bound target schema and ignores divergent neighbours", async () => {
    const decoy = uniqueSchema("decoy");
    const target = uniqueSchema("target");
    await createSchema(decoy);
    await createSchema(target);
    // The decoy matches the baseline plus a rogue table: an unbound
    // introspection or a search_path-dependent read would abort on it.
    await applyBaseline(decoy);
    await admin.query(`CREATE TABLE ${quoteIdentifier(decoy)}.rogue_table (id integer)`);

    const { result, calls } = await deploy(target);

    expect(result.plan).toBe("empty");
    expect(calls).toEqual(["lock", "inspect", "deploy", "release"]);

    const rows = await history(target);
    expect(rows).toHaveLength(inventory.migrations.length);
    expect(await historyTableCount(decoy)).toBe(0);
  });
});
