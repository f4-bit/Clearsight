import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../lib/prisma.js";
import {
  INFERENCE_TERMINAL_STATUSES,
  type InferenceTerminalStatus,
} from "../workers/inference.contracts.js";

export type InferenceRunExecution = Prisma.InferenceGetPayload<{
  include: { image: true; snapshot: true };
}>;

export interface TerminalInferenceUpdate {
  status: InferenceTerminalStatus;
  predictedClass?: number | null;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  cdr?: number | null;
  cdrVertical?: number | null;
  quality?: Record<string, unknown>;
  artifacts?: Record<string, string>;
  elapsedSeconds?: number | null;
  gradcamPath?: string | null;
  modelVersion?: string | null;
}

export interface InferenceRunRepository {
  findExecution(inferenceId: string): Promise<InferenceRunExecution | null>;
  /** Compare-and-set: never overwrites an already terminal inference. */
  saveTerminalResult(
    inferenceId: string,
    update: TerminalInferenceUpdate,
  ): Promise<boolean>;
}

export function createInferenceRunRepository(
  db: PrismaClient,
): InferenceRunRepository {
  return {
    findExecution: (inferenceId) =>
      db.inference.findUnique({
        where: { id: inferenceId },
        include: { image: true, snapshot: true },
      }),

    saveTerminalResult: async (inferenceId, update) => {
      const data: Prisma.InferenceUpdateManyMutationInput = {
        status: update.status,
        ...(update.predictedClass !== undefined && {
          predictedClass: update.predictedClass,
        }),
        ...(update.confidence !== undefined && { confidence: update.confidence }),
        ...(update.probabilities !== undefined && {
          probabilities: update.probabilities as Prisma.InputJsonValue,
        }),
        ...(update.cdr !== undefined && { cdr: update.cdr }),
        ...(update.cdrVertical !== undefined && {
          cdrVertical: update.cdrVertical,
        }),
        ...(update.quality !== undefined && {
          quality: update.quality as Prisma.InputJsonValue,
        }),
        ...(update.artifacts !== undefined && {
          artifacts: update.artifacts as Prisma.InputJsonValue,
        }),
        ...(update.elapsedSeconds !== undefined && {
          elapsedSeconds: update.elapsedSeconds,
        }),
        ...(update.gradcamPath !== undefined && {
          gradcamPath: update.gradcamPath,
        }),
        ...(update.modelVersion !== undefined && {
          modelVersion: update.modelVersion,
        }),
      };
      const result = await db.inference.updateMany({
        where: {
          id: inferenceId,
          OR: [
            { status: null },
            { status: { notIn: [...INFERENCE_TERMINAL_STATUSES] } },
          ],
        },
        data,
      });
      return result.count === 1;
    },
  };
}
