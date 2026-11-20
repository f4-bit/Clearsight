import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ioredis", () => {
  throw new Error("processor tests must not import ioredis");
});
vi.mock("bullmq", () => {
  throw new Error("processor tests must not import bullmq");
});

import type { JobResponse } from "../../src/schemas/inference.js";
import type {
  InferenceRunExecution,
  InferenceRunRepository,
  TerminalInferenceUpdate,
} from "../../src/repositories/inference-run.repo.js";
import {
  MlClientError,
  MlClientHttpError,
  type MlClient,
} from "../../src/services/ml-client.js";
import { FEATURES } from "../fixtures/clinical.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "../helpers/ml.js";
import {
  createInferenceProcessor,
  InferenceRetryableError,
} from "../../src/workers/inference.processor.js";
import type { InferenceJobData } from "../../src/workers/inference.contracts.js";

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const prepared = makePreparedSnapshot(FEATURES);

function execution(
  overrides: {
    status?: string | null;
    snapshot?: InferenceRunExecution["snapshot"];
    eyeSide?: string | null;
    modelVersion?: string | null;
  } = {},
): InferenceRunExecution {
  return {
    id: INFERENCE_ID,
    imageId: IMAGE_ID,
    status: overrides.status ?? "QUEUED",
    eyeSide: overrides.eyeSide === undefined ? "OD" : overrides.eyeSide,
    modelVersion:
      overrides.modelVersion === undefined
        ? FAKE_MANIFEST_VERSION
        : overrides.modelVersion,
    image: {
      id: IMAGE_ID,
      eyeSide: "OD",
      consultationId: "55555555-5555-4555-8555-555555555555",
      storagePath: "2026/10/image.jpg",
    },
    snapshot:
      overrides.snapshot === undefined
        ? {
            id: SNAPSHOT_ID,
            schemaVersion: "ml-zscore-f32-v1",
            rawPayload: { eyeSide: "OD", clinicalFeatures: FEATURES },
            normalizedPayload: {
              ...prepared.normalizedPayload,
              eyeSide: "OD",
            },
            modelVersions: prepared.modelVersions,
          }
        : overrides.snapshot,
  } as unknown as InferenceRunExecution;
}

function job(overrides: Partial<InferenceJobData> = {}): InferenceJobData {
  return {
    inferenceId: INFERENCE_ID,
    imageId: IMAGE_ID,
    imageUrl: "https://ml.test/image.png",
    eyeSide: "OD",
    clinicalFeatures: FEATURES,
    modelVersion: FAKE_MANIFEST_VERSION,
    expectedContext: {
      schemaVersion: "ml-zscore-f32-v1",
      fingerprintSha256: prepared.contextFingerprintSha256,
    },
    ...overrides,
  };
}

function completedResult(
  overrides: Record<string, unknown> = {},
): NonNullable<JobResponse["result"]> {
  return {
    inferenceId: INFERENCE_ID,
    eyeSide: "OD",
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
  status: JobResponse["status"],
  result: JobResponse["result"] = null,
): JobResponse {
  return {
    inferenceId: INFERENCE_ID,
    jobId: JOB_ID,
    status,
    stage: status,
    message: null,
    result,
  };
}

class FakeDb implements InferenceRunRepository {
  current: InferenceRunExecution | null;
  readonly saves: TerminalInferenceUpdate[] = [];
  saveResult = true;

  constructor(initial: InferenceRunExecution | null) {
    this.current = initial;
  }

  async findExecution(): Promise<InferenceRunExecution | null> {
    return this.current;
  }

  async saveTerminalResult(
    _inferenceId: string,
    update: TerminalInferenceUpdate,
  ): Promise<boolean> {
    this.saves.push(update);
    if (!this.saveResult) {
      // Simulate another worker winning the compare-and-set.
      if (this.current) {
        this.current = { ...this.current, status: "COMPLETED" };
      }
      return false;
    }
    if (this.current) {
      this.current = { ...this.current, status: update.status };
    }
    return true;
  }
}

function fakeMl(responses: JobResponse[]) {
  const submitInference = vi.fn(
    async (_payload: Parameters<MlClient["submitInference"]>[0]) => ({
      inferenceId: INFERENCE_ID,
      jobId: JOB_ID,
      status: "QUEUED" as const,
    }),
  );
  const getJobStatus = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected poll");
    return next;
  });
  return { submitInference, getJobStatus };
}

function processor(db: FakeDb, ml: ReturnType<typeof fakeMl>) {
  return createInferenceProcessor({
    db,
    mlClient: ml,
    sleep: async () => {},
    now: () => new Date("2026-11-20T00:00:00.000Z"),
    pollIntervalMs: 1,
    maxPolls: 2,
  });
}

