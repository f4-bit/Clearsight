import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workerInstance = { on: vi.fn() };
  const redisInstance = { on: vi.fn() };
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
  const createArtifactPublicationRepository = vi.fn(
    () => publicationRepository,
  );
  const createDefaultArtifactPublicationService = vi.fn(
    () => publicationService,
  );
  return {
    redis: vi.fn(function () {
      return redisInstance;
    }),
    redisInstance,
    worker: vi.fn(function (..._args: unknown[]) {
      return workerInstance;
    }),
    workerInstance,
    reconcilerStop,
    reconcilerRunOnce,
    startDispatchReconciler,
    publicationRepository,
    publicationService,
    createArtifactPublicationRepository,
    createDefaultArtifactPublicationService,
  };
});

vi.mock("ioredis", () => ({ Redis: mocks.redis }));
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  return { ...actual, Worker: mocks.worker };
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

import { UnrecoverableError } from "bullmq";
import {
  createInferenceJobHandler,
  handleFailedInferenceJob,
  persistInferenceFailure,
  safeErrorCode,
  startInferenceWorker,
} from "../../src/workers/inference.worker.js";
import { INFERENCE_DEFAULT_JOB_OPTIONS } from "../../src/workers/inference.contracts.js";
import {
  InferenceRetryableError,
  InferenceTerminalError,
} from "../../src/workers/inference.processor.js";

