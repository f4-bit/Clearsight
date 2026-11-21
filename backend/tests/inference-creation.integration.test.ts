import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn(),
    getDownloadUrl: vi.fn(),
    getMlDownloadUrl: vi.fn().mockResolvedValue("http://minio:9000/retina.jpg"),
    getObjectStream: vi.fn(),
    getArtifactReferenceContext: vi.fn(
      (kind: "image" | "gradcam") => ({
        provider: "minio",
        storageId: "minio-local",
        allowedBuckets: ["raw-retinas", "gradcam-overlays"],
        defaultBucket: kind === "image" ? "raw-retinas" : "gradcam-overlays",
      }),
    ),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import type { FastifyInstance } from "fastify";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { createClinicalAccessService } from "../src/services/clinical-access.js";
import { createInferenceCreationService } from "../src/services/inference-creation.js";
import { MlClientHttpError, type ClinicalContextPreparer } from "../src/services/ml-client.js";
import type { SafePrincipal } from "../src/services/session.js";
import { StorageService } from "../src/services/storage.js";
import { enqueueInference } from "../src/workers/inference.queue.js";
import { FEATURES } from "./fixtures/clinical.js";
import { bearer, buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeSession, makeUser, resetDb } from "./helpers/db.js";
import {
  createFakeMlClient,
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "./helpers/ml.js";

const prisma = createTestPrisma();
let app: FastifyInstance;
let doctor: Awaited<ReturnType<typeof makeUser>>;
let headers: { authorization: string };

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

beforeEach(async () => {
  vi.mocked(StorageService.getMlDownloadUrl).mockClear();
  vi.mocked(StorageService.getMlDownloadUrl).mockResolvedValue("http://minio:9000/retina.jpg");
  vi.mocked(enqueueInference).mockClear();
  vi.mocked(enqueueInference).mockResolvedValue({ id: "mock-job-id" } as never);

  await resetDb(prisma);
  doctor = await makeUser(prisma, "OFTALMOLOGO");
  headers = await bearer(app, prisma, doctor);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeCase(
  doctorId: string,
  options: { eyeSide?: "OD" | "OS"; clinicalData?: Record<string, unknown>; status?: string } = {},
) {
  const patient = await prisma.patient.create({ data: { ownerDoctorId: doctorId } });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId,
      status: options.status ?? "COMPLETED",
      clinicalData: (options.clinicalData ?? { Age: 999 }) as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: options.eyeSide ?? "OD",
      storagePath: `2026/10/${randomUUID()}.jpg`,
    },
  });
  return { patient, consultation, image };
}

function post(
  target: FastifyInstance,
  payload: Record<string, unknown>,
  authHeaders = headers,
  idempotencyKey = randomUUID(),
) {
  return target.inject({
    method: "POST",
    url: "/inferences",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    payload: { clinicalFeatures: FEATURES, ...payload },
  });
}

async function expectNoExecution(): Promise<void> {
  expect(await prisma.inference.count()).toBe(0);
  expect(await prisma.clinicalSnapshot.count()).toBe(0);
}

async function expectNoExecutionFor(imageId: string): Promise<void> {
  expect(await prisma.inference.count({ where: { imageId } })).toBe(0);
  expect(await prisma.clinicalSnapshot.count()).toBe(0);
}

async function withMlClient<T>(
  mlClient: ClinicalContextPreparer,
  run: (target: FastifyInstance) => Promise<T>,
): Promise<T> {
  const target = await buildTestApp(prisma, { mlClient });
  try {
    return await run(target);
  } finally {
    await target.close();
  }
}

