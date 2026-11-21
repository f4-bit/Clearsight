import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
import { buildIdempotencyPayloadHash } from "../src/services/idempotency.js";
import type { SafePrincipal } from "../src/services/session.js";
import { StorageService } from "../src/services/storage.js";
import { enqueueInference } from "../src/workers/inference.queue.js";
import { createIdempotencyRepository } from "../src/repositories/idempotency.repo.js";
import { FEATURES } from "./fixtures/clinical.js";
import { bearer, buildTestApp } from "./helpers/app.js";
import {
  createTestPrisma,
  makeSession,
  makeUser,
  resetDb,
} from "./helpers/db.js";
import {
  createFakeMlClient,
  FAKE_FINGERPRINT,
  FAKE_MANIFEST_VERSION,
  FAKE_SCHEMA_VERSION,
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
  vi.mocked(StorageService.getMlDownloadUrl).mockResolvedValue(
    "http://minio:9000/retina.jpg",
  );
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

function countingMlClient() {
  let calls = 0;
  const client = createFakeMlClient(async (payload) => {
    calls += 1;
    return makePreparedSnapshot(payload.clinical_features);
  });
  return { client, calls: () => calls };
}

async function makeCase(doctorId: string, eyeSide: "OD" | "OS" = "OD") {
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
      eyeSide,
      storagePath: `2026/10/${randomUUID()}.jpg`,
    },
  });
  return { patient, consultation, image };
}

function post(
  target: FastifyInstance,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
  authHeaders: Record<string, string> = headers,
) {
  return target.inject({
    method: "POST",
    url: "/inferences",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    payload: { clinicalFeatures: FEATURES, ...payload },
  });
}

function postWithoutKey(
  target: FastifyInstance,
  payload: Record<string, unknown>,
  authHeaders: Record<string, string> = headers,
) {
  return target.inject({
    method: "POST",
    url: "/inferences",
    headers: { ...authHeaders, "content-type": "application/json" },
    payload: { clinicalFeatures: FEATURES, ...payload },
  });
}

async function counts() {
  return {
    inferences: await prisma.inference.count(),
    snapshots: await prisma.clinicalSnapshot.count(),
    records: await prisma.idempotencyRecord.count(),
  };
}

/**
 * Seeds a PENDING idempotent create whose pinned snapshot is corrupt in one
 * dimension (missing context pin or drifted model versions) while the payload
 * hash still matches the request, so the resume reaches the durable
 * consistency checks instead of a 409.
 */
async function seedCorruptPending(
  study: Awaited<ReturnType<typeof makeCase>>,
  key: string,
  corrupt: "missing-pin" | "model-drift",
) {
  const prepared = makePreparedSnapshot(FEATURES);
  const { contextFingerprintSha256: _pin, ...withoutPin } =
    prepared.normalizedPayload;
  const normalizedPayload = {
    ...(corrupt === "missing-pin" ? withoutPin : prepared.normalizedPayload),
    eyeSide: "OD",
  };
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: study.consultation.id,
      rawPayload: {
        eyeSide: "OD",
        clinicalFeatures: { ...FEATURES },
      } as Prisma.InputJsonValue,
      normalizedPayload: normalizedPayload as Prisma.InputJsonValue,
      schemaVersion: prepared.schemaVersion,
      modelVersions: (
        corrupt === "model-drift"
          ? { ...prepared.modelVersions, manifest: "2026-01-01-drifted" }
          : prepared.modelVersions
      ) as Prisma.InputJsonValue,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: study.image.id,
      consultationId: study.consultation.id,
      eyeSide: "OD",
      snapshotId: snapshot.id,
      status: "QUEUED",
      modelVersion: prepared.modelVersions.manifest,
    },
  });
  await prisma.idempotencyRecord.create({
    data: {
      actorUserId: doctor.id,
      scope: "inferences:create:v1",
      key,
      payloadHash: buildIdempotencyPayloadHash({
        imageId: study.image.id,
        eyeSide: "OD",
        clinicalFeatures: FEATURES,
      }),
      inferenceId: inference.id,
      resolvedModelVersions: prepared.modelVersions,
      state: "PENDING",
    },
  });
  return { inference, snapshot };
}

