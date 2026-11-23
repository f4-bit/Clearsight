import { prisma } from "../lib/prisma.js";
import { ClinicalFeaturesSchema } from "../schemas/clinical.js";
import {
  createInferenceQueueRepository,
  type ClaimedInference,
  type InferenceQueueRepository,
} from "../repositories/inference-queue.repo.js";
import {
  createInferenceRunRepository,
  type InferenceRunExecution,
  type InferenceRunRepository,
} from "../repositories/inference-run.repo.js";
import { createArtifactPublicationRepository } from "../repositories/artifact-publication.repo.js";
import { createIdempotencyRepository } from "../repositories/idempotency.repo.js";
import { parseArtifactLocation } from "../services/artifact-reference.js";
import { createDefaultArtifactPublicationService } from "../services/artifact-publication.js";
import { createInferenceDispatchService } from "../services/inference-dispatch.js";
import { mlClient } from "../services/ml-client.js";
import { StorageService } from "../services/storage.js";
import {
  INFERENCE_PROCESS_BATCH_SIZE,
  INFERENCE_PROCESS_MAX_ATTEMPTS,
  INFERENCE_PROCESS_POLL_INTERVAL_MS,
  isTerminalInferenceStatus,
  type InferenceJobData,
} from "./inference.contracts.js";
import { startDispatchReconciler } from "./inference.reconciler.js";
import {
  createInferenceProcessor,
  failedTerminalUpdate,
  InferenceRetryableError,
  InferenceTerminalError,
  type InferenceProcessor,
} from "./inference.processor.js";
import { enqueueInference } from "./inference.queue.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface InferencePollerLogEvent {
  readonly code: string;
  readonly inferenceId?: string;
  readonly attempt?: number;
  readonly errorCode?: string;
}

export interface InferencePollerDeps {
  readonly repository: Pick<
    InferenceRunRepository,
    "findExecution" | "saveTerminalResult"
  >;
  readonly queue: Pick<
    InferenceQueueRepository,
    "claimProcessBatch" | "markProcessRetry" | "markProcessDone"
  >;
  readonly processor: InferenceProcessor;
  readonly logger?: (event: InferencePollerLogEvent) => void;
  /** 0 disables the timer; `runOnce()` remains available for tests. */
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export interface InferencePoller {
  runOnce(): Promise<void>;
  stop(): void;
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof InferenceTerminalError) return error.message;
  if (error instanceof InferenceRetryableError) return "retryable";
  if (error instanceof Error) return error.name;
  return "unknown";
}

function defaultLogger(event: InferencePollerLogEvent): void {
  if (event.code === "completed") {
    console.log("[Worker] Inference completed", event);
    return;
  }
  // Safe operational log: no driver messages, URLs, PHI or credentials.
  console.error("[Worker] Inference processing issue", event);
}

