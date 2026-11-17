import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { inject } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Upgrade path of an existing deployment: a database bootstrapped from
 * docker/init.sql (with data) must accept the Prisma alignment migration.
 * Runs in its own schema so it does not touch the shared test schema.
 */
const SCHEMA = "legacy_upgrade";
let client: Client;

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

describe("0_init + prisma_alignment on legacy data", () => {
  const [baseline, alignment] = migrationNames();

  it("migration folders are in the expected order", () => {
    expect(baseline).toBe("0_init");
    expect(alignment).toMatch(/prisma_alignment$/);
  });

  it("upgrades a populated init.sql database without losing rows", async () => {
    await client.query(migrationSql(baseline as string));
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

    await client.query(migrationSql(alignment as string));

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
  });

  it("is re-runnable (database already bootstrapped / already migrated)", async () => {
    await expect(client.query(migrationSql(alignment as string))).resolves.toBeDefined();
  });

  it("enforces the new rules", async () => {
    await expect(client.query(`UPDATE consultations SET status = 'PENDIENTE'`)).rejects.toThrow(/consultations_status_check/);
    await expect(
      client.query(`UPDATE clinical_feedback SET validated_class = NULL, is_gold_standard = TRUE`),
    ).rejects.toThrow(/gold_requires_label/);
    await expect(client.query(`DELETE FROM users WHERE id = '${D1}'`)).rejects.toThrow(/foreign key/);
  });
});