describe("POST /inferences idempotency header validation", () => {
  it("rejects a missing or malformed header before ML, DB, signing or queue", async () => {
    const study = await makeCase(doctor.id);
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const missing = await postWithoutKey(target, {
      imageId: study.image.id,
      eyeSide: "OD",
    });
    expect(missing.statusCode).toBe(400);

    for (const key of ["", "   ", "a,b", "a b", "a".repeat(129)]) {
      const response = await post(
        target,
        { imageId: study.image.id, eyeSide: "OD" },
        key,
      );
      expect(response.statusCode).toBe(400);
    }

    expect(ml.calls()).toBe(0);
    expect(await counts()).toEqual({ inferences: 0, snapshots: 0, records: 0 });
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    await target.close();
  });

  it("keeps 401/403 before the missing-header 400", async () => {
    const study = await makeCase(doctor.id);
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const researcherHeaders = await bearer(app, prisma, researcher);
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const unauthenticated = await postWithoutKey(
      target,
      { imageId: study.image.id, eyeSide: "OD" },
      {},
    );
    expect(unauthenticated.statusCode).toBe(401);

    const wrongRole = await postWithoutKey(
      target,
      { imageId: study.image.id, eyeSide: "OD" },
      researcherHeaders,
    );
    expect(wrongRole.statusCode).toBe(403);

    expect(ml.calls()).toBe(0);
    expect(await counts()).toEqual({ inferences: 0, snapshots: 0, records: 0 });
    await target.close();
  });
});

describe("POST /inferences idempotent replay", () => {
  it("replays the same strict 202 without prepare, signing or queue", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const first = await post(target, payload, key);
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as {
      inferenceId: string;
      jobId: string;
      status: string;
    };
    expect(firstBody.jobId).toBe(firstBody.inferenceId);
    expect(ml.calls()).toBe(1);

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();

    const replay = await post(target, payload, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(ml.calls()).toBe(1);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        actorUserId_scope_key: {
          actorUserId: doctor.id,
          scope: "inferences:create:v1",
          key,
        },
      },
    });
    expect(record.state).toBe("ACCEPTED");
    expect(record.responseStatus).toBe(202);
    expect(record.responseBody).toEqual(firstBody);
    expect(record.acceptedAt!.getTime()).toBeGreaterThanOrEqual(
      record.createdAt.getTime(),
    );
    await target.close();
  });

  it("returns 409 for the same key with a different body before ML", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const first = await post(
      target,
      { imageId: study.image.id, eyeSide: "OD" },
      key,
    );
    expect(first.statusCode).toBe(202);
    expect(ml.calls()).toBe(1);
    const before = await counts();

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();

    const conflict = await post(
      target,
      {
        imageId: study.image.id,
        eyeSide: "OD",
        clinicalFeatures: { ...FEATURES, Age: FEATURES.Age + 1 },
      },
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain(key);
    expect(ml.calls()).toBe(1);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
    await target.close();
  });

  it("serializes concurrent same-key/same-body requests to one execution", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const responses = await Promise.all([
      post(target, payload, key),
      post(target, payload, key),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    const bodies = responses.map(
      (response) =>
        response.json() as {
          inferenceId: string;
          jobId: string;
          status: string;
        },
    );
    expect(new Set(bodies.map((body) => body.inferenceId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.jobId)).size).toBe(1);
    expect(bodies[0]!.jobId).toBe(bodies[0]!.inferenceId);
    expect(ml.calls()).toBeGreaterThanOrEqual(1);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    for (const call of vi.mocked(enqueueInference).mock.calls) {
      expect(call[0]).toMatchObject({
        inferenceId: bodies[0]!.inferenceId,
      });
    }
    await target.close();
  });

  it("serializes concurrent same-key/different-body requests to 202 + 409", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const responses = await Promise.all([
      post(target, { imageId: study.image.id, eyeSide: "OD" }, key),
      post(
        target,
        {
          imageId: study.image.id,
          eyeSide: "OD",
          clinicalFeatures: { ...FEATURES, Age: FEATURES.Age + 2 },
        },
        key,
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      202, 409,
    ]);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(ml.calls()).toBeGreaterThanOrEqual(1);
    await target.close();
  });

  it("isolates the same key across different actors", async () => {
    const studyA = await makeCase(doctor.id);
    const other = await makeUser(prisma, "OFTALMOLOGO");
    const otherHeaders = await bearer(app, prisma, other);
    const studyB = await makeCase(other.id);
    const key = randomUUID();

    const first = await post(
      app,
      { imageId: studyA.image.id, eyeSide: "OD" },
      key,
    );
    const second = await post(
      app,
      { imageId: studyB.image.id, eyeSide: "OD" },
      key,
      otherHeaders,
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(
      (first.json() as { inferenceId: string }).inferenceId,
    ).not.toBe((second.json() as { inferenceId: string }).inferenceId);
    expect(await prisma.idempotencyRecord.count()).toBe(2);
  });
});

