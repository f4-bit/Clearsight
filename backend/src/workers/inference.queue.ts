import { prisma } from "../lib/prisma.js";
import { createInferenceQueueRepository } from "../repositories/inference-queue.repo.js";
import type { InferenceJobData } from "./inference.contracts.js";

export type {
  InferenceExpectedContext,
  InferenceJobData,
} from "./inference.contracts.js";

const queueRepository = createInferenceQueueRepository(prisma);

/**
 * PostgreSQL-backed queue seam. It keeps the signature used by every call-site
 * but no longer talks to Redis/BullMQ: the inference row already exists, so the
 * only side effect is making it due for the worker poller.
 */
export async function enqueueInference(
  data: InferenceJobData,
): Promise<{ id: string }> {
  await queueRepository.markReady(data.inferenceId);
  return { id: data.inferenceId };
}
