import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ioredis", () => {
  throw new Error("worker tests must not import ioredis");
});
vi.mock("bullmq", () => {
  throw new Error("worker tests must not import bullmq");
});

const mocks = vi.hoisted(() => {
  const reconcilerStop = vi.fn();
  const reconcilerRunOnce = vi.fn(async () => {});
  const startDispatchReconciler = vi.fn((..._args: unknown[]) => ({
    runOnce: reconcilerRunOnce,
    stop: reconcilerStop,
  }));
  const publicationRepository = {
    findPublicationCandidates: vi.fn(async () => [] as string[]),
  };
  const publicationService = {
    publish: vi.fn(async () => ({ report: null, artifacts: [] })),
  };
  return {
    reconcilerStop,
    reconcilerRunOnce,
    startDispatchReconciler,
    publicationRepository,
    publicationService,
    createArtifactPublicationRepository: vi.fn(() => publicationRepository),
    createDefaultArtifactPublicationService: vi.fn(() => publicationService),
  };
});

vi.mock("../../src/workers/inference.reconciler.js", () => ({
  startDispatchReconciler: mocks.startDispatchReconciler,
}));
vi.mock("../../src/repositories/artifact-publication.repo.js", () => ({
  createArtifactPublicationRepository:
    mocks.createArtifactPublicationRepository,
}));
vi.mock("../../src/services/artifact-publication.js", () => ({
  createDefaultArtifactPublicationService:
    mocks.createDefaultArtifactPublicationService,
}));

import type { InferenceRunExecution } from "../../src/repositories/inference-run.repo.js";
import { FEATURES } from "../fixtures/clinical.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "../helpers/ml.js";
import {
  buildInferenceJobData,
  createInferencePoller,
  safeErrorCode,
  startInferenceWorker,
} from "../../src/workers/inference.worker.js";
import {
  INFERENCE_PROCESS_BATCH_SIZE,
  INFERENCE_PROCESS_CLAIM_LEASE_SECONDS,
} from "../../src/workers/inference.contracts.js";
import {
  failedTerminalUpdate,
  InferenceRetryableError,
  InferenceTerminalError,
  type ProcessInferenceOutcome,
} from "../../src/workers/inference.processor.js";

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const CONSULTATION_ID = "44444444-4444-4444-8444-444444444444";
const prepared = makePreparedSnapshot(FEATURES);

function execution(
  overrides: {
    status?: string | null;
    processAttempts?: number;
    snapshot?: InferenceRunExecution["snapshot"];
  } = {},
): InferenceRunExecution {
  return {
    id: INFERENCE_ID,
    imageId: IMAGE_ID,
    modelVersion: FAKE_MANIFEST_VERSION,
    status: overrides.status ?? "QUEUED",
    eyeSide: "OD",
    image: {
      id: IMAGE_ID,
      consultationId: CONSULTATION_ID,
      eyeSide: "OD",
      storagePath: "2026/11/image.jpg",
    },
    snapshot:
      overrides.snapshot === undefined
        ? {
            id: SNAPSHOT_ID,
            consultationId: CONSULTATION_ID,
            rawPayload: {
              eyeSide: "OD",
              clinicalFeatures: FEATURES,
            },
            normalizedPayload: {
              ...prepared.normalizedPayload,
              eyeSide: "OD",
            },
            schemaVersion: "ml-zscore-f32-v1",
            modelVersions: prepared.modelVersions,
          }
        : overrides.snapshot,
    processAttempts: overrides.processAttempts ?? 0,
  } as unknown as InferenceRunExecution;
}

function outcome(): ProcessInferenceOutcome {
  return {
    inferenceId: INFERENCE_ID,
    status: "COMPLETED",
    skipped: false,
    finishedAt: "2026-11-20T00:00:00.000Z",
  };
}

