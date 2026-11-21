import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ArtifactAvailableData,
  ArtifactPublicationRepository,
  ArtifactPublicationRow,
  PdfReportListRow,
  PdfReportPublicationRow,
  PendingPdfReportInput,
  PublicationInference,
} from "../../src/repositories/artifact-publication.repo.js";
import {
  ArtifactContentError,
  type ArtifactContentEnv,
  type ArtifactContentKind,
} from "../../src/services/artifact-content.js";
import {
  ArtifactPublicationError,
  createArtifactPublicationService,
  type ArtifactPublicationStoragePort,
} from "../../src/services/artifact-publication.js";
import { StorageProviderError } from "../../src/services/storage-provider.js";

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const CONSULTATION_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";

const CONTENT_ENV: ArtifactContentEnv = {
  STORAGE_PROVIDER: "minio",
  MINIO_BUCKET_RAW: "raw-retinas",
  MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  MINIO_BUCKET_MASK: "retina-masks",
  MINIO_BUCKET_OVERLAY: "retina-overlays",
  MINIO_BUCKET_PDF: "pdf-bucket",
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02]);
const MASK = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x12,
]);
const OVERLAY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x21, 0x22,
]);
const PDF = Buffer.from("%PDF-1.7\nunit\n", "ascii");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeInference(
  overrides: Partial<PublicationInference> = {},
): PublicationInference {
  return {
    id: INFERENCE_ID,
    consultationId: CONSULTATION_ID,
    eyeSide: "OD",
    snapshotId: SNAPSHOT_ID,
    imageId: "55555555-5555-4555-8555-555555555555",
    predictedClass: 2,
    confidence: 0.87,
    probabilities: {
      Glaucoma: 0.1,
      Non_Glaucoma: 0.03,
      Suspicious_Glaucoma: 0.87,
    },
    cdr: 0.42,
    cdrVertical: 0.38,
    quality: { segmentation: 0.91 },
    elapsedSeconds: 3.5,
    modelVersion: "v1",
    modelVersions: { manifest: "resnet50-v1" },
    modelPredictions: {
      resnet50: {
        predictedClass: "Suspicious_Glaucoma",
        confidence: 0.87,
        probabilities: {
          Glaucoma: 0.1,
          Non_Glaucoma: 0.03,
          Suspicious_Glaucoma: 0.87,
        },
      },
    },
    artifacts: {
      mask: "s3://retina-masks/case/mask.png",
      overlay: "s3://retina-overlays/case/overlay.png",
    },
    status: "COMPLETED",
    createdAt: new Date("2026-11-20T10:00:00.000Z"),
    image: { storagePath: "case/original.jpg" },
    snapshot: {
      id: SNAPSHOT_ID,
      consultationId: CONSULTATION_ID,
      schemaVersion: "ml-zscore-f32-v1",
      rawPayload: { Age: 63 },
      modelVersions: { manifest: "resnet50-v1" },
    },
    ...overrides,
  };
}

function makeStorage(
  objects: Map<string, Buffer>,
): {
  readonly storage: ArtifactPublicationStoragePort;
  readonly uploads: Array<{
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }>;
} {
  const uploads: Array<{
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }> = [];
  return {
    uploads,
    storage: {
      storageId: "minio-local",
      async loadBytes(reference: string, _kind: ArtifactContentKind) {
        const bytes = objects.get(reference);
        if (bytes === undefined) {
          throw new ArtifactContentError("artifact_content_missing");
        }
        return bytes;
      },
      async upload(bucket, key, body, contentType) {
        uploads.push({ bucket, key, body, contentType });
      },
    },
  };
}

class FakePublicationRepository implements ArtifactPublicationRepository {
  readonly artifacts = new Map<string, ArtifactPublicationRow>();
  readonly reports = new Map<number, PdfReportPublicationRow>();
  readonly calls: string[] = [];
  readonly inference: PublicationInference;

  constructor(inference: PublicationInference) {
    this.inference = inference;
  }

  private key(artifactType: string, version: number): string {
    return `${artifactType}:${version}`;
  }

