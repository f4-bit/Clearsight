import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { inject } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Upgrade path of an existing deployment: a database bootstrapped from
 * docker/init.sql (with data) must accept every incremental migration in
 * order. Runs in its own schema so it does not touch the shared test schema.
 */
const SCHEMA = "legacy_upgrade";
let client: Client;

const MIGRATIONS = migrationNames();
const BASELINE = MIGRATIONS[0] as string;
const ALIGNMENT = MIGRATIONS[1] as string;
const EXECUTION = MIGRATIONS[2] as string;

const A = "00000000-0000-4000-8000-0000000000a1";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const I = "00000000-0000-4000-8000-0000000000e1";
const IMG = "00000000-0000-4000-8000-0000000000b1";
const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";

beforeAll(async () => {
  client = new Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
});
afterAll(async () => {
  await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

describe("0_init + incremental migrations on legacy data", () => {
  const SNAPSHOT = "00000000-0000-4000-8000-0000000000e2";
  const NEW_INFERENCE = "00000000-0000-4000-8000-0000000000e3";

  it("migration folders are in the expected order", () => {
    expect(BASELINE).toBe("0_init");
    expect(ALIGNMENT).toMatch(/prisma_alignment$/);
    expect(EXECUTION).toMatch(/_execution$/);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3);
  });

  it("upgrades a populated init.sql database without losing rows", async () => {
    await client.query(migrationSql(BASELINE));
    await client.query(`
      INSERT INTO patients (id) VALUES ('${A}');
      INSERT INTO consultations (id, patient_id, doctor_id, status) VALUES
        ('${C1}', '${A}', '${D1}', 'PENDIENTE'), ('${C2}', '${A}', '${D2}', 'COMPLETADA');
      INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ('${IMG}', '${C1}', 'OD', 'x');
      INSERT INTO inferences (id, image_id, predicted_class) VALUES ('${I}', '${IMG}', 1);
      INSERT INTO clinical_feedback (consultation_id, inference_id, doctor_id, validated_class, created_at) VALUES
        ('${C1}', '${I}', '${D1}', 0, now() - interval '1 day'),
        ('${C1}', '${I}', '${D1}', 1, now());
    `);

    for (const name of MIGRATIONS.slice(1)) {
      await client.query(migrationSql(name));
    }

    const statuses = await client.query("SELECT id, status FROM consultations ORDER BY id");
    expect(statuses.rows.map((r) => r.status)).toEqual(["QUEUED", "COMPLETED"]);

    // Orphan doctor ids became disabled placeholder users so the FKs hold.
    const users = await client.query("SELECT id, is_active, role FROM users ORDER BY id");
    expect(users.rows).toEqual([
      { id: D1, is_active: false, role: "OFTALMOLOGO" },
      { id: D2, is_active: false, role: "OFTALMOLOGO" },
    ]);

    // Duplicate verdicts collapsed to the most recent one.
    const feedback = await client.query("SELECT validated_class FROM clinical_feedback");
    expect(feedback.rows).toEqual([{ validated_class: 1 }]);

    // Legacy execution metadata is preserved as NULL/empty: no fake backfill.
    const inference = await client.query(
      "SELECT consultation_id, eye_side, clinical_snapshot_id, status, reanalysis_of_id, predicted_class FROM inferences WHERE id = $1",
      [I],
    );
    expect(inference.rows).toEqual([
      {
        consultation_id: null,
        eye_side: null,
        clinical_snapshot_id: null,
        status: null,
        reanalysis_of_id: null,
        predicted_class: 1,
      },
    ]);

    const snapshots = await client.query("SELECT count(*)::int AS count FROM clinical_snapshots");
    expect(snapshots.rows[0].count).toBe(0);

    const selections = await client.query(
      "SELECT required_execution_ids, required_set_version, required_set_frozen_at FROM consultations ORDER BY id",
    );
    expect(selections.rows).toEqual([
      { required_execution_ids: [], required_set_version: null, required_set_frozen_at: null },
      { required_execution_ids: [], required_set_version: null, required_set_frozen_at: null },
    ]);
  });

  it("is re-runnable (database already bootstrapped / already migrated)", async () => {
    await expect(client.query(migrationSql(ALIGNMENT))).resolves.toBeDefined();
  });

  it("replays migration A without duplicating or destroying existing data", async () => {
    await client.query(
      "INSERT INTO clinical_snapshots (id, consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'clinical-v1')",
      [SNAPSHOT, C1],
    );
    await client.query(
      "INSERT INTO inferences (id, image_id, consultation_id, eye_side, clinical_snapshot_id, status) VALUES ($1, $2, $3, 'OD', $4, 'COMPLETED')",
      [NEW_INFERENCE, IMG, C1, SNAPSHOT],
    );

    const before = await client.query(
      "SELECT (SELECT count(*)::int FROM clinical_snapshots) AS snapshots, (SELECT count(*)::int FROM inferences) AS inferences",
    );
    await expect(client.query(migrationSql(EXECUTION))).resolves.toBeDefined();
    const after = await client.query(
      "SELECT (SELECT count(*)::int FROM clinical_snapshots) AS snapshots, (SELECT count(*)::int FROM inferences) AS inferences",
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      client.query("SELECT status FROM inferences WHERE id = $1", [NEW_INFERENCE]),
    ).resolves.toMatchObject({ rows: [{ status: "COMPLETED" }] });
  });

  it("enforces the new rules", async () => {
    await expect(client.query(`UPDATE consultations SET status = 'PENDIENTE'`)).rejects.toThrow(/consultations_status_check/);
    await expect(
      client.query(`UPDATE clinical_feedback SET validated_class = NULL, is_gold_standard = TRUE`),
    ).rejects.toThrow(/gold_requires_label/);
    await expect(client.query(`DELETE FROM users WHERE id = '${D1}'`)).rejects.toThrow(/foreign key/);
    await expect(
      client.query("UPDATE clinical_snapshots SET schema_version = 'changed' WHERE id = $1", [SNAPSHOT]),
    ).rejects.toThrow(/immutable/);
  });
});

/**
 * Migration A invariants on a fresh schema. The schema is owned by this test
 * file and dropped afterwards; it never touches the shared public test schema.
 */
describe("migration A execution invariants", () => {
  const RULES_SCHEMA = "execution_rules";
  const P = "00000000-0000-4000-8000-0000000001a1";
  const D1 = "00000000-0000-4000-8000-0000000001d1";
  const D2 = "00000000-0000-4000-8000-0000000001d2";
  const C1 = "00000000-0000-4000-8000-0000000001c1";
  const C2 = "00000000-0000-4000-8000-0000000001c2";
  const IMG1 = "00000000-0000-4000-8000-0000000001b1";
  const IMG2 = "00000000-0000-4000-8000-0000000001b2";
  const IMG3 = "00000000-0000-4000-8000-0000000001b3";
  const IMG4 = "00000000-0000-4000-8000-0000000001b4";
  const I1 = "00000000-0000-4000-8000-0000000001e1";
  const I2 = "00000000-0000-4000-8000-0000000001e2";
  const I3 = "00000000-0000-4000-8000-0000000001e3";
  const I4 = "00000000-0000-4000-8000-0000000001e4";
  const S1 = "00000000-0000-4000-8000-0000000001f1";
  const S2 = "00000000-0000-4000-8000-0000000001f2";
  const S3 = "00000000-0000-4000-8000-0000000001f3";

  let rules: Client;

  beforeAll(async () => {
    rules = new Client({ connectionString: inject("databaseUrl") });
    await rules.connect();
    await rules.query(`DROP SCHEMA IF EXISTS ${RULES_SCHEMA} CASCADE; CREATE SCHEMA ${RULES_SCHEMA}; SET search_path TO ${RULES_SCHEMA}`);
    for (const name of MIGRATIONS) {
      await rules.query(migrationSql(name));
    }
  });

  afterAll(async () => {
    await rules.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${RULES_SCHEMA} CASCADE`);
    await rules.end();
  });

  beforeEach(async () => {
    await rules.query(
      "TRUNCATE TABLE clinical_snapshots, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
    );
  });

  async function seedBase(): Promise<void> {
    await rules.query(
      "INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dr'), ($3, $4, 'x', 'Dr')",
      [D1, "rules-d1@clearsight.test", D2, "rules-d2@clearsight.test"],
    );
    await rules.query("INSERT INTO patients (id) VALUES ($1)", [P]);
    await rules.query(
      "INSERT INTO consultations (id, patient_id, doctor_id) VALUES ($1, $2, $3), ($4, $2, $5)",
      [C1, P, D1, C2, D2],
    );
    await rules.query(
      "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'a'), ($3, $2, 'OS', 'b'), ($4, $5, 'OD', 'c')",
      [IMG1, C1, IMG2, IMG3, C2],
    );
  }

  async function insertSnapshot(id: string, consultationId: string): Promise<void> {
    await rules.query(
      "INSERT INTO clinical_snapshots (id, consultation_id, raw_payload, normalized_payload, schema_version, model_versions) " +
        "VALUES ($1, $2, $3::jsonb, $4::jsonb, 'clinical-v1', $5::jsonb)",
      [id, consultationId, JSON.stringify({ raw: true }), JSON.stringify({ normalized: true }), JSON.stringify({ model: "2026-09-24" })],
    );
  }

  async function insertInference(
    id: string,
    imageId: string,
    opts: {
      consultationId?: string | null;
      eyeSide?: string | null;
      snapshotId?: string | null;
      status?: string | null;
      reanalysisOfId?: string | null;
    } = {},
  ): Promise<void> {
    await rules.query(
      "INSERT INTO inferences (id, image_id, consultation_id, eye_side, clinical_snapshot_id, status, reanalysis_of_id, predicted_class) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 1)",
      [
        id,
        imageId,
        opts.consultationId ?? null,
        opts.eyeSide ?? null,
        opts.snapshotId ?? null,
        opts.status ?? null,
        opts.reanalysisOfId ?? null,
      ],
    );
  }

  async function freezeSelection(consultationId: string, ids: string[], version = "required-v1"): Promise<void> {
    await rules.query(
      "UPDATE consultations SET required_execution_ids = $2::uuid[], required_set_version = $3, required_set_frozen_at = now() WHERE id = $1",
      [consultationId, ids, version],
    );
  }

  it("creates the expected tables, columns and constraints", async () => {
    const consultationColumns = await rules.query(
      "SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'consultations'",
      [RULES_SCHEMA],
    );
    const consultations = Object.fromEntries(
      consultationColumns.rows.map((row) => [row.column_name, row]),
    ) as Record<string, { is_nullable: string; udt_name: string }>;
    expect(consultations.required_execution_ids).toMatchObject({ is_nullable: "NO", udt_name: "_uuid" });
    expect(consultations.required_set_version).toMatchObject({ is_nullable: "YES" });
    expect(consultations.required_set_frozen_at).toMatchObject({ is_nullable: "YES" });

    const inferenceColumns = await rules.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'inferences'",
      [RULES_SCHEMA],
    );
    const inferences = Object.fromEntries(
      inferenceColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    ) as Record<string, string>;
    for (const column of ["consultation_id", "eye_side", "clinical_snapshot_id", "status", "reanalysis_of_id"]) {
      expect(inferences[column]).toBe("YES");
    }

    const snapshotColumns = await rules.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'clinical_snapshots'",
      [RULES_SCHEMA],
    );
    const snapshots = Object.fromEntries(
      snapshotColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    ) as Record<string, string>;
    for (const column of ["raw_payload", "normalized_payload", "schema_version", "model_versions"]) {
      expect(snapshots[column]).toBe("NO");
    }

    const snapshotConstraints = await rules.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass",
      [`${RULES_SCHEMA}.clinical_snapshots`],
    );
    expect(snapshotConstraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "clinical_snapshots_raw_payload_object",
        "clinical_snapshots_normalized_payload_object",
        "clinical_snapshots_model_versions_object",
        "clinical_snapshots_schema_version_nonempty",
        "clinical_snapshots_consultation_id_fkey",
      ]),
    );

    const inferenceConstraints = await rules.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass",
      [`${RULES_SCHEMA}.inferences`],
    );
    expect(inferenceConstraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "inferences_consultation_id_fkey",
        "inferences_clinical_snapshot_id_fkey",
        "inferences_reanalysis_of_id_fkey",
        "inferences_eye_side_check",
        "inferences_status_check",
        "inferences_reanalysis_not_self",
      ]),
    );
  });

  it("requires JSON objects and a non-empty schema version in snapshots", async () => {
    await seedBase();

    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, '[]'::jsonb, '{}'::jsonb, 'v1')",
        [C1],
      ),
    ).rejects.toThrow(/raw_payload_object/);
    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, '{}'::jsonb, '[]'::jsonb, 'v1')",
        [C1],
      ),
    ).rejects.toThrow(/normalized_payload_object/);
    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, '{}'::jsonb, '{}'::jsonb, '   ')",
        [C1],
      ),
    ).rejects.toThrow(/schema_version_nonempty/);
    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version, model_versions) VALUES ($1, '{}'::jsonb, '{}'::jsonb, 'v1', '[]'::jsonb)",
        [C1],
      ),
    ).rejects.toThrow(/model_versions_object/);
  });

  it("accepts a full execution and keeps the snapshot immutable", async () => {
    await seedBase();
    await insertSnapshot(S1, C1);
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD", snapshotId: S1, status: "COMPLETED" });
    await insertInference(I2, IMG2, { consultationId: C1, eyeSide: "OS", snapshotId: S1, status: "REVIEW_REQUIRED" });

    const rows = await rules.query(
      "SELECT id, consultation_id, eye_side, clinical_snapshot_id, status FROM inferences ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: I1, consultation_id: C1, eye_side: "OD", clinical_snapshot_id: S1, status: "COMPLETED" },
      { id: I2, consultation_id: C1, eye_side: "OS", clinical_snapshot_id: S1, status: "REVIEW_REQUIRED" },
    ]);

    await expect(
      rules.query("UPDATE clinical_snapshots SET schema_version = 'changed' WHERE id = $1", [S1]),
    ).rejects.toThrow(/immutable/);
    await expect(rules.query("DELETE FROM clinical_snapshots WHERE id = $1", [S1])).rejects.toThrow(/immutable/);
    await expect(rules.query("DELETE FROM consultations WHERE id = $1", [C1])).rejects.toThrow(/foreign key/);
  });

  it("rejects contradictory execution metadata and invalid statuses", async () => {
    await seedBase();
    await insertSnapshot(S1, C1);
    await insertSnapshot(S2, C2);

    await expect(insertInference(I1, IMG1, { eyeSide: "OS" })).rejects.toThrow(/eye_side/);
    await expect(insertInference(I1, IMG1, { consultationId: C2 })).rejects.toThrow(/consultation_id/);
    await expect(insertInference(I1, IMG1, { snapshotId: S2 })).rejects.toThrow(/another consultation/);
    await expect(insertInference(I1, IMG1, { status: "PROCESSING" })).rejects.toThrow(/inferences_status_check/);
    await expect(insertInference(I1, IMG1, { eyeSide: "XX" })).rejects.toThrow(/eye_side/);
    await expect(insertInference(I1, IMG1, { reanalysisOfId: I1 })).rejects.toThrow(/itself/);
  });

  it("links reanalysis only within the same consultation and eye context", async () => {
    await seedBase();
    await insertSnapshot(S1, C1);
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD", snapshotId: S1, status: "COMPLETED" });
    await insertInference(I2, IMG1, {
      consultationId: C1,
      eyeSide: "OD",
      snapshotId: S1,
      status: "QUEUED",
      reanalysisOfId: I1,
    });

    await expect(
      insertInference(I3, IMG2, { consultationId: C1, eyeSide: "OS", reanalysisOfId: I1 }),
    ).rejects.toThrow(/same consultation and eye/);
    await expect(
      insertInference(I4, IMG3, { consultationId: C2, eyeSide: "OD", reanalysisOfId: I1 }),
    ).rejects.toThrow(/same consultation and eye/);
    await expect(rules.query("DELETE FROM inferences WHERE id = $1", [I1])).rejects.toThrow(/foreign key|reanalysis/);
    await expect(
      rules.query("UPDATE inferences SET image_id = $2, eye_side = 'OS' WHERE id = $1", [I1, IMG2]),
    ).rejects.toThrow(/reanalysis child/);
  });

  it("keeps legacy minimal inferences creatable with NULL metadata", async () => {
    await seedBase();
    await rules.query("INSERT INTO inferences (id, image_id, predicted_class) VALUES ($1, $2, 1)", [I1, IMG1]);

    const row = await rules.query(
      "SELECT consultation_id, eye_side, clinical_snapshot_id, status, reanalysis_of_id FROM inferences WHERE id = $1",
      [I1],
    );
    expect(row.rows).toEqual([
      {
        consultation_id: null,
        eye_side: null,
        clinical_snapshot_id: null,
        status: null,
        reanalysis_of_id: null,
      },
    ]);
  });

  it("freezes a required selection that belongs to the consultation", async () => {
    await seedBase();
    // Legacy-style execution: consultation_id is NULL, so membership falls back
    // to the authoritative image consultation without writing a fake backfill.
    await rules.query("INSERT INTO inferences (id, image_id, predicted_class) VALUES ($1, $2, 1)", [I1, IMG1]);

    await freezeSelection(C1, [I1], "required-v1");

    const frozen = await rules.query(
      "SELECT required_execution_ids, required_set_version, required_set_frozen_at FROM consultations WHERE id = $1",
      [C1],
    );
    expect(frozen.rows[0].required_execution_ids).toEqual([I1]);
    expect(frozen.rows[0].required_set_version).toBe("required-v1");
    expect(frozen.rows[0].required_set_frozen_at).not.toBeNull();

    await expect(
      rules.query("UPDATE consultations SET status = 'COMPLETED', clinical_data = $2::jsonb WHERE id = $1", [
        C1,
        JSON.stringify({ updated: true }),
      ]),
    ).resolves.toBeDefined();

    const open = await rules.query(
      "SELECT required_execution_ids, required_set_version, required_set_frozen_at FROM consultations WHERE id = $1",
      [C2],
    );
    expect(open.rows).toEqual([
      { required_execution_ids: [], required_set_version: null, required_set_frozen_at: null },
    ]);
  });

  it("rejects invalid required selections", async () => {
    await seedBase();
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD" });
    await insertInference(I2, IMG3, { consultationId: C2, eyeSide: "OD" });

    await expect(freezeSelection(C1, [I1, I1], "required-v1")).rejects.toThrow(/duplicates/);
    await expect(freezeSelection(C1, [I2], "required-v1")).rejects.toThrow(/belong to this consultation/);
    await expect(freezeSelection(C1, [I1], "")).rejects.toThrow(/required_set_version/);
    await expect(
      rules.query(
        "UPDATE consultations SET required_execution_ids = $2::uuid[], required_set_version = 'required-v1' WHERE id = $1",
        [C1, [I1]],
      ),
    ).rejects.toThrow(/must be frozen/);
    await expect(
      rules.query("UPDATE consultations SET required_set_version = 'required-v1' WHERE id = $1", [C1]),
    ).rejects.toThrow(/empty required selection cannot be frozen/);
  });

  it("protects a frozen selection and its selected executions", async () => {
    await seedBase();
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD" });
    await freezeSelection(C1, [I1], "required-v1");

    await expect(
      rules.query("UPDATE consultations SET required_execution_ids = '{}'::uuid[] WHERE id = $1", [C1]),
    ).rejects.toThrow(/frozen/);
    await expect(
      rules.query("UPDATE consultations SET required_set_version = 'required-v2' WHERE id = $1", [C1]),
    ).rejects.toThrow(/frozen/);
    await expect(
      rules.query("UPDATE consultations SET required_set_frozen_at = now() WHERE id = $1", [C1]),
    ).rejects.toThrow(/frozen/);

    await expect(
      rules.query("UPDATE consultations SET status = 'COMPLETED', clinical_data = $2::jsonb WHERE id = $1", [
        C1,
        JSON.stringify({ stillValid: true }),
      ]),
    ).resolves.toBeDefined();

    await expect(rules.query("DELETE FROM inferences WHERE id = $1", [I1])).rejects.toThrow(/selected as required/);
    await expect(
      rules.query("UPDATE inferences SET image_id = $2, consultation_id = $3, eye_side = 'OD' WHERE id = $1", [I1, IMG3, C2]),
    ).rejects.toThrow(/required selection/);
  });

  it("replays migration A without duplicating or dropping new execution data", async () => {
    await seedBase();
    await insertSnapshot(S1, C1);
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD", snapshotId: S1, status: "COMPLETED" });
    await freezeSelection(C1, [I1], "required-v1");

    const before = await rules.query(
      "SELECT (SELECT count(*)::int FROM clinical_snapshots) AS snapshots, " +
        "(SELECT count(*)::int FROM inferences) AS inferences, " +
        "(SELECT required_execution_ids FROM consultations WHERE id = $1) AS required",
      [C1],
    );
    await expect(rules.query(migrationSql(EXECUTION))).resolves.toBeDefined();
    const after = await rules.query(
      "SELECT (SELECT count(*)::int FROM clinical_snapshots) AS snapshots, " +
        "(SELECT count(*)::int FROM inferences) AS inferences, " +
        "(SELECT required_execution_ids FROM consultations WHERE id = $1) AS required",
      [C1],
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      rules.query("UPDATE clinical_snapshots SET schema_version = 'changed' WHERE id = $1", [S1]),
    ).rejects.toThrow(/immutable/);
  });

  it("preserves the legacy cascade when no snapshot or execution metadata exists", async () => {
    await seedBase();
    await rules.query("INSERT INTO inferences (id, image_id, predicted_class) VALUES ($1, $2, 1)", [I1, IMG1]);
    await rules.query(
      "INSERT INTO clinical_feedback (consultation_id, inference_id, doctor_id, validated_class, created_at) VALUES ($1, $2, $3, 1, now())",
      [C1, I1, D1],
    );

    // Old, non-snapshot rows must keep the historical ON DELETE CASCADE path.
    await rules.query("DELETE FROM consultations WHERE id = $1", [C1]);

    const rest = await rules.query(
      "SELECT (SELECT count(*)::int FROM consultations WHERE id = $1) AS consultations, " +
        "(SELECT count(*)::int FROM images WHERE consultation_id = $1) AS images, " +
        "(SELECT count(*)::int FROM inferences WHERE image_id = ANY($2::uuid[])) AS inferences, " +
        "(SELECT count(*)::int FROM clinical_feedback WHERE consultation_id = $1) AS feedback",
      [C1, [IMG1, IMG2]],
    );
    expect(rest.rows).toEqual([{ consultations: 0, images: 0, inferences: 0, feedback: 0 }]);

    // The sibling consultation is untouched.
    const sibling = await rules.query(
      "SELECT (SELECT count(*)::int FROM consultations WHERE id = $1) AS consultations, " +
        "(SELECT count(*)::int FROM images WHERE consultation_id = $1) AS images",
      [C2],
    );
    expect(sibling.rows).toEqual([{ consultations: 1, images: 1 }]);
  });

  it("restricts consultation deletion precisely on the snapshot FK", async () => {
    await seedBase();
    // Snapshot only: no inference carries the new consultation_id, so a plain
    // /foreign key/ match could not tell which constraint protects the history.
    await insertSnapshot(S1, C1);

    await expect(rules.query("DELETE FROM consultations WHERE id = $1", [C1])).rejects.toThrow(
      /clinical_snapshots_consultation_id_fkey/,
    );
    await expect(rules.query("DELETE FROM patients WHERE id = $1", [P])).rejects.toThrow(
      /clinical_snapshots_consultation_id_fkey/,
    );
  });

  it("accepts every canonical job status and rejects other labels", async () => {
    await seedBase();
    const canonical = [
      "QUEUED",
      "DOWNLOADING",
      "LOCALIZING",
      "SEGMENTING",
      "CLASSIFYING",
      "COMPLETED",
      "REVIEW_REQUIRED",
      "FAILED",
    ];
    for (const [n, status] of canonical.entries()) {
      await insertInference(`00000000-0000-4000-8000-00000000019${n}`, IMG1, {
        consultationId: C1,
        eyeSide: "OD",
        status,
      });
    }
    const persisted = await rules.query("SELECT DISTINCT status FROM inferences ORDER BY status");
    expect(persisted.rows.map((r) => r.status).sort()).toEqual([...canonical].sort());

    for (const status of ["PROCESSING", "completed", "COMPLETED ", "", "NONE"]) {
      await expect(insertInference(I4, IMG1, { consultationId: C1, eyeSide: "OD", status })).rejects.toThrow(
        /inferences_status_check/,
      );
    }
    // NULL is the explicit legacy state, not a cast label.
    await insertInference(I4, IMG1, { consultationId: C1, eyeSide: "OD", status: null });
    const legacy = await rules.query("SELECT status FROM inferences WHERE id = $1", [I4]);
    expect(legacy.rows).toEqual([{ status: null }]);
  });

  it("validates reanalysis context through the authoritative image when metadata is NULL", async () => {
    await seedBase();
    await insertInference(I1, IMG1, { consultationId: null, eyeSide: null, status: null });

    // Both metadata NULL: accepted when the authoritative images agree.
    await insertInference(I2, IMG1, { reanalysisOfId: I1 });
    const child = await rules.query("SELECT consultation_id, eye_side, reanalysis_of_id FROM inferences WHERE id = $1", [I2]);
    expect(child.rows).toEqual([{ consultation_id: null, eye_side: null, reanalysis_of_id: I1 }]);

    // The parent row is not overwritten by the reanalysis (no label cast).
    const parent = await rules.query("SELECT predicted_class, consultation_id, eye_side FROM inferences WHERE id = $1", [I1]);
    expect(parent.rows).toEqual([{ predicted_class: 1, consultation_id: null, eye_side: null }]);

    // Fallback still rejects wrong eye/consultation even with NULL metadata.
    await expect(insertInference(I3, IMG2, { reanalysisOfId: I1 })).rejects.toThrow(/same consultation and eye/);
    await expect(insertInference(I3, IMG3, { reanalysisOfId: I1 })).rejects.toThrow(/same consultation and eye/);

    // A reanalysis target must be a real execution id, not a cast label. The
    // BEFORE trigger fires before the FK, so either guard may raise.
    await expect(
      insertInference(I3, IMG1, { reanalysisOfId: "00000000-0000-4000-8000-000000000404" }),
    ).rejects.toThrow(/reanalysis parent|foreign key/);
  });

  it("rejects non-object JSON payloads for snapshot evidence", async () => {
    await seedBase();
    for (const scalar of ["'42'::jsonb", "'\"x\"'::jsonb", "'true'::jsonb", "'null'::jsonb"]) {
      await expect(
        rules.query(
          `INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, ${scalar}, '{}'::jsonb, 'v1')`,
          [C1],
        ),
      ).rejects.toThrow(/raw_payload_object/);
    }
    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, '{}'::jsonb, '42'::jsonb, 'v1')",
        [C1],
      ),
    ).rejects.toThrow(/normalized_payload_object/);
    await expect(
      rules.query(
        "INSERT INTO clinical_snapshots (consultation_id, raw_payload, normalized_payload, schema_version, model_versions) VALUES ($1, '{}'::jsonb, '{}'::jsonb, 'v1', '42'::jsonb)",
        [C1],
      ),
    ).rejects.toThrow(/model_versions_object/);
  });

  it("creates the expected execution indexes", async () => {
    const idx = await rules.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'idx\\_%' ORDER BY indexname",
      [RULES_SCHEMA],
    );
    const names = idx.rows.map((r) => r.indexname as string);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_clinical_snapshots_consultation_id",
        "idx_consultations_required_execution_ids",
        "idx_inferences_consultation_id",
        "idx_inferences_clinical_snapshot_id",
        "idx_inferences_reanalysis_of_id",
      ]),
    );
    const gin = idx.rows.find((r) => r.indexname === "idx_consultations_required_execution_ids") as
      | { indexdef: string }
      | undefined;
    expect(gin?.indexdef).toContain("USING gin");
    expect(gin?.indexdef).toContain("required_execution_ids");
  });

  it("blocks swapping a selected execution to another image of the same consultation", async () => {
    await seedBase();
    await rules.query(
      "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'd')",
      [IMG4, C1],
    );
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD" });
    await freezeSelection(C1, [I1], "required-v1");

    await expect(
      rules.query("UPDATE inferences SET image_id = $2 WHERE id = $1", [I1, IMG4]),
    ).rejects.toThrow(/required selection/);

    const row = await rules.query("SELECT image_id, consultation_id, eye_side FROM inferences WHERE id = $1", [I1]);
    expect(row.rows).toEqual([{ image_id: IMG1, consultation_id: C1, eye_side: "OD" }]);
  });

  it("blocks changing a selected execution to the other eye in the same consultation", async () => {
    await seedBase();
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD" });
    await freezeSelection(C1, [I1], "required-v1");

    await expect(
      rules.query("UPDATE inferences SET image_id = $2, consultation_id = $3, eye_side = 'OS' WHERE id = $1", [
        I1,
        IMG2,
        C1,
      ]),
    ).rejects.toThrow(/required selection/);

    const row = await rules.query("SELECT image_id, consultation_id, eye_side FROM inferences WHERE id = $1", [I1]);
    expect(row.rows).toEqual([{ image_id: IMG1, consultation_id: C1, eye_side: "OD" }]);
  });

  it("keeps a non-NULL snapshot link immutable and blocks selected late links", async () => {
    await seedBase();
    await insertSnapshot(S1, C1);
    await insertSnapshot(S2, C1);
    await insertSnapshot(S3, C2);
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD", snapshotId: S1 });
    await freezeSelection(C1, [I1], "required-v1");

    await expect(
      rules.query("UPDATE inferences SET clinical_snapshot_id = $2 WHERE id = $1", [I1, S2]),
    ).rejects.toThrow(/snapshot link|immutable/);
    await expect(
      rules.query("UPDATE inferences SET clinical_snapshot_id = NULL WHERE id = $1", [I1]),
    ).rejects.toThrow(/snapshot link|immutable/);

    const unchanged = await rules.query("SELECT clinical_snapshot_id FROM inferences WHERE id = $1", [I1]);
    expect(unchanged.rows).toEqual([{ clinical_snapshot_id: S1 }]);

    // A selected execution whose legacy snapshot was NULL cannot get a late
    // snapshot link after the set is frozen; that would change closed evidence.
    await insertInference(I2, IMG3, { consultationId: C2, eyeSide: "OD" });
    await freezeSelection(C2, [I2], "required-c2");
    await expect(
      rules.query("UPDATE inferences SET clinical_snapshot_id = $2 WHERE id = $1", [I2, S3]),
    ).rejects.toThrow(/snapshot link|immutable/);

    // A legacy, non-selected execution may receive its first real snapshot; the
    // migration itself never fabricates that link.
    await insertInference(I3, IMG2, { consultationId: C1, eyeSide: "OS" });
    await expect(
      rules.query("UPDATE inferences SET clinical_snapshot_id = $2 WHERE id = $1", [I3, S1]),
    ).resolves.toBeDefined();
    const linked = await rules.query("SELECT clinical_snapshot_id FROM inferences WHERE id = $1", [I3]);
    expect(linked.rows).toEqual([{ clinical_snapshot_id: S1 }]);
  });

  it("keeps reanalysis provenance append-only", async () => {
    await seedBase();
    await insertInference(I1, IMG1, { consultationId: C1, eyeSide: "OD", status: "COMPLETED" });
    await insertInference(I2, IMG1, {
      consultationId: C1,
      eyeSide: "OD",
      status: "COMPLETED",
      reanalysisOfId: I1,
    });
    await insertInference(I3, IMG1, { consultationId: C1, eyeSide: "OD", status: "COMPLETED" });

    await expect(
      rules.query("UPDATE inferences SET reanalysis_of_id = $2 WHERE id = $1", [I1, I2]),
    ).rejects.toThrow(/reanalysis_of_id is immutable|immutable/);
    await expect(
      rules.query("UPDATE inferences SET reanalysis_of_id = $2 WHERE id = $1", [I2, I3]),
    ).rejects.toThrow(/reanalysis_of_id is immutable|immutable/);
    await expect(
      rules.query("UPDATE inferences SET reanalysis_of_id = $2 WHERE id = $1", [I3, I1]),
    ).rejects.toThrow(/reanalysis_of_id is immutable|immutable/);

    // Non-provenance updates remain valid, including a no-op reparent value.
    await expect(
      rules.query("UPDATE inferences SET status = 'FAILED', reanalysis_of_id = $2 WHERE id = $1", [I2, I1]),
    ).resolves.toBeDefined();

    const provenance = await rules.query("SELECT id, reanalysis_of_id, status FROM inferences ORDER BY id");
    expect(provenance.rows).toEqual([
      { id: I1, reanalysis_of_id: null, status: "COMPLETED" },
      { id: I2, reanalysis_of_id: I1, status: "FAILED" },
      { id: I3, reanalysis_of_id: null, status: "COMPLETED" },
    ]);
  });
});
