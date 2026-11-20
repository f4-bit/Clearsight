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
    modelPredictions: {
      efficientnet_b3: {
        probabilities: {
          Glaucoma: 0.8,
          Non_Glaucoma: 0.1,
          Suspicious_Glaucoma: 0.1,
        },
        predictedClass: "Glaucoma",
        confidence: 0.8,
      },
      resnet50: {
        probabilities: {
          Glaucoma: 0.1,
          Non_Glaucoma: 0.8,
          Suspicious_Glaucoma: 0.1,
        },
        predictedClass: "Non_Glaucoma",
        confidence: 0.8,
      },
    },
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
    expect(stored.modelVersions).toEqual(result(execution).modelVersions);
    expect(stored.modelPredictions).toEqual(result(execution).modelPredictions);
    expect(stored.modelVersions).not.toEqual(execution.snapshot.modelVersions);
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

  it("round-trips own prototype-named JSON keys through Prisma without mutating inputs", async () => {
    const execution = await createExecution();
    const modelPredictions = JSON.parse(
      '{"__proto__":{"probabilities":{"Glaucoma":0.8,"Non_Glaucoma":0.1,"Suspicious_Glaucoma":0.1},"predictedClass":"Glaucoma","confidence":0.8}}',
    );
    const modelVersions = {
      ...result(execution).modelVersions,
    };
    Object.defineProperty(modelVersions, "__proto__", {
      value: "repo/legacy@revision",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const predictionsBefore = JSON.stringify(modelPredictions);
    const versionsBefore = JSON.stringify(modelVersions);
    const ml = mlClient(
      execution,
      response(
        execution,
        "COMPLETED",
        result(execution, { modelPredictions, modelVersions }),
      ),
    );

    const outcome = await processor(ml)(execution.job);
    expect(outcome.status).toBe("COMPLETED");

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    const storedPredictions = JSON.parse(
      JSON.stringify(stored.modelPredictions),
    );
    const storedVersions = JSON.parse(JSON.stringify(stored.modelVersions));
    expect(
      Object.prototype.hasOwnProperty.call(storedPredictions, "__proto__"),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(storedVersions, "__proto__"),
    ).toBe(true);
    expect(storedPredictions).toEqual(JSON.parse(predictionsBefore));
    expect(storedVersions).toEqual(JSON.parse(versionsBefore));
    expect(JSON.stringify(modelPredictions)).toBe(predictionsBefore);
    expect(JSON.stringify(modelVersions)).toBe(versionsBefore);
  });

  it("targets the declared public schema despite a decoy search_path and preserves proto JSON", async () => {
    const execution = await createExecution();
    const decoySchema = `qa_repo_decoy_${execution.inference.id.replaceAll("-", "")}`;
    const decoyTable = `"${decoySchema}"."inferences"`;
    const decoyJson = '{"decoy":"yes"}';
    const modelPredictions = JSON.parse(
      '{"__proto__":{"probabilities":{"Glaucoma":0.8,"Non_Glaucoma":0.1,"Suspicious_Glaucoma":0.1},"predictedClass":"Glaucoma","confidence":0.8}}',
    );
    const modelVersions = JSON.parse(
      '{"efficientnet_b3":"repo/efficientnet_b3@revision-efficientnet_b3","resnet50":"repo/resnet50@revision-resnet50","segmentation":"repo/segmentation@revision-segmentation","__proto__":"repo/legacy@revision"}',
    );
    const predictionsBefore = JSON.stringify(modelPredictions);
    const versionsBefore = JSON.stringify(modelVersions);

    try {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${decoySchema}" CASCADE`,
      );
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${decoySchema}"`);
      await prisma.$executeRawUnsafe(
        `CREATE TABLE ${decoyTable} (
          id uuid PRIMARY KEY,
          status varchar(32),
          predicted_class integer,
          confidence double precision,
          probabilities jsonb,
          model_versions jsonb,
          model_predictions jsonb,
          cdr double precision,
          cdr_vertical double precision,
          quality jsonb,
          artifacts jsonb,
          elapsed_seconds double precision,
          gradcam_path text,
          model_version varchar(128)
        )`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${decoyTable} (
          id, status, predicted_class, confidence, probabilities,
          model_versions, model_predictions, cdr, cdr_vertical, quality,
          artifacts, elapsed_seconds, gradcam_path, model_version
        ) VALUES ($1, 'FAILED', 1, 0.1, $2::jsonb, $2::jsonb, $2::jsonb,
          9, 9, $2::jsonb, $2::jsonb, 9, 'decoy', 'decoy')`,
        execution.inference.id,
        decoyJson,
      );

      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL search_path TO "${decoySchema}", public`,
        );
        const repository = createInferenceRunRepository(tx, {
          databaseSchema: "public",
        });
        const found = await repository.findExecution(execution.inference.id);
        expect(found?.status).toBe("QUEUED");
        expect(found?.predictedClass).toBeNull();

        const saved = await repository.saveTerminalResult(
          execution.inference.id,
          {
            status: "COMPLETED",
            predictedClass: 0,
            confidence: 0.8,
            probabilities: {
              Glaucoma: 0.8,
              Non_Glaucoma: 0.1,
              Suspicious_Glaucoma: 0.1,
            },
            modelVersions,
            modelPredictions,
            cdr: 0.4,
            cdrVertical: 0.45,
            quality: { review_required: false },
            artifacts: { mask: "s3://masks/mask.png" },
            elapsedSeconds: 1.2,
            gradcamPath: null,
            modelVersion: FAKE_MANIFEST_VERSION,
          },
        );
        expect(saved).toBe(true);

        const duplicate = await repository.saveTerminalResult(
          execution.inference.id,
          {
            status: "FAILED",
            predictedClass: 2,
            confidence: 0.1,
            probabilities: {},
            modelVersions: {},
            modelPredictions: {},
            quality: {},
            artifacts: {},
          },
        );
        expect(duplicate).toBe(false);
        return { found, saved, duplicate };
      });

      expect(result.saved).toBe(true);
      expect(result.duplicate).toBe(false);

      const publicRows = await prisma.$queryRawUnsafe<
        Array<{
          status: string;
          predicted_class: number | null;
          model_versions: string;
          model_predictions: string;
        }>
      >(
        'SELECT status, predicted_class, model_versions::text AS model_versions, model_predictions::text AS model_predictions FROM "public"."inferences" WHERE id = $1',
        execution.inference.id,
      );
      expect(publicRows).toHaveLength(1);
      expect(publicRows[0]?.status).toBe("COMPLETED");
      expect(publicRows[0]?.predicted_class).toBe(0);
      const storedPredictions = JSON.parse(
        publicRows[0]?.model_predictions ?? "{}",
      );
      const storedVersions = JSON.parse(publicRows[0]?.model_versions ?? "{}");
      expect(
        Object.prototype.hasOwnProperty.call(storedPredictions, "__proto__"),
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(storedVersions, "__proto__"),
      ).toBe(true);

      const decoyRows = await prisma.$queryRawUnsafe<
        Array<{
          status: string;
          predicted_class: number;
          model_versions: string;
          model_predictions: string;
        }>
      >(
        `SELECT status, predicted_class, model_versions::text AS model_versions, model_predictions::text AS model_predictions FROM ${decoyTable} WHERE id = $1`,
        execution.inference.id,
      );
      expect(decoyRows).toHaveLength(1);
      expect(decoyRows[0]).toMatchObject({
        status: "FAILED",
        predicted_class: 1,
      });
      expect(JSON.parse(decoyRows[0]?.model_versions ?? "{}")).toEqual(
        JSON.parse(decoyJson),
      );
      expect(JSON.parse(decoyRows[0]?.model_predictions ?? "{}")).toEqual(
        JSON.parse(decoyJson),
      );
      expect(JSON.stringify(modelPredictions)).toBe(predictionsBefore);
      expect(JSON.stringify(modelVersions)).toBe(versionsBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${decoySchema}" CASCADE`,
      );
    }
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
            modelVersions: {
              ...result(execution).modelVersions,
              race_marker: label,
            },
            modelPredictions: {
              race_model: {
                probabilities: {
                  Glaucoma: predictedClass === 0 ? 0.9 : 0.05,
                  Non_Glaucoma: predictedClass === 1 ? 0.9 : 0.05,
                  Suspicious_Glaucoma: predictedClass === 2 ? 0.9 : 0.05,
                },
                predictedClass: label,
                confidence: 0.9,
              },
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
    const winnerLabel = stored.predictedClass === 0 ? "Glaucoma" : "Non_Glaucoma";
    expect(stored.modelVersions).toMatchObject({ race_marker: winnerLabel });
    expect(stored.modelPredictions).toMatchObject({
      race_model: { predictedClass: winnerLabel, confidence: 0.9 },
    });
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
    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.modelVersions).toEqual(result(execution).modelVersions);
    expect(stored.modelPredictions).toEqual(result(execution).modelPredictions);
    const snapshot = await prisma.clinicalSnapshot.findUniqueOrThrow({
      where: { id: execution.snapshot.id },
    });
    expect(snapshot.rawPayload).toEqual({
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
  });

  it("round-trips legitimate empty REVIEW_REQUIRED diagnostics with segmentation metadata", async () => {
    const execution = await createExecution();
    const reviewResult = result(execution, {
      label: null,
      confidence: null,
      probabilities: {},
      modelPredictions: {},
      quality: { review_required: true, segmentation: "ok" },
      artifacts: {
        mask: "s3://masks/mask.png",
        overlay: "s3://overlays/overlay.png",
      },
    });
    const ml = mlClient(
      execution,
      response(execution, "REVIEW_REQUIRED", reviewResult),
    );

    const outcome = await processor(ml)(execution.job);
    expect(outcome.status).toBe("REVIEW_REQUIRED");

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.status).toBe("REVIEW_REQUIRED");
    expect(stored.predictedClass).toBeNull();
    expect(stored.confidence).toBeNull();
    expect(stored.probabilities).toEqual({});
    expect(stored.modelPredictions).toEqual({});
    expect(stored.modelVersions).toEqual(reviewResult.modelVersions);
    expect(stored.quality).toEqual({
      review_required: true,
      segmentation: "ok",
    });
    expect(stored.artifacts).toEqual({
      mask: "s3://masks/mask.png",
      overlay: "s3://overlays/overlay.png",
    });
    expect(stored.cdr).toBe(0.4);
    expect(stored.cdrVertical).toBe(0.45);
    expect(stored.elapsedSeconds).toBe(1.2);
  });

  it("persists empty result details for REVIEW_REQUIRED with foreign identity", async () => {
    const execution = await createExecution();
    const foreign = result(execution, {
      inferenceId: "99999999-9999-4999-8999-999999999999",
      label: "Glaucoma",
      confidence: 0.99,
      probabilities: {
        Glaucoma: 0.99,
        Non_Glaucoma: 0.005,
        Suspicious_Glaucoma: 0.005,
      },
      artifacts: { mask: "s3://foreign/mask.png" },
      modelVersions: { foreign_model: "repo/foreign@revision" },
      modelPredictions: {
        foreign_model: {
          probabilities: { Glaucoma: 0.99 },
          predictedClass: "Glaucoma",
          confidence: 0.99,
        },
      },
    });
    const ml = mlClient(
      execution,
      response(execution, "REVIEW_REQUIRED", foreign),
    );

    const outcome = await processor(ml)(execution.job);
    expect(outcome.status).toBe("REVIEW_REQUIRED");

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.modelVersions).toEqual({});
    expect(stored.modelPredictions).toEqual({});
    expect(stored.artifacts).toEqual({});
    expect(stored.probabilities).toEqual({});
  });

  it("does not mutate persisted result details when the returned payload is mutated", async () => {
    const execution = await createExecution();
    const payload = result(execution);
    const originalVersions = structuredClone(payload.modelVersions);
    const originalPredictions = structuredClone(payload.modelPredictions);
    const ml = mlClient(
      execution,
      response(execution, "COMPLETED", payload),
    );

    await processor(ml)(execution.job);
    payload.modelVersions.manifest = "mutated-after-return";
    const prediction = payload.modelPredictions.efficientnet_b3;
    if (!prediction) throw new Error("fixture is missing efficientnet_b3");
    prediction.predictedClass = "Mutated";
    prediction.probabilities.Glaucoma = 0.01;

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.modelVersions).toEqual(originalVersions);
    expect(stored.modelPredictions).toEqual(originalPredictions);
  });
});