describe("POST /inferences idempotent resume", () => {
  it("resumes the same execution after a queue failure without re-preparing", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    vi.mocked(enqueueInference).mockRejectedValueOnce(new Error("redis down"));
    const failed = await post(target, payload, key);
    expect(failed.statusCode).toBe(503);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(ml.calls()).toBe(1);
    const pending = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(pending.state).toBe("PENDING");
    vi.mocked(enqueueInference).mockClear();
    const expectedHash = buildIdempotencyPayloadHash({
      imageId: study.image.id,
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
    expect(pending.payloadHash).toBe(expectedHash);
    const snapshotBefore = await prisma.clinicalSnapshot.findUniqueOrThrow({
      where: {
        id: (
          await prisma.inference.findUniqueOrThrow({
            where: { id: pending.inferenceId },
          })
        ).snapshotId!,
      },
    });

    // A different current ML default must not matter on resume: the saved
    // snapshot/model versions/pin are the authority, and prepare is not called.
    const drifted = await buildTestApp(prisma, {
      mlClient: createFakeMlClient(async () => {
        throw new Error("prepare must not run on resume");
      }),
    });
    const resumed = await post(drifted, payload, key);
    expect(resumed.statusCode).toBe(202);
    const body = resumed.json() as { inferenceId: string; jobId: string };
    expect(body.jobId).toBe(pending.inferenceId);
    expect(body.inferenceId).toBe(pending.inferenceId);
    expect(ml.calls()).toBe(1);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueInference).mock.calls[0]![0]).toMatchObject({
      inferenceId: pending.inferenceId,
      imageId: study.image.id,
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
      modelVersion: FAKE_MANIFEST_VERSION,
      expectedContext: {
        schemaVersion: FAKE_SCHEMA_VERSION,
        fingerprintSha256: FAKE_FINGERPRINT,
      },
    });
    expect(vi.mocked(enqueueInference).mock.calls[0]![0]).not.toHaveProperty(
      "imageUrl",
    );
    const afterResume = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(afterResume.state).toBe("ACCEPTED");
    expect(afterResume.payloadHash).toBe(expectedHash);
    const snapshotAfter = await prisma.clinicalSnapshot.findUniqueOrThrow({
      where: { id: snapshotBefore.id },
    });
    expect(snapshotAfter).toEqual(snapshotBefore);
    await drifted.close();
    await target.close();
  });

  it("resumes after queue failure with the same job id", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    vi.mocked(enqueueInference).mockRejectedValueOnce(new Error("redis down"));
    const failed = await post(target, payload, key);
    expect(failed.statusCode).toBe(503);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(ml.calls()).toBe(1);

    vi.mocked(enqueueInference).mockClear();
    const resumed = await post(target, payload, key);
    expect(resumed.statusCode).toBe(202);
    const body = resumed.json() as { inferenceId: string };
    expect(ml.calls()).toBe(1);
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(enqueueInference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueInference).mock.calls[0]![0]).toMatchObject({
      inferenceId: body.inferenceId,
    });
    await target.close();
  });

  it("leaves PENDING when mark-accepted fails and resumes on retry", async () => {
    const study = await makeCase(doctor.id);
    const session = await makeSession(prisma, doctor);
    const principal: SafePrincipal = {
      id: doctor.id,
      email: doctor.email,
      role: doctor.role,
      sessionId: session.id,
      tokenVersion: doctor.tokenVersion,
    };
    const key = randomUUID();
    let failMark = true;
    let enqueues = 0;
    const access = createClinicalAccessService(prisma);
    const service = createInferenceCreationService({
      prisma,
      access,
      authService: { verifySession: async () => principal },
      mlClient: createFakeMlClient(),
      enqueue: async () => {
        enqueues += 1;
        return { id: "mock-job-id" };
      },
      idempotencyRepositoryFactory: (db, options) => {
        const repository = createIdempotencyRepository(db, options);
        return {
          ...repository,
          markAccepted: async (id, body) => {
            if (failMark) {
              failMark = false;
              throw new Error("forced mark failure");
            }
            return repository.markAccepted(id, body);
          },
        };
      },
    });
    const input = {
      subject: { id: doctor.id, role: doctor.role },
      claims: {
        sub: doctor.id,
        role: doctor.role,
        sessionId: session.id,
        tokenVersion: doctor.tokenVersion,
      },
      idempotencyKey: key,
      imageId: study.image.id,
      eyeSide: "OD" as const,
      clinicalFeatures: FEATURES,
    };

    await expect(service.create(input)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("PENDING");
    expect(enqueues).toBe(1);

    const resumed = await service.create(input);
    expect(resumed.status).toBe("QUEUED");
    expect(enqueues).toBe(2);
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("ACCEPTED");
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
  });

  it("marks a terminal PENDING record accepted without enqueueing", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const target = await buildTestApp(prisma);

    vi.mocked(enqueueInference).mockRejectedValueOnce(new Error("redis down"));
    const failed = await post(target, payload, key);
    expect(failed.statusCode).toBe(503);
    const record = await prisma.idempotencyRecord.findFirstOrThrow();
    await prisma.inference.update({
      where: { id: record.inferenceId },
      data: { status: "COMPLETED" },
    });

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();
    const resumed = await post(target, payload, key);
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({
      inferenceId: record.inferenceId,
      jobId: record.inferenceId,
      status: "QUEUED",
    });
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("ACCEPTED");
    await target.close();
  });

  it("fails safe when a PENDING record has no snapshot, without re-preparing", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });

    const inference = await prisma.inference.create({
      data: {
        imageId: study.image.id,
        consultationId: study.consultation.id,
        eyeSide: "OD",
        status: "QUEUED",
      },
    });
    await prisma.idempotencyRecord.create({
      data: {
        actorUserId: doctor.id,
        scope: "inferences:create:v1",
        key,
        payloadHash: buildIdempotencyPayloadHash({
          imageId: study.image.id,
          eyeSide: "OD",
          clinicalFeatures: FEATURES,
        }),
        inferenceId: inference.id,
        resolvedModelVersions: {},
        state: "PENDING",
      },
    });

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();
    const resumed = await post(target, payload, key);
    expect(resumed.statusCode).toBe(503);
    expect(ml.calls()).toBe(0);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("PENDING");
    await target.close();
  });

  it("fails safe when the pending snapshot lost its context pin, without re-preparing", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });
    await seedCorruptPending(study, key, "missing-pin");

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();
    const resumed = await post(target, payload, key);
    expect(resumed.statusCode).toBe(503);
    expect(resumed.body).not.toContain("http");
    expect(ml.calls()).toBe(0);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("PENDING");
    await target.close();
  });

  it("fails safe when the pinned model versions drift from the record, without re-preparing", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const ml = countingMlClient();
    const target = await buildTestApp(prisma, { mlClient: ml.client });
    await seedCorruptPending(study, key, "model-drift");

    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(enqueueInference).mockClear();
    const resumed = await post(target, payload, key);
    expect(resumed.statusCode).toBe(503);
    expect(resumed.body).not.toContain("http");
    expect(ml.calls()).toBe(0);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
    expect(
      (await prisma.idempotencyRecord.findFirstOrThrow()).state,
    ).toBe("PENDING");
    await target.close();
  });
});

