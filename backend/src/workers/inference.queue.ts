import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  INFERENCE_QUEUE_NAME,
  type InferenceJobData,
} from "./inference.contracts.js";

export { INFERENCE_QUEUE_NAME } from "./inference.contracts.js";
export type {
  InferenceExpectedContext,
  InferenceJobData,
} from "./inference.contracts.js";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const inferenceQueue = new Queue<InferenceJobData>(INFERENCE_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueInference(data: InferenceJobData) {
  return inferenceQueue.add("run-inference", data, {
    jobId: data.inferenceId,
  });
}
