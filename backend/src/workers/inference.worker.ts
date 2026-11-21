import { UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import {
  createInferenceRunRepository,
  type InferenceRunRepository,
} from "../repositories/inference-run.repo.js";
import { createIdempotencyRepository } from "../repositories/idempotency.repo.js";
import { parseArtifactLocation } from "../services/artifact-reference.js";
import { createInferenceDispatchService } from "../services/inference-dispatch.js";
import { mlClient } from "../services/ml-client.js";
import { StorageService } from "../services/storage.js";
import {
  INFERENCE_QUEUE_NAME,
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

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function safeErrorCode(error: unknown): string {
  if (error instanceof InferenceUnrecoverableError) return error.code;
  if (error instanceof InferenceRetryableError) return "retryable";
  if (error instanceof InferenceTerminalError) return error.message;
  if (error instanceof Error) return error.name;
  return "unknown";
}

class InferenceUnrecoverableError extends UnrecoverableError {
  constructor(readonly code: string) {
    super(code);
    this.name = "UnrecoverableError";
  }
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

/** Keeps the queue module (and its Redis client) out of worker import time. */
async function enqueueInferenceLazily(
  data: InferenceJobData,
): Promise<{ id?: string }> {
  const { enqueueInference } = await import("./inference.queue.js");
  return enqueueInference(data);
}

/** Maps terminal processor errors to BullMQ's no-retry error. */
export function createInferenceJobHandler(processor: InferenceProcessor) {
  return async (job: Pick<Job<InferenceJobData>, "data">) => {
    try {
      return await processor(job.data);
    } catch (error) {
      if (error instanceof InferenceTerminalError) {
        throw new InferenceUnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

/**
 * Persists FAILED once when the attempt is final. An attempt is final when
 * BullMQ exhausted the attempts or the processor threw UnrecoverableError,
 * which BullMQ marks failed without consuming the remaining attempts.
 * Non-final attempts return false without writing; the existing CAS protects
 * terminal COMPLETED/REVIEW_REQUIRED evidence.
 */
export async function persistInferenceFailure(
  db: Pick<InferenceRunRepository, "saveTerminalResult">,
  job: Pick<Job<InferenceJobData>, "attemptsMade" | "opts" | "data">,
  error: unknown,
): Promise<boolean> {
  const attempts = job.opts.attempts;
  const exhausted =
    typeof attempts === "number" &&
    attempts > 0 &&
    job.attemptsMade >= attempts;
  const unrecoverable =
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === "UnrecoverableError");
  if (!exhausted && !unrecoverable) {
    return false;
  }
  return db.saveTerminalResult(job.data.inferenceId, failedTerminalUpdate());
}

/**
 * BullMQ emits failed even when moveToFailed returns null (lock lost). Only
 * persist after confirming the job is actually in failed state; otherwise a
 * later COMPLETED by another worker could be overwritten.
 */
export async function handleFailedInferenceJob(
  db: Pick<InferenceRunRepository, "saveTerminalResult">,
  job: Pick<Job<InferenceJobData>, "attemptsMade" | "opts" | "data" | "isFailed">,
  error: unknown,
): Promise<boolean> {
  if (!(await job.isFailed())) {
    return false;
  }
  return persistInferenceFailure(db, job, error);
}

/** Preserved no-arg bootstrap. Redis is created only when this runs. */
export function startInferenceWorker(): Worker<InferenceJobData> {
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  connection.on("error", (error: Error) => {
    // Never print the connection URL or driver message.
    console.error("[Worker] Redis connection error", { error: error.name });
  });
  const runRepository = createInferenceRunRepository(prisma);
  const signMlDownloadUrl = createStorageSigner();
  const processor = createInferenceProcessor({
    db: runRepository,
    mlClient,
    signMlDownloadUrl,
    sleep,
    now: () => new Date(),
  });
  const jobHandler = createInferenceJobHandler(processor);
  const idempotencyRepository = createIdempotencyRepository(prisma);
  const dispatchService = createInferenceDispatchService({
    prisma,
    repository: idempotencyRepository,
    signMlDownloadUrl,
    enqueue: enqueueInferenceLazily,
  });
  const reconciler = startDispatchReconciler({
    repository: idempotencyRepository,
    dispatch: (record) => dispatchService.dispatchPendingExecution(record),
  });

  const worker = new Worker<InferenceJobData>(
    INFERENCE_QUEUE_NAME,
    jobHandler,
    {
      connection,
      concurrency: 4,
    },
  );

  worker.on("completed", (job) => {
    console.log(`[Worker] Inference job completed: ${job?.id ?? "unknown"}`);
  });

  worker.on("closed", () => {
    reconciler.stop();
  });

  worker.on("failed", (job, error) => {
    // Safe operational log: no driver messages, URLs, PHI or credentials.
    console.error(`[Worker] Inference job failed: ${job?.id ?? "unknown"}`, {
      code: safeErrorCode(error),
    });
    if (job) {
      void handleFailedInferenceJob(runRepository, job, error).catch(
        (persistError: unknown) => {
          console.error(
            `[Worker] Inference failure could not be persisted: ${job.id ?? "unknown"}`,
            { code: safeErrorCode(persistError) },
          );
        },
      );
    }
  });

  return worker;
}

if (
  process.argv[1]?.endsWith("inference.worker.ts") ||
  process.argv[1]?.endsWith("inference.worker.js")
) {
  console.log("[Worker] Starting standalone Clearsight BullMQ inference worker...");
  startInferenceWorker();
}
