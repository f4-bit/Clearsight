import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "../src/generated/prisma/client.js";
import type { JobResponse } from "../src/schemas/inference.js";
import { createInferenceRunRepository } from "../src/repositories/inference-run.repo.js";
import type { MlClient } from "../src/services/ml-client.js";
import { FEATURES } from "./fixtures/clinical.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "./helpers/ml.js";
import { createInferenceProcessor } from "../src/workers/inference.processor.js";
import type { InferenceJobData } from "../src/workers/inference.contracts.js";

const prisma = createTestPrisma();
const prepared = makePreparedSnapshot(FEATURES);

beforeEach(async () => {
  await resetDb(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createExecution(options: {
  frozen?: boolean;
  status?: string;
  eyeSide?: "OD" | "OS";
} = {}) {
  const doctor = await makeUser(prisma, "OFTALMOLOGO");
  const patient = await prisma.patient.create({
    data: { ownerDoctorId: doctor.id },
  });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      status: "COMPLETED",
      clinicalData: { ...FEATURES, Age: 999 } as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: options.eyeSide ?? "OD",
      storagePath: "2026/10/image.jpg",
    },
  });
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: consultation.id,
      rawPayload: {
        eyeSide: options.eyeSide ?? "OD",
        clinicalFeatures: FEATURES,
      } as Prisma.InputJsonValue,
      normalizedPayload: {
        ...prepared.normalizedPayload,
        eyeSide: options.eyeSide ?? "OD",
      } as Prisma.InputJsonValue,
      schemaVersion: "ml-zscore-f32-v1",
      modelVersions: prepared.modelVersions as Prisma.InputJsonValue,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide: options.eyeSide ?? "OD",
      snapshotId: snapshot.id,
      status: options.status ?? "QUEUED",
      modelVersion: FAKE_MANIFEST_VERSION,
    },
  });
  if (options.frozen) {
    await prisma.consultation.update({
      where: { id: consultation.id },
      data: {
        requiredExecutionIds: [inference.id],
        requiredSetVersion: "required-v1",
        requiredSetFrozenAt: new Date("2026-11-20T00:00:00.000Z"),
      },
    });
  }
  const job: InferenceJobData = {
    inferenceId: inference.id,
    imageId: image.id,
    imageUrl: "https://ml.test/image.png",
    eyeSide: (options.eyeSide ?? "OD") as "OD" | "OS",
    clinicalFeatures: FEATURES,
    modelVersion: FAKE_MANIFEST_VERSION,
    expectedContext: {
      schemaVersion: "ml-zscore-f32-v1",
      fingerprintSha256: prepared.contextFingerprintSha256,
    },
  };
  return { doctor, consultation, image, snapshot, inference, job };
}

function result(
  execution: { inference: { id: string }; image: { eyeSide: string } },
  overrides: Record<string, unknown> = {},
): NonNullable<JobResponse["result"]> {
  return {
    inferenceId: execution.inference.id,
    eyeSide: execution.image.eyeSide as "OD" | "OS",
    label: "Glaucoma",
    confidence: 0.8,
    probabilities: {
      Glaucoma: 0.8,
      Non_Glaucoma: 0.1,
      Suspicious_Glaucoma: 0.1,
    },
    modelPredictions: {},
    cdr: 0.4,
    cdrVertical: 0.45,
    quality: { review_required: false },
    artifacts: {
      mask: "s3://masks/mask.png",
      overlay: "s3://overlays/overlay.png",
    },
    modelVersions: {
      segmentation: prepared.modelVersions.segmentation,
      efficientnet_b3: prepared.modelVersions.efficientnet_b3,
      resnet50: prepared.modelVersions.resnet50,
    },
    elapsedSeconds: 1.2,
    ...overrides,
  } as NonNullable<JobResponse["result"]>;
}

function response(
  execution: { inference: { id: string } },
  status: JobResponse["status"],
  jobResult: JobResponse["result"] = null,
): JobResponse {
  return {
    inferenceId: execution.inference.id,
    jobId: execution.inference.id,
    status,
    stage: status,
    message: null,
    result: jobResult,
  };
}

function mlClient(
  execution: { inference: { id: string }; image: { eyeSide: string } },
  final: JobResponse,
): Pick<MlClient, "submitInference" | "getJobStatus"> {
  return {
    submitInference: vi.fn(async (_payload: Parameters<MlClient["submitInference"]>[0]) => ({
      inferenceId: execution.inference.id,
      jobId: execution.inference.id,
      status: "QUEUED" as const,
    })),
    getJobStatus: vi.fn(async () => final),
  };
}

