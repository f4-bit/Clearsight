import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { inject } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Migration E invariants: controlled owner backfill, immutable ownership and
 * author binding, explicit grant terms, append-only revocation, granted
 * execution identity freeze and least-privilege application-role DML.
 *
 * Each schema is owned by this file and dropped afterwards; the shared test
 * schema is never touched. PostgreSQL-only, no external resources.
 */

const MIGRATIONS = migrationNames();
const CLINICAL_ACCESS = MIGRATIONS.find((name) => name.endsWith("_clinical_access")) as string;
const PRE_CLINICAL_ACCESS = MIGRATIONS.filter((name) => name !== CLINICAL_ACCESS);

const RULES_SCHEMA = "clinical_access_rules";
const BACKFILL_SCHEMA = "clinical_access_backfill";

const DOCTOR = "00000000-0000-4000-8000-0000000a0001";
const DOCTOR2 = "00000000-0000-4000-8000-0000000a0002";
const ADMIN = "00000000-0000-4000-8000-0000000a0003";
const RESEARCHER = "00000000-0000-4000-8000-0000000a0004";
const PATIENT = "00000000-0000-4000-8000-0000000a0010";
const OTHER_PATIENT = "00000000-0000-4000-8000-0000000a0011";
const CONSULTATION = "00000000-0000-4000-8000-0000000a0020";
const OTHER_CONSULTATION = "00000000-0000-4000-8000-0000000a0021";
const IMAGE = "00000000-0000-4000-8000-0000000a0030";
const OTHER_IMAGE = "00000000-0000-4000-8000-0000000a0031";
const INFERENCE = "00000000-0000-4000-8000-0000000a0040";
const OTHER_INFERENCE = "00000000-0000-4000-8000-0000000a0041";