describe("POST /inferences accepted replay and revocation", () => {
  it("returns the stored 202 even when ML, storage and queue are down", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const first = await post(app, payload, key);
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    const failingMl = createFakeMlClient(async () => {
      throw new Error("ML must not be called on accepted replay");
    });
    const target = await buildTestApp(prisma, { mlClient: failingMl });
    vi.mocked(StorageService.getMlDownloadUrl).mockClear();
    vi.mocked(StorageService.getMlDownloadUrl).mockRejectedValue(
      new Error("storage down"),
    );
    vi.mocked(enqueueInference).mockClear();
    vi.mocked(enqueueInference).mockRejectedValue(new Error("queue down"));

    const replay = await post(target, payload, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();
    expect(enqueueInference).not.toHaveBeenCalled();
    await target.close();
  });

  it("rejects a replay after the session is revoked without leaking the record", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const first = await post(app, payload, key);
    expect(first.statusCode).toBe(202);

    await prisma.userSession.updateMany({
      where: { userId: doctor.id, revokedAt: null },
      data: { revokedAt: new Date(), reasonCode: "QA_REVOKED" },
    });

    const replay = await post(app, payload, key);
    expect(replay.statusCode).toBe(401);
    expect(replay.body).not.toContain(
      (first.json() as { inferenceId: string }).inferenceId,
    );
    expect(await counts()).toEqual({ inferences: 1, snapshots: 1, records: 1 });
  });
});