describe("inference worker bootstrap", () => {
  beforeEach(() => {
    mocks.redis.mockClear();
    mocks.redisInstance.on.mockClear();
    mocks.worker.mockClear();
    mocks.workerInstance.on.mockClear();
    mocks.startDispatchReconciler.mockClear();
    mocks.reconcilerStop.mockClear();
    mocks.reconcilerRunOnce.mockClear();
    mocks.createArtifactPublicationRepository.mockClear();
    mocks.createDefaultArtifactPublicationService.mockClear();
    mocks.publicationRepository.findPublicationCandidates.mockClear();
    mocks.publicationService.publish.mockClear();
  });

  it("does not open Redis at import and only does it inside the no-arg boot", () => {
    expect(mocks.redis).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();

    const worker = startInferenceWorker();

    expect(worker).toBe(mocks.workerInstance);
    expect(mocks.redis).toHaveBeenCalledTimes(1);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
    expect(mocks.redisInstance.on).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls[0]![0]).toBe("inference-jobs");
    expect(mocks.worker.mock.calls[0]![2]).toMatchObject({ concurrency: 4 });
    expect(mocks.workerInstance.on).toHaveBeenCalledTimes(3);
    expect(
      mocks.workerInstance.on.mock.calls.map((call) => call[0]),
    ).toEqual(["completed", "closed", "failed"]);
  });

  it("fixes the queue defaultJobOptions", () => {
    expect(INFERENCE_DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  });

  it("starts the dispatch reconciler with the repository and stops it on worker close", async () => {
    startInferenceWorker();

    expect(mocks.startDispatchReconciler).toHaveBeenCalledTimes(1);
    const deps = mocks.startDispatchReconciler.mock.calls[0]![0] as {
      repository: unknown;
      dispatch: (record: unknown) => Promise<unknown>;
      publication?: {
        findCandidates: (limit: number) => Promise<readonly string[]>;
        publish: (inferenceId: string) => Promise<unknown>;
      };
      intervalMs?: number;
      batchSize?: number;
    };
    expect(deps.repository).toBeDefined();
    expect(typeof deps.dispatch).toBe("function");
    expect(deps.intervalMs).toBeUndefined();
    expect(deps.batchSize).toBeUndefined();
    expect(deps.publication).toBeDefined();
    expect(mocks.createArtifactPublicationRepository).toHaveBeenCalledTimes(1);
    expect(
      mocks.createDefaultArtifactPublicationService,
    ).toHaveBeenCalledTimes(1);

    await deps.publication!.findCandidates(7);
    expect(
      mocks.publicationRepository.findPublicationCandidates,
    ).toHaveBeenCalledWith(7);
    await deps.publication!.publish(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(mocks.publicationService.publish).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    const closed = mocks.workerInstance.on.mock.calls.find(
      (call) => call[0] === "closed",
    )?.[1] as () => void;
    expect(typeof closed).toBe("function");
    closed();
    expect(mocks.reconcilerStop).toHaveBeenCalledTimes(1);
  });
});

describe("inference worker terminal handling", () => {
  const job = (attemptsMade: number, attempts = 3) =>
    ({
      attemptsMade,
      opts: { attempts },
      data: { inferenceId: "11111111-1111-4111-8111-111111111111" },
    }) as never;

  it("persists FAILED once when attempts are exhausted", async () => {
    const saveTerminalResult = vi.fn(
      async (_inferenceId: string, _update: unknown) => true,
    );
    const db = { saveTerminalResult };

    await expect(
      persistInferenceFailure(db, job(3), new Error("retryable exhausted")),
    ).resolves.toBe(true);
    expect(saveTerminalResult).toHaveBeenCalledTimes(1);
    expect(saveTerminalResult).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        status: "FAILED",
        predictedClass: null,
        confidence: null,
        probabilities: {},
        modelVersions: {},
        modelPredictions: {},
        cdr: null,
        cdrVertical: null,
        quality: {},
        artifacts: {},
        elapsedSeconds: null,
        gradcamPath: null,
      },
    );
    expect(saveTerminalResult.mock.calls[0]![1]).not.toHaveProperty(
      "modelVersion",
    );
  });

  it("does not write on a non-final retryable attempt", async () => {
    const saveTerminalResult = vi.fn(async () => true);

    await expect(
      persistInferenceFailure(
        { saveTerminalResult },
        job(2),
        new Error("retryable"),
      ),
    ).resolves.toBe(false);
    expect(saveTerminalResult).not.toHaveBeenCalled();
  });

  it("persists FAILED for UnrecoverableError before attempts are exhausted", async () => {
    const saveTerminalResult = vi.fn(
      async (_inferenceId: string, _update: unknown) => true,
    );

    await expect(
      persistInferenceFailure(
        { saveTerminalResult },
        job(1),
        new UnrecoverableError("invalid_job_context"),
      ),
    ).resolves.toBe(true);
    expect(saveTerminalResult).toHaveBeenCalledTimes(1);
  });

  it("maps terminal processor errors to UnrecoverableError", async () => {
    const handler = createInferenceJobHandler(
      (async () => {
        throw new InferenceTerminalError("invalid_job_context");
      }) as never,
    );

    await expect(handler(job(0))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("preserves the terminal code through the UnrecoverableError wrapper", async () => {
    const handler = createInferenceJobHandler(
      (async () => {
        throw new InferenceTerminalError("ml_rejected");
      }) as never,
    );
    const error: unknown = await handler(job(0)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(safeErrorCode(error)).toBe("ml_rejected");
    expect(safeErrorCode(error)).not.toBe("UnrecoverableError");
  });

  it("does not persist when the job is not actually failed (lock lost)", async () => {
    const saveTerminalResult = vi.fn(
      async (_inferenceId: string, _update: unknown) => true,
    );
    const failedJob = {
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: { inferenceId: "11111111-1111-4111-8111-111111111111" },
      isFailed: vi.fn(async () => false),
    } as never;

    await expect(
      handleFailedInferenceJob(
        { saveTerminalResult },
        failedJob,
        new Error("lock lost"),
      ),
    ).resolves.toBe(false);
    expect(saveTerminalResult).not.toHaveBeenCalled();
  });

  it("persists exactly once when the job is actually failed", async () => {
    const saveTerminalResult = vi.fn(
      async (_inferenceId: string, _update: unknown) => true,
    );
    const failedJob = {
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: { inferenceId: "11111111-1111-4111-8111-111111111111" },
      isFailed: vi.fn(async () => true),
    } as never;

    await expect(
      handleFailedInferenceJob(
        { saveTerminalResult },
        failedJob,
        new Error("exhausted"),
      ),
    ).resolves.toBe(true);
    expect(saveTerminalResult).toHaveBeenCalledTimes(1);
  });

  it("keeps retryable errors retryable", async () => {
    const retryable = new InferenceRetryableError();
    const handler = createInferenceJobHandler(
      (async () => {
        throw retryable;
      }) as never,
    );

    await expect(handler(job(0))).rejects.toBe(retryable);
  });

  it("ends a terminal error without retry and persists FAILED exactly once with no processor write", async () => {
    const saveTerminalResult = vi.fn(
      async (_inferenceId: string, _update: unknown) => true,
    );
    const db = { saveTerminalResult };
    const processor = vi.fn(async () => {
      throw new InferenceTerminalError("invalid_result");
    });
    const handler = createInferenceJobHandler(processor as never);

    // BullMQ 5.81.5 nuance: the final marker arrives with attemptsMade=1.
    const failure = handler(job(1));
    await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
    const error: unknown = await failure.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: "invalid_result" });

    // The handler neither retries nor writes; only the failed event persists.
    expect(processor).toHaveBeenCalledTimes(1);
    await expect(persistInferenceFailure(db, job(1), error)).resolves.toBe(
      true,
    );
    expect(saveTerminalResult).toHaveBeenCalledTimes(1);
    expect(saveTerminalResult).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        status: "FAILED",
        predictedClass: null,
        confidence: null,
        probabilities: {},
        modelVersions: {},
        modelPredictions: {},
        cdr: null,
        cdrVertical: null,
        quality: {},
        artifacts: {},
        elapsedSeconds: null,
        gradcamPath: null,
      },
    );
    expect(saveTerminalResult.mock.calls[0]![1]).not.toHaveProperty(
      "modelVersion",
    );
  });
});