function processor(ml: Pick<MlClient, "submitInference" | "getJobStatus">) {
  return createInferenceProcessor({
    db: createInferenceRunRepository(prisma),
    mlClient: ml,
    sleep: async () => {},
    now: () => new Date("2026-11-20T00:00:00.000Z"),
    pollIntervalMs: 1,
    maxPolls: 2,
  });
}

describe("worker inference processor integration (C)", () => {
  it("persists COMPLETED against real Prisma without mutating the consultation", async () => {
    const execution = await createExecution();
    const ml = mlClient(
      execution,
      response(execution, "COMPLETED", result(execution)),
    );

    const outcome = await processor(ml)(execution.job);
    expect(outcome).toMatchObject({ status: "COMPLETED", skipped: false });

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored).toMatchObject({
      status: "COMPLETED",
      predictedClass: 0,
      confidence: 0.8,
      cdr: 0.4,
      cdrVertical: 0.45,
      elapsedSeconds: 1.2,
      modelVersion: FAKE_MANIFEST_VERSION,
      gradcamPath: null,
    });
    expect(stored.artifacts).toEqual(result(execution).artifacts);
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: execution.consultation.id },
    });
    expect(consultation.status).toBe("COMPLETED");
    expect(consultation.requiredExecutionIds).toEqual([]);
    const snapshot = await prisma.clinicalSnapshot.findUniqueOrThrow({
      where: { id: execution.snapshot.id },
    });
    expect(snapshot.rawPayload).toEqual({
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
  });

  it("does not call ML or overwrite when a duplicate terminal job arrives", async () => {
    const execution = await createExecution();
    const ml = mlClient(
      execution,
      response(execution, "COMPLETED", result(execution)),
    );
    const run = processor(ml);

    await run(execution.job);
    const storedBefore = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    const duplicate = await run(execution.job);
    const storedAfter = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });

    expect(duplicate.skipped).toBe(true);
    expect(ml.submitInference).toHaveBeenCalledTimes(1);
    expect(storedAfter).toEqual(storedBefore);
  });

  it("lets only one of two racing workers win the terminal compare-and-set", async () => {
    const execution = await createExecution();
    let submissions = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const makeRacingClient = (
      label: string,
      predictedClass: number,
    ): Pick<MlClient, "submitInference" | "getJobStatus"> => ({
      submitInference: vi.fn(async (_payload: Parameters<MlClient["submitInference"]>[0]) => {
        submissions += 1;
        if (submissions === 2) release();
        await barrier;
        return {
          inferenceId: execution.inference.id,
          jobId: execution.inference.id,
          status: "QUEUED" as const,
        };
      }),
      getJobStatus: vi.fn(async () =>
        response(
          execution,
          "COMPLETED",
          result(execution, {
            label,
            confidence: 0.9,
            probabilities: {
              Glaucoma: predictedClass === 0 ? 0.9 : 0.05,
              Non_Glaucoma: predictedClass === 1 ? 0.9 : 0.05,
              Suspicious_Glaucoma: predictedClass === 2 ? 0.9 : 0.05,
            },
          }),
        ),
      ),
    });

    const outcomes = await Promise.all([
      processor(makeRacingClient("Glaucoma", 0))(execution.job),
      processor(makeRacingClient("Non_Glaucoma", 1))(execution.job),
    ]);

    expect(outcomes.filter((outcome) => outcome.skipped)).toHaveLength(1);
    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect([0, 1]).toContain(stored.predictedClass);
    expect(stored.status).toBe("COMPLETED");
  });

  it("keeps a frozen consultation and selected snapshot immutable", async () => {
    const execution = await createExecution({ frozen: true });
    const ml = mlClient(
      execution,
      response(execution, "REVIEW_REQUIRED", result(execution)),
    );

    const outcome = await processor(ml)(execution.job);
    expect(outcome.status).toBe("REVIEW_REQUIRED");

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: execution.consultation.id },
    });
    expect(consultation.status).toBe("COMPLETED");
    expect(consultation.requiredExecutionIds).toEqual([execution.inference.id]);
    expect(consultation.requiredSetVersion).toBe("required-v1");
    expect(consultation.requiredSetFrozenAt?.toISOString()).toBe(
      "2026-11-20T00:00:00.000Z",
    );
    const snapshot = await prisma.clinicalSnapshot.findUniqueOrThrow({
      where: { id: execution.snapshot.id },
    });
    expect(snapshot.rawPayload).toEqual({
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
  });
});