describe("POST /inferences canonical reanalysis idempotency", () => {
  it("uses the parent in the hash and does not mutate a frozen consultation", async () => {
    const study = await makeCase(doctor.id);
    const parent = await prisma.inference.create({
      data: {
        imageId: study.image.id,
        consultationId: study.consultation.id,
        eyeSide: "OD",
        status: "COMPLETED",
      },
    });
    const otherParent = await prisma.inference.create({
      data: {
        imageId: study.image.id,
        consultationId: study.consultation.id,
        eyeSide: "OD",
        status: "COMPLETED",
      },
    });
    const imageOne = await prisma.image.create({
      data: {
        consultationId: study.consultation.id,
        eyeSide: "OD",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });
    const imageTwo = await prisma.image.create({
      data: {
        consultationId: study.consultation.id,
        eyeSide: "OD",
        storagePath: `2026/10/${randomUUID()}.jpg`,
      },
    });
    await prisma.consultation.update({
      where: { id: study.consultation.id },
      data: {
        requiredExecutionIds: [parent.id],
        requiredSetVersion: "required-v1",
        requiredSetFrozenAt: new Date(),
      },
    });
    const key = randomUUID();

    const first = await post(
      app,
      {
        imageId: imageOne.id,
        eyeSide: "OD",
        reanalysisOf: parent.id,
      },
      key,
    );
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { inferenceId: string };

    const changedParent = await post(
      app,
      {
        imageId: imageOne.id,
        eyeSide: "OD",
        reanalysisOf: otherParent.id,
      },
      key,
    );
    expect(changedParent.statusCode).toBe(409);
    expect(
      await prisma.inference.count({ where: { reanalysisOfId: parent.id } }),
    ).toBe(1);

    const second = await post(
      app,
      {
        imageId: imageTwo.id,
        eyeSide: "OD",
        reanalysisOf: parent.id,
      },
      randomUUID(),
    );
    expect(second.statusCode).toBe(202);
    expect(
      (second.json() as { inferenceId: string }).inferenceId,
    ).not.toBe(firstBody.inferenceId);
    expect(
      await prisma.inference.count({ where: { reanalysisOfId: parent.id } }),
    ).toBe(2);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: study.consultation.id },
    });
    expect(consultation.status).toBe("COMPLETED");
    expect(consultation.requiredExecutionIds).toEqual([parent.id]);
    expect(consultation.requiredSetVersion).toBe("required-v1");
    expect(consultation.requiredSetFrozenAt).not.toBeNull();
    const parentAfter = await prisma.inference.findUniqueOrThrow({
      where: { id: parent.id },
    });
    expect(parentAfter.snapshotId).toBeNull();
    expect(parentAfter.status).toBe("COMPLETED");
  });
});

