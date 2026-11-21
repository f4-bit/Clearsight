import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full local clinical E2E (7.2) without Azure, MinIO, Redis or a real ML model.
 * Storage and the BullMQ enqueue are mocked; the database, HTTP routes, auth,
 * sanitizer, publication seam and PDF renderer are the real implementations.
 */

const storageState = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  uploads: [] as Array<{
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }>,
}));

vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn(
      async (
        bucket: string,
        key: string,
        body: Buffer | Uint8Array,
        contentType = "image/jpeg",
      ) => {
        const stored = Buffer.from(body);
        storageState.objects.set(`${bucket}/${key}`, stored);
        storageState.uploads.push({ bucket, key, body: stored, contentType });
        return `${bucket}/${key}`;
      },
    ),
    getObjectStream: vi.fn(),
    getDownloadUrl: vi.fn(async () => "https://signed.example/artifact"),
    getMlDownloadUrl: vi.fn(async () => "http://minio:9000/image"),
    getArtifactReferenceContext: vi.fn(),
    getArtifactRecordContext: vi.fn(),
    getDownloadTtlSeconds: vi.fn(() => 3600),
    getStorageId: vi.fn(() => "minio-local"),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import { createArtifactPublicationRepository } from "../src/repositories/artifact-publication.repo.js";