  private withArtifact(
    report: PdfReportPublicationRow,
  ): PdfReportPublicationRow {
    const artifact =
      report.artifactId === null
        ? null
        : (this.artifacts.get(this.key("pdf", report.version)) ?? null);
    return {
      ...report,
      artifact:
        artifact === null
          ? null
          : {
              failureCode: artifact.failureCode,
              retryable: artifact.retryable,
            },
    };
  }

  async findPublicationCandidates(): Promise<string[]> {
    return [];
  }

  async findInference(): Promise<PublicationInference | null> {
    return this.inference;
  }

  async findArtifact(
    _inferenceId: string,
    artifactType: string,
    version: number,
  ): Promise<ArtifactPublicationRow | null> {
    return this.artifacts.get(this.key(artifactType, version)) ?? null;
  }

  async ensurePendingArtifact(input: {
    inferenceId: string;
    artifactType: string;
    version: number;
  }): Promise<ArtifactPublicationRow> {
    this.calls.push(`ensure:${input.artifactType}:${input.version}`);
    const key = this.key(input.artifactType, input.version);
    const existing = this.artifacts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const row: ArtifactPublicationRow = {
      id: randomUUID(),
      inferenceId: input.inferenceId,
      artifactType: input.artifactType,
      version: input.version,
      status: "PENDING",
      storageId: null,
      bucketOrContainer: null,
      key: null,
      contentType: null,
      sizeBytes: null,
      checksumSha256: null,
      failureCode: null,
      retryable: false,
      availableAt: null,
    };
    this.artifacts.set(key, row);
    return row;
  }

  async markArtifactAvailable(
    id: string,
    data: ArtifactAvailableData,
  ): Promise<ArtifactPublicationRow | null> {
    this.calls.push(`available:${id}`);
    for (const [key, row] of this.artifacts) {
      if (row.id !== id) {
        continue;
      }
      if (row.status === "AVAILABLE") {
        return row;
      }
      const updated: ArtifactPublicationRow = {
        ...row,
        status: "AVAILABLE",
        storageId: data.storageId,
        bucketOrContainer: data.bucketOrContainer,
        key: data.key,
        contentType: data.contentType,
        sizeBytes: BigInt(data.sizeBytes),
        checksumSha256: data.checksumSha256,
        failureCode: null,
        retryable: false,
        availableAt: data.availableAt,
      };
      this.artifacts.set(key, updated);
      return updated;
    }
    return null;
  }

  async markArtifactFailed(
    id: string,
    failureCode: string,
    retryable: boolean,
  ): Promise<ArtifactPublicationRow | null> {
    this.calls.push(`failed:${id}:${failureCode}`);
    for (const [key, row] of this.artifacts) {
      if (row.id !== id) {
        continue;
      }
      if (row.status === "AVAILABLE") {
        return row;
      }
      const updated: ArtifactPublicationRow = {
        ...row,
        status: "FAILED",
        storageId: null,
        bucketOrContainer: null,
        key: null,
        contentType: null,
        sizeBytes: null,
        checksumSha256: null,
        failureCode,
        retryable,
        availableAt: null,
      };
      this.artifacts.set(key, updated);
      return updated;
    }
    return null;
  }

  async findLatestPdfReport(): Promise<PdfReportPublicationRow | null> {
    const versions = [...this.reports.keys()].sort((a, b) => b - a);
    const version = versions[0];
    if (version === undefined) {
      return null;
    }
    const report = this.reports.get(version);
    return report === undefined ? null : this.withArtifact(report);
  }

  async ensurePendingPdfReport(
    input: PendingPdfReportInput,
  ): Promise<PdfReportPublicationRow> {
    this.calls.push(`report-ensure:${input.version}`);
    const existing = this.reports.get(input.version);
    if (existing !== undefined) {
      return this.withArtifact(existing);
    }
    const report: PdfReportPublicationRow = {
      id: input.id,
      inferenceId: input.inferenceId,
      version: input.version,
      artifactId: null,
      sourceSnapshotId: input.sourceSnapshotId,
      status: "PENDING",
      dataVersion: input.dataVersion,
      modelVersions: input.modelVersions as PdfReportPublicationRow["modelVersions"],
      renderingInputs:
        input.renderingInputs as PdfReportPublicationRow["renderingInputs"],
      createdAt: new Date("2026-11-20T11:00:00.000Z"),
      availableAt: null,
      artifact: null,
    };
    this.reports.set(input.version, report);
    return report;
  }