describe("worker inference processor (C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a completed result with full available fields and canonical class", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([response("COMPLETED", completedResult())]);

    const result = await processor(db, ml)(job());

    expect(result).toMatchObject({
      inferenceId: INFERENCE_ID,
      status: "COMPLETED",
      skipped: false,
    });
    expect(ml.submitInference).toHaveBeenCalledWith(
      expect.objectContaining({
        clinical_features: FEATURES,
        model_version: FAKE_MANIFEST_VERSION,
        expected_context: {
          schema_version: "ml-zscore-f32-v1",
          fingerprint_sha256: prepared.contextFingerprintSha256,
        },
      }),
    );
    expect(db.saves[0]).toMatchObject({
      status: "COMPLETED",
      predictedClass: 0,
      confidence: 0.8,
      cdr: 0.4,
      cdrVertical: 0.45,
      elapsedSeconds: 1.2,
      gradcamPath: null,
      modelVersion: FAKE_MANIFEST_VERSION,
    });
    expect(db.saves[0]?.probabilities).toEqual(
      completedResult().probabilities,
    );
    expect(db.saves[0]?.artifacts).toEqual(completedResult().artifacts);
  });

  it("uses the snapshot clinicalFeatures even when only the job is perturbed", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([response("COMPLETED", completedResult())]);

    await processor(db, ml)(job());

    expect(ml.submitInference).toHaveBeenCalledTimes(1);
    expect(ml.submitInference.mock.calls[0]![0].clinical_features).toEqual(
      FEATURES,
    );
  });

  it("persists REVIEW_REQUIRED as terminal without throwing or retrying", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({ label: "Suspicious_Glaucoma", confidence: 0.55 }),
      ),
    ]);

    const result = await processor(db, ml)(job());

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(db.saves[0]).toMatchObject({
      status: "REVIEW_REQUIRED",
      predictedClass: 2,
      confidence: 0.55,
    });
  });

  it("persists FAILED without fabricating a result", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([response("FAILED", completedResult())]);

    const result = await processor(db, ml)(job());

    expect(result.status).toBe("FAILED");
    expect(db.saves[0]).toMatchObject({
      status: "FAILED",
      predictedClass: null,
      confidence: null,
      probabilities: {},
      quality: {},
      artifacts: {},
      gradcamPath: null,
    });
  });

  it("rejects unknown labels, NaN and mismatched identities as terminal failure", async () => {
    for (const result of [
      completedResult({ label: "Not_A_Class" }),
      completedResult({ label: "toString" }),
      completedResult({ probabilities: { Glaucoma: Number.NaN } }),
      completedResult({ inferenceId: "99999999-9999-4999-8999-999999999999" }),
      completedResult({ eyeSide: "OS" }),
    ]) {
      const db = new FakeDb(execution());
      const ml = fakeMl([response("COMPLETED", result)]);

      const outcome = await processor(db, ml)(job());

      expect(outcome.status).toBe("FAILED");
      expect(db.saves[0]?.status).toBe("FAILED");
      expect(db.saves[0]?.predictedClass).toBeNull();
    }
  });

  it("rejects model-version drift against the snapshot as terminal failure", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "COMPLETED",
        completedResult({
          modelVersions: {
            ...completedResult().modelVersions,
            resnet50: "other@revision",
          },
        }),
      ),
    ]);

    const result = await processor(db, ml)(job());

    expect(result.status).toBe("FAILED");
    expect(db.saves[0]?.status).toBe("FAILED");
  });

  it("skips a duplicate terminal job without calling ML or overwriting", async () => {
    const db = new FakeDb(execution({ status: "COMPLETED" }));
    const ml = fakeMl([]);

    const result = await processor(db, ml)(job());

    expect(result).toMatchObject({ status: "COMPLETED", skipped: true });
    expect(ml.submitInference).not.toHaveBeenCalled();
    expect(db.saves).toEqual([]);
  });

  it("rejects mismatched job context before ML without writing evidence", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([]);

    await expect(
      processor(db, ml)(
        job({
          expectedContext: {
            ...job().expectedContext!,
            fingerprintSha256: "b".repeat(64),
          },
        }),
      ),
    ).rejects.toThrow("invalid_job_context");

    expect(ml.submitInference).not.toHaveBeenCalled();
    expect(db.saves).toEqual([]);

    const alreadyTerminal = new FakeDb(execution({ status: "COMPLETED" }));
    const second = await processor(alreadyTerminal, fakeMl([]))(job());
    expect(second.skipped).toBe(true);
    expect(alreadyTerminal.saves).toEqual([]);
  });

  it("keeps legacy snapshot-null jobs unpinned and closes no consultation", async () => {
    const db = new FakeDb(
      execution({ snapshot: null, modelVersion: null, eyeSide: null }),
    );
    const ml = fakeMl([
      response(
        "COMPLETED",
        completedResult({
          modelVersions: {
            efficientnet_b3: "repo/efficientnet_b3@rev",
            resnet50: "repo/resnet50@rev",
          },
        }),
      ),
    ]);
    const legacyJob = job({
      expectedContext: undefined,
      modelVersion: null,
    });

    const result = await processor(db, ml)(legacyJob);

    expect(result.status).toBe("COMPLETED");
    expect(ml.submitInference.mock.calls[0]![0]).toMatchObject({
      expected_context: undefined,
      model_version: null,
    });
    expect(db.saves[0]?.status).toBe("COMPLETED");
  });

  it("retries 429/5xx/timeout and persists terminal 4xx safely", async () => {
    const retryDb = new FakeDb(execution());
    const retryMl = fakeMl([]);
    retryMl.submitInference.mockRejectedValueOnce(new MlClientHttpError(503));
    await expect(processor(retryDb, retryMl)(job())).rejects.toBeInstanceOf(
      InferenceRetryableError,
    );
    expect(retryDb.saves).toEqual([]);

    const networkDb = new FakeDb(execution());
    const networkMl = fakeMl([]);
    networkMl.submitInference.mockRejectedValueOnce(new MlClientError());
    await expect(processor(networkDb, networkMl)(job())).rejects.toBeInstanceOf(
      InferenceRetryableError,
    );

    const terminalDb = new FakeDb(execution());
    const terminalMl = fakeMl([]);
    terminalMl.submitInference.mockRejectedValueOnce(new MlClientHttpError(422));
    const terminal = await processor(terminalDb, terminalMl)(job());
    expect(terminal.status).toBe("FAILED");
    expect(terminalDb.saves[0]?.status).toBe("FAILED");
  });

  it("stops a bounded poll with a safe failure", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response("QUEUED"),
      response("QUEUED"),
      response("QUEUED"),
    ]);

    const result = await processor(db, ml)(job());

    expect(result.status).toBe("FAILED");
    expect(db.saves[0]?.status).toBe("FAILED");
  });

  it("does not overwrite when the compare-and-set loses a race", async () => {
    const db = new FakeDb(execution());
    db.saveResult = false;
    const ml = fakeMl([response("COMPLETED", completedResult())]);

    const result = await processor(db, ml)(job());

    expect(result.skipped).toBe(true);
    expect(result.status).toBe("COMPLETED");
  });

  it("treats a 409 context_mismatch at submit as terminal failure, no retry", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([]);
    ml.submitInference.mockRejectedValueOnce(new MlClientHttpError(409));

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("FAILED");
    expect(db.saves[0]).toMatchObject({
      status: "FAILED",
      predictedClass: null,
      confidence: null,
      probabilities: {},
      artifacts: {},
    });
    expect(ml.getJobStatus).not.toHaveBeenCalled();
  });

  it("rejects job clinicalFeatures that contradict the persisted snapshot before ML", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([]);

    await expect(
      processor(db, ml)(
        job({
          clinicalFeatures: { ...FEATURES, Age: FEATURES.Age + 1 },
        }),
      ),
    ).rejects.toThrow("invalid_job_context");

    expect(ml.submitInference).not.toHaveBeenCalled();
    expect(db.saves).toEqual([]);
  });

  it("discards REVIEW_REQUIRED results with a foreign identity without persisting their data", async () => {
    for (const foreign of [
      { inferenceId: "99999999-9999-4999-8999-999999999999" },
      { eyeSide: "OS" as const },
    ]) {
      const db = new FakeDb(execution());
      const ml = fakeMl([
        response(
          "REVIEW_REQUIRED",
          completedResult({
            ...foreign,
            label: "Glaucoma",
            confidence: 0.99,
            probabilities: {
              Glaucoma: 0.99,
              Non_Glaucoma: 0.005,
              Suspicious_Glaucoma: 0.005,
            },
            artifacts: { mask: "s3://foreign/mask.png" },
          }),
        ),
      ]);

      const outcome = await processor(db, ml)(job());

      expect(outcome.status).not.toBe("COMPLETED");
      const saved = db.saves[0];
      expect(saved?.status).not.toBe("COMPLETED");
      expect(saved?.predictedClass).toBeNull();
      expect(saved?.confidence).toBeNull();
      expect(saved?.probabilities).toEqual({});
      expect(saved?.artifacts).toEqual({});
    }
  });

  it("fails safely when ML acknowledges a different inference id", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([response("COMPLETED", completedResult())]);
    ml.submitInference.mockResolvedValueOnce({
      inferenceId: "99999999-9999-4999-8999-999999999999",
      jobId: JOB_ID,
      status: "QUEUED" as const,
    });

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("FAILED");
    expect(db.saves[0]?.status).toBe("FAILED");
    expect(db.saves[0]?.predictedClass).toBeNull();
  });
});