function isTerminalProcessingError(error: unknown): boolean {
  return (
    error instanceof InferenceTerminalError ||
    (error instanceof Error && error.name === "UnrecoverableError")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reconstructs the processor input from the immutable DB execution. The queue
 * no longer stores clinical data, and the payload never carries `imageUrl`: JIT
 * signing happens in the processor from the trusted storagePath.
 */
export function buildInferenceJobData(
  execution: InferenceRunExecution,
): InferenceJobData {
  const snapshot = execution.snapshot;
  if (snapshot === null) {
    // Without the pinned snapshot there is no trusted clinical context.
    throw new InferenceTerminalError("invalid_job_context");
  }

  const rawPayload = asRecord(snapshot.rawPayload);
  const normalizedPayload = asRecord(snapshot.normalizedPayload);
  if (rawPayload === null || normalizedPayload === null) {
    throw new InferenceTerminalError("invalid_job_context");
  }

  const clinicalFeatures = ClinicalFeaturesSchema.safeParse(
    rawPayload.clinicalFeatures,
  );
  const fingerprint = normalizedPayload.contextFingerprintSha256;
  const eyeSide = execution.image.eyeSide;
  if (
    !clinicalFeatures.success ||
    typeof fingerprint !== "string" ||
    !SHA256_HEX.test(fingerprint) ||
    (eyeSide !== "OD" && eyeSide !== "OS") ||
    rawPayload.eyeSide !== eyeSide ||
    (execution.eyeSide !== null && execution.eyeSide !== eyeSide) ||
    execution.image.id !== execution.imageId
  ) {
    throw new InferenceTerminalError("invalid_job_context");
  }

  const snapshotVersions = asRecord(snapshot.modelVersions);
  const manifest = snapshotVersions?.manifest;
  const modelVersion =
    execution.modelVersion ??
    (typeof manifest === "string" && manifest !== "" ? manifest : null);

  return {
    inferenceId: execution.id,
    imageId: execution.imageId,
    eyeSide,
    clinicalFeatures: clinicalFeatures.data,
    modelVersion,
    expectedContext: {
      schemaVersion: snapshot.schemaVersion,
      fingerprintSha256: fingerprint,
    },
  };
}

/**
 * Bounded PostgreSQL poller: claims due, unleased QUEUED rows with SKIP LOCKED
 * and an explicit lease, rebuilds the job input from the DB, and runs the
 * unchanged processor. Retryable failures increment `process_attempts`, clear
 * the lease and schedule exponential backoff; terminal failures or exhaustion
 * persist FAILED through the existing CAS and release the lease.
 */
export function createInferencePoller(
  deps: InferencePollerDeps,
): InferencePoller {
  const intervalMs = deps.intervalMs ?? INFERENCE_PROCESS_POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? INFERENCE_PROCESS_BATCH_SIZE;
  const maxAttempts = deps.maxAttempts ?? INFERENCE_PROCESS_MAX_ATTEMPTS;
  const logger = deps.logger ?? defaultLogger;
  const schedule = deps.setIntervalFn ?? setInterval;
  const unschedule = deps.clearIntervalFn ?? clearInterval;

  let running = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const persistFailed = async (inferenceId: string): Promise<void> => {
    // The repository compare-and-set never overwrites COMPLETED/REVIEW_REQUIRED.
    await deps.repository.saveTerminalResult(
      inferenceId,
      failedTerminalUpdate(),
    );
  };

  const releaseLease = async (inferenceId: string): Promise<void> => {
    try {
      await deps.queue.markProcessDone(inferenceId);
    } catch (error) {
      // The lease expires on its own; never turn a release failure into a retry.
      logger({
        code: "lease_release_failed",
        inferenceId,
        errorCode: safeErrorCode(error),
      });
    }
  };

  const handleFailure = async (
    claimed: ClaimedInference,
    error: unknown,
  ): Promise<void> => {
    const errorCode = safeErrorCode(error);
    if (isTerminalProcessingError(error)) {
      await persistFailed(claimed.id);
      await releaseLease(claimed.id);
      logger({ code: "failed", inferenceId: claimed.id, errorCode });
      return;
    }

    const attempt = await deps.queue.markProcessRetry(claimed.id);
    if (attempt === null) {
      // The row vanished between claim and failure handling.
      await releaseLease(claimed.id);
      logger({ code: "retry_not_applied", inferenceId: claimed.id, errorCode });
      return;
    }
    if (attempt >= maxAttempts) {
      // The retry consumed the final attempt; persist FAILED through the CAS.
      await persistFailed(claimed.id);
      await releaseLease(claimed.id);
      logger({ code: "failed_exhausted", inferenceId: claimed.id, attempt, errorCode });
      return;
    }

    logger({ code: "retry_scheduled", inferenceId: claimed.id, attempt, errorCode });
  };

  const processClaimed = async (claimed: ClaimedInference): Promise<void> => {
    const execution = await deps.repository.findExecution(claimed.id);
    if (execution === null) {
      await releaseLease(claimed.id);
      return;
    }
    if (isTerminalInferenceStatus(execution.status)) {
      // A racing worker already persisted the terminal result.
      await releaseLease(claimed.id);
      return;
    }
    const data = buildInferenceJobData(execution);
    const outcome = await deps.processor(data);
    await releaseLease(claimed.id);
    logger({
      code: "completed",
      inferenceId: outcome.inferenceId,
    });
  };

  const runOnce = async (): Promise<void> => {
    if (running || closed) return;
    running = true;
    try {
      const claimed = await deps.queue.claimProcessBatch(batchSize);
      for (const item of claimed) {
        if (closed) break;
        try {
          await processClaimed(item);
        } catch (error) {
          try {
            await handleFailure(item, error);
          } catch (persistError) {
            logger({
              code: "process_failed",
              inferenceId: item.id,
              errorCode: safeErrorCode(persistError),
            });
          }
        }
      }
    } catch (error) {
      logger({ code: "claim_failed", errorCode: safeErrorCode(error) });
    } finally {
      running = false;
    }
  };

  if (intervalMs > 0) {
    timer = schedule(() => {
      void runOnce();
    }, intervalMs);
    // The timer must stay ref'd: in the standalone worker the Prisma pool is
    // lazy, so an unref'd timer would let the event loop drain and the process
    // exit before the first poll runs.
  }

  return {
    runOnce,
    stop() {
      closed = true;
      if (timer !== null) {
        unschedule(timer);
        timer = null;
      }
    },
  };
}

function createStorageSigner(): (storagePath: string) => Promise<string> {
  return async (storagePath) => {
    const location = parseArtifactLocation(
      storagePath,
      StorageService.getArtifactReferenceContext("image"),
    );
    return StorageService.getMlDownloadUrl(
      location.bucketOrContainer,
      location.key,
    );
  };
}

/**
 * Preserved no-arg bootstrap. The reconciler (dispatch + publication) and the
 * poller run in the same process; stop() stops both. No Redis connection is
 * opened anywhere.
 */
export function startInferenceWorker(): InferencePoller {
  const runRepository = createInferenceRunRepository(prisma);
  const queueRepository = createInferenceQueueRepository(prisma);
  const signMlDownloadUrl = createStorageSigner();
  const processor = createInferenceProcessor({
    db: runRepository,
    mlClient,
    signMlDownloadUrl,
    sleep,
    now: () => new Date(),
  });
  const idempotencyRepository = createIdempotencyRepository(prisma);
  const dispatchService = createInferenceDispatchService({
    prisma,
    repository: idempotencyRepository,
    signMlDownloadUrl,
    enqueue: enqueueInference,
  });
  const publicationRepository = createArtifactPublicationRepository(prisma);
  const publicationService = createDefaultArtifactPublicationService(prisma);
  const reconciler = startDispatchReconciler({
    repository: idempotencyRepository,
    dispatch: (record) => dispatchService.dispatchPendingExecution(record),
    publication: {
      findCandidates: (limit) =>
        publicationRepository.findPublicationCandidates(limit),
      publish: (inferenceId) => publicationService.publish(inferenceId),
    },
  });

  const poller = createInferencePoller({
    repository: runRepository,
    queue: queueRepository,
    processor,
  });

  console.log("[Worker] PostgreSQL inference poller started");

  return {
    runOnce: poller.runOnce,
    stop() {
      poller.stop();
      reconciler.stop();
    },
  };
}

if (
  process.argv[1]?.endsWith("inference.worker.ts") ||
  process.argv[1]?.endsWith("inference.worker.js")
) {
  console.log("[Worker] Starting standalone Clearsight PostgreSQL inference worker...");
  startInferenceWorker();
  // Ref'd keep-alive: the standalone process must not exit even if a timer is
  // unexpectedly unref'd while the lazy Prisma pool has no other handles.
  setInterval(() => {}, 1 << 30);
}