  async markPdfReportPending(id: string): Promise<boolean> {
    for (const [version, report] of this.reports) {
      if (report.id !== id || report.status !== "FAILED") {
        continue;
      }
      this.reports.set(version, {
        ...report,
        status: "PENDING",
        availableAt: null,
      });
      return true;
    }
    return false;
  }

  async updatePdfReportContent(
    id: string,
    dataVersion: string,
    renderingInputs: Parameters<
      ArtifactPublicationRepository["updatePdfReportContent"]
    >[2],
  ): Promise<boolean> {
    for (const [version, report] of this.reports) {
      if (report.id !== id || report.status !== "PENDING") {
        continue;
      }
      this.reports.set(version, {
        ...report,
        dataVersion,
        renderingInputs:
          renderingInputs as PdfReportPublicationRow["renderingInputs"],
      });
      return true;
    }
    return false;
  }

  async finalizePdfAvailable(input: {
    artifactId: string;
    reportId: string;
    metadata: ArtifactAvailableData;
  }): Promise<{
    artifact: ArtifactPublicationRow;
    report: PdfReportPublicationRow;
  } | null> {
    this.calls.push(`finalize:${input.reportId}`);
    const artifact = await this.markArtifactAvailable(
      input.artifactId,
      input.metadata,
    );
    if (artifact === null) {
      return null;
    }
    for (const [version, report] of this.reports) {
      if (report.id !== input.reportId) {
        continue;
      }
      const updated: PdfReportPublicationRow = {
        ...report,
        status: "AVAILABLE",
        artifactId: artifact.id,
        availableAt: input.metadata.availableAt,
      };
      this.reports.set(version, updated);
      return { artifact, report: this.withArtifact(updated) };
    }
    return null;
  }

  async finalizePdfFailed(input: {
    artifactId: string;
    reportId: string;
    failureCode: string;
    retryable: boolean;
  }): Promise<void> {
    this.calls.push(`finalize-failed:${input.reportId}`);
    await this.markArtifactFailed(
      input.artifactId,
      input.failureCode,
      input.retryable,
    );
    for (const [version, report] of this.reports) {
      if (report.id !== input.reportId || report.status === "AVAILABLE") {
        continue;
      }
      this.reports.set(version, {
        ...report,
        status: "FAILED",
        artifactId: input.artifactId,
        availableAt: null,
      });
    }
  }

  async listPdfReports(): Promise<PdfReportListRow[]> {
    return [...this.reports.values()].map((report) => ({
      id: report.id,
      inferenceId: report.inferenceId,
      version: report.version,
      status: report.status,
      createdAt: report.createdAt,
      availableAt: report.availableAt,
      artifact:
        report.artifactId === null
          ? null
          : {
              failureCode:
                this.artifacts.get(this.key("pdf", report.version))
                  ?.failureCode ?? null,
            },
    }));
  }
}

function serviceFor(input: {
  inference?: PublicationInference;
  env?: ArtifactContentEnv;
  objects?: Map<string, Buffer>;
  repository?: FakePublicationRepository;
}) {
  const inference = input.inference ?? makeInference();
  const repository = input.repository ?? new FakePublicationRepository(inference);
  const objects =
    input.objects ??
    new Map<string, Buffer>([
      [inference.image.storagePath, JPEG],
      ["s3://retina-masks/case/mask.png", MASK],
      ["s3://retina-overlays/case/overlay.png", OVERLAY],
    ]);
  const { storage, uploads } = makeStorage(objects);
  const service = createArtifactPublicationService({
    repository,
    storage,
    contentEnv: input.env ?? CONTENT_ENV,
    pdfBucket: "pdf-bucket",
    renderPdf: async () => PDF,
    now: () => new Date("2026-11-20T11:00:00.000Z"),
    generateReportId: () => REPORT_ID,
  });
  return { service, repository, uploads, objects, storage };
}