import { createInferenceRunRepository } from "../src/repositories/inference-run.repo.js";
import { bootstrapAdmin } from "../src/services/admin-bootstrap.js";
import {
  loadArtifactBytes,
  type ArtifactContentEnv,
  type ArtifactContentStoragePort,
} from "../src/services/artifact-content.js";
import {
  createArtifactPublicationService,
  type ArtifactPublicationStoragePort,
} from "../src/services/artifact-publication.js";
import type {
  ArtifactDefaultKind,
  ArtifactReferenceContext,
} from "../src/services/artifact-reference.js";
import { renderBasicPdf } from "../src/services/pdf-report.js";
import { StorageProviderError } from "../src/services/storage-provider.js";
import type { ArtifactStoragePort } from "../src/services/storage.js";
import { enqueueInference } from "../src/workers/inference.queue.js";
import { FEATURES } from "./fixtures/clinical.js";
import { buildTestApp, withAuthOrigin } from "./helpers/app.js";
import { createTestPrisma, resetDb } from "./helpers/db.js";
import {
  createFakeMlClient,
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "./helpers/ml.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

const PASSWORD = "ClearsightE2E-1234";
const ADMIN_EMAIL = "e2e-admin@clearsight.test";
const DOCTOR_EMAIL = "e2e-doctor@clearsight.test";

const CONTENT_ENV: ArtifactContentEnv = {
  STORAGE_PROVIDER: "minio",
  MINIO_BUCKET_RAW: "raw-retinas",
  MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  MINIO_BUCKET_MASK: "mask-bucket",
  MINIO_BUCKET_OVERLAY: "overlay-bucket",
  MINIO_BUCKET_PDF: "pdf-bucket",
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

const contentStorage: ArtifactContentStoragePort = {
  async getObjectStream(bucket, key) {
    const body = storageState.objects.get(`${bucket}/${key}`);
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
    storageState.objects.set(`${bucket}/${key}`, Buffer.from(body));
    storageState.uploads.push({
      bucket,
      key,
      body: Buffer.from(body),
      contentType,
    });
  },
};

type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; content: Buffer };

function multipart(parts: MultipartPart[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----clearsight-e2e${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        part.content,
        Buffer.from("\r\n"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: withAuthOrigin(),
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().accessToken as string;
}

function authHeaders(token: string): Record<string, string> {
  return withAuthOrigin({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
}

beforeAll(async () => {
  app = await buildTestApp(prisma, {
    mlClient: createFakeMlClient(),
    storage: urlStorage,
  });
});

beforeEach(async () => {
  storageState.objects.clear();
  storageState.uploads.length = 0;
  await resetDb(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("clinical E2E (7.2)", () => {
  it("runs bootstrap, clinical delivery, feedback, export and report downloads", async () => {
    // 1. Controlled administrator bootstrap.
    const admin = await bootstrapAdmin(prisma, {
      email: ADMIN_EMAIL,
      fullName: "E2E Administrator",
      password: PASSWORD,
    });
    const adminToken = await login(ADMIN_EMAIL, PASSWORD);

    // 2. Administrator provisions the ophthalmologist.
    const createdDoctor = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeaders(adminToken),
      payload: {
        email: DOCTOR_EMAIL,
        password: PASSWORD,
        fullName: "E2E Ophthalmologist",
        role: "OFTALMOLOGO",
      },
    });
    expect(createdDoctor.statusCode).toBe(201);
    const doctorId = createdDoctor.json().id as string;

    // 3. The provisioned doctor logs in through the real endpoint.
    const doctorToken = await login(DOCTOR_EMAIL, PASSWORD);
    const doctorHeaders = authHeaders(doctorToken);

    // 4. Pseudonymized patient and consultation.
    const patientResponse = await app.inject({
      method: "POST",
      url: "/patients",
      headers: doctorHeaders,
      payload: {
        externalCode: `E2E-${randomUUID()}`,
        age: 63,
        gender: "M",
      },
    });
    expect(patientResponse.statusCode).toBe(201);
    const patientId = patientResponse.json().id as string;

    const consultationResponse = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: doctorHeaders,
      payload: {
        patientId,
        status: "QUEUED",
        clinicalData: { ...FEATURES },
      },
    });
    expect(consultationResponse.statusCode).toBe(201);
    const consultationId = consultationResponse.json().id as string;

    // 5. Real sanitizer + mocked storage for the synthetic retina image.
    const syntheticOriginal = await sharp({
      create: {
        width: 640,
        height: 640,
        channels: 3,
        background: { r: 128, g: 72, b: 40 },
      },
    })
      .jpeg({ quality: 90 })
      .withMetadata({ exif: { IFD0: { Copyright: "E2E_EXIF_CANARY" } } })
      .toBuffer();
    const form = multipart([
      { name: "eyeSide", value: "OD" },
      { name: "file", filename: "retina.jpg", content: syntheticOriginal },
    ]);
    const uploadResponse = await app.inject({
      method: "POST",
      url: `/consultations/${consultationId}/images`,
      headers: { ...doctorHeaders, "content-type": form.contentType },
      payload: form.payload,
    });
    expect(uploadResponse.statusCode).toBe(201);
    const uploadedImage = uploadResponse.json() as {
      id: string;
      storagePath: string;
      eyeSide: string;
      hashMd5: string | null;
    };
    expect(uploadedImage.eyeSide).toBe("OD");
    expect(uploadedImage.hashMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(uploadedImage.storagePath).toMatch(/^raw-retinas\/.+\/[0-9a-f-]+\.jpg$/);

    const storedOriginal = storageState.objects.get(uploadedImage.storagePath);
    expect(storedOriginal).toBeDefined();
    expect(storedOriginal!.includes(Buffer.from("E2E_EXIF_CANARY"))).toBe(false);
    expect(storageState.uploads).toHaveLength(1);

    // 6. Inference creation with a durable Idempotency-Key (mocked BullMQ).
    const inferenceResponse = await app.inject({
      method: "POST",
      url: "/inferences",
      headers: {
        ...doctorHeaders,
        "idempotency-key": randomUUID(),
      },
      payload: {
        imageId: uploadedImage.id,
        eyeSide: "OD",
        clinicalFeatures: { ...FEATURES },
      },
    });
    expect(inferenceResponse.statusCode).toBe(202);
    const accepted = inferenceResponse.json() as {
      inferenceId: string;
      jobId: string;
      status: string;
    };
    expect(accepted).toMatchObject({
      jobId: accepted.inferenceId,
      status: "QUEUED",
    });
    expect(enqueueInference).toHaveBeenCalledTimes(1);
    const inferenceId = accepted.inferenceId;

    // 7. Polling while queued: pending delivery + backend Retry-After hint.
    const queuedPoll = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}`,
      headers: doctorHeaders,
    });
    expect(queuedPoll.statusCode).toBe(200);
    const queuedBody = queuedPoll.json() as {
      status: string;
      delivery: { complete: boolean };
      pollingStop: string;
    };
    expect(queuedBody.status).toBe("QUEUED");
    expect(queuedBody.delivery.complete).toBe(false);
    expect(queuedBody.pollingStop).toBe("CONTINUE");
    expect(queuedPoll.headers["retry-after"]).toBe("2");

    // 8. Persist the mocked ML COMPLETED result through the real CAS writer.
    const maskKey = `case/${randomUUID()}.png`;
    const overlayKey = `case/${randomUUID()}.png`;
    const mask = await sharp({
      create: {
        width: 640,
        height: 640,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const overlay = await sharp({
      create: {
        width: 640,
        height: 640,
        channels: 3,
        background: { r: 220, g: 30, b: 30 },
      },
    })
      .png()
      .toBuffer();
    storageState.objects.set(`mask-bucket/${maskKey}`, mask);
    storageState.objects.set(`overlay-bucket/${overlayKey}`, overlay);

    const prepared = makePreparedSnapshot(FEATURES);
    const persisted = await createInferenceRunRepository(prisma).saveTerminalResult(
      inferenceId,
      {
        status: "COMPLETED",
        predictedClass: 2,
        confidence: 0.87,
        probabilities: {
          Glaucoma: 0.1,
          Non_Glaucoma: 0.03,
          Suspicious_Glaucoma: 0.87,
        },
        modelVersions: prepared.modelVersions,
        modelPredictions: {
          ensemble: {
            predictedClass: "Suspicious_Glaucoma",
            confidence: 0.87,
            probabilities: {
              Glaucoma: 0.1,
              Non_Glaucoma: 0.03,
              Suspicious_Glaucoma: 0.87,
            },
          },
        },
        cdr: 0.42,
        cdrVertical: 0.38,
        quality: { segmentation: 0.91 },
        artifacts: {
          mask: `s3://mask-bucket/${maskKey}`,
          overlay: `s3://overlay-bucket/${overlayKey}`,
        },
        elapsedSeconds: 3.5,
        modelVersion: FAKE_MANIFEST_VERSION,
      },
    );
    expect(persisted).toBe(true);

    // 9. Real publication seam: mask/overlay rows, PDF render and PdfReport.
    const publication = createArtifactPublicationService({
      repository: createArtifactPublicationRepository(prisma),
      storage: publicationStorage,
      contentEnv: CONTENT_ENV,
      pdfBucket: "pdf-bucket",
      renderPdf: renderBasicPdf,
      now: () => new Date("2026-11-20T11:00:00.000Z"),
    });
    const published = await publication.publish(inferenceId);
    expect(published.report).toMatchObject({
      inferenceId,
      version: 1,
      status: "AVAILABLE",
      failureCode: null,
    });
    expect(
      published.artifacts
        .map((artifact) => `${artifact.artifactType}:${artifact.status}`)
        .sort(),
    ).toEqual(["mask:AVAILABLE", "overlay:AVAILABLE", "pdf:AVAILABLE"]);

    // 10. Freeze the required execution set.
    const freezeResponse = await app.inject({
      method: "POST",
      url: `/consultations/${consultationId}/required-executions`,
      headers: doctorHeaders,
      payload: { executionIds: [inferenceId] },
    });
    expect(freezeResponse.statusCode).toBe(200);
    const frozen = freezeResponse.json() as {
      requiredExecutionIds: string[];
      requiredSetVersion: string;
      requiredSetFrozenAt: string;
    };
    expect(frozen.requiredExecutionIds).toEqual([inferenceId]);
    expect(frozen.requiredSetVersion).toMatch(/^rsv1:[0-9a-f]{64}$/);

    // 11. Consultation aggregates reach COMPLETE.
    const consultationRead = await app.inject({
      method: "GET",
      url: `/consultations/${consultationId}`,
      headers: doctorHeaders,
    });
    expect(consultationRead.statusCode).toBe(200);
    expect(consultationRead.json()).toMatchObject({
      id: consultationId,
      analysisState: "COMPLETED",
      reportState: "AVAILABLE",
      completionState: "COMPLETE",
      pollingStop: "COMPLETE",
      requiredExecutionIds: [inferenceId],
      requiredSetVersion: frozen.requiredSetVersion,
      images: [{ id: uploadedImage.id, eyeSide: "OD" }],
    });

    // 12. Delivery is complete and no longer asks the client to poll.
    const completedPoll = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}`,
      headers: doctorHeaders,
    });
    expect(completedPoll.statusCode).toBe(200);
    expect(completedPoll.json()).toMatchObject({
      id: inferenceId,
      status: "COMPLETED",
      cdr: 0.42,
      cdrVertical: 0.38,
      delivery: {
        resultStatus: "AVAILABLE",
        evidenceStatus: "AVAILABLE",
        pdfStatus: "AVAILABLE",
        complete: true,
        reviewRequired: false,
        failed: false,
        deliveryTerminal: true,
      },
      pollingStop: "COMPLETE",
    });
    expect(completedPoll.headers["retry-after"]).toBeUndefined();

    // 13. Clinical feedback against the stored result.
    const feedbackResponse = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: doctorHeaders,
      payload: {
        consultation_id: consultationId,
        inference_id: inferenceId,
        validated_class: 2,
        is_gold_standard: true,
        doctor_notes: "E2E validated",
      },
    });
    expect(feedbackResponse.statusCode).toBe(200);
    expect(feedbackResponse.json()).toMatchObject({
      consultation_id: consultationId,
      inference_id: inferenceId,
      validated_class: 2,
      predicted_class: 2,
      agreement: true,
      is_gold_standard: true,
    });

    // 14. Explicit export grant, then gold-standard export as ADMIN.
    await prisma.inferenceAccessGrant.create({
      data: {
        inferenceId,
        consultationId,
        recipientUserId: admin.id,
        approvalReference: `E2E-EXPORT-${randomUUID()}`,
        canExportGoldStandard: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const adminHeaders = authHeaders(adminToken);
    const exportResponse = await app.inject({
      method: "GET",
      url: "/export/gold-standard",
      headers: adminHeaders,
    });
    expect(exportResponse.statusCode).toBe(200);
    const exported = exportResponse.json() as {
      count: number;
      items: Array<Record<string, unknown>>;
    };
    expect(exported.count).toBe(1);
    expect(exported.items[0]).toMatchObject({
      inference_id: inferenceId,
      validated_class: 2,
      predicted_class: 2,
      is_gold_standard: true,
    });

    // 15. Artifact catalog and a fresh signed report URL.
    const artifactsResponse = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}/artifacts`,
      headers: doctorHeaders,
    });
    expect(artifactsResponse.statusCode).toBe(200);
    const artifactList = artifactsResponse.json() as {
      total: number;
      items: Array<{ version: number; reference: { artifactType: string; status: string } }>;
    };
    expect(artifactList.total).toBe(3);
    expect(
      artifactList.items
        .map((item) => item.reference.artifactType)
        .sort(),
    ).toEqual(["mask", "overlay", "pdf"]);
    expect(
      artifactList.items.every((item) => item.reference.status === "AVAILABLE"),
    ).toBe(true);

    const reportsResponse = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}/reports`,
      headers: doctorHeaders,
    });
    expect(reportsResponse.statusCode).toBe(200);
    expect(reportsResponse.json()).toEqual([
      expect.objectContaining({
        inferenceId,
        version: 1,
        status: "AVAILABLE",
        immutable: true,
        failureCode: null,
      }),
    ]);

    const reportUrlResponse = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}/reports/1/url`,
      headers: doctorHeaders,
    });
    expect(reportUrlResponse.statusCode).toBe(200);
    expect(reportUrlResponse.json()).toMatchObject({
      artifactType: "pdf",
      status: "AVAILABLE",
      url: "https://signed.example/artifact",
      expiresInSeconds: 3600,
      contentType: "application/pdf",
      reportVersion: 1,
    });

    const maskUrlResponse = await app.inject({
      method: "GET",
      url: `/inferences/${inferenceId}/artifacts/mask/url?version=1`,
      headers: doctorHeaders,
    });
    expect(maskUrlResponse.statusCode).toBe(200);
    expect(maskUrlResponse.json()).toMatchObject({
      artifactType: "mask",
      status: "AVAILABLE",
      url: "https://signed.example/artifact",
      expiresInSeconds: 3600,
      contentType: "image/png",
      reportVersion: null,
    });

    // The persisted subscription still belongs to the provisioned doctor.
    const storedInference = await prisma.inference.findUniqueOrThrow({
      where: { id: inferenceId },
    });
    expect(storedInference.consultationId).toBe(consultationId);
    expect(storedInference.modelVersion).toBe(FAKE_MANIFEST_VERSION);
    expect(doctorId).toBe(
      (
        await prisma.consultation.findUniqueOrThrow({
          where: { id: consultationId },
          select: { doctorId: true },
        })
      ).doctorId,
    );
  });
});
