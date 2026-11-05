import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const INFERENCE_QUEUE_NAME = "inference-jobs";

export interface InferenceJobData {
  inferenceId: string;
  imageId: string;
  imageUrl: string;
  eyeSide: "OD" | "OS";
  clinicalFeatures: any;
  modelVersion?: string | null;
}

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
