import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import type { Prisma } from "../src/generated/prisma/client.js";
import {
  createArtifactPublicationRepository,
  type ArtifactPublicationRepository,
} from "../src/repositories/artifact-publication.repo.js";
import {
  createArtifactPublicationService,
  type ArtifactPublicationStoragePort,
} from "../src/services/artifact-publication.js";
import {
  loadArtifactBytes,
  type ArtifactContentEnv,
  type ArtifactContentStoragePort,
} from "../src/services/artifact-content.js";
import type {
  ArtifactDefaultKind,
  ArtifactReferenceContext,
} from "../src/services/artifact-reference.js";
import { renderBasicPdf } from "../src/services/pdf-report.js";
import { StorageProviderError } from "../src/services/storage-provider.js";
import type { ArtifactStoragePort } from "../src/services/storage.js";
import { FEATURES } from "./fixtures/clinical.js";
import { bearer, buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

type Role = "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN";
interface User {
  id: string;
  role: Role;
}

interface Study {
  patient: { id: string };
  consultation: { id: string };
  image: { id: string };
  snapshot: { id: string } | null;
  inference: { id: string };
}

let doctor: User;
let researcher: User;
let admin: User;
let headersDoctor: { authorization: string };
let headersResearcher: { authorization: string };
let headersAdmin: { authorization: string };

const CONTENT_ENV: ArtifactContentEnv = {
  STORAGE_PROVIDER: "minio",
  MINIO_BUCKET_RAW: "raw-retinas",
  MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  MINIO_BUCKET_MASK: "mask-bucket",
  MINIO_BUCKET_OVERLAY: "overlay-bucket",
  MINIO_BUCKET_PDF: "pdf-bucket",
};

const ORIGINAL_PATH = "case/original.jpg";
const MASK_REFERENCE = "s3://mask-bucket/case/mask.png";
const OVERLAY_REFERENCE = "s3://overlay-bucket/case/overlay.png";

const objects = new Map<string, Buffer>();
const uploads: Array<{
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}> = [];

let original: Buffer;
let mask: Buffer;
let overlay: Buffer;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const contentStorage: ArtifactContentStoragePort = {
  async getObjectStream(bucket, key) {
    const body = objects.get(`${bucket}/${key}`);
    if (body === undefined) {
      throw new StorageProviderError("storage_object_missing");
    }
    return Readable.from([body]);
  },
};

const publicationStorage: ArtifactPublicationStoragePort = {
  storageId: "minio-local",
  loadBytes: (reference, kind) =>
    loadArtifactBytes(reference, kind, {
      env: CONTENT_ENV,
      storage: contentStorage,
    }),
  async upload(bucket, key, body, contentType) {
    uploads.push({ bucket, key, body, contentType });
    objects.set(`${bucket}/${key}`, Buffer.from(body));
  },
};

function contextFor(bucket: string): ArtifactReferenceContext {
  return {
    provider: "minio",
    storageId: "minio-local",
    allowedBuckets: [
      "raw-retinas",
      "gradcam-overlays",
      "mask-bucket",
      "overlay-bucket",
      "pdf-bucket",
      bucket,
    ],
    defaultBucket: bucket,
  };
}

const urlStorage: ArtifactStoragePort = {
  getArtifactReferenceContext: (kind: ArtifactDefaultKind) =>
    contextFor(kind === "image" ? "raw-retinas" : "gradcam-overlays"),
  getArtifactRecordContext: (bucket: string) => contextFor(bucket),
  getDownloadTtlSeconds: () => 3600,
  getDownloadUrl: async () => "https://signed.example/artifact",
  getMlDownloadUrl: async () => "http://minio:9000/image",
};

function publicationFor(input: {
  env?: ArtifactContentEnv;
  storage?: ArtifactPublicationStoragePort;
} = {}) {
  return createArtifactPublicationService({
    repository: createArtifactPublicationRepository(prisma),
    storage: input.storage ?? publicationStorage,
    contentEnv: input.env ?? CONTENT_ENV,
    pdfBucket: "pdf-bucket",
    renderPdf: renderBasicPdf,
    now: () => new Date("2026-11-20T11:00:00.000Z"),
  });
}

beforeAll(async () => {
  original = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  mask = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  overlay = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  app = await buildTestApp(prisma, { storage: urlStorage });
});

beforeEach(async () => {
  objects.clear();
  uploads.length = 0;
  await resetDb(prisma);
  doctor = await makeUser(prisma, "OFTALMOLOGO");
  researcher = await makeUser(prisma, "INVESTIGADOR");
  admin = await makeUser(prisma, "ADMIN");
  headersDoctor = await bearer(app, prisma, doctor);
  headersResearcher = await bearer(app, prisma, researcher);
  headersAdmin = await bearer(app, prisma, admin);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function seedStudy(
  doctorId: string,
  input: {
    withSnapshot?: boolean;
    artifacts?: Record<string, string>;
  } = {},
): Promise<Study> {
  const patient = await prisma.patient.create({
    data: { ownerDoctorId: doctorId },
  });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId,
      status: "COMPLETED",
      clinicalData: { ...FEATURES } as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: "OD",
      storagePath: ORIGINAL_PATH,
    },
  });
  const snapshot =
    input.withSnapshot === false
      ? null
      : await prisma.clinicalSnapshot.create({
          data: {
            consultationId: consultation.id,
            rawPayload: { ...FEATURES } as Prisma.InputJsonValue,
            normalizedPayload: {
              eyeSide: "OD",
              values: FEATURES,
            } as Prisma.InputJsonValue,
            schemaVersion: "ml-zscore-f32-v1",
            modelVersions: { manifest: "resnet50-v1" } as Prisma.InputJsonValue,
          },
        });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide: "OD",
      snapshotId: snapshot?.id ?? null,
      status: "COMPLETED",
      predictedClass: 2,
      confidence: 0.87,
      probabilities: {
        Glaucoma: 0.1,
        Non_Glaucoma: 0.03,
        Suspicious_Glaucoma: 0.87,
      } as Prisma.InputJsonValue,
      cdr: 0.42,
      cdrVertical: 0.38,
      quality: { segmentation: 0.91 } as Prisma.InputJsonValue,
      elapsedSeconds: 3.5,
      modelVersion: "v1",
      modelVersions: { manifest: "resnet50-v1" } as Prisma.InputJsonValue,
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
      } as Prisma.InputJsonValue,
      artifacts: (input.artifacts ?? {
        mask: MASK_REFERENCE,
        overlay: OVERLAY_REFERENCE,
      }) as Prisma.InputJsonValue,
    },
  });

  objects.set(`raw-retinas/${ORIGINAL_PATH}`, original);
  objects.set("mask-bucket/case/mask.png", mask);
  objects.set("overlay-bucket/case/overlay.png", overlay);

  return { patient, consultation, image, snapshot, inference };
}

