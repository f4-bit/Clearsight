import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { inject } from "vitest";
import { migrationNames, migrationSql } from "./helpers/migrations.js";

/**
 * Migration B invariants on a fresh schema. The schema is owned by this file
 * and dropped afterwards; it never touches the shared public test schema.
 */
const SCHEMA = "artifact_reports_rules";
const MIGRATIONS = migrationNames();
const ARTIFACT_MIGRATION = "20261118010000_artifact_reports";
const DATA_VERSION_MIGRATION = "20261122000000_pdf_report_data_version_pending";
const CHECKSUM = "a".repeat(64);

const P = "00000000-0000-4000-8000-0000000002a1";
const D1 = "00000000-0000-4000-8000-0000000002d1";
const C1 = "00000000-0000-4000-8000-0000000002c1";
const C2 = "00000000-0000-4000-8000-0000000002c2";
const C3 = "00000000-0000-4000-8000-0000000002c3";
const IMG1 = "00000000-0000-4000-8000-0000000002b1";
const IMG2 = "00000000-0000-4000-8000-0000000002b2";
const IMG3 = "00000000-0000-4000-8000-0000000002b3";
const IMG4 = "00000000-0000-4000-8000-0000000002b4";
const I1 = "00000000-0000-4000-8000-0000000002e1";
const I2 = "00000000-0000-4000-8000-0000000002e2";
const I3 = "00000000-0000-4000-8000-0000000002e3";
const I4 = "00000000-0000-4000-8000-0000000002e4";
const S1 = "00000000-0000-4000-8000-0000000002f1";
const A1 = "00000000-0000-4000-8000-0000000002f2";
const A2 = "00000000-0000-4000-8000-0000000002f3";
const A3 = "00000000-0000-4000-8000-0000000002f4";
const A4 = "00000000-0000-4000-8000-0000000002f5";
const R1 = "00000000-0000-4000-8000-0000000002f6";
const R2 = "00000000-0000-4000-8000-0000000002f7";
const R3 = "00000000-0000-4000-8000-0000000002f8";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
  for (const name of MIGRATIONS) {
    await client.query(migrationSql(name));
  }
});

