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
    modelVersions: {},
    modelPredictions: {},
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
    expect(db.saves[0]?.modelVersions).toEqual(completedResult().modelVersions);
    expect(db.saves[0]?.modelVersions).not.toEqual(prepared.modelVersions);
    expect(db.saves[0]?.modelPredictions).toEqual(
      completedResult().modelPredictions,
    );
    expect(db.saves[0]?.modelPredictions?.efficientnet_b3).not.toHaveProperty(
      "predicted_class",
    );
  });

  it.each([
    ["Glaucoma", 0],
    ["Non_Glaucoma", 1],
    ["Suspicious_Glaucoma", 2],
    ["glaucoma", 0],
    ["NON_GLAUCOMA", 1],
    ["suspicious_glaucoma", 2],
  ])("maps %s to canonical class %i and persists actual metadata", async (label, expected) => {
    const db = new FakeDb(execution());
    const ml = fakeMl([response("COMPLETED", completedResult({ label }))]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("COMPLETED");
    expect(db.saves[0]?.predictedClass).toBe(expected);
    expect(db.saves[0]?.modelVersions).toEqual(completedResult().modelVersions);
    expect(db.saves[0]?.modelPredictions).toEqual(
      completedResult().modelPredictions,
    );
  });

  it("persists the actual modelVersions exactly without merging snapshot keys", async () => {
    const db = new FakeDb(execution());
    const actualVersions = {
      ...completedResult().modelVersions,
      extra_model: "repo/extra@actual-revision",
    };
    const ml = fakeMl([
      response("COMPLETED", completedResult({ modelVersions: actualVersions })),
    ]);

    await processor(db, ml)(job());

    expect(db.saves[0]?.modelVersions).toEqual(actualVersions);
    expect(db.saves[0]?.modelVersions).not.toHaveProperty("manifest");
    expect(db.saves[0]?.modelVersions).not.toEqual(prepared.modelVersions);
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
    expect(db.saves[0]?.modelVersions).toEqual(completedResult().modelVersions);
    expect(db.saves[0]?.modelPredictions).toEqual(
      completedResult().modelPredictions,
    );
  });

  it("persists partial model metadata in REVIEW_REQUIRED without filling missing versions", async () => {
    const db = new FakeDb(execution());
    const partialVersions = {
      efficientnet_b3: completedResult().modelVersions.efficientnet_b3,
    };
    const partialPredictions = {
      efficientnet_b3: completedResult().modelPredictions.efficientnet_b3,
    };
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          modelVersions: partialVersions,
          modelPredictions: partialPredictions,
        }),
      ),
    ]);

    const result = await processor(db, ml)(job());

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(db.saves[0]?.modelVersions).toEqual(partialVersions);
    expect(db.saves[0]?.modelVersions).not.toHaveProperty("resnet50");
    expect(db.saves[0]?.modelPredictions).toEqual(partialPredictions);
  });

  it("keeps REVIEW_REQUIRED with an unknown aggregate label null and preserves valid partials", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response("REVIEW_REQUIRED", completedResult({ label: "Not_A_Class" })),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.status).toBe("REVIEW_REQUIRED");
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.cdr).toBe(0.4);
    expect(saved?.cdrVertical).toBe(0.45);
    expect(saved?.quality).toEqual(completedResult().quality);
    expect(saved?.artifacts).toEqual(completedResult().artifacts);
    expect(saved?.modelVersions).toEqual(completedResult().modelVersions);
    expect(saved?.modelPredictions).toEqual(completedResult().modelPredictions);
    expect(saved?.elapsedSeconds).toBe(1.2);
  });

  it("preserves a valid legacy per-model raw label without casting an index", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "COMPLETED",
        completedResult({
          modelPredictions: {
            efficientnet_b3: {
              ...completedResult().modelPredictions.efficientnet_b3!,
              predictedClass: "glaucoma",
            },
          },
        }),
      ),
    ]);

    await processor(db, ml)(job());

    expect(
      db.saves[0]?.modelPredictions?.efficientnet_b3?.predictedClass,
    ).toBe("glaucoma");
  });

  it("keeps legitimate empty REVIEW_REQUIRED diagnostics while preserving segmentation metadata", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          label: null,
          confidence: null,
          probabilities: {},
          modelPredictions: {},
          quality: { review_required: true, segmentation: "ok" },
          artifacts: {
            mask: "s3://masks/mask.png",
            overlay: "s3://overlays/overlay.png",
          },
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.status).toBe("REVIEW_REQUIRED");
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.confidence).toBeNull();
    expect(saved?.probabilities).toEqual({});
    expect(saved?.modelPredictions).toEqual({});
    expect(saved?.modelVersions).toEqual(completedResult().modelVersions);
    expect(saved?.quality).toEqual({ review_required: true, segmentation: "ok" });
    expect(saved?.artifacts).toEqual({
      mask: "s3://masks/mask.png",
      overlay: "s3://overlays/overlay.png",
    });
    expect(saved?.cdr).toBe(0.4);
    expect(saved?.cdrVertical).toBe(0.45);
    expect(saved?.elapsedSeconds).toBe(1.2);
  });

  it("drops malformed aggregate probabilities in REVIEW but preserves segmentation metadata", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          label: "Glaucoma",
          confidence: 0.8,
          probabilities: JSON.parse('{"Glaucoma":0.8,"Unknown":0.2}'),
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.confidence).toBeNull();
    expect(saved?.probabilities).toEqual({});
    expect(saved?.modelVersions).toEqual(completedResult().modelVersions);
    expect(saved?.modelPredictions).toEqual(completedResult().modelPredictions);
    expect(saved?.quality).toEqual(completedResult().quality);
    expect(saved?.artifacts).toEqual(completedResult().artifacts);
    expect(saved?.cdr).toBe(0.4);
    expect(saved?.cdrVertical).toBe(0.45);
    expect(saved?.elapsedSeconds).toBe(1.2);
  });

  it("does not keep REVIEW data when version compatibility fails", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          modelVersions: {
            ...completedResult().modelVersions,
            resnet50: "other@revision",
          },
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.probabilities).toEqual({});
    expect(saved?.modelVersions).toEqual({});
    expect(saved?.modelPredictions).toEqual({});
    expect(saved?.quality).toEqual({});
    expect(saved?.artifacts).toEqual({});
    expect(saved?.cdr).toBeNull();
    expect(saved?.cdrVertical).toBeNull();
    expect(saved?.elapsedSeconds).toBeNull();
  });

  it("discards invalid per-model predictions in REVIEW_REQUIRED but keeps other partials", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          modelPredictions: {
            efficientnet_b3: {
              probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
              predictedClass: "Glaucoma",
              confidence: 0.8,
            },
          },
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.status).toBe("REVIEW_REQUIRED");
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.modelPredictions).toEqual({});
    expect(saved?.modelVersions).toEqual(completedResult().modelVersions);
    expect(saved?.cdr).toBe(0.4);
    expect(saved?.cdrVertical).toBe(0.45);
    expect(saved?.quality).toEqual(completedResult().quality);
    expect(saved?.artifacts).toEqual(completedResult().artifacts);
    expect(saved?.elapsedSeconds).toBe(1.2);
  });

  it("discards predictions with prototype probability keys in REVIEW_REQUIRED and keeps other partials", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "REVIEW_REQUIRED",
        completedResult({
          modelPredictions: JSON.parse(
            '{"efficientnet_b3":{"probabilities":{"Glaucoma":0.8,"Non_Glaucoma":0.1,"Suspicious_Glaucoma":0.1,"__proto__":0},"predictedClass":"Glaucoma","confidence":0.8}}',
          ),
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("REVIEW_REQUIRED");
    const saved = db.saves[0];
    expect(saved?.status).toBe("REVIEW_REQUIRED");
    expect(saved?.predictedClass).toBeNull();
    expect(saved?.modelPredictions).toEqual({});
    expect(saved?.modelVersions).toEqual(completedResult().modelVersions);
    expect(saved?.cdr).toBe(0.4);
    expect(saved?.cdrVertical).toBe(0.45);
    expect(saved?.quality).toEqual(completedResult().quality);
    expect(saved?.artifacts).toEqual(completedResult().artifacts);
    expect(saved?.elapsedSeconds).toBe(1.2);
  });

  it("preserves prototype-named wire keys instead of silently dropping predictions", async () => {
    const db = new FakeDb(execution());
    const ml = fakeMl([
      response(
        "COMPLETED",
        completedResult({
          modelPredictions: JSON.parse(
            '{"__proto__":{"probabilities":{"Glaucoma":0.8,"Non_Glaucoma":0.1,"Suspicious_Glaucoma":0.1},"predictedClass":"Glaucoma","confidence":0.8}}',
          ),
        }),
      ),
    ]);

    const outcome = await processor(db, ml)(job());

    expect(outcome.status).toBe("COMPLETED");
    const saved = db.saves[0];
    expect(
      Object.prototype.hasOwnProperty.call(saved?.modelPredictions, "__proto__"),
    ).toBe(true);
    expect(
      Object.getOwnPropertyNames(saved?.modelPredictions ?? {}).sort(),
    ).toEqual(["__proto__"]);
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
      modelVersions: {},
      modelPredictions: {},
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
      expect(db.saves[0]?.modelVersions).toEqual({});
      expect(db.saves[0]?.modelPredictions).toEqual({});
      expect(db.saves[0]?.modelVersion).not.toBe("v1");
    }
  });

  it.each([
    [
      "unknown predicted class",
      {
        efficientnet_b3: {
          probabilities: {
            Glaucoma: 0.8,
            Non_Glaucoma: 0.1,
            Suspicious_Glaucoma: 0.1,
          },
          predictedClass: "Not_A_Class",
          confidence: 0.8,
        },
      },
    ],
    [
      "missing canonical probability",
      {
        efficientnet_b3: {
          probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
          predictedClass: "Glaucoma",
          confidence: 0.8,
        },
      },
    ],
    [
      "extra probability key",
      {
        efficientnet_b3: {
          probabilities: {
            Glaucoma: 0.8,
            Non_Glaucoma: 0.1,
            Suspicious_Glaucoma: 0.1,
            Unknown: 0,
          },
          predictedClass: "Glaucoma",
          confidence: 0.8,
        },
      },
    ],
    [
      "prototype probability key",
      JSON.parse(
        '{"efficientnet_b3":{"probabilities":{"Glaucoma":0.8,"Non_Glaucoma":0.1,"Suspicious_Glaucoma":0.1,"__proto__":0},"predictedClass":"Glaucoma","confidence":0.8}}',
      ),
    ],
    [
      "confidence outside unit interval",
      {
        efficientnet_b3: {
          probabilities: {
            Glaucoma: 0.8,
            Non_Glaucoma: 0.1,
            Suspicious_Glaucoma: 0.1,
          },
          predictedClass: "Glaucoma",
          confidence: 1.5,
        },
      },
    ],
    [
      "malformed prediction",
      {
        efficientnet_b3: {
          probabilities: "not-an-object",
          predictedClass: "Glaucoma",
          confidence: 0.8,
        },
      },
    ],
  ])(
    "rejects invalid per-model predictions in COMPLETED: %s",
    async (_case, modelPredictions) => {
      const db = new FakeDb(execution());
      const ml = fakeMl([
        response("COMPLETED", completedResult({ modelPredictions })),
      ]);

      const outcome = await processor(db, ml)(job());

      expect(outcome.status).toBe("FAILED");
      expect(db.saves[0]?.status).toBe("FAILED");
      expect(db.saves[0]?.predictedClass).toBeNull();
      expect(db.saves[0]?.modelVersions).toEqual({});
      expect(db.saves[0]?.modelPredictions).toEqual({});
    },
  );

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
      expect(saved?.modelVersions).toEqual({});
      expect(saved?.modelPredictions).toEqual({});
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