async function grant(
  recipient: User,
  study: Study,
  over: { readArtifacts?: boolean; readPdf?: boolean } = {},
): Promise<void> {
  await prisma.inferenceAccessGrant.create({
    data: {
      inferenceId: study.inference.id,
      consultationId: study.consultation.id,
      recipientUserId: recipient.id,
      approvalReference: `APP-${randomUUID()}`,
      readResult: false,
      readArtifacts: over.readArtifacts ?? false,
      readPdf: over.readPdf ?? false,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe("artifact publication (real PostgreSQL)", () => {
  it("publishes mask/overlay/pdf rows and a versioned PdfReport", async () => {
    const study = await seedStudy(doctor.id);
    const result = await publicationFor().publish(study.inference.id);

    expect(result.report?.status).toBe("AVAILABLE");

    const rows = await prisma.artifactRecord.findMany({
      where: { inferenceId: study.inference.id },
      orderBy: [{ artifactType: "asc" }],
    });
    const byType = new Map(rows.map((row) => [row.artifactType, row]));

    expect(byType.get("mask")).toMatchObject({
      status: "AVAILABLE",
      storageId: "minio-local",
      bucketOrContainer: "mask-bucket",
      key: "case/mask.png",
      contentType: "image/png",
    });
    expect(byType.get("mask")?.sizeBytes).toBe(BigInt(mask.byteLength));
    expect(byType.get("mask")?.checksumSha256).toBe(sha256(mask));
    expect(byType.get("mask")?.availableAt).toBeInstanceOf(Date);

    expect(byType.get("overlay")).toMatchObject({
      status: "AVAILABLE",
      bucketOrContainer: "overlay-bucket",
      key: "case/overlay.png",
      contentType: "image/png",
    });
    expect(byType.get("overlay")?.checksumSha256).toBe(sha256(overlay));

    const pdfRow = byType.get("pdf");
    expect(pdfRow).toMatchObject({
      status: "AVAILABLE",
      storageId: "minio-local",
      bucketOrContainer: "pdf-bucket",
      key: `${study.inference.id}/v1.pdf`,
      contentType: "application/pdf",
    });
    expect(pdfRow?.sizeBytes).toBeGreaterThan(0n);
    expect(pdfRow?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const reports = await prisma.pdfReport.findMany({
      where: { inferenceId: study.inference.id },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      version: 1,
      status: "AVAILABLE",
      artifactId: pdfRow?.id,
      sourceSnapshotId: study.snapshot?.id,
    });
    expect(reports[0]?.dataVersion).toMatch(/^pdfv1:[0-9a-f]{64}$/);
    expect(JSON.stringify(reports[0]?.renderingInputs)).not.toContain("://");
    expect(uploads).toHaveLength(1);
    expect(objects.has(`pdf-bucket/${study.inference.id}/v1.pdf`)).toBe(true);
  });

  it("rolls back the artifact when the report finalization loses the PENDING guard", async () => {
    const study = await seedStudy(doctor.id);
    const snapshotId = study.snapshot?.id;
    if (snapshotId === undefined) {
      throw new Error("seedStudy must create a snapshot for this test");
    }

    const pdfArtifact = await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "pdf",
        version: 1,
        status: "PENDING",
      },
    });
    const report = await prisma.pdfReport.create({
      data: {
        inferenceId: study.inference.id,
        version: 1,
        sourceSnapshotId: snapshotId,
        status: "PENDING",
        dataVersion: "pdfv1:pending",
        modelVersions: {},
        renderingInputs: {},
      },
    });
    // Simulate the concurrent FAILED transition that makes the report guard
    // match zero rows during finalization.
    await prisma.pdfReport.update({
      where: { id: report.id },
      data: { status: "FAILED" },
    });

    const repository = createArtifactPublicationRepository(prisma);
    const finalized = await repository.finalizePdfAvailable({
      artifactId: pdfArtifact.id,
      reportId: report.id,
      metadata: {
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${study.inference.id}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 123,
        checksumSha256: "a".repeat(64),
        availableAt: new Date("2026-11-20T11:00:00.000Z"),
      },
    });

    expect(finalized).toBeNull();
    const artifactAfter = await prisma.artifactRecord.findUnique({
      where: { id: pdfArtifact.id },
    });
    expect(artifactAfter).toMatchObject({
      status: "PENDING",
      storageId: null,
      bucketOrContainer: null,
      key: null,
      contentType: null,
    });
    const reportAfter = await prisma.pdfReport.findUnique({
      where: { id: report.id },
    });
    expect(reportAfter?.status).toBe("FAILED");
  });

  it("does not let a concurrent finalize loser mark the winner FAILED", async () => {
    const study = await seedStudy(doctor.id);
    const realRepository = createArtifactPublicationRepository(prisma);
    let serviceFinalizeCalls = 0;
    let realFinalizeCalls = 0;
    let failedCalls = 0;
    const racingRepository: ArtifactPublicationRepository = {
      ...realRepository,
      async finalizePdfAvailable(input) {
        serviceFinalizeCalls += 1;
        // Winner commits the pair first.
        realFinalizeCalls += 1;
        const winner = await realRepository.finalizePdfAvailable(input);
        expect(winner).not.toBeNull();
        // The loser now hits AVAILABLE rows and gets a conflict/rollback.
        realFinalizeCalls += 1;
        return realRepository.finalizePdfAvailable(input);
      },
      async finalizePdfFailed(input) {
        failedCalls += 1;
        return realRepository.finalizePdfFailed(input);
      },
    };

    const publication = createArtifactPublicationService({
      repository: racingRepository,
      storage: publicationStorage,
      contentEnv: CONTENT_ENV,
      pdfBucket: "pdf-bucket",
      renderPdf: renderBasicPdf,
      now: () => new Date("2026-11-20T11:00:00.000Z"),
    });
    const result = await publication.publish(study.inference.id);

    expect(serviceFinalizeCalls).toBe(1);
    expect(realFinalizeCalls).toBe(2);
    expect(failedCalls).toBe(0);
    expect(result.report?.status).toBe("AVAILABLE");
    const report = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
      include: { artifact: true },
    });
    expect(report?.status).toBe("AVAILABLE");
    expect(report?.artifact?.status).toBe("AVAILABLE");
    const artifact = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(artifact?.status).toBe("AVAILABLE");
  });

  it("reuses the same rows and report on a same-content retry", async () => {
    const study = await seedStudy(doctor.id);
    const publication = publicationFor();

    const first = await publication.publish(study.inference.id);
    const second = await publication.publish(study.inference.id);

    const artifactCount = await prisma.artifactRecord.count({
      where: { inferenceId: study.inference.id },
    });
    const reportCount = await prisma.pdfReport.count({
      where: { inferenceId: study.inference.id },
    });
    expect(artifactCount).toBe(3);
    expect(reportCount).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(second.report?.reportId).toBe(first.report?.reportId);
    expect(second.report?.version).toBe(1);
    expect(second.report?.dataVersion).toBe(first.report?.dataVersion);
  });

  it("fails closed when a key-only mask has no configured bucket", async () => {
    const study = await seedStudy(doctor.id, {
      artifacts: {
        mask: "case/mask.png",
        overlay: OVERLAY_REFERENCE,
      },
    });
    const publication = publicationFor({
      env: { ...CONTENT_ENV, MINIO_BUCKET_MASK: undefined },
    });

    const result = await publication.publish(study.inference.id);

    const maskRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "mask" },
    });
    expect(maskRow).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });
    const pdfRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(pdfRow).toMatchObject({
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });

    const report = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
      include: { artifact: true },
    });
    expect(report).toMatchObject({
      status: "FAILED",
      artifact: { failureCode: "artifact_bucket_unconfigured", retryable: false },
    });
    expect(result.report?.status).toBe("FAILED");
    expect(uploads).toHaveLength(0);
  });

  it("records a retryable FAILED state when the PDF upload fails", async () => {
    const study = await seedStudy(doctor.id);
    const failingStorage: ArtifactPublicationStoragePort = {
      storageId: publicationStorage.storageId,
      loadBytes: publicationStorage.loadBytes,
      async upload() {
        throw new StorageProviderError("storage_unavailable");
      },
    };
    const result = await publicationFor({ storage: failingStorage }).publish(
      study.inference.id,
    );

    const maskRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "mask" },
    });
    expect(maskRow?.status).toBe("AVAILABLE");

    const pdfRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(pdfRow).toMatchObject({
      status: "FAILED",
      failureCode: "storage_upload_failed",
      retryable: true,
    });
    const report = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
      include: { artifact: true },
    });
    expect(report).toMatchObject({
      status: "FAILED",
      artifact: { failureCode: "storage_upload_failed", retryable: true },
    });
    expect(result.report?.status).toBe("FAILED");
  });

  it("never publishes an AVAILABLE report when the snapshot is null", async () => {
    const study = await seedStudy(doctor.id, { withSnapshot: false });
    const result = await publicationFor().publish(study.inference.id);

    const pdfRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(pdfRow).toMatchObject({
      status: "FAILED",
      failureCode: "snapshot_missing",
      retryable: false,
    });
    const report = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
      include: { artifact: true },
    });
    expect(report).toMatchObject({
      status: "FAILED",
      sourceSnapshotId: null,
      artifact: { failureCode: "snapshot_missing", retryable: false },
    });
    expect(result.report?.status).toBe("FAILED");
    expect(uploads).toHaveLength(0);
  });

  it("lists report versions and issues a PDF URL only with readPdf", async () => {
    const study = await seedStudy(doctor.id);
    const result = await publicationFor().publish(study.inference.id);
    const reportId = result.report?.reportId;
    expect(reportId).toBeDefined();

    const ownerList = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersDoctor,
    });
    expect(ownerList.statusCode).toBe(200);
    expect(ownerList.headers["cache-control"]).toBe("no-store");
    const list = ownerList.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      reportId,
      inferenceId: study.inference.id,
      version: 1,
      status: "AVAILABLE",
      immutable: true,
      failureCode: null,
    });

    const ownerUrl = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
      headers: headersDoctor,
    });
    expect(ownerUrl.statusCode).toBe(200);
    expect(ownerUrl.headers["cache-control"]).toBe("no-store");
    expect(ownerUrl.json()).toMatchObject({
      artifactType: "pdf",
      status: "AVAILABLE",
      reportVersion: 1,
      contentType: "application/pdf",
      expiresInSeconds: 3600,
    });

    await grant(researcher, study, { readPdf: true });
    const researcherList = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersResearcher,
    });
    expect(researcherList.statusCode).toBe(200);
    const researcherUrl = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
      headers: headersResearcher,
    });
    expect(researcherUrl.statusCode).toBe(200);

    const noPdfGrant = await makeUser(prisma, "INVESTIGADOR");
    const noPdfHeaders = await bearer(app, prisma, noPdfGrant);
    await grant(noPdfGrant, study, { readArtifacts: true });
    const deniedList = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: noPdfHeaders,
    });
    expect(deniedList.statusCode).toBe(404);
    const deniedUrl = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
      headers: noPdfHeaders,
    });
    expect(deniedUrl.statusCode).toBe(404);

    const adminList = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersAdmin,
    });
    expect(adminList.statusCode).toBe(404);
  });
});