describe("POST /inferences creation (2.2 B)", () => {
  it("creates the exact snapshot and inference in one transaction", async () => {
    const study = await makeCase(doctor.id, {
      clinicalData: { ...FEATURES, Age: 999 },
    });

    const response = await post(app, { imageId: study.image.id, eyeSide: "OD" });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { inferenceId: string; jobId: string; status: string };
    expect(body.status).toBe("QUEUED");
    expect(body.jobId).toBe(body.inferenceId);

    const inference = await prisma.inference.findUniqueOrThrow({
      where: { id: body.inferenceId },
      include: { snapshot: true },
    });
    expect(inference).toMatchObject({
      imageId: study.image.id,
      consultationId: study.consultation.id,
      eyeSide: "OD",
      status: "QUEUED",
      reanalysisOfId: null,
      modelVersion: FAKE_MANIFEST_VERSION,
    });
    expect(inference.snapshotId).not.toBeNull();
    expect(inference.snapshot).not.toBeNull();

    const snapshot = inference.snapshot!;
    expect(snapshot.schemaVersion).toBe("ml-zscore-f32-v1");
    expect(snapshot.rawPayload).toEqual({
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
    expect(snapshot.modelVersions).toEqual(
      makePreparedSnapshot(FEATURES).modelVersions,
    );
    const normalized = snapshot.normalizedPayload as {
      eyeSide: string;
      descriptor: unknown;
      canonicalJson: string;
      contextFingerprintSha256: string;
    };
    expect(normalized.eyeSide).toBe("OD");
    expect(normalized.descriptor).toEqual(
      makePreparedSnapshot(FEATURES).normalizedPayload.descriptor,
    );
    expect(normalized.contextFingerprintSha256).toBe(
      makePreparedSnapshot(FEATURES).contextFingerprintSha256,
    );
    expect(
      createHash("sha256").update(normalized.canonicalJson, "utf8").digest("hex"),
    ).toBe(normalized.contextFingerprintSha256);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: study.consultation.id },
    });
    expect(consultation.status).toBe("COMPLETED");
    expect(consultation.requiredExecutionIds).toEqual([]);
    expect(consultation.requiredSetVersion).toBeNull();
    expect(consultation.requiredSetFrozenAt).toBeNull();

    expect(StorageService.getMlDownloadUrl).toHaveBeenCalledWith(
      "raw-retinas",
      study.image.storagePath,
    );
    expect(enqueueInference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueInference).mock.calls[0]![0]).toMatchObject({
      inferenceId: body.inferenceId,
      imageId: study.image.id,
      eyeSide: "OD",
      modelVersion: FAKE_MANIFEST_VERSION,
      clinicalFeatures: FEATURES,
      expectedContext: {
        schemaVersion: "ml-zscore-f32-v1",
        fingerprintSha256: makePreparedSnapshot(FEATURES).contextFingerprintSha256,
      },
    });
  });

  it("parses a legacy URI before signing and preserves the exact key", async () => {
    const study = await makeCase(doctor.id);
    const exactPath = "s3://raw-retinas/folder/a b%20c#d?e|f.png";
    await prisma.image.update({
      where: { id: study.image.id },
      data: { storagePath: exactPath },
    });

    const response = await post(app, { imageId: study.image.id, eyeSide: "OD" });
    expect(response.statusCode).toBe(202);
    expect(StorageService.getMlDownloadUrl).toHaveBeenCalledWith(
      "raw-retinas",
      "folder/a b%20c#d?e|f.png",
    );
  });

  it("returns safe 503 without signing on a corrupt server reference", async () => {
    const study = await makeCase(doctor.id);
    await prisma.image.update({
      where: { id: study.image.id },
      data: { storagePath: "https://secret.example/retina.jpg" },
    });

    const response = await post(app, { imageId: study.image.id, eyeSide: "OD" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret.example");
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    // 4.6 owns post-commit dispatch recovery; 3.3 does not claim rollback.
    expect(
      await prisma.inference.count({
        where: { imageId: study.image.id, status: "QUEUED" },
      }),
    ).toBe(1);
  });

  it("uses request clinicalFeatures, never mutable consultation clinicalData", async () => {
    const study = await makeCase(doctor.id, {
      clinicalData: { ...FEATURES, Age: 999 },
    });

    const response = await post(app, { imageId: study.image.id, eyeSide: "OD" });
    expect(response.statusCode).toBe(202);
    const inference = await prisma.inference.findFirstOrThrow({
      include: { snapshot: true },
    });
    expect(inference.snapshot!.rawPayload).toEqual({
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
  });

  it("returns safe 503 without DB effects on timeout or invalid upstream", async () => {
    const study = await makeCase(doctor.id);

    for (const mlClient of [
      createFakeMlClient(async () => {
        throw new Error("timeout");
      }),
      createFakeMlClient(async () => ({})),
    ]) {
      await withMlClient(mlClient, async (target) => {
        const response = await post(target, {
          imageId: study.image.id,
          eyeSide: "OD",
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("timeout");
        await expectNoExecution();
        expect(enqueueInference).not.toHaveBeenCalled();
        expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
      });
    }
  });

  it("maps unknown requested model to 422 and old ML 404/503 without DB effects", async () => {
    const study = await makeCase(doctor.id);

    await withMlClient(
      createFakeMlClient(async () => {
        throw new MlClientHttpError(422);
      }),
      async (target) => {
        const response = await post(target, {
          imageId: study.image.id,
          eyeSide: "OD",
          modelVersion: "unknown",
        });
        expect(response.statusCode).toBe(422);
        await expectNoExecution();
      },
    );

    for (const status of [404, 503]) {
      await withMlClient(
        createFakeMlClient(async () => {
          throw new MlClientHttpError(status);
        }),
        async (target) => {
          const response = await post(target, {
            imageId: study.image.id,
            eyeSide: "OD",
          });
          expect(response.statusCode).toBe(503);
          await expectNoExecution();
        },
      );
    }
  });

  it("maps a float32-overflow input rejected by ML to safe 422 without DB or queue", async () => {
    const study = await makeCase(doctor.id);

    await withMlClient(
      createFakeMlClient(async () => {
        throw new MlClientHttpError(422);
      }),
      async (target) => {
        const response = await post(target, {
          imageId: study.image.id,
          eyeSide: "OD",
          clinicalFeatures: { ...FEATURES, Pachymetry: 1e300 },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json().message).toBe("Clinical snapshot input is not accepted");
        expect(response.body).not.toContain("1e300");
        await expectNoExecution();
        expect(enqueueInference).not.toHaveBeenCalled();
        expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects an altered raw canonical response and a broken descriptor", async () => {
    const study = await makeCase(doctor.id);

    await withMlClient(
      createFakeMlClient(async () => {
        const prepared = makePreparedSnapshot(FEATURES);
        prepared.rawCanonical.clinicalFeatures = {
          ...prepared.rawCanonical.clinicalFeatures,
          Age: FEATURES.Age + 1,
        };
        return prepared;
      }),
      async (target) => {
        expect(
          (await post(target, { imageId: study.image.id, eyeSide: "OD" })).statusCode,
        ).toBe(503);
        await expectNoExecution();
      },
    );

    await withMlClient(
      createFakeMlClient(async () => {
        const prepared = makePreparedSnapshot(FEATURES);
        prepared.normalizedPayload.canonicalJson = "{}";
        return prepared;
      }),
      async (target) => {
        expect(
          (await post(target, { imageId: study.image.id, eyeSide: "OD" })).statusCode,
        ).toBe(503);
        await expectNoExecution();
      },
    );
  });

  it("rejects foreign parents uniformly before ML and mismatched context with 422", async () => {
    const own = await makeCase(doctor.id);
    const otherDoctor = await makeUser(prisma, "OFTALMOLOGO");
    const foreign = await makeCase(otherDoctor.id);
    const foreignParent = await prisma.inference.create({
      data: { imageId: foreign.image.id, consultationId: foreign.consultation.id, eyeSide: "OD" },
    });

    const prepare = vi.fn(async () => makePreparedSnapshot(FEATURES));
    await withMlClient({ prepareClinicalSnapshot: prepare }, async (target) => {
      const foreignResponse = await post(target, {
        imageId: own.image.id,
        eyeSide: "OD",
        reanalysisOf: foreignParent.id,
      });
      expect(foreignResponse.statusCode).toBe(404);
      expect(prepare).not.toHaveBeenCalled();
      const missingResponse = await post(target, {
        imageId: own.image.id,
        eyeSide: "OD",
        reanalysisOf: randomUUID(),
      });
      expect(missingResponse.statusCode).toBe(404);
      expect(prepare).not.toHaveBeenCalled();
      await expectNoExecutionFor(own.image.id);
    });

    prepare.mockClear();
    const parent = await prisma.inference.create({
      data: { imageId: own.image.id, consultationId: own.consultation.id, eyeSide: "OD" },
    });
    const otherCase = await makeCase(doctor.id, { eyeSide: "OD" });
    await withMlClient({ prepareClinicalSnapshot: prepare }, async (target) => {
      const mismatch = await post(target, {
        imageId: otherCase.image.id,
        eyeSide: "OD",
        reanalysisOf: parent.id,
      });
      expect(mismatch.statusCode).toBe(422);
      expect(prepare).not.toHaveBeenCalled();
      await expectNoExecutionFor(otherCase.image.id);
    });

    const osImage = await prisma.image.create({
      data: {
        consultationId: own.consultation.id,
        eyeSide: "OS",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });
    const osParent = await prisma.inference.create({
      data: {
        imageId: osImage.id,
        consultationId: own.consultation.id,
        eyeSide: "OS",
      },
    });
    const odChild = await prisma.image.create({
      data: {
        consultationId: own.consultation.id,
        eyeSide: "OD",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });
    prepare.mockClear();
    await withMlClient({ prepareClinicalSnapshot: prepare }, async (target) => {
      const eyeMismatch = await post(target, {
        imageId: odChild.id,
        eyeSide: "OD",
        reanalysisOf: osParent.id,
      });
      expect(eyeMismatch.statusCode).toBe(422);
      expect(prepare).not.toHaveBeenCalled();
      await expectNoExecutionFor(odChild.id);
    });
  });

  it("allows a new-image reanalysis of a legacy parent without overwriting it", async () => {
    const study = await makeCase(doctor.id);
    const parent = await prisma.inference.create({ data: { imageId: study.image.id } });
    const newImage = await prisma.image.create({
      data: {
        consultationId: study.consultation.id,
        eyeSide: "OD",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });

    const response = await post(app, {
      imageId: newImage.id,
      eyeSide: "OD",
      reanalysisOf: parent.id,
    });
    expect(response.statusCode).toBe(202);
    const child = await prisma.inference.findUniqueOrThrow({
      where: { id: (response.json() as { inferenceId: string }).inferenceId },
    });
    expect(child.reanalysisOfId).toBe(parent.id);
    expect(child.snapshotId).not.toBeNull();
    const unchangedParent = await prisma.inference.findUniqueOrThrow({
      where: { id: parent.id },
    });
    expect(unchangedParent.snapshotId).toBeNull();
    expect(unchangedParent.status).toBeNull();
  });

  it("does not mutate a frozen consultation or its required selection", async () => {
    const study = await makeCase(doctor.id);
    const parent = await prisma.inference.create({
      data: {
        imageId: study.image.id,
        consultationId: study.consultation.id,
        eyeSide: "OD",
      },
    });
    const frozenAt = new Date();
    await prisma.consultation.update({
      where: { id: study.consultation.id },
      data: {
        requiredExecutionIds: [parent.id],
        requiredSetVersion: "required-v1",
        requiredSetFrozenAt: frozenAt,
      },
    });
    const newImage = await prisma.image.create({
      data: {
        consultationId: study.consultation.id,
        eyeSide: "OD",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });

    const response = await post(app, {
      imageId: newImage.id,
      eyeSide: "OD",
      reanalysisOf: parent.id,
    });
    expect(response.statusCode).toBe(202);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: study.consultation.id },
    });
    expect(consultation.status).toBe("COMPLETED");
    expect(consultation.requiredExecutionIds).toEqual([parent.id]);
    expect(consultation.requiredSetVersion).toBe("required-v1");
    expect(consultation.requiredSetFrozenAt?.getTime()).toBe(frozenAt.getTime());
    const parentAfter = await prisma.inference.findUniqueOrThrow({
      where: { id: parent.id },
    });
    expect(parentAfter.status).toBeNull();
    expect(parentAfter.snapshotId).toBeNull();
  });

  it("serializes concurrent reanalyses without deadlock and preserves the parent", async () => {
    const study = await makeCase(doctor.id);
    const parent = await prisma.inference.create({
      data: {
        imageId: study.image.id,
        consultationId: study.consultation.id,
        eyeSide: "OD",
      },
    });
    const images = await Promise.all(
      [0, 1].map(() =>
        prisma.image.create({
          data: {
            consultationId: study.consultation.id,
            eyeSide: "OD",
            storagePath: `2026/10/${randomUUID()}.jpg`,
          },
        }),
      ),
    );

    const responses = await Promise.all(
      images.map((image) =>
        post(app, { imageId: image.id, eyeSide: "OD", reanalysisOf: parent.id }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(await prisma.clinicalSnapshot.count()).toBe(2);
    expect(await prisma.inference.count()).toBe(3);
    const parentAfter = await prisma.inference.findUniqueOrThrow({
      where: { id: parent.id },
    });
    expect(parentAfter.status).toBeNull();
    expect(parentAfter.snapshotId).toBeNull();
  });

  it("keeps a durable QUEUED row when signing or enqueue fails after commit", async () => {
    const study = await makeCase(doctor.id);

    vi.mocked(StorageService.getMlDownloadUrl).mockRejectedValueOnce(
      new Error("storage down"),
    );
    const storageFailure = await post(app, {
      imageId: study.image.id,
      eyeSide: "OD",
    });
    expect(storageFailure.statusCode).toBe(503);
    expect(await prisma.inference.count()).toBe(1);
    expect(await prisma.clinicalSnapshot.count()).toBe(1);
    const queued = await prisma.inference.findFirstOrThrow();
    expect(queued.status).toBe("QUEUED");
    expect(queued.jobId).toBeNull();
    expect(enqueueInference).not.toHaveBeenCalled();

    await resetDb(prisma);
    doctor = await makeUser(prisma, "OFTALMOLOGO");
    headers = await bearer(app, prisma, doctor);
    const second = await makeCase(doctor.id);
    vi.mocked(enqueueInference).mockRejectedValueOnce(new Error("redis down"));
    const queueFailure = await post(app, {
      imageId: second.image.id,
      eyeSide: "OD",
    });
    expect(queueFailure.statusCode).toBe(503);
    expect(await prisma.inference.count()).toBe(1);
    expect(await prisma.clinicalSnapshot.count()).toBe(1);
    expect((await prisma.inference.findFirstOrThrow()).status).toBe("QUEUED");
  });

  it("rolls back snapshot+inference with a real transaction fault", async () => {
    const study = await makeCase(doctor.id);
    const session = await makeSession(prisma, doctor);
    const principal: SafePrincipal = {
      id: doctor.id,
      email: doctor.email,
      role: doctor.role,
      sessionId: session.id,
      tokenVersion: doctor.tokenVersion,
    };
    const access = createClinicalAccessService(prisma);
    const wrappedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") {
          return Reflect.get(target, property, target);
        }
        return async <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
        ) =>
          target.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty !== "inference") {
                    return Reflect.get(txTarget, txProperty, txTarget);
                  }
                  return new Proxy(txTarget.inference, {
                    get(model, method) {
                      if (method !== "create") {
                        return Reflect.get(model, method, model);
                      }
                      return async (...args: unknown[]) => {
                        await (
                          model.create as (
                            ...callArgs: unknown[]
                          ) => Promise<unknown>
                        )(...args);
                        throw new Error("forced inference failure");
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    }) as unknown as PrismaClient;

    const service = createInferenceCreationService({
      prisma: wrappedPrisma,
      access,
      authService: { verifySession: async () => principal },
      mlClient: createFakeMlClient(),
      signMlDownloadUrl: async () => "http://minio:9000/retina.jpg",
      enqueue: async () => ({ id: "mock-job-id" }),
      now: () => new Date(),
    });

    await expect(
      service.create({
        subject: { id: doctor.id, role: doctor.role },
        claims: {
          sub: doctor.id,
          role: doctor.role,
          sessionId: session.id,
          tokenVersion: doctor.tokenVersion,
        },
        idempotencyKey: randomUUID(),
        imageId: study.image.id,
        eyeSide: "OD",
        clinicalFeatures: FEATURES,
      }),
    ).rejects.toThrow("forced inference failure");

    expect(await prisma.inference.count()).toBe(0);
    expect(await prisma.clinicalSnapshot.count()).toBe(0);
  });

  it("revalidates the acting session after prepare and aborts if it was revoked", async () => {
    const study = await makeCase(doctor.id);
    const revoking = createFakeMlClient(async (payload) => {
      // The actor loses their session while the slow ML prepare is in flight.
      await prisma.userSession.updateMany({
        where: { userId: doctor.id, revokedAt: null },
        data: { revokedAt: new Date(), reasonCode: "QA_REVOKED_MID_PREPARE" },
      });
      return makePreparedSnapshot(payload.clinical_features);
    });

    await withMlClient(revoking, async (target) => {
      const response = await post(target, {
        imageId: study.image.id,
        eyeSide: "OD",
      });
      expect(response.statusCode).toBe(401);
      await expectNoExecution();
      expect(enqueueInference).not.toHaveBeenCalled();
      expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
