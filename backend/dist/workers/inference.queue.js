import { Queue } from "bullmq";
import { env } from "../config/env.js";
const connection = {
    url: env.REDIS_URL,
};
export const INFERENCE_QUEUE_NAME = "inference-jobs";
export const inferenceQueue = new Queue(INFERENCE_QUEUE_NAME, {
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
export async function enqueueInference(data) {
    return inferenceQueue.add("run-inference", data, {
        jobId: data.inferenceId,
    });
}
//# sourceMappingURL=inference.queue.js.map