/**
 * QA independent gap coverage for 6.2/3.5 (contract D28.3, artifact-evidence
 * "Reintento de publicación", frontend-api-contract §4.4). Idempotent reuse on
 * retry, /reports observability of FAILED rows, DB constraint backstops and
 * atomic PENDING->AVAILABLE transitions are not covered above.
 */
describe("artifact publication QA gap coverage (6.2/3.5)", () => {
  it("reuses the same report row and version after a retryable upload failure", async () => {
    const study = await seedStudy(doctor.id);
    const failingStorage: ArtifactPublicationStoragePort = {
      storageId: publicationStorage.storageId,
      loadBytes: publicationStorage.loadBytes,
      async upload() {
        throw new StorageProviderError("storage_unavailable");
      },
    };

    const first = await publicationFor({ storage: failingStorage }).publish(
      study.inference.id,
    );
    expect(first.report).toMatchObject({
      status: "FAILED",
      version: 1,
      failureCode: "storage_upload_failed",
      retryable: true,
    });
    const failedPdfRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(failedPdfRow?.status).toBe("FAILED");

    const second = await publicationFor().publish(study.inference.id);

    expect(second.report).toMatchObject({
      reportId: first.report?.reportId,
      version: 1,
      status: "AVAILABLE",
      failureCode: null,
      retryable: false,
    });
    const artifactCount = await prisma.artifactRecord.count({
      where: { inferenceId: study.inference.id },
    });
    const reportCount = await prisma.pdfReport.count({
      where: { inferenceId: study.inference.id },
    });
    expect(artifactCount).toBe(3);
    expect(reportCount).toBe(1);

    const reusedPdfRow = await prisma.artifactRecord.findFirst({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
    });
    expect(reusedPdfRow?.id).toBe(failedPdfRow?.id);
    expect(reusedPdfRow).toMatchObject({
      status: "AVAILABLE",
      key: `${study.inference.id}/v1.pdf`,
    });
    expect(uploads).toHaveLength(1);

    const renderingInputsText = JSON.stringify(
      (
        await prisma.pdfReport.findFirst({
          where: { inferenceId: study.inference.id },
        })
      )?.renderingInputs ?? {},
    );
    expect(renderingInputsText).not.toContain("://");
    expect(renderingInputsText).not.toMatch(
      /(sig|x-amz-signature|x-amz-credential|x-amz-security-token)["']?\s*[:=]/i,
    );
  });

  it("reuses the same report row and version after a retryable content failure", async () => {
    const study = await seedStudy(doctor.id);
    objects.delete("overlay-bucket/case/overlay.png");

    const first = await publicationFor().publish(study.inference.id);
    expect(first.report).toMatchObject({
      status: "FAILED",
      version: 1,
      failureCode: "artifact_object_missing",
      retryable: true,
    });
    const firstReportId = first.report?.reportId;

    // Same data as before; only the transient storage failure was repaired.
    objects.set("overlay-bucket/case/overlay.png", overlay);
    const second = await publicationFor().publish(study.inference.id);

    // "Reintento de PDF": retry without data changes reuses the same
    // fila/version idempotently; only feedback/content changes make a new
    // version.
    expect(second.report).toMatchObject({
      reportId: firstReportId,
      version: 1,
      status: "AVAILABLE",
    });
    // The pre-render placeholder dataVersion is replaced in place while the
    // row is PENDING (corrective migration: data_version mutable only
    // PENDING->PENDING) and then frozen at AVAILABLE.
    expect(first.report?.dataVersion).toMatch(/^pdfv1:[0-9a-f]{64}$/);
    expect(second.report?.dataVersion).toMatch(/^pdfv1:[0-9a-f]{64}$/);
    expect(second.report?.dataVersion).not.toBe(first.report?.dataVersion);
    const reportCount = await prisma.pdfReport.count({
      where: { inferenceId: study.inference.id },
    });
    expect(reportCount).toBe(1);
    const pdfRows = await prisma.artifactRecord.findMany({
      where: { inferenceId: study.inference.id, artifactType: "pdf" },
      orderBy: { version: "asc" },
    });
    expect(pdfRows).toHaveLength(1);
    expect(pdfRows[0]).toMatchObject({
      version: 1,
      status: "AVAILABLE",
      key: `${study.inference.id}/v1.pdf`,
    });

    const reusedReport = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
    });
    const reusedInputs = reusedReport?.renderingInputs as {
      failureCode?: string;
      artifacts?: Record<string, { checksumSha256: string; size: number }>;
    };
    expect(reusedInputs.failureCode).toBeUndefined();
    expect(reusedInputs.artifacts?.original?.checksumSha256).toBe(
      sha256(original),
    );
    expect(reusedInputs.artifacts?.mask?.checksumSha256).toBe(sha256(mask));
    expect(reusedInputs.artifacts?.overlay?.checksumSha256).toBe(
      sha256(overlay),
    );
    expect(JSON.stringify(reusedInputs)).not.toContain("://");
  });

  it("exposes a FAILED report in /reports with the linked artifact failure code", async () => {
    const study = await seedStudy(doctor.id);
    const failingStorage: ArtifactPublicationStoragePort = {
      storageId: publicationStorage.storageId,
      loadBytes: publicationStorage.loadBytes,
      async upload() {
        throw new StorageProviderError("storage_unavailable");
      },
    };
    const result = await publicationFor({ storage: failingStorage }).publish(
      study.inference.id,
    );
    expect(result.report).toMatchObject({
      status: "FAILED",
      failureCode: "storage_upload_failed",
    });

    const list = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersDoctor,
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    const reports = list.json() as Array<Record<string, unknown>>;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      reportId: result.report?.reportId,
      inferenceId: study.inference.id,
      version: 1,
      status: "FAILED",
      availableAt: null,
      failureCode: "storage_upload_failed",
    });

    const url = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
      headers: headersDoctor,
    });
    expect(url.statusCode).toBe(200);
    expect(url.headers["cache-control"]).toBe("no-store");
    expect(url.json()).toMatchObject({
      artifactType: "pdf",
      status: "FAILED",
      url: null,
      expiresInSeconds: null,
      contentType: null,
      reportVersion: null,
    });
    expect(JSON.stringify(url.json())).not.toContain("://");
  });

  it("validates the report version path parameter", async () => {
    const study = await seedStudy(doctor.id);
    await publicationFor().publish(study.inference.id);

    const nonNumeric = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/abc/url`,
      headers: headersDoctor,
    });
    expect(nonNumeric.statusCode).toBe(400);

    const zero = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/0/url`,
      headers: headersDoctor,
    });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/-1/url`,
      headers: headersDoctor,
    });
    expect(negative.statusCode).toBe(400);

    const unknownVersion = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/2/url`,
      headers: headersDoctor,
    });
    expect(unknownVersion.statusCode).toBe(404);
  });

  it("requires authentication and readPdf on /reports while readArtifacts still opens /artifacts", async () => {
    const study = await seedStudy(doctor.id);
    await publicationFor().publish(study.inference.id);

    const missingToken = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
    });
    expect(missingToken.statusCode).toBe(401);
    const missingTokenUrl = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
    });
    expect(missingTokenUrl.statusCode).toBe(401);

    const invalidToken = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(invalidToken.statusCode).toBe(401);

    // Contrast: the same principal with only readArtifacts keeps its artifact
    // access but /reports stays closed (no reportId leaks in the 404 body).
    const noPdfUser = await makeUser(prisma, "INVESTIGADOR");
    const noPdfHeaders = await bearer(app, prisma, noPdfUser);
    await grant(noPdfUser, study, { readArtifacts: true });

    const artifacts = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/artifacts`,
      headers: noPdfHeaders,
    });
    expect(artifacts.statusCode).toBe(200);
    expect((artifacts.json() as { total: number }).total).toBeGreaterThan(0);

    const deniedList = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: noPdfHeaders,
    });
    expect(deniedList.statusCode).toBe(404);
    expect(JSON.stringify(deniedList.json())).not.toContain("reportId");

    const deniedUrl = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports/1/url`,
      headers: noPdfHeaders,
    });
    expect(deniedUrl.statusCode).toBe(404);
  });

  it("rejects forcing AVAILABLE on a report without a source snapshot", async () => {
    const study = await seedStudy(doctor.id, { withSnapshot: false });
    await publicationFor().publish(study.inference.id);

    const availableReports = await prisma.pdfReport.count({
      where: { inferenceId: study.inference.id, status: "AVAILABLE" },
    });
    expect(availableReports).toBe(0);

    const legacy = await prisma.pdfReport.findFirst({
      where: { inferenceId: study.inference.id },
    });
    expect(legacy?.status).toBe("FAILED");
    expect(legacy?.sourceSnapshotId).toBeNull();

    // The FAILED row cannot be forced to AVAILABLE (transition guard).
    await expect(
      prisma.pdfReport.update({
        where: { id: legacy!.id },
        data: { status: "AVAILABLE", availableAt: new Date() },
      }),
    ).rejects.toThrow();
    expect(
      (
        await prisma.pdfReport.findUnique({ where: { id: legacy!.id } })
      )?.status,
    ).toBe("FAILED");

    // Even a PENDING legacy row cannot publish AVAILABLE without a snapshot:
    // the existing pdf_reports_available_check rejects the publication.
    const repository = createArtifactPublicationRepository(prisma);
    const pending = await repository.ensurePendingPdfReport({
      id: randomUUID(),
      inferenceId: study.inference.id,
      version: 2,
      sourceSnapshotId: null,
      dataVersion: `pdfv1:${"0".repeat(64)}`,
      modelVersions: {},
      renderingInputs: { kind: "legacy-null-snapshot" },
    });
    expect(pending.status).toBe("PENDING");

    await expect(
      prisma.pdfReport.update({
        where: { id: pending.id },
        data: { status: "AVAILABLE", availableAt: new Date() },
      }),
    ).rejects.toThrow();
    const unchanged = await prisma.pdfReport.findUnique({
      where: { id: pending.id },
    });
    expect(unchanged).toMatchObject({ status: "PENDING", availableAt: null });
  });

  it("rejects a report whose source snapshot does not match the inference", async () => {
    const study = await seedStudy(doctor.id);
    const otherSnapshot = await prisma.clinicalSnapshot.create({
      data: {
        consultationId: study.consultation.id,
        rawPayload: { ...FEATURES } as Prisma.InputJsonValue,
        normalizedPayload: {
          eyeSide: "OD",
          values: FEATURES,
        } as Prisma.InputJsonValue,
        schemaVersion: "ml-zscore-f32-v1",
        modelVersions: { manifest: "other" } as Prisma.InputJsonValue,
      },
    });

    const repository = createArtifactPublicationRepository(prisma);
    await expect(
      repository.ensurePendingPdfReport({
        id: randomUUID(),
        inferenceId: study.inference.id,
        version: 1,
        sourceSnapshotId: otherSnapshot.id,
        dataVersion: `pdfv1:${"1".repeat(64)}`,
        modelVersions: {},
        renderingInputs: { kind: "wrong-provenance" },
      }),
    ).rejects.toThrow(/source_snapshot_id must match/);

    const rows = await prisma.pdfReport.count({
      where: { inferenceId: study.inference.id },
    });
    expect(rows).toBe(0);
  });

  it("rejects a report linked to a non-pdf artifact or published over a non-available pdf artifact", async () => {
    const study = await seedStudy(doctor.id);
    const repository = createArtifactPublicationRepository(prisma);
    const report = await repository.ensurePendingPdfReport({
      id: randomUUID(),
      inferenceId: study.inference.id,
      version: 1,
      sourceSnapshotId: study.snapshot!.id,
      dataVersion: `pdfv1:${"2".repeat(64)}`,
      modelVersions: {},
      renderingInputs: { kind: "linkage" },
    });

    const maskRow = await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "mask",
        version: 1,
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "mask-bucket",
        key: "case/mask.png",
        contentType: "image/png",
        sizeBytes: 1n,
        checksumSha256: "0".repeat(64),
        availableAt: new Date(),
      },
    });

    await expect(
      prisma.pdfReport.update({
        where: { id: report.id },
        data: { artifactId: maskRow.id },
      }),
    ).rejects.toThrow(/pdf artifact of the same inference and version/);

    // PENDING rows must keep every AVAILABLE-only field NULL
    // (artifact_records_available_fields_check).
    const pendingPdf = await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "pdf",
        version: 1,
        status: "PENDING",
      },
    });
    await prisma.pdfReport.update({
      where: { id: report.id },
      data: { artifactId: pendingPdf.id },
    });

    await expect(
      prisma.pdfReport.update({
        where: { id: report.id },
        data: { status: "AVAILABLE", availableAt: new Date() },
      }),
    ).rejects.toThrow(/available application\/pdf artifact/);
    expect(
      (await prisma.pdfReport.findUnique({ where: { id: report.id } }))?.status,
    ).toBe("PENDING");
  });

  it("leaves no half-published rows when the report cannot transition", async () => {
    const study = await seedStudy(doctor.id);
    const repository = createArtifactPublicationRepository(prisma);
    const artifact = await repository.ensurePendingArtifact({
      inferenceId: study.inference.id,
      artifactType: "pdf",
      version: 1,
    });
    const report = await repository.ensurePendingPdfReport({
      id: randomUUID(),
      inferenceId: study.inference.id,
      version: 1,
      sourceSnapshotId: study.snapshot!.id,
      dataVersion: `pdfv1:${"3".repeat(64)}`,
      modelVersions: {},
      renderingInputs: { kind: "atomicity" },
    });
    await repository.finalizePdfFailed({
      artifactId: artifact.id,
      reportId: report.id,
      failureCode: "storage_upload_failed",
      retryable: true,
    });

    // Out-of-order state at finalize time (e.g. a concurrent publisher already
    // failed the report): the PENDING->AVAILABLE transition must be atomic.
    const finalized = await repository.finalizePdfAvailable({
      artifactId: artifact.id,
      reportId: report.id,
      metadata: {
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${study.inference.id}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 12,
        checksumSha256: "b".repeat(64),
        availableAt: new Date("2026-11-20T11:00:00.000Z"),
      },
    });

    expect(finalized).toBeNull();
    const artifactAfter = await prisma.artifactRecord.findUnique({
      where: { id: artifact.id },
    });
    const reportAfter = await prisma.pdfReport.findUnique({
      where: { id: report.id },
    });
    expect(artifactAfter?.status).toBe("FAILED");
    expect(reportAfter?.status).toBe("FAILED");
  });

  it("does not freeze a report against divergent bytes published by a concurrent winner", async () => {
    const study = await seedStudy(doctor.id);
    const repository = createArtifactPublicationRepository(prisma);
    const artifact = await repository.ensurePendingArtifact({
      inferenceId: study.inference.id,
      artifactType: "pdf",
      version: 1,
    });
    const report = await repository.ensurePendingPdfReport({
      id: randomUUID(),
      inferenceId: study.inference.id,
      version: 1,
      sourceSnapshotId: study.snapshot!.id,
      dataVersion: `pdfv1:${"4".repeat(64)}`,
      modelVersions: {},
      renderingInputs: { kind: "divergent-metadata" },
    });

    // A concurrent winner already published DIFFERENT bytes for the same
    // artifact row and left it AVAILABLE.
    await prisma.artifactRecord.update({
      where: { id: artifact.id },
      data: {
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${study.inference.id}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 999n,
        checksumSha256: "c".repeat(64),
        availableAt: new Date("2026-11-20T10:30:00.000Z"),
      },
    });

    const finalized = await repository.finalizePdfAvailable({
      artifactId: artifact.id,
      reportId: report.id,
      metadata: {
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${study.inference.id}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 12,
        checksumSha256: "b".repeat(64),
        availableAt: new Date("2026-11-20T11:00:00.000Z"),
      },
    });

    expect(finalized).toBeNull();
    const artifactAfter = await prisma.artifactRecord.findUnique({
      where: { id: artifact.id },
    });
    const reportAfter = await prisma.pdfReport.findUnique({
      where: { id: report.id },
    });
    // The winner's artifact metadata is preserved and the report is not
    // frozen (rolled back) against the divergent bytes.
    expect(artifactAfter).toMatchObject({
      status: "AVAILABLE",
      sizeBytes: 999n,
      checksumSha256: "c".repeat(64),
    });
    expect(reportAfter?.status).toBe("PENDING");
    expect(reportAfter?.availableAt).toBeNull();
  });

  it("creates a new version after a non-retryable failure and preserves the failed attempt", async () => {
    const study = await seedStudy(doctor.id, {
      artifacts: {
        mask: "case/mask.png",
        overlay: OVERLAY_REFERENCE,
      },
    });

    const first = await publicationFor({
      env: { ...CONTENT_ENV, MINIO_BUCKET_MASK: undefined },
    }).publish(study.inference.id);
    expect(first.report).toMatchObject({
      status: "FAILED",
      version: 1,
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });

    // A non-retryable failure is an explicit failed attempt: repairing the
    // configuration and republishing creates a NEW version/reportId and keeps
    // the failed attempt visible for traceability.
    const second = await publicationFor().publish(study.inference.id);
    expect(second.report).toMatchObject({ status: "AVAILABLE", version: 2 });
    expect(second.report?.reportId).not.toBe(first.report?.reportId);

    const reports = await prisma.pdfReport.findMany({
      where: { inferenceId: study.inference.id },
      orderBy: { version: "asc" },
      include: { artifact: true },
    });
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      version: 1,
      status: "FAILED",
      sourceSnapshotId: study.snapshot?.id,
    });
    expect(reports[0]?.artifact).toMatchObject({
      failureCode: "artifact_bucket_unconfigured",
      retryable: false,
    });
    expect(reports[1]).toMatchObject({ version: 2, status: "AVAILABLE" });

    const list = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersDoctor,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      version: 2,
      status: "AVAILABLE",
      failureCode: null,
    });
    expect(items[1]).toMatchObject({
      version: 1,
      status: "FAILED",
      failureCode: "artifact_bucket_unconfigured",
      availableAt: null,
    });
  });

  it("keeps a retryable pre-render failure visible in /reports with the linked artifact failure code", async () => {
    const study = await seedStudy(doctor.id);
    objects.delete("overlay-bucket/case/overlay.png");

    const result = await publicationFor().publish(study.inference.id);
    expect(result.report).toMatchObject({
      status: "FAILED",
      version: 1,
      failureCode: "artifact_object_missing",
      retryable: true,
    });

    const list = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}/reports`,
      headers: headersDoctor,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reportId: result.report?.reportId,
      inferenceId: study.inference.id,
      version: 1,
      status: "FAILED",
      availableAt: null,
      failureCode: "artifact_object_missing",
    });
  });
});