describe("idempotency SQL schema binding under search_path decoys", () => {
  const decoySchema = "qa_idem_decoy";

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${decoySchema}" CASCADE`,
    );
  });

  it("keeps the conditional ACCEPTED update immune to a decoy idempotency_records table", async () => {
    const study = await makeCase(doctor.id);
    const key = randomUUID();
    const payload = { imageId: study.image.id, eyeSide: "OD" };
    const target = await buildTestApp(prisma);

    vi.mocked(enqueueInference).mockRejectedValueOnce(new Error("redis down"));
    const failed = await post(target, payload, key);
    expect(failed.statusCode).toBe(503);
    const pending = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(pending.state).toBe("PENDING");

    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${decoySchema}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${decoySchema}"."idempotency_records" (LIKE public.idempotency_records INCLUDING DEFAULTS)`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${decoySchema}"."raise_decoy"() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''DECOY HIT''; END'`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER decoy_guard BEFORE INSERT OR UPDATE ON "${decoySchema}"."idempotency_records" FOR EACH ROW EXECUTE FUNCTION "${decoySchema}"."raise_decoy"()`,
    );
    // The trap is armed: an explicit decoy write must raise.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${decoySchema}"."idempotency_records" DEFAULT VALUES`,
      ),
    ).rejects.toThrow(/DECOY HIT/);

    const responseBody = {
      inferenceId: pending.inferenceId,
      jobId: pending.inferenceId,
      status: "QUEUED" as const,
    };
    const affected = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL search_path TO "${decoySchema}", public`,
      );
      const repo = createIdempotencyRepository(tx, {
        databaseSchema: "public",
      });
      return repo.markAccepted(pending.id, responseBody);
    });
    expect(affected).toBe(1);

    const accepted = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(accepted.state).toBe("ACCEPTED");
    expect(accepted.responseStatus).toBe(202);
    expect(accepted.responseBody).toEqual(responseBody);
    expect(accepted.acceptedAt!.getTime()).toBeGreaterThanOrEqual(
      accepted.createdAt.getTime(),
    );
    const decoyRows = await prisma.$queryRawUnsafe<
      Array<{ count: number }>
    >(
      `SELECT count(*)::int AS count FROM "${decoySchema}"."idempotency_records"`,
    );
    expect(decoyRows).toEqual([{ count: 0 }]);
    await target.close();
  });

  it("binds the advisory xact lock to purpose, schema, actor, scope and key", async () => {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${decoySchema}"`);
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${decoySchema}"."pg_advisory_xact_lock"(integer, integer) RETURNS void LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''DECOY HIT''; END'`,
    );
    // The trap is armed: the decoy overload raises when called explicitly.
    await expect(
      prisma.$queryRawUnsafe(
        `SELECT "${decoySchema}"."pg_advisory_xact_lock"(1, 2)`,
      ),
    ).rejects.toThrow(/DECOY HIT/);

    const clientA = createTestPrisma();
    const clientB = createTestPrisma();
    const scope = "inferences:create:v1";
    const lockKey = randomUUID();
    const otherKey = randomUUID();
    let releaseA!: () => void;
    const aHolds = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aReady!: () => void;
    const readyA = new Promise<void>((resolve) => {
      aReady = resolve;
    });

    try {
      const txA = clientA.$transaction(
        async (tx) => {
          const repo = createIdempotencyRepository(tx, {
            databaseSchema: "public",
          });
          await repo.lock(doctor.id, scope, lockKey);
          aReady();
          await aHolds;
        },
        { timeout: 30_000 },
      );
      await readyA;

      // The same binding blocks a concurrent transaction until it times out.
      await expect(
        clientB.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500'");
            const repo = createIdempotencyRepository(tx, {
              databaseSchema: "public",
            });
            await repo.lock(doctor.id, scope, lockKey);
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow(/timeout|cancel|57014/i);

      // A different key is a different binding: it acquires while A holds its
      // lock, and the decoy pg_advisory_xact_lock overload cannot shadow the
      // catalog function.
      await clientB.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${decoySchema}", public`,
          );
          const repo = createIdempotencyRepository(tx, {
            databaseSchema: "public",
          });
          await repo.lock(doctor.id, scope, otherKey);
        },
        { timeout: 30_000 },
      );

      releaseA();
      await txA;

      // The xact lock is released at commit: the same binding now acquires.
      await clientB.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${decoySchema}", public`,
          );
          const repo = createIdempotencyRepository(tx, {
            databaseSchema: "public",
          });
          await repo.lock(doctor.id, scope, lockKey);
        },
        { timeout: 30_000 },
      );
    } finally {
      releaseA();
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });
});