function dependencies(overrides: {
  processor?: (data: unknown) => Promise<ProcessInferenceOutcome>;
  findExecution?: (id: string) => Promise<InferenceRunExecution | null>;
  saveTerminalResult?: (
    id: string,
    update: unknown,
  ) => Promise<boolean>;
  claimProcessBatch?: (
    limit: number,
  ) => Promise<Array<{ id: string; processAttempts: number }>>;
  markProcessRetry?: (id: string) => Promise<number | null>;
  markProcessDone?: (id: string) => Promise<number>;
} = {}) {
  const queue = {
    claimProcessBatch: vi.fn(
      overrides.claimProcessBatch ??
        (async () => [{ id: INFERENCE_ID, processAttempts: 0 }]),
    ),
    markProcessRetry: vi.fn(
      overrides.markProcessRetry ?? (async () => 1),
    ),
    markProcessDone: vi.fn(overrides.markProcessDone ?? (async () => 1)),
  };
  const repository = {
    findExecution: vi.fn(
      overrides.findExecution ?? (async () => execution()),
    ),
    saveTerminalResult: vi.fn(
      overrides.saveTerminalResult ?? (async () => true),
    ),
  };
  const processor = vi.fn(overrides.processor ?? (async () => outcome()));
  const logger = vi.fn();
  const poller = createInferencePoller({
    repository: repository as never,
    queue: queue as never,
    processor: processor as never,
    intervalMs: 0,
    logger,
  });
  return { poller, queue, repository, processor, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostgreSQL inference poller", () => {
  it("claims a bounded due batch and runs the processor with rebuilt DB context", async () => {
    const deps = dependencies();

    await deps.poller.runOnce();

    expect(deps.queue.claimProcessBatch).toHaveBeenCalledWith(
      INFERENCE_PROCESS_BATCH_SIZE,
    );
    expect(deps.repository.findExecution).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.processor).toHaveBeenCalledTimes(1);
    expect(deps.processor).toHaveBeenCalledWith({
      inferenceId: INFERENCE_ID,
      imageId: IMAGE_ID,
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
      modelVersion: FAKE_MANIFEST_VERSION,
      expectedContext: {
        schemaVersion: "ml-zscore-f32-v1",
        fingerprintSha256: prepared.contextFingerprintSha256,
      },
    });
    expect(deps.processor.mock.calls[0]![0]).not.toHaveProperty("imageUrl");
    expect(deps.queue.markProcessRetry).not.toHaveBeenCalled();
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.repository.saveTerminalResult).not.toHaveBeenCalled();
  });

  it("consumes one retryable attempt and clears the lease before retrying", async () => {
    const deps = dependencies({
      markProcessRetry: vi.fn(async () => 1),
      processor: vi.fn(async () => {
        throw new InferenceRetryableError();
      }),
    });

    await deps.poller.runOnce();

    expect(deps.queue.markProcessRetry).toHaveBeenCalledTimes(1);
    expect(deps.queue.markProcessRetry).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.queue.markProcessDone).not.toHaveBeenCalled();
    expect(deps.repository.saveTerminalResult).not.toHaveBeenCalled();
    expect(deps.logger).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "retry_scheduled",
        inferenceId: INFERENCE_ID,
        attempt: 1,
        errorCode: "retryable",
      }),
    );
  });

  it("does not persist FAILED when the retry row vanished", async () => {
    const deps = dependencies({
      markProcessRetry: vi.fn(async () => null),
      processor: vi.fn(async () => {
        throw new InferenceRetryableError();
      }),
    });

    await deps.poller.runOnce();

    expect(deps.queue.markProcessRetry).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.repository.saveTerminalResult).not.toHaveBeenCalled();
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
  });

  it("persists FAILED once when the third retryable failure exhausts attempts", async () => {
    const deps = dependencies({
      claimProcessBatch: vi.fn(async () => [
        { id: INFERENCE_ID, processAttempts: 2 },
      ]),
      markProcessRetry: vi.fn(async () => 3),
      processor: vi.fn(async () => {
        throw new InferenceRetryableError();
      }),
    });

    await deps.poller.runOnce();

    expect(deps.queue.markProcessRetry).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.repository.saveTerminalResult).toHaveBeenCalledTimes(1);
    expect(deps.repository.saveTerminalResult).toHaveBeenCalledWith(
      INFERENCE_ID,
      failedTerminalUpdate(),
    );
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "failed_exhausted",
        inferenceId: INFERENCE_ID,
        attempt: 3,
      }),
    );
  });

  it("persists FAILED immediately for a terminal processor error without retry", async () => {
    const deps = dependencies({
      processor: vi.fn(async () => {
        throw new InferenceTerminalError("invalid_job_context");
      }),
    });

    await deps.poller.runOnce();

    expect(deps.queue.markProcessRetry).not.toHaveBeenCalled();
    expect(deps.repository.saveTerminalResult).toHaveBeenCalledTimes(1);
    expect(deps.repository.saveTerminalResult).toHaveBeenCalledWith(
      INFERENCE_ID,
      failedTerminalUpdate(),
    );
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "failed",
        errorCode: "invalid_job_context",
      }),
    );
  });

  it("does not call the processor when a racing worker already persisted a terminal status", async () => {
    const deps = dependencies({
      findExecution: vi.fn(async () => execution({ status: "COMPLETED" })),
    });

    await deps.poller.runOnce();

    expect(deps.processor).not.toHaveBeenCalled();
    expect(deps.repository.saveTerminalResult).not.toHaveBeenCalled();
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
  });

  it("rejects a snapshot-less execution as terminal invalid context", async () => {
    const deps = dependencies({
      findExecution: vi.fn(async () => execution({ snapshot: null })),
    });

    await deps.poller.runOnce();

    expect(deps.processor).not.toHaveBeenCalled();
    expect(deps.repository.saveTerminalResult).toHaveBeenCalledWith(
      INFERENCE_ID,
      failedTerminalUpdate(),
    );
    expect(deps.queue.markProcessDone).toHaveBeenCalledWith(INFERENCE_ID);
  });

  it("guards against overlapping runs and stops after close", async () => {
    let release: (value: ProcessInferenceOutcome) => void = () => {};
    const blocked = new Promise<ProcessInferenceOutcome>((resolve) => {
      release = resolve;
    });
    const deps = dependencies({
      processor: vi.fn(() => blocked),
    });

    const first = deps.poller.runOnce();
    const second = deps.poller.runOnce();
    expect(deps.queue.claimProcessBatch).toHaveBeenCalledTimes(1);

    release(outcome());
    await Promise.all([first, second]);

    deps.poller.stop();
    await deps.poller.runOnce();
    expect(deps.queue.claimProcessBatch).toHaveBeenCalledTimes(1);
  });
});