describe("artifact publication", () => {
  it("publishes mask/overlay with real metadata and a versioned PDF report", async () => {
    const { service, repository, uploads } = serviceFor({});
    const result = await service.publish(INFERENCE_ID);

    const mask = repository.artifacts.get("mask:1");
    expect(mask).toMatchObject({
      status: "AVAILABLE",
      storageId: "minio-local",
      bucketOrContainer: "retina-masks",
      key: "case/mask.png",
      contentType: "image/png",
      sizeBytes: BigInt(MASK.byteLength),
      checksumSha256: sha256(MASK),
    });
    expect(mask?.availableAt).toBeInstanceOf(Date);

    const overlay = repository.artifacts.get("overlay:1");
    expect(overlay).toMatchObject({
      status: "AVAILABLE",
      bucketOrContainer: "retina-overlays",
      key: "case/overlay.png",
      contentType: "image/png",
      checksumSha256: sha256(OVERLAY),
    });

    const pdfArtifact = repository.artifacts.get("pdf:1");
    expect(pdfArtifact).toMatchObject({
      status: "AVAILABLE",
      storageId: "minio-local",
      bucketOrContainer: "pdf-bucket",
      key: `${INFERENCE_ID}/v1.pdf`,
      contentType: "application/pdf",
      sizeBytes: BigInt(PDF.byteLength),
      checksumSha256: sha256(PDF),
    });

    const report = repository.reports.get(1);
    expect(report).toMatchObject({
      id: REPORT_ID,
      inferenceId: INFERENCE_ID,
      version: 1,
      status: "AVAILABLE",
      artifactId: pdfArtifact?.id,
      sourceSnapshotId: SNAPSHOT_ID,
    });
    expect(report?.dataVersion).toMatch(/^pdfv1:[0-9a-f]{64}$/);
    expect(JSON.stringify(report?.renderingInputs)).not.toContain("://");

    expect(result.report).toMatchObject({
      reportId: REPORT_ID,
      version: 1,
      status: "AVAILABLE",
      dataVersion: report?.dataVersion,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      bucket: "pdf-bucket",
      key: `${INFERENCE_ID}/v1.pdf`,
      contentType: "application/pdf",
    });
  });

  it("marks a key-only reference FAILED when its kind bucket is unconfigured", async () => {
    const inference = makeInference({
      artifacts: {
        mask: "case/mask.png",
        overlay: "s3://retina-overlays/case/overlay.png",
      },
    });
    const { service, repository } = serviceFor({
      inference,
      env: { ...CONTENT_ENV, MINIO_BUCKET_MASK: undefined },
    });

    const result = await service.publish(INFERENCE_ID);

    const mask = repository.artifacts.get("mask:1");
    expect(mask).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });
    const pdf = repository.artifacts.get("pdf:1");
    expect(pdf).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });
    expect(result.report).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
    });
    expect(JSON.stringify(result)).not.toContain("://");
    expect(JSON.stringify(result)).not.toContain("retina-masks");
  });

  it("does not duplicate rows or re-upload when the same content is retried", async () => {
    const { service, repository, uploads } = serviceFor({});

    const first = await service.publish(INFERENCE_ID);
    const second = await service.publish(INFERENCE_ID);

    expect(repository.artifacts.size).toBe(3);
    expect(repository.reports.size).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(second.report?.reportId).toBe(first.report?.reportId);
    expect(second.report?.version).toBe(first.report?.version);
    expect(second.report?.dataVersion).toBe(first.report?.dataVersion);
  });

  it("never publishes an AVAILABLE report when the inference snapshot is null", async () => {
    const inference = makeInference({
      snapshotId: null,
      snapshot: null,
    });
    const { service, repository } = serviceFor({ inference });

    const result = await service.publish(INFERENCE_ID);

    expect(repository.artifacts.get("mask:1")?.status).toBe("AVAILABLE");
    expect(repository.artifacts.get("overlay:1")?.status).toBe("AVAILABLE");
    expect(repository.artifacts.get("pdf:1")).toMatchObject({
      status: "FAILED",
      failureCode: "snapshot_missing",
      retryable: false,
    });
    expect(repository.reports.get(1)).toMatchObject({
      status: "FAILED",
      sourceSnapshotId: null,
    });
    expect(result.report?.status).toBe("FAILED");
    expect(result.report?.failureCode).toBe("snapshot_missing");
  });

  it("records a retryable FAILED state when storage is missing", async () => {
    const inference = makeInference();
    const objects = new Map<string, Buffer>([
      [inference.image.storagePath, JPEG],
      ["s3://retina-masks/case/mask.png", MASK],
      // overlay intentionally absent
    ]);
    const { service, repository } = serviceFor({ inference, objects });

    const result = await service.publish(INFERENCE_ID);

    expect(repository.artifacts.get("overlay:1")).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_object_missing",
      retryable: true,
    });
    expect(repository.artifacts.get("pdf:1")).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_object_missing",
      retryable: true,
    });
    expect(result.report).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_object_missing",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("case/overlay.png");
  });

  it("reuses the same version after a retryable pre-render failure is repaired", async () => {
    const inference = makeInference();
    const objects = new Map<string, Buffer>([
      [inference.image.storagePath, JPEG],
      ["s3://retina-masks/case/mask.png", MASK],
      // overlay intentionally absent on the first attempt
    ]);
    const { service, repository, uploads, objects: store } = serviceFor({
      inference,
      objects,
    });

    const failed = await service.publish(INFERENCE_ID);
    expect(failed.report).toMatchObject({ status: "FAILED", version: 1 });
    const reportId = failed.report?.reportId;
    const placeholder = repository.reports.get(1)?.dataVersion;
    expect(placeholder).toMatch(/^pdfv1:[0-9a-f]{64}$/);
    expect(uploads).toHaveLength(0);

    store.set("s3://retina-overlays/case/overlay.png", OVERLAY);
    const retried = await service.publish(INFERENCE_ID);

    expect(retried.report).toMatchObject({
      reportId,
      version: 1,
      status: "AVAILABLE",
    });
    expect(retried.report?.dataVersion).not.toBe(placeholder);
    expect(repository.reports.size).toBe(1);
    expect(
      [...repository.artifacts.values()].filter(
        (row) => row.artifactType === "pdf",
      ),
    ).toHaveLength(1);
    expect(uploads).toHaveLength(1);

    const reusedInputs = repository.reports.get(1)?.renderingInputs as {
      failureCode?: string;
      artifacts: Record<string, { checksumSha256: string }>;
    };
    expect(reusedInputs.failureCode).toBeUndefined();
    expect(reusedInputs.artifacts.original?.checksumSha256).toBe(sha256(JPEG));
    expect(reusedInputs.artifacts.mask?.checksumSha256).toBe(sha256(MASK));
    expect(reusedInputs.artifacts.overlay?.checksumSha256).toBe(
      sha256(OVERLAY),
    );
    expect(JSON.stringify(reusedInputs)).not.toContain("://");
  });

  it("records a retryable FAILED state when the PDF upload fails", async () => {
    const { service, repository, storage } = serviceFor({});
    const failingStorage: ArtifactPublicationStoragePort = {
      storageId: storage.storageId,
      loadBytes: storage.loadBytes,
      async upload() {
        throw new StorageProviderError("storage_unavailable");
      },
    };
    const failingService = createArtifactPublicationService({
      repository,
      storage: failingStorage,
      contentEnv: CONTENT_ENV,
      pdfBucket: "pdf-bucket",
      renderPdf: async () => PDF,
      now: () => new Date("2026-11-20T11:00:00.000Z"),
      generateReportId: () => REPORT_ID,
    });

    const result = await failingService.publish(INFERENCE_ID);

    expect(repository.artifacts.get("pdf:1")).toMatchObject({
      status: "FAILED",
      failureCode: "storage_upload_failed",
      retryable: true,
    });
    expect(result.report).toMatchObject({
      status: "FAILED",
      failureCode: "storage_upload_failed",
      retryable: true,
    });
  });

  it("returns a typed safe error when the inference does not exist", async () => {
    const repository = new FakePublicationRepository(makeInference());
    repository.findInference = async () => null;
    const { service } = serviceFor({ repository });

    await expect(service.publish(INFERENCE_ID)).rejects.toMatchObject({
      code: "inference_not_found",
    });
    await expect(service.publish(INFERENCE_ID)).rejects.toBeInstanceOf(
      ArtifactPublicationError,
    );
  });
});
