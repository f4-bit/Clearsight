import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createInferenceRunRepository } from "../repositories/inference-run.repo.js";
import { mlClient } from "../services/ml-client.js";
import {
  INFERENCE_QUEUE_NAME,
  type InferenceJobData,
} from "./inference.contracts.js";
import {
  createInferenceProcessor,
  InferenceRetryableError,
  InferenceTerminalError,
} from "./inference.processor.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function safeErrorCode(error: Error): string {
  if (error instanceof InferenceRetryableError) return "retryable";
  if (error instanceof InferenceTerminalError) return error.message;
  return error.name;
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
  const processor = createInferenceProcessor({
    db: createInferenceRunRepository(prisma),
    mlClient,
    sleep,
    now: () => new Date(),
  });

  const worker = new Worker<InferenceJobData>(
    INFERENCE_QUEUE_NAME,
    async (job) => processor(job.data),
    {
      connection,
      concurrency: 4,
    },
  );

  worker.on("completed", (job) => {
    console.log(`[Worker] Inference job completed: ${job?.id ?? "unknown"}`);
  });

  worker.on("failed", (job, error) => {
    // Safe operational log: no driver messages, URLs, PHI or credentials.
    console.error(`[Worker] Inference job failed: ${job?.id ?? "unknown"}`, {
      code: safeErrorCode(error),
    });
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