describe("buildInferenceJobData", () => {
  it("rejects a corrupt snapshot without inventing clinical context", () => {
    expect(() =>
      buildInferenceJobData(
        execution({
          snapshot: {
            id: SNAPSHOT_ID,
            rawPayload: {},
            normalizedPayload: {},
            schemaVersion: "ml-zscore-f32-v1",
            modelVersions: {},
          } as never,
        }),
      ),
    ).toThrow(InferenceTerminalError);
  });

  it("rejects a snapshot whose context fingerprint is not sha256 hex", () => {
    expect(() =>
      buildInferenceJobData(
        execution({
          snapshot: {
            id: SNAPSHOT_ID,
            consultationId: CONSULTATION_ID,
            rawPayload: { eyeSide: "OD", clinicalFeatures: FEATURES },
            normalizedPayload: {
              ...prepared.normalizedPayload,
              eyeSide: "OD",
              contextFingerprintSha256: "not-a-sha256",
            },
            schemaVersion: "ml-zscore-f32-v1",
            modelVersions: prepared.modelVersions,
          } as never,
        }),
      ),
    ).toThrowError(new InferenceTerminalError("invalid_job_context"));
  });

  it("preserves safe error codes", () => {
    expect(safeErrorCode(new InferenceTerminalError("invalid_result"))).toBe(
      "invalid_result",
    );
    expect(safeErrorCode(new InferenceRetryableError())).toBe("retryable");
    expect(safeErrorCode(new Error("boom"))).toBe("Error");
    expect(safeErrorCode("boom")).toBe("unknown");
  });
});

describe("inference worker bootstrap", () => {
  beforeEach(() => {
    mocks.startDispatchReconciler.mockClear();
    mocks.reconcilerStop.mockClear();
    mocks.createArtifactPublicationRepository.mockClear();
    mocks.createDefaultArtifactPublicationService.mockClear();
  });

  it("starts the reconciler and poller without Redis or BullMQ and stops both", () => {
    vi.useFakeTimers();
    try {
      const worker = startInferenceWorker();
      expect(mocks.startDispatchReconciler).toHaveBeenCalledTimes(1);
      expect(mocks.createArtifactPublicationRepository).toHaveBeenCalledTimes(1);
      expect(
        mocks.createDefaultArtifactPublicationService,
      ).toHaveBeenCalledTimes(1);
      worker.stop();
      expect(mocks.reconcilerStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a bounded PostgreSQL poll interval", () => {
    expect(INFERENCE_PROCESS_BATCH_SIZE).toBe(4);
    expect(INFERENCE_PROCESS_CLAIM_LEASE_SECONDS).toBe(300);
  });

  it("schedules exactly one poller timer and the composed stop() clears it", () => {
    vi.useFakeTimers();
    try {
      expect(vi.getTimerCount()).toBe(0);
      const worker = startInferenceWorker();
      // One interval for the poller; the mocked reconciler schedules none.
      expect(vi.getTimerCount()).toBe(1);
      worker.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