afterAll(async () => {
  await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

beforeEach(async () => {
  await client.query(
    "TRUNCATE TABLE pdf_reports, artifact_records, clinical_snapshots, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
  );
});

async function seedBase(): Promise<void> {
  await client.query(
    "INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dr')",
    [D1, "artifact-d1@clearsight.test"],
  );
  await client.query("INSERT INTO patients (id) VALUES ($1)", [P]);
  await client.query(
    "INSERT INTO consultations (id, patient_id, doctor_id) VALUES ($1, $2, $3), ($4, $2, $3), ($5, $2, $3)",
    [C1, P, D1, C2, C3],
  );
  await client.query(
    "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'a'), ($3, $2, 'OS', 'b'), ($4, $5, 'OD', 'c')",
    [IMG1, C1, IMG2, IMG3, C2],
  );
  await client.query(
    "INSERT INTO clinical_snapshots (id, consultation_id, raw_payload, normalized_payload, schema_version) VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'clinical-v1')",
    [S1, C1],
  );
  await client.query(
    "INSERT INTO inferences (id, image_id, consultation_id, eye_side, clinical_snapshot_id, status) VALUES " +
      "($1, $2, $3, 'OD', $4, 'COMPLETED'), ($5, $6, $3, 'OS', NULL, 'COMPLETED'), ($7, $8, $9, 'OD', NULL, 'COMPLETED')",
    [I1, IMG1, C1, S1, I2, IMG2, I3, IMG3, C2],
  );
}

async function insertArtifact(
  id: string,
  inferenceId: string,
  artifactType: string,
  opts: {
    status?: string;
    version?: number;
    storageId?: string | null;
    bucket?: string | null;
    key?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    checksum?: string | null;
    failureCode?: string | null;
    retryable?: boolean;
    complete?: boolean;
    availableAt?: boolean;
  } = {},
): Promise<void> {
  const status = opts.status ?? "PENDING";
  const complete = opts.complete ?? status === "AVAILABLE";
  const availableAt = opts.availableAt ?? status === "AVAILABLE";

  await client.query(
    "INSERT INTO artifact_records (id, inference_id, artifact_type, version, status, storage_id, bucket_or_container, key, content_type, size_bytes, checksum_sha256, failure_code, retryable, available_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14 THEN now() ELSE NULL END)",
    [
      id,
      inferenceId,
      artifactType,
      opts.version ?? 1,
      status,
      opts.storageId !== undefined ? opts.storageId : complete ? "azure-blob-default" : null,
      opts.bucket !== undefined ? opts.bucket : complete ? "artifacts" : null,
      opts.key !== undefined ? opts.key : complete ? "inference/artifact.bin" : null,
      opts.contentType !== undefined ? opts.contentType : complete ? (artifactType === "pdf" ? "application/pdf" : "image/png") : null,
      opts.sizeBytes !== undefined ? opts.sizeBytes : complete ? 123 : null,
      opts.checksum !== undefined ? opts.checksum : complete ? CHECKSUM : null,
      opts.failureCode !== undefined ? opts.failureCode : status === "FAILED" ? "UPLOAD_FAILED" : null,
      opts.retryable ?? false,
      availableAt,
    ],
  );
}

async function insertPdfReport(
  id: string,
  inferenceId: string,
  opts: {
    version?: number;
    artifactId?: string | null;
    sourceSnapshotId?: string | null;
    status?: string;
    documentKind?: string;
    dataVersion?: string;
    modelVersions?: unknown;
    renderingInputs?: unknown;
    availableAt?: boolean;
  } = {},
): Promise<void> {
  const status = opts.status ?? "PENDING";
  const availableAt = opts.availableAt ?? status === "AVAILABLE";

  await client.query(
    "INSERT INTO pdf_reports (id, inference_id, version, artifact_id, source_snapshot_id, status, document_kind, data_version, model_versions, rendering_inputs, available_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, CASE WHEN $11 THEN now() ELSE NULL END)",
    [
      id,
      inferenceId,
      opts.version ?? 1,
      opts.artifactId ?? null,
      opts.sourceSnapshotId ?? null,
      status,
      opts.documentKind ?? "basic",
      opts.dataVersion ?? "clinical-v1",
      JSON.stringify(opts.modelVersions ?? { model: "2026-09-24" }),
      JSON.stringify(opts.renderingInputs ?? { result: "inline" }),
      availableAt,
    ],
  );
}

describe("migration B artifact and PDF persistence", () => {
  it("creates the expected tables, columns, constraints and indexes", async () => {
    expect(MIGRATIONS).toContain(ARTIFACT_MIGRATION);
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('artifact_records', 'pdf_reports') ORDER BY table_name",
      [SCHEMA],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["artifact_records", "pdf_reports"]);

    const artifactColumns = await client.query(
      "SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'artifact_records'",
      [SCHEMA],
    );
    const artifacts = Object.fromEntries(
      artifactColumns.rows.map((row) => [row.column_name, row]),
    ) as Record<string, { is_nullable: string; udt_name: string }>;
    expect(artifacts.inference_id).toMatchObject({ is_nullable: "NO", udt_name: "uuid" });
    expect(artifacts.artifact_type).toMatchObject({ is_nullable: "NO" });
    expect(artifacts.version).toMatchObject({ is_nullable: "NO" });
    expect(artifacts.status).toMatchObject({ is_nullable: "NO" });
    expect(artifacts.storage_id).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.bucket_or_container).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.key).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.content_type).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.size_bytes).toMatchObject({ is_nullable: "YES", udt_name: "int8" });
    expect(artifacts.checksum_sha256).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.failure_code).toMatchObject({ is_nullable: "YES" });
    expect(artifacts.retryable).toMatchObject({ is_nullable: "NO" });
    expect(artifacts.available_at).toMatchObject({ is_nullable: "YES" });

    const pdfColumns = await client.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'pdf_reports'",
      [SCHEMA],
    );
    const reports = Object.fromEntries(
      pdfColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    ) as Record<string, string>;
    for (const column of [
      "inference_id",
      "version",
      "status",
      "document_kind",
      "data_version",
      "model_versions",
      "rendering_inputs",
    ]) {
      expect(reports[column]).toBe("NO");
    }
    for (const column of ["artifact_id", "source_snapshot_id", "available_at"]) {
      expect(reports[column]).toBe("YES");
    }

    const artifactConstraints = await client.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass",
      [`${SCHEMA}.artifact_records`],
    );
    expect(artifactConstraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "artifact_records_artifact_type_check",
        "artifact_records_version_positive",
        "artifact_records_status_check",
        "artifact_records_available_fields_check",
        "artifact_records_failure_check",
        "artifact_records_checksum_check",
        "artifact_records_pdf_content_type_check",
      ]),
    );

    const pdfConstraints = await client.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass",
      [`${SCHEMA}.pdf_reports`],
    );
    expect(pdfConstraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "pdf_reports_version_positive",
        "pdf_reports_status_check",
        "pdf_reports_document_kind_check",
        "pdf_reports_data_version_nonempty",
        "pdf_reports_model_versions_object",
        "pdf_reports_rendering_inputs_object",
        "pdf_reports_rendering_inputs_no_secrets",
        "pdf_reports_available_check",
      ]),
    );

    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN (" +
        "'artifact_records_inference_id_artifact_type_version_key', " +
        "'pdf_reports_inference_id_version_key', " +
        "'idx_artifact_records_inference_id', 'idx_artifact_records_status', " +
        "'idx_pdf_reports_inference_id', 'idx_pdf_reports_artifact_id', " +
        "'idx_pdf_reports_source_snapshot_id', 'idx_pdf_reports_status') ORDER BY indexname",
      [SCHEMA],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "artifact_records_inference_id_artifact_type_version_key",
      "idx_artifact_records_inference_id",
      "idx_artifact_records_status",
      "idx_pdf_reports_artifact_id",
      "idx_pdf_reports_inference_id",
      "idx_pdf_reports_source_snapshot_id",
      "idx_pdf_reports_status",
      "pdf_reports_inference_id_version_key",
    ]);
  });

  it("accepts all artifact states and complete AVAILABLE references", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", { status: "NOT_SUPPORTED", version: 1 });
    await insertArtifact(A2, I1, "mask", { status: "NOT_REQUESTED", version: 2 });
    await insertArtifact(A3, I1, "mask", { status: "PENDING", version: 3 });
    await insertArtifact(A4, I1, "mask", {
      status: "FAILED",
      version: 4,
      failureCode: "UPLOAD_FAILED",
      retryable: true,
    });
    await insertArtifact("00000000-0000-4000-8000-0000000002f9", I1, "mask", {
      status: "AVAILABLE",
      version: 5,
    });

    const rows = await client.query(
      "SELECT version, status, storage_id, bucket_or_container, key, content_type, size_bytes::int AS size_bytes, checksum_sha256, failure_code, retryable, available_at " +
        "FROM artifact_records ORDER BY version",
    );
    expect(rows.rows.map((row) => row.status)).toEqual([
      "NOT_SUPPORTED",
      "NOT_REQUESTED",
      "PENDING",
      "FAILED",
      "AVAILABLE",
    ]);
    expect(rows.rows[4]).toMatchObject({
      storage_id: "azure-blob-default",
      bucket_or_container: "artifacts",
      key: "inference/artifact.bin",
      content_type: "image/png",
      size_bytes: 123,
      checksum_sha256: CHECKSUM,
      failure_code: null,
      retryable: false,
    });
    expect(rows.rows[4]?.available_at).not.toBeNull();
  });

  it("rejects partial/inconsistent artifact references and invalid sizes/checksums", async () => {
    await seedBase();
    for (const field of ["storageId", "bucket", "key", "contentType", "sizeBytes", "checksum"] as const) {
      await expect(
        insertArtifact(A1, I1, "mask", { status: "AVAILABLE", [field]: null }),
      ).rejects.toThrow(/artifact_records_available_fields_check/);
    }

    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", availableAt: false }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "PENDING", storageId: "azure-blob-default" }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", sizeBytes: -1 }),
    ).rejects.toThrow(/artifact_records_size_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", checksum: CHECKSUM.toUpperCase() }),
    ).rejects.toThrow(/artifact_records_checksum_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", checksum: "abc" }),
    ).rejects.toThrow(/artifact_records_checksum_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", contentType: "https://example.test/x" }),
    ).rejects.toThrow(/artifact_records_content_type_check/);
    await expect(
      insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", contentType: "image/png" }),
    ).rejects.toThrow(/artifact_records_pdf_content_type_check/);
  });

  it("enforces safe FAILED codes and retryable semantics", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", {
      status: "FAILED",
      version: 1,
      failureCode: "UPLOAD_FAILED",
      retryable: true,
    });

    for (const [version, failureCode, retryable] of [
      [2, null, true],
      [3, "upload failed", true],
      [4, "https://example.test/failure", true],
      [5, "Bad-Code", true],
    ] as const) {
      await expect(
        insertArtifact(A2, I1, "mask", {
          status: "FAILED",
          version,
          failureCode,
          retryable,
        }),
      ).rejects.toThrow(/artifact_records_failure_check/);
    }

    await expect(
      insertArtifact(A2, I1, "mask", { status: "PENDING", version: 6, failureCode: "UPLOAD_FAILED" }),
    ).rejects.toThrow(/artifact_records_failure_check/);
    await expect(
      insertArtifact(A2, I1, "mask", { status: "PENDING", version: 7, retryable: true }),
    ).rejects.toThrow(/artifact_records_failure_check/);
    await expect(
      insertArtifact(A2, I1, "mask", {
        status: "AVAILABLE",
        version: 8,
        failureCode: "UPLOAD_FAILED",
      }),
    ).rejects.toThrow(/artifact_records_failure_check/);
  });

  it("rejects URI/signature identities but preserves exact valid keys", async () => {
    await seedBase();
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", storageId: "https://blob.example.test" }),
    ).rejects.toThrow(/artifact_records_storage_id_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", bucket: "s3://bucket" }),
    ).rejects.toThrow(/artifact_records_bucket_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", key: "https://bucket/key.png" }),
    ).rejects.toThrow(/artifact_records_key_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", key: "folder/file.png?sv=1&sig=secret" }),
    ).rejects.toThrow(/artifact_records_key_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", key: "folder/file.png?X-Amz-Signature=secret" }),
    ).rejects.toThrow(/artifact_records_key_check/);

    const exactKey = "carpeta/ünïcode %20 file?.png";
    await insertArtifact(A1, I1, "mask", { status: "AVAILABLE", key: exactKey });
    const row = await client.query("SELECT key FROM artifact_records WHERE id = $1", [A1]);
    expect(row.rows).toEqual([{ key: exactKey }]);
  });

  it("keeps artifact identity and published rows immutable", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", { status: "AVAILABLE", version: 1 });

    await expect(
      client.query("UPDATE artifact_records SET inference_id = $2 WHERE id = $1", [A1, I3]),
    ).rejects.toThrow(/artifact identity is immutable/);
    await expect(
      client.query("UPDATE artifact_records SET artifact_type = 'overlay' WHERE id = $1", [A1]),
    ).rejects.toThrow(/artifact identity is immutable/);
    await expect(
      client.query("UPDATE artifact_records SET version = 2 WHERE id = $1", [A1]),
    ).rejects.toThrow(/artifact identity is immutable/);
    await expect(
      client.query("UPDATE artifact_records SET key = 'other/key.png' WHERE id = $1", [A1]),
    ).rejects.toThrow(/published artifact records are immutable/);
    await expect(
      client.query("UPDATE artifact_records SET status = 'FAILED' WHERE id = $1", [A1]),
    ).rejects.toThrow(/published artifact records are immutable/);
    await expect(client.query("DELETE FROM artifact_records WHERE id = $1", [A1])).rejects.toThrow(
      /published artifact records cannot be deleted/,
    );

    await insertArtifact(A2, I1, "overlay", { status: "PENDING", version: 1 });
    await expect(
      client.query("UPDATE artifact_records SET inference_id = $2 WHERE id = $1", [A2, I3]),
    ).rejects.toThrow(/artifact identity is immutable/);
    const deleted = await client.query("DELETE FROM artifact_records WHERE id = $1", [A2]);
    expect(deleted.rowCount).toBe(1);
    const remaining = await client.query("SELECT count(*)::int AS count FROM artifact_records WHERE id = $1", [A2]);
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it("allows explicit artifact versions and rejects duplicate versions", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", { status: "AVAILABLE", version: 1 });
    await insertArtifact(A2, I1, "mask", { status: "AVAILABLE", version: 2 });
    await expect(
      insertArtifact(A3, I1, "mask", { status: "AVAILABLE", version: 1 }),
    ).rejects.toThrow(/artifact_records_inference_id_artifact_type_version_key|duplicate key/);

    const rows = await client.query("SELECT version FROM artifact_records WHERE inference_id = $1 ORDER BY version", [I1]);
    expect(rows.rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("does not store a fake blob result artifact", async () => {
    await seedBase();
    await expect(insertArtifact(A1, I1, "result", { status: "PENDING" })).rejects.toThrow(
      /artifact_records_artifact_type_check/,
    );
  });

  it("accepts PENDING/FAILED/AVAILABLE PDF reports only with matching evidence", async () => {
    await seedBase();
    await insertArtifact(A3, I1, "pdf", { status: "AVAILABLE", version: 3 });
    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1 });
    await insertPdfReport(R2, I1, { version: 2, sourceSnapshotId: S1, status: "FAILED" });
    await insertPdfReport(R3, I1, {
      version: 3,
      sourceSnapshotId: S1,
      artifactId: A3,
      status: "AVAILABLE",
    });

    const rows = await client.query(
      "SELECT version, status, artifact_id, source_snapshot_id, document_kind, data_version FROM pdf_reports ORDER BY version",
    );
    expect(rows.rows).toEqual([
      {
        version: 1,
        status: "PENDING",
        artifact_id: null,
        source_snapshot_id: S1,
        document_kind: "basic",
        data_version: "clinical-v1",
      },
      {
        version: 2,
        status: "FAILED",
        artifact_id: null,
        source_snapshot_id: S1,
        document_kind: "basic",
        data_version: "clinical-v1",
      },
      {
        version: 3,
        status: "AVAILABLE",
        artifact_id: A3,
        source_snapshot_id: S1,
        document_kind: "basic",
        data_version: "clinical-v1",
      },
    ]);
  });

  it("rejects incomplete or unsafe PDF rendering inputs", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });

    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, status: "AVAILABLE" }),
    ).rejects.toThrow(/pdf_reports_available_check/);
    await expect(
      insertPdfReport(R1, I1, {
        version: 1,
        sourceSnapshotId: S1,
        artifactId: A1,
        status: "AVAILABLE",
        availableAt: false,
      }),
    ).rejects.toThrow(/pdf_reports_available_check/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, availableAt: true }),
    ).rejects.toThrow(/pdf_reports_available_check/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: null }),
    ).rejects.toThrow(/source_snapshot_id must match/);
    await expect(
      insertPdfReport(R1, I2, { version: 1, sourceSnapshotId: S1 }),
    ).rejects.toThrow(/source_snapshot_id must match/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, modelVersions: [] }),
    ).rejects.toThrow(/pdf_reports_model_versions_object/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, renderingInputs: [] }),
    ).rejects.toThrow(/pdf_reports_rendering_inputs_object/);
    await expect(
      insertPdfReport(R1, I1, {
        version: 1,
        sourceSnapshotId: S1,
        renderingInputs: { url: "https://example.test/object" },
      }),
    ).rejects.toThrow(/pdf_reports_rendering_inputs_no_secrets/);
    await expect(
      insertPdfReport(R1, I1, {
        version: 1,
        sourceSnapshotId: S1,
        renderingInputs: { sig: "secret" },
      }),
    ).rejects.toThrow(/pdf_reports_rendering_inputs_no_secrets/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, dataVersion: "   " }),
    ).rejects.toThrow(/pdf_reports_data_version_nonempty/);
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, documentKind: "report" }),
    ).rejects.toThrow(/pdf_reports_document_kind_check/);
    await expect(
      insertPdfReport(R1, I1, { version: 0, sourceSnapshotId: S1 }),
    ).rejects.toThrow(/pdf_reports_version_positive/);
  });

  it("validates PDF artifact linkage on insert and relink", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertArtifact(A2, I2, "pdf", { status: "AVAILABLE", version: 1 });
    await insertArtifact(A3, I1, "mask", { status: "AVAILABLE", version: 1 });
    await insertArtifact(A4, I1, "pdf", { status: "AVAILABLE", version: 2 });
    await insertArtifact("00000000-0000-4000-8000-0000000002fa", I1, "pdf", { status: "PENDING", version: 3 });

    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1 });
    await expect(
      client.query("UPDATE pdf_reports SET artifact_id = $2 WHERE id = $1", [R1, A2]),
    ).rejects.toThrow(/same inference and version/);
    await expect(
      client.query("UPDATE pdf_reports SET artifact_id = $2 WHERE id = $1", [R1, A3]),
    ).rejects.toThrow(/same inference and version/);
    await expect(
      client.query("UPDATE pdf_reports SET artifact_id = $2 WHERE id = $1", [R1, A4]),
    ).rejects.toThrow(/same inference and version/);

    const published = await client.query(
      "UPDATE pdf_reports SET artifact_id = $2, status = 'AVAILABLE', available_at = now() WHERE id = $1",
      [R1, A1],
    );
    expect(published.rowCount).toBe(1);
    const linked = await client.query("SELECT status, artifact_id FROM pdf_reports WHERE id = $1", [R1]);
    expect(linked.rows).toEqual([{ status: "AVAILABLE", artifact_id: A1 }]);

    await expect(
      insertPdfReport(R2, I1, {
        version: 3,
        sourceSnapshotId: S1,
        artifactId: "00000000-0000-4000-8000-0000000002fa",
        status: "AVAILABLE",
      }),
    ).rejects.toThrow(/available application\/pdf artifact/);
  });

  it("keeps PDF identity/rendering immutable and enforces transitions", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1 });

    await expect(
      client.query("UPDATE pdf_reports SET source_snapshot_id = NULL WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET model_versions = '{\"other\":\"v\"}'::jsonb WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);
    // D1 correction: data_version and rendering_inputs may be replaced only
    // while PENDING (a repaired retry refreshes provenance before AVAILABLE).
    await client.query("UPDATE pdf_reports SET rendering_inputs = '{\"changed\":true}'::jsonb WHERE id = $1", [R1]);
    await client.query("UPDATE pdf_reports SET data_version = 'other-pending' WHERE id = $1", [R1]);
    const afterPendingData = await client.query(
      "SELECT data_version, rendering_inputs FROM pdf_reports WHERE id = $1",
      [R1],
    );
    expect(afterPendingData.rows).toEqual([
      {
        data_version: "other-pending",
        rendering_inputs: { changed: true },
      },
    ]);
    await expect(
      client.query("UPDATE pdf_reports SET document_kind = 'gradcam' WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET version = 2 WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET inference_id = $2 WHERE id = $1", [R1, I2]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);

    const failed = await client.query("UPDATE pdf_reports SET status = 'FAILED' WHERE id = $1", [R1]);
    expect(failed.rowCount).toBe(1);
    const afterFailed = await client.query("SELECT status FROM pdf_reports WHERE id = $1", [R1]);
    expect(afterFailed.rows).toEqual([{ status: "FAILED" }]);
    await expect(
      client.query("UPDATE pdf_reports SET data_version = 'other-failed' WHERE id = $1", [R1]),
    ).rejects.toThrow(/data_version and rendering_inputs can only change while the report remains PENDING/);
    await expect(
      client.query("UPDATE pdf_reports SET rendering_inputs = '{\"failed\":true}'::jsonb WHERE id = $1", [R1]),
    ).rejects.toThrow(/data_version and rendering_inputs can only change while the report remains PENDING/);

    const pending = await client.query("UPDATE pdf_reports SET status = 'PENDING' WHERE id = $1", [R1]);
    expect(pending.rowCount).toBe(1);
    const afterPending = await client.query("SELECT status FROM pdf_reports WHERE id = $1", [R1]);
    expect(afterPending.rows).toEqual([{ status: "PENDING" }]);
    await client.query(
      "UPDATE pdf_reports SET data_version = 'other-pending-2', rendering_inputs = '{\"pending\":true}'::jsonb WHERE id = $1",
      [R1],
    );

    await expect(
      client.query("UPDATE pdf_reports SET status = 'AVAILABLE' WHERE id = $1", [R1]),
    ).rejects.toThrow(/available_check/);
    const published = await client.query(
      "UPDATE pdf_reports SET status = 'AVAILABLE', artifact_id = $2, available_at = now() WHERE id = $1",
      [R1, A1],
    );
    expect(published.rowCount).toBe(1);
    const afterPublished = await client.query("SELECT status, artifact_id FROM pdf_reports WHERE id = $1", [R1]);
    expect(afterPublished.rows).toEqual([{ status: "AVAILABLE", artifact_id: A1 }]);
    await expect(
      client.query("UPDATE pdf_reports SET data_version = 'other-available' WHERE id = $1", [R1]),
    ).rejects.toThrow(/published PDF reports are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET rendering_inputs = '{\"available\":true}'::jsonb WHERE id = $1", [R1]),
    ).rejects.toThrow(/published PDF reports are immutable/);

    await expect(
      client.query("UPDATE pdf_reports SET artifact_id = NULL WHERE id = $1", [R1]),
    ).rejects.toThrow(/published PDF reports are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET version = 2 WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable|published PDF reports are immutable/);
    await expect(
      client.query("UPDATE pdf_reports SET inference_id = $2 WHERE id = $1", [R1, I2]),
    ).rejects.toThrow(/identity and rendering inputs are immutable|published PDF reports are immutable/);
    await expect(client.query("DELETE FROM pdf_reports WHERE id = $1", [R1])).rejects.toThrow(
      /published PDF reports cannot be deleted/,
    );
  });

  it("allows PDF version 2 without changing version 1", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertArtifact(A2, I1, "pdf", { status: "AVAILABLE", version: 2 });
    await insertPdfReport(R1, I1, {
      version: 1,
      sourceSnapshotId: S1,
      artifactId: A1,
      status: "AVAILABLE",
    });
    await insertPdfReport(R2, I1, {
      version: 2,
      sourceSnapshotId: S1,
      artifactId: A2,
      status: "AVAILABLE",
    });

    const before = await client.query(
      "SELECT id, version, artifact_id, status FROM pdf_reports WHERE version = 1",
    );
    await expect(
      insertPdfReport(R3, I1, { version: 1, sourceSnapshotId: S1 }),
    ).rejects.toThrow(/pdf_reports_inference_id_version_key|duplicate key/);
    const after = await client.query(
      "SELECT id, version, artifact_id, status FROM pdf_reports WHERE version = 1",
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toEqual([{ id: R1, version: 1, artifact_id: A1, status: "AVAILABLE" }]);
  });

  it("replays migration B without changing published records", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertPdfReport(R1, I1, {
      version: 1,
      sourceSnapshotId: S1,
      artifactId: A1,
      status: "AVAILABLE",
    });

    const artifactBefore = await client.query(
      "SELECT id, status, key, checksum_sha256, available_at FROM artifact_records ORDER BY id",
    );
    const reportBefore = await client.query(
      "SELECT id, version, artifact_id, status, available_at FROM pdf_reports ORDER BY id",
    );

    await expect(client.query(migrationSql(ARTIFACT_MIGRATION))).resolves.toBeDefined();

    const artifactAfter = await client.query(
      "SELECT id, status, key, checksum_sha256, available_at FROM artifact_records ORDER BY id",
    );
    const reportAfter = await client.query(
      "SELECT id, version, artifact_id, status, available_at FROM pdf_reports ORDER BY id",
    );
    expect(artifactAfter.rows).toEqual(artifactBefore.rows);
    expect(reportAfter.rows).toEqual(reportBefore.rows);

    await expect(
      client.query("UPDATE artifact_records SET key = 'other/key.png' WHERE id = $1", [A1]),
    ).rejects.toThrow(/published artifact records are immutable/);
    await expect(client.query("DELETE FROM pdf_reports WHERE id = $1", [R1])).rejects.toThrow(
      /published PDF reports cannot be deleted/,
    );
  });

  it("replays the corrective pending-content migration without changing rows or weakening guards", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "PENDING" });
    await insertPdfReport(R1, I1, {
      version: 1,
      sourceSnapshotId: S1,
      artifactId: A1,
      status: "PENDING",
      dataVersion: "pdfv1:pending-placeholder",
    });

    const before = await client.query(
      "SELECT id, version, artifact_id, status, data_version, rendering_inputs FROM pdf_reports ORDER BY id",
    );

    // The corrective migration is idempotent (CREATE OR REPLACE FUNCTION +
    // DROP TRIGGER IF EXISTS): replaying it changes nothing.
    await expect(client.query(migrationSql(DATA_VERSION_MIGRATION))).resolves.toBeDefined();
    await expect(client.query(migrationSql(DATA_VERSION_MIGRATION))).resolves.toBeDefined();

    const after = await client.query(
      "SELECT id, version, artifact_id, status, data_version, rendering_inputs FROM pdf_reports ORDER BY id",
    );
    expect(after.rows).toEqual(before.rows);

    // Guards survive the replay: data_version changes only PENDING -> PENDING.
    await client.query("UPDATE pdf_reports SET data_version = 'pdfv1:replaced' WHERE id = $1", [
      R1,
    ]);
    await client.query(
      "UPDATE pdf_reports SET rendering_inputs = '{\"replaced\":true}'::jsonb WHERE id = $1",
      [R1],
    );
    const replaced = await client.query(
      "SELECT data_version, rendering_inputs FROM pdf_reports WHERE id = $1",
      [R1],
    );
    expect(replaced.rows).toEqual([
      {
        data_version: "pdfv1:replaced",
        rendering_inputs: { replaced: true },
      },
    ]);

    const failed = await client.query(
      "UPDATE pdf_reports SET status = 'FAILED' WHERE id = $1",
      [R1],
    );
    expect(failed.rowCount).toBe(1);
    await expect(
      client.query("UPDATE pdf_reports SET data_version = 'pdfv1:illegal' WHERE id = $1", [R1]),
    ).rejects.toThrow(/data_version and rendering_inputs can only change while the report remains PENDING/);
    await expect(
      client.query(
        "UPDATE pdf_reports SET rendering_inputs = '{\"changed\":true}'::jsonb WHERE id = $1",
        [R1],
      ),
    ).rejects.toThrow(/data_version and rendering_inputs can only change while the report remains PENDING/);

    // Other identity fields remain immutable after the replay.
    await expect(
      client.query("UPDATE pdf_reports SET document_kind = 'gradcam' WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);

    // AVAILABLE stays immutable after the replay as well.
    const repended = await client.query(
      "UPDATE pdf_reports SET status = 'PENDING' WHERE id = $1",
      [R1],
    );
    expect(repended.rowCount).toBe(1);
    await client.query(
      "UPDATE artifact_records SET status = 'AVAILABLE', storage_id = 'azure-blob-default', bucket_or_container = 'artifacts', key = 'inference/artifact.bin', content_type = 'application/pdf', size_bytes = 123, checksum_sha256 = $2, available_at = now() WHERE id = $1",
      [A1, CHECKSUM],
    );
    const published = await client.query(
      "UPDATE pdf_reports SET status = 'AVAILABLE', artifact_id = $2, available_at = now() WHERE id = $1",
      [R1, A1],
    );
    expect(published.rowCount).toBe(1);
    await expect(
      client.query("UPDATE pdf_reports SET data_version = 'pdfv1:illegal-available' WHERE id = $1", [R1]),
    ).rejects.toThrow(/published PDF reports are immutable/);
    await expect(
      client.query(
        "UPDATE pdf_reports SET rendering_inputs = '{\"available\":true}'::jsonb WHERE id = $1",
        [R1],
      ),
    ).rejects.toThrow(/published PDF reports are immutable/);
  });

  it("rejects deleting inference evidence while preserving the legacy cascade", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertPdfReport(R1, I1, {
      version: 1,
      sourceSnapshotId: S1,
      artifactId: A1,
      status: "AVAILABLE",
    });

    await expect(client.query("DELETE FROM inferences WHERE id = $1", [I1])).rejects.toThrow(/foreign key/);

    await client.query(
      "INSERT INTO images (id, consultation_id, eye_side, storage_path) VALUES ($1, $2, 'OD', 'legacy')",
      [IMG4, C3],
    );
    await client.query("INSERT INTO inferences (id, image_id, predicted_class) VALUES ($1, $2, 1)", [I4, IMG4]);
    const deleted = await client.query("DELETE FROM consultations WHERE id = $1", [C3]);
    expect(deleted.rowCount).toBe(1);
    const remaining = await client.query(
      "SELECT (SELECT count(*)::int FROM consultations WHERE id = $1) AS consultations, " +
        "(SELECT count(*)::int FROM images WHERE id = $2) AS images, " +
        "(SELECT count(*)::int FROM inferences WHERE id = $3) AS inferences",
      [C3, IMG4, I4],
    );
    expect(remaining.rows).toEqual([{ consultations: 0, images: 0, inferences: 0 }]);
  });

  // --- Adversarial QA additions: boundary, NULL-combination, retry/publish,
  // --- provenance and concurrency coverage for migration B invariants. -----

  it("rejects partial NULL combinations and full references on non-AVAILABLE states", async () => {
    await seedBase();
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", key: null, checksum: null }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "AVAILABLE", contentType: null, sizeBytes: null, checksum: null }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "FAILED", complete: true, failureCode: "UPLOAD_FAILED" }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);
    await expect(
      insertArtifact(A1, I1, "mask", { status: "PENDING", key: "only/key.png" }),
    ).rejects.toThrow(/artifact_records_available_fields_check/);

    for (const status of ["NOT_SUPPORTED", "NOT_REQUESTED", "FAILED", "PENDING"] as const) {
      await expect(
        insertArtifact(A1, I1, "mask", {
          status,
          availableAt: true,
          failureCode: status === "FAILED" ? "UPLOAD_FAILED" : null,
        }),
      ).rejects.toThrow(/artifact_records_available_fields_check/);
    }
  });

  it("enforces artifact version positivity and accepts zero-byte AVAILABLE sizes", async () => {
    await seedBase();
    await expect(insertArtifact(A1, I1, "mask", { status: "PENDING", version: 0 })).rejects.toThrow(
      /artifact_records_version_positive/,
    );
    await expect(insertArtifact(A1, I1, "mask", { status: "PENDING", version: -1 })).rejects.toThrow(
      /artifact_records_version_positive/,
    );

    await insertArtifact(A2, I1, "mask", { status: "AVAILABLE", version: 1, sizeBytes: 0 });
    const row = await client.query("SELECT size_bytes::int AS size_bytes FROM artifact_records WHERE id = $1", [A2]);
    expect(row.rows).toEqual([{ size_bytes: 0 }]);
  });

  it("accepts deferred gradcam and shap artifact types without references", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "gradcam", { status: "NOT_SUPPORTED", version: 1 });
    await insertArtifact(A2, I1, "shap", { status: "NOT_REQUESTED", version: 1 });
    const rows = await client.query(
      "SELECT artifact_type, status, key FROM artifact_records ORDER BY artifact_type",
    );
    expect(rows.rows).toEqual([
      { artifact_type: "gradcam", status: "NOT_SUPPORTED", key: null },
      { artifact_type: "shap", status: "NOT_REQUESTED", key: null },
    ]);
  });

  it("allows FAILED and PENDING artifact retries to publish when the retry is valid", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", {
      status: "FAILED",
      version: 1,
      failureCode: "UPLOAD_FAILED",
      retryable: true,
    });
    await insertArtifact(A2, I1, "mask", { status: "PENDING", version: 2 });

    await client.query(
      "UPDATE artifact_records SET status = 'AVAILABLE', storage_id = 'azure-blob-default', bucket_or_container = 'artifacts', " +
        "key = 'inference/retry.bin', content_type = 'image/png', size_bytes = 10, checksum_sha256 = $2, " +
        "failure_code = NULL, retryable = FALSE, available_at = now() WHERE id = $1",
      [A1, CHECKSUM],
    );
    await client.query(
      "UPDATE artifact_records SET status = 'AVAILABLE', storage_id = 'azure-blob-default', bucket_or_container = 'artifacts', " +
        "key = 'inference/pending.bin', content_type = 'image/png', size_bytes = 10, checksum_sha256 = $2, " +
        "available_at = now() WHERE id = $1",
      [A2, CHECKSUM],
    );

    const rows = await client.query(
      "SELECT id, status, failure_code, retryable, available_at FROM artifact_records ORDER BY version",
    );
    expect(
      rows.rows.map((row) => ({
        id: row.id,
        status: row.status,
        failure_code: row.failure_code,
        retryable: row.retryable,
        published: row.available_at !== null,
      })),
    ).toEqual([
      { id: A1, status: "AVAILABLE", failure_code: null, retryable: false, published: true },
      { id: A2, status: "AVAILABLE", failure_code: null, retryable: false, published: true },
    ]);

    await insertArtifact(A3, I1, "mask", {
      status: "FAILED",
      version: 3,
      failureCode: "UPLOAD_FAILED",
      retryable: true,
    });
    await expect(
      client.query(
        "UPDATE artifact_records SET status = 'AVAILABLE', storage_id = 'azure-blob-default', bucket_or_container = 'artifacts', " +
          "key = 'inference/retry3.bin', content_type = 'image/png', size_bytes = 10, checksum_sha256 = $2, " +
          "available_at = now() WHERE id = $1",
        [A3, CHECKSUM],
      ),
    ).rejects.toThrow(/artifact_records_failure_check/);

    await expect(
      client.query("UPDATE artifact_records SET key = 'other/key.png' WHERE id = $1", [A1]),
    ).rejects.toThrow(/published artifact records are immutable/);
  });

  it("enforces failure code length boundaries and retryable-only-on-FAILED semantics", async () => {
    await seedBase();
    const maxLengthCode = `F${"a".repeat(63)}`;
    await insertArtifact(A1, I1, "mask", {
      status: "FAILED",
      version: 1,
      failureCode: maxLengthCode,
    });
    const stored = await client.query("SELECT failure_code FROM artifact_records WHERE id = $1", [A1]);
    expect(stored.rows).toEqual([{ failure_code: maxLengthCode }]);

    // 65 chars are rejected by the layered enforcement (VARCHAR(64) and/or the
    // pattern CHECK); either layer alone already forbids the value.
    await expect(
      insertArtifact(A2, I1, "mask", { status: "FAILED", version: 2, failureCode: `F${"a".repeat(64)}` }),
    ).rejects.toThrow(/value too long|artifact_records_failure_check/);
    await expect(
      insertArtifact(A2, I1, "mask", { status: "NOT_SUPPORTED", version: 3, retryable: true }),
    ).rejects.toThrow(/artifact_records_failure_check/);
    await expect(
      insertArtifact(A2, I1, "mask", { status: "AVAILABLE", version: 4, retryable: true }),
    ).rejects.toThrow(/artifact_records_failure_check/);
  });

  it("keeps artifact and report primary identity immutable", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "mask", { status: "PENDING", version: 1 });
    await expect(
      client.query("UPDATE artifact_records SET id = $2 WHERE id = $1", [A1, A2]),
    ).rejects.toThrow(/artifact identity is immutable/);
    await expect(
      client.query("UPDATE artifact_records SET created_at = created_at - interval '1 day' WHERE id = $1", [A1]),
    ).rejects.toThrow(/artifact identity is immutable/);

    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1 });
    await expect(client.query("UPDATE pdf_reports SET id = $2 WHERE id = $1", [R1, R2])).rejects.toThrow(
      /identity and rendering inputs are immutable/,
    );
    await expect(
      client.query("UPDATE pdf_reports SET created_at = created_at - interval '1 day' WHERE id = $1", [R1]),
    ).rejects.toThrow(/identity and rendering inputs are immutable/);
  });

  it("rejects query signatures and generic URI schemes embedded in rendering inputs values", async () => {
    await seedBase();
    const attempts: string[] = [];
    for (const [id, version, link] of [
      [R1, 1, "files.example.test/a?sig=secret"],
      [R2, 2, "files.example.test/a?X-Amz-Signature=secret"],
      [R3, 3, "file:///etc/passwd"],
      [R1, 4, "ftp://host/artifact"],
    ] as const) {
      attempts.push(
        await insertPdfReport(id, I1, {
          version,
          sourceSnapshotId: S1,
          renderingInputs: { link },
        }).then(
          () => "accepted",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
    expect(attempts).toEqual([
      expect.stringMatching(/pdf_reports_rendering_inputs_no_secrets/),
      expect.stringMatching(/pdf_reports_rendering_inputs_no_secrets/),
      expect.stringMatching(/pdf_reports_rendering_inputs_no_secrets/),
      expect.stringMatching(/pdf_reports_rendering_inputs_no_secrets/),
    ]);

    // Legitimate filename-like values with unicode, spaces, `%` and a non-
    // signature query remain unchanged.
    const benign = "carpeta/ünïcode %20 file?.png";
    await insertPdfReport(R3, I1, {
      version: 5,
      sourceSnapshotId: S1,
      renderingInputs: { link: benign },
    });
    const row = await client.query(
      "SELECT rendering_inputs->>'link' AS link FROM pdf_reports WHERE id = $1 AND version = 5",
      [R3],
    );
    expect(row.rows).toEqual([{ link: benign }]);
  });

  it("rejects non-listed URI schemes in artifact keys", async () => {
    await seedBase();
    const attempts: string[] = [];
    for (const [id, version, key] of [
      [A1, 1, "file:///etc/passwd"],
      [A2, 2, "ftp://host/obj"],
      [A3, 3, "gopher://host/obj"],
    ] as const) {
      attempts.push(
        await insertArtifact(id, I1, "mask", { status: "AVAILABLE", version, key }).then(
          () => "accepted",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
    expect(attempts).toEqual([
      expect.stringMatching(/artifact_records_key_check/),
      expect.stringMatching(/artifact_records_key_check/),
      expect.stringMatching(/artifact_records_key_check/),
    ]);
  });

  it("rejects direct FAILED to AVAILABLE PDF transitions", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "AVAILABLE", version: 1 });
    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1 });
    await client.query("UPDATE pdf_reports SET status = 'FAILED' WHERE id = $1", [R1]);

    await expect(
      client.query("UPDATE pdf_reports SET status = 'AVAILABLE', artifact_id = $2, available_at = now() WHERE id = $1", [
        R1,
        A1,
      ]),
    ).rejects.toThrow(/invalid PDF report status transition/);

    const stillFailed = await client.query("SELECT status, artifact_id FROM pdf_reports WHERE id = $1", [R1]);
    expect(stillFailed.rows).toEqual([{ status: "FAILED", artifact_id: null }]);

    const failedAgain = await client.query("UPDATE pdf_reports SET status = 'FAILED' WHERE id = $1", [R1]);
    expect(failedAgain.rowCount).toBe(1);
    const afterFailedAgain = await client.query("SELECT status FROM pdf_reports WHERE id = $1", [R1]);
    expect(afterFailedAgain.rows).toEqual([{ status: "FAILED" }]);

    const pending = await client.query("UPDATE pdf_reports SET status = 'PENDING' WHERE id = $1", [R1]);
    expect(pending.rowCount).toBe(1);
    const publishedUpdate = await client.query(
      "UPDATE pdf_reports SET status = 'AVAILABLE', artifact_id = $2, available_at = now() WHERE id = $1",
      [R1, A1],
    );
    expect(publishedUpdate.rowCount).toBe(1);
    const published = await client.query("SELECT status, artifact_id FROM pdf_reports WHERE id = $1", [R1]);
    expect(published.rows).toEqual([{ status: "AVAILABLE", artifact_id: A1 }]);
  });

  it("protects linked snapshot and artifact evidence from deletion", async () => {
    await seedBase();
    await insertArtifact(A1, I1, "pdf", { status: "PENDING", version: 1 });
    await insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, artifactId: A1 });

    await expect(client.query("DELETE FROM artifact_records WHERE id = $1", [A1])).rejects.toThrow(/foreign key/);
    await expect(client.query("DELETE FROM clinical_snapshots WHERE id = $1", [S1])).rejects.toThrow(
      /clinical_snapshots are immutable/,
    );

    const rows = await client.query(
      "SELECT (SELECT count(*)::int FROM artifact_records WHERE id = $1) AS artifacts, " +
        "(SELECT count(*)::int FROM clinical_snapshots WHERE id = $2) AS snapshots",
      [A1, S1],
    );
    expect(rows.rows).toEqual([{ artifacts: 1, snapshots: 1 }]);
  });

  it("records explicit report provenance and revalidates binding on late parent snapshot assignment", async () => {
    await seedBase();
    await insertArtifact(A1, I2, "pdf", { status: "AVAILABLE", version: 1 });
    // I2 is unselected and has no snapshot yet: the report records NULL provenance.
    await insertPdfReport(R1, I2, { version: 1, sourceSnapshotId: null });

    // Migration A allows a first snapshot link only while the inference is unselected.
    await client.query("UPDATE inferences SET clinical_snapshot_id = $2 WHERE id = $1", [I2, S1]);

    // The stored provenance is explicit and is never rewritten by parent changes.
    const report = await client.query("SELECT source_snapshot_id FROM pdf_reports WHERE id = $1", [R1]);
    expect(report.rows).toEqual([{ source_snapshot_id: null }]);
    const parent = await client.query("SELECT clinical_snapshot_id FROM inferences WHERE id = $1", [I2]);
    expect(parent.rows).toEqual([{ clinical_snapshot_id: S1 }]);

    // A NULL-captured report cannot be published without trace, even though
    // the parent now has a snapshot; it is not rewritten retroactively.
    await expect(
      client.query("UPDATE pdf_reports SET status = 'AVAILABLE', artifact_id = $2, available_at = now() WHERE id = $1", [
        R1,
        A1,
      ]),
    ).rejects.toThrow(/pdf_reports_available_check/);

    // The legacy NULL-provenance report is not frozen: it can still terminate
    // as FAILED, while its captured inputs stay unchanged.
    const failed = await client.query("UPDATE pdf_reports SET status = 'FAILED' WHERE id = $1", [R1]);
    expect(failed.rowCount).toBe(1);
    const captured = await client.query(
      "SELECT source_snapshot_id, status, model_versions, rendering_inputs FROM pdf_reports WHERE id = $1",
      [R1],
    );
    expect(captured.rows).toEqual([
      {
        source_snapshot_id: null,
        status: "FAILED",
        model_versions: { model: "2026-09-24" },
        rendering_inputs: { result: "inline" },
      },
    ]);

    // New writes are re-validated against the parent's current snapshot binding.
    await expect(insertPdfReport(R2, I2, { version: 2, sourceSnapshotId: null })).rejects.toThrow(
      /source_snapshot_id must match/,
    );
    await insertArtifact(A2, I2, "pdf", { status: "AVAILABLE", version: 2 });
    await insertPdfReport(R3, I2, {
      version: 2,
      sourceSnapshotId: S1,
      artifactId: A2,
      status: "AVAILABLE",
    });
    const newVersion = await client.query(
      "SELECT source_snapshot_id, status, artifact_id FROM pdf_reports WHERE id = $1",
      [R3],
    );
    expect(newVersion.rows).toEqual([
      { source_snapshot_id: S1, status: "AVAILABLE", artifact_id: A2 },
    ]);

    // Once set, the parent link cannot be rewritten, keeping non-NULL bindings valid.
    await expect(
      client.query("UPDATE inferences SET clinical_snapshot_id = NULL WHERE id = $1", [I1]),
    ).rejects.toThrow(/snapshot link is immutable once set/);
  });

  it("rejects concurrent duplicate artifact versions with exactly one winner", async () => {
    await seedBase();
    const other = new Client({ connectionString: inject("databaseUrl") });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${SCHEMA}`);
      const sql =
        "INSERT INTO artifact_records (id, inference_id, artifact_type, version, status, storage_id, bucket_or_container, key, content_type, size_bytes, checksum_sha256, available_at) " +
        "VALUES ($1, $2, 'mask', 1, 'AVAILABLE', 'azure-blob-default', 'artifacts', 'inference/artifact.bin', 'image/png', 123, $3, now())";
      const results = await Promise.allSettled([
        client.query(sql, ["00000000-0000-4000-8000-000000000301", I1, CHECKSUM]),
        other.query(sql, ["00000000-0000-4000-8000-000000000302", I1, CHECKSUM]),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/duplicate key/);

      const rows = await client.query(
        "SELECT count(*)::int AS count FROM artifact_records WHERE inference_id = $1 AND artifact_type = 'mask' AND version = 1",
        [I1],
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    } finally {
      await other.end();
    }
  });

  it("rejects non-object JSON provenance values", async () => {
    await seedBase();
    await expect(
      insertPdfReport(R1, I1, { version: 1, sourceSnapshotId: S1, modelVersions: 5 }),
    ).rejects.toThrow(/pdf_reports_model_versions_object/);
    await expect(
      insertPdfReport(R2, I1, { version: 2, sourceSnapshotId: S1, renderingInputs: "raw text" }),
    ).rejects.toThrow(/pdf_reports_rendering_inputs_object/);
  });
});