describe("clinical access migration E", () => {
  let rules: Client;

  beforeAll(async () => {
    rules = new Client({ connectionString: inject("databaseUrl") });
    await rules.connect();
    await rules.query(
      `DROP SCHEMA IF EXISTS ${RULES_SCHEMA} CASCADE; CREATE SCHEMA ${RULES_SCHEMA}; SET search_path TO ${RULES_SCHEMA}`,
    );
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
      "TRUNCATE TABLE inference_access_grants, clinical_snapshots, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
    );
    await rules.query(
      "INSERT INTO users (id, email, password_hash, full_name, role, is_active) VALUES " +
        "($1, 'doctor@rules.test', 'x', 'Doctor', 'OFTALMOLOGO', true), " +
        "($2, 'doctor2@rules.test', 'x', 'Doctor2', 'OFTALMOLOGO', true), " +
        "($3, 'admin@rules.test', 'x', 'Admin', 'ADMIN', true), " +
        "($4, 'researcher@rules.test', 'x', 'Researcher', 'INVESTIGADOR', true)",
      [DOCTOR, DOCTOR2, ADMIN, RESEARCHER],
    );
    await rules.query("INSERT INTO patients (id) VALUES ($1), ($2)", [PATIENT, OTHER_PATIENT]);
    await rules.query(
      "INSERT INTO consultations (id, patient_id, doctor_id) VALUES ($1, $3, $4), ($2, $3, $4)",
      [CONSULTATION, OTHER_CONSULTATION, PATIENT, DOCTOR],
    );
    await rules.query(
      "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'a'), ($3, $2, 'OS', 'b')",
      [IMAGE, CONSULTATION, OTHER_IMAGE],
    );
    await rules.query(
      "INSERT INTO inferences (id, image_id, predicted_class) VALUES ($1, $2, 1), ($3, $4, 1)",
      [INFERENCE, IMAGE, OTHER_INFERENCE, OTHER_IMAGE],
    );
  });

  async function insertGrant(over: {
    id?: string;
    inferenceId?: string;
    consultationId?: string;
    recipient?: string;
    reference?: string;
    approver?: string | null;
    createdAt?: Date;
    expiresAt?: Date;
    readResult?: boolean;
    readArtifacts?: boolean;
    readPdf?: boolean;
    canExport?: boolean;
  } = {}): Promise<string> {
    const id = over.id ?? randomUUID();
    const createdAt = over.createdAt ?? new Date();
    const expiresAt = over.expiresAt ?? new Date(createdAt.getTime() + 3_600_000);
    await rules.query(
      "INSERT INTO inference_access_grants " +
        "(id, inference_id, consultation_id, recipient_user_id, approval_reference, approved_by_user_id, created_at, expires_at, read_result, read_artifacts, read_pdf, can_export_gold_standard) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [
        id,
        over.inferenceId ?? INFERENCE,
        over.consultationId ?? CONSULTATION,
        over.recipient ?? RESEARCHER,
        over.reference ?? `APPROVAL-${randomUUID()}`,
        over.approver === undefined ? null : over.approver,
        createdAt,
        expiresAt,
        over.readResult ?? true,
        over.readArtifacts ?? false,
        over.readPdf ?? false,
        over.canExport ?? false,
      ],
    );
    return id;
  }

  it("creates the owner column, grant table, constraints and indexes", async () => {
    const owner = await rules.query(
      "SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'patients' AND column_name = 'owner_doctor_id'",
      [RULES_SCHEMA],
    );
    expect(owner.rows).toEqual([{ column_name: "owner_doctor_id", is_nullable: "YES", udt_name: "uuid" }]);

    const grantColumns = await rules.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'inference_access_grants' ORDER BY ordinal_position",
      [RULES_SCHEMA],
    );
    expect(grantColumns.rows.map((r) => r.column_name)).toEqual([
      "id",
      "inference_id",
      "consultation_id",
      "recipient_user_id",
      "approval_reference",
      "approved_by_user_id",
      "created_at",
      "expires_at",
      "revoked_at",
      "read_result",
      "read_artifacts",
      "read_pdf",
      "can_export_gold_standard",
    ]);

    const constraints = await rules.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass",
      [`${RULES_SCHEMA}.inference_access_grants`],
    );
    const names = constraints.rows.map((r) => r.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        "inference_access_grants_inference_id_fkey",
        "inference_access_grants_consultation_id_fkey",
        "inference_access_grants_recipient_user_id_fkey",
        "inference_access_grants_approved_by_user_id_fkey",
        "inference_access_grants_recipient_inference_approval_key",
        "inference_access_grants_approval_reference_nonempty",
        "inference_access_grants_approval_reference_not_url",
        "inference_access_grants_expiry_after_created",
        "inference_access_grants_revoked_after_created",
        "inference_access_grants_at_least_one_capability",
      ]),
    );

    const indexes = await rules.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename IN ('patients', 'inference_access_grants') ORDER BY indexname",
      [RULES_SCHEMA],
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        "idx_patients_owner_doctor_id",
        "idx_inference_access_grants_inference_id",
        "idx_inference_access_grants_consultation_id",
        "idx_inference_access_grants_recipient_user_id",
        "idx_inference_access_grants_expires_at",
      ]),
    );
  });

  it("allows one controlled owner assignment then freezes it", async () => {
    await rules.query("UPDATE patients SET owner_doctor_id = $2 WHERE id = $1", [PATIENT, DOCTOR]);
    const assigned = await rules.query("SELECT owner_doctor_id FROM patients WHERE id = $1", [PATIENT]);
    expect(assigned.rows).toEqual([{ owner_doctor_id: DOCTOR }]);

    await expect(
      rules.query("UPDATE patients SET owner_doctor_id = $2 WHERE id = $1", [PATIENT, DOCTOR2]),
    ).rejects.toThrow(/cannot be reassigned/);
    await expect(
      rules.query("UPDATE patients SET owner_doctor_id = NULL WHERE id = $1", [PATIENT]),
    ).rejects.toThrow(/cannot be reassigned/);
  });

  it("keeps the consultation patient/doctor binding immutable but permits same-value upserts", async () => {
    await expect(
      rules.query("UPDATE consultations SET doctor_id = $2 WHERE id = $1", [CONSULTATION, DOCTOR2]),
    ).rejects.toThrow(/binding is immutable/);
    await expect(
      rules.query("UPDATE consultations SET patient_id = $2 WHERE id = $1", [CONSULTATION, OTHER_PATIENT]),
    ).rejects.toThrow(/binding is immutable/);

    await expect(
      rules.query("UPDATE consultations SET patient_id = $2, doctor_id = $3, status = 'COMPLETED' WHERE id = $1", [
        CONSULTATION,
        PATIENT,
        DOCTOR,
      ]),
    ).resolves.toBeDefined();
  });

  it("validates recipient role, captured consultation, flags, expiry and approver", async () => {
    await insertGrant();

    await expect(insertGrant({ recipient: DOCTOR })).rejects.toThrow(/ADMIN or INVESTIGADOR/);
    await expect(
      insertGrant({ consultationId: OTHER_CONSULTATION }),
    ).rejects.toThrow(/authoritative image consultation/);
    await expect(
      insertGrant({ reference: "https://approval.example/1" }),
    ).rejects.toThrow(/not_url/);
    await expect(insertGrant({ reference: "   " })).rejects.toThrow(/nonempty/);
    await expect(
      insertGrant({ createdAt: new Date(), expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toThrow(/expiry_after_created/);
    await expect(
      insertGrant({ readResult: false, readArtifacts: false, readPdf: false, canExport: false }),
    ).rejects.toThrow(/at_least_one_capability/);
    await expect(insertGrant({ approver: RESEARCHER })).rejects.toThrow(/active ADMIN/);
    await expect(insertGrant({ approver: ADMIN })).resolves.toBeTruthy();
  });

  it("keeps grant terms immutable, expiry non-null and revocation append-only", async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const id = await insertGrant({ createdAt });

    await expect(
      rules.query("UPDATE inference_access_grants SET read_result = false WHERE id = $1", [id]),
    ).rejects.toThrow(/terms are immutable/);
    await expect(
      rules.query("UPDATE inference_access_grants SET expires_at = now() + interval '1 day' WHERE id = $1", [id]),
    ).rejects.toThrow(/terms are immutable/);
    await expect(
      rules.query("UPDATE inference_access_grants SET approval_reference = 'NEW' WHERE id = $1", [id]),
    ).rejects.toThrow(/terms are immutable/);

    const revokedAt = new Date();
    await rules.query("UPDATE inference_access_grants SET revoked_at = $2 WHERE id = $1", [id, revokedAt]);
    await expect(
      rules.query("UPDATE inference_access_grants SET revoked_at = now() WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      rules.query("UPDATE inference_access_grants SET revoked_at = NULL WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);

    const earlyId = await insertGrant({ createdAt: new Date() });
    await expect(
      rules.query("UPDATE inference_access_grants SET revoked_at = $2 WHERE id = $1", [
        earlyId,
        new Date(Date.now() - 3_600_000),
      ]),
    ).rejects.toThrow(/cannot precede creation/);
  });

  it("requires a new grant per inference (no silent duplicate approval reference)", async () => {
    // A reanalysis child is a different inference UUID and needs its own grant.
    await rules.query(
      "INSERT INTO inferences (id, image_id, reanalysis_of_id, predicted_class) VALUES ($1, $2, $3, 1)",
      ["00000000-0000-4000-8000-0000000a0042", IMAGE, INFERENCE],
    );
    await insertGrant({ reference: "APPROVAL-FIXED" });
    await expect(insertGrant({ reference: "APPROVAL-FIXED" })).rejects.toThrow(/duplicate key|unique/);
    await insertGrant({
      reference: "APPROVAL-FIXED",
      inferenceId: "00000000-0000-4000-8000-0000000a0042",
    });
  });

  it("freezes execution identity once any grant history exists, even revoked", async () => {
    const id = await insertGrant();
    await rules.query("UPDATE inference_access_grants SET revoked_at = now() WHERE id = $1", [id]);

    await expect(
      rules.query("UPDATE inferences SET image_id = $2 WHERE id = $1", [INFERENCE, OTHER_IMAGE]),
    ).rejects.toThrow(/grant history/);

    // A non-granted execution keeps the pre-existing context rules only.
    await expect(
      rules.query("UPDATE inferences SET image_id = $2 WHERE id = $1", [OTHER_INFERENCE, IMAGE]),
    ).resolves.toBeDefined();
  });

  it("grants clearsight_app SELECT and monotonic revocation only", async () => {
    const granted = await insertGrant();
    const qualified = formatQualified(RULES_SCHEMA, "inference_access_grants");

    const privilege = await rules.query(
      "SELECT has_table_privilege('clearsight_app', $1, 'SELECT') AS sel, " +
        "has_table_privilege('clearsight_app', $1, 'INSERT') AS ins, " +
        "has_table_privilege('clearsight_app', $1, 'DELETE') AS del, " +
        "has_table_privilege('clearsight_app', $1, 'TRUNCATE') AS trunc, " +
        "has_column_privilege('clearsight_app', $1, 'revoked_at', 'UPDATE') AS revoke_col, " +
        "has_column_privilege('clearsight_app', $1, 'read_result', 'UPDATE') AS result_col, " +
        "has_column_privilege('clearsight_app', $1, 'expires_at', 'UPDATE') AS expiry_col",
      [qualified],
    );
    expect(privilege.rows[0]).toEqual({
      sel: true,
      ins: false,
      del: false,
      trunc: false,
      revoke_col: true,
      result_col: false,
      expiry_col: false,
    });

    await rules.query("SET ROLE clearsight_app");
    try {
      await expect(
        rules.query(
          "INSERT INTO inference_access_grants (inference_id, consultation_id, recipient_user_id, approval_reference, expires_at, read_result) VALUES ($1, $2, $3, 'SELF', now() + interval '1 hour', true)",
          [INFERENCE, CONSULTATION, RESEARCHER],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        rules.query("UPDATE inference_access_grants SET read_result = false WHERE id = $1", [granted]),
      ).rejects.toThrow(/permission denied/);
      await expect(rules.query("DELETE FROM inference_access_grants WHERE id = $1", [granted])).rejects.toThrow(
        /permission denied/,
      );
      await expect(rules.query("TRUNCATE inference_access_grants")).rejects.toThrow(/permission denied/);

      await expect(
        rules.query("UPDATE inference_access_grants SET revoked_at = now() WHERE id = $1", [granted]),
      ).resolves.toBeDefined();
      const visible = await rules.query("SELECT id FROM inference_access_grants WHERE id = $1", [granted]);
      expect(visible.rows).toHaveLength(1);
    } finally {
      await rules.query("RESET ROLE");
    }
  });

  it("keeps revocation possible after the recipient or approver turns inactive or legacy-role", async () => {
    // The role/approval checks are INSERT-only; they must never block the
    // monotonic revocation UPDATE once the parties later change status.
    const id = await insertGrant({ approver: ADMIN });
    await rules.query("UPDATE users SET is_active = false WHERE id IN ($1, $2)", [RESEARCHER, ADMIN]);
    await rules.query("UPDATE users SET role = 'OFTALMOLOGO' WHERE id = $1", [RESEARCHER]);

    await expect(
      rules.query("UPDATE inference_access_grants SET revoked_at = now() WHERE id = $1", [id]),
    ).resolves.toBeDefined();
    const row = await rules.query("SELECT revoked_at FROM inference_access_grants WHERE id = $1", [id]);
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  it("allows nonclinical JSON updates and same-value owner replay once the owner is frozen", async () => {
    await rules.query("UPDATE patients SET owner_doctor_id = $2 WHERE id = $1", [PATIENT, DOCTOR]);

    await rules.query("UPDATE patients SET clinical_data = '{\"kept\":2}'::jsonb WHERE id = $1", [PATIENT]);
    let row = await rules.query("SELECT owner_doctor_id, clinical_data FROM patients WHERE id = $1", [PATIENT]);
    expect(row.rows[0]).toEqual({ owner_doctor_id: DOCTOR, clinical_data: { kept: 2 } });

    // Seed replay: the same owner plus a metadata refresh stays valid.
    await rules.query(
      "UPDATE patients SET owner_doctor_id = $2, clinical_history_flags = '{\"flag\":9}'::jsonb WHERE id = $1",
      [PATIENT, DOCTOR],
    );
    row = await rules.query("SELECT owner_doctor_id, clinical_history_flags FROM patients WHERE id = $1", [PATIENT]);
    expect(row.rows[0]).toEqual({ owner_doctor_id: DOCTOR, clinical_history_flags: { flag: 9 } });

    await expect(
      rules.query("UPDATE patients SET owner_doctor_id = $2 WHERE id = $1", [PATIENT, DOCTOR2]),
    ).rejects.toThrow(/cannot be reassigned/);
  });

  it("freezes case, laterality and snapshot provenance once any grant history exists", async () => {
    await insertGrant();

    const snapshotId = randomUUID();
    await rules.query(
      "INSERT INTO clinical_snapshots (id, consultation_id, raw_payload, normalized_payload, schema_version) " +
        "VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'qa-1')",
      [snapshotId, CONSULTATION],
    );

    await expect(
      rules.query("UPDATE inferences SET consultation_id = $2 WHERE id = $1", [INFERENCE, CONSULTATION]),
    ).rejects.toThrow(/grant history/);
    await expect(
      rules.query("UPDATE inferences SET eye_side = 'OD' WHERE id = $1", [INFERENCE]),
    ).rejects.toThrow(/grant history/);
    await expect(
      rules.query("UPDATE inferences SET clinical_snapshot_id = $2 WHERE id = $1", [INFERENCE, snapshotId]),
    ).rejects.toThrow(/grant history/);
    // Reanalysis provenance is rejected by the pre-existing context guard even
    // before the grant guard runs: it can never be repointed either.
    await expect(
      rules.query("UPDATE inferences SET reanalysis_of_id = $2 WHERE id = $1", [INFERENCE, OTHER_INFERENCE]),
    ).rejects.toThrow(/reanalysis_of_id is immutable/);
  });

  it("replays migration E without duplicating or destroying grants", async () => {
    const id = await insertGrant();
    const before = await rules.query(
      "SELECT (SELECT count(*)::int FROM inference_access_grants) AS grants, (SELECT count(*)::int FROM patients) AS patients",
    );
    await expect(rules.query(migrationSql(CLINICAL_ACCESS))).resolves.toBeDefined();
    const after = await rules.query(
      "SELECT (SELECT count(*)::int FROM inference_access_grants) AS grants, (SELECT count(*)::int FROM patients) AS patients",
    );
    expect(after.rows).toEqual(before.rows);
    const grant = await rules.query("SELECT id, read_result FROM inference_access_grants WHERE id = $1", [id]);
    expect(grant.rows).toEqual([{ id, read_result: true }]);
  });
});

describe("clinical access owner backfill", () => {
  let backfill: Client;

  const BACK_SINGLE = "00000000-0000-4000-8000-0000000b0001";
  const BACK_MIXED = "00000000-0000-4000-8000-0000000b0002";
  const BACK_ORPHAN = "00000000-0000-4000-8000-0000000b0003";
  const BACK_ADMIN = "00000000-0000-4000-8000-0000000b0004";
  const BACK_D1 = "00000000-0000-4000-8000-0000000b0011";
  const BACK_D2 = "00000000-0000-4000-8000-0000000b0012";
  const BACK_A = "00000000-0000-4000-8000-0000000b0013";

  beforeAll(async () => {
    backfill = new Client({ connectionString: inject("databaseUrl") });
    await backfill.connect();
    await backfill.query(
      `DROP SCHEMA IF EXISTS ${BACKFILL_SCHEMA} CASCADE; CREATE SCHEMA ${BACKFILL_SCHEMA}; SET search_path TO ${BACKFILL_SCHEMA}`,
    );
    for (const name of PRE_CLINICAL_ACCESS) {
      await backfill.query(migrationSql(name));
    }

    await backfill.query(
      "INSERT INTO users (id, email, password_hash, full_name, role) VALUES " +
        "($1, 'd1@back.test', 'x', 'D1', 'OFTALMOLOGO'), " +
        "($2, 'd2@back.test', 'x', 'D2', 'OFTALMOLOGO'), " +
        "($3, 'a@back.test', 'x', 'A', 'ADMIN')",
      [BACK_D1, BACK_D2, BACK_A],
    );
    await backfill.query(
      "INSERT INTO patients (id, clinical_data, clinical_history_flags) VALUES " +
        "($1, '{\"kept\":1}'::jsonb, '{\"flag\":true}'::jsonb), ($2, '{}'::jsonb, '{}'::jsonb), ($3, '{}'::jsonb, '{}'::jsonb), ($4, '{}'::jsonb, '{}'::jsonb)",
      [BACK_SINGLE, BACK_MIXED, BACK_ORPHAN, BACK_ADMIN],
    );
    await backfill.query(
      "INSERT INTO consultations (id, patient_id, doctor_id, status) VALUES " +
        "('00000000-0000-4000-8000-0000000b0021', $1, $3, 'COMPLETED'), " +
        "('00000000-0000-4000-8000-0000000b0022', $1, $3, 'QUEUED'), " +
        "('00000000-0000-4000-8000-0000000b0023', $2, $3, 'QUEUED'), " +
        "('00000000-0000-4000-8000-0000000b0024', $2, $4, 'QUEUED'), " +
        "('00000000-0000-4000-8000-0000000b0025', $5, $6, 'QUEUED')",
      [BACK_SINGLE, BACK_MIXED, BACK_D1, BACK_D2, BACK_ADMIN, BACK_A],
    );

    await backfill.query(migrationSql(CLINICAL_ACCESS));
  });

  afterAll(async () => {
    await backfill.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${BACKFILL_SCHEMA} CASCADE`);
    await backfill.end();
  });

  it("assigns only single-doctor OFTALMOLOGO access owners and leaves the rest NULL", async () => {
    const rows = await backfill.query(
      "SELECT id, owner_doctor_id, clinical_data, clinical_history_flags FROM patients ORDER BY id",
    );
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    expect(byId[BACK_SINGLE].owner_doctor_id).toBe(BACK_D1);
    expect(byId[BACK_MIXED].owner_doctor_id).toBeNull();
    expect(byId[BACK_ORPHAN].owner_doctor_id).toBeNull();
    expect(byId[BACK_ADMIN].owner_doctor_id).toBeNull();

    // No clinical provenance/status/JSON was fabricated or rewritten.
    expect(byId[BACK_SINGLE].clinical_data).toEqual({ kept: 1 });
    expect(byId[BACK_SINGLE].clinical_history_flags).toEqual({ flag: true });
    const statuses = await backfill.query("SELECT status FROM consultations ORDER BY status");
    expect(statuses.rows.map((r) => r.status)).toEqual(["COMPLETED", "QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
  });

  it("is stable on replay and does not reassign owners", async () => {
    const before = await backfill.query("SELECT id, owner_doctor_id FROM patients ORDER BY id");
    await expect(backfill.query(migrationSql(CLINICAL_ACCESS))).resolves.toBeDefined();
    const after = await backfill.query("SELECT id, owner_doctor_id FROM patients ORDER BY id");
    expect(after.rows).toEqual(before.rows);
  });
});

function formatQualified(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}
