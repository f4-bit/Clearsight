import type { InferenceCreate, InferenceResultUpdate } from "../schemas/inference.js";
import type { Db, JsonObject } from "./types.js";

export function createInferenceRepository(db: Db) {
  return {
    create: (input: InferenceCreate) =>
      db.inference.create({
        data: {
          imageId: input.imageId,
          jobId: input.jobId ?? null,
          modelVersion: input.modelVersion ?? null,
          consultationId: input.consultationId ?? null,
          eyeSide: input.eyeSide ?? null,
          snapshotId: input.snapshotId ?? null,
          reanalysisOfId: input.reanalysisOfId ?? null,
          status: input.status ?? null,
        },
      }),

    findById: (id: string) => db.inference.findUnique({ where: { id } }),

    findByJobId: (jobId: string) => db.inference.findUnique({ where: { jobId } }),

    /** Inference + its image + owning consultation (ownership checks, feedback). */
    findWithContext: (id: string) =>
      db.inference.findUnique({
        where: { id },
        include: { image: { include: { consultation: true } } },
      }),

    listByImage: (imageId: string) =>
      db.inference.findMany({ where: { imageId }, orderBy: { createdAt: "desc" } }),

    /** Persists the ML InferenceResult. */
    saveResult: (id: string, result: InferenceResultUpdate) =>
      db.inference.update({
        where: { id },
        data: {
          predictedClass: result.predictedClass,
          confidence: result.confidence,
          probabilities: result.probabilities as JsonObject,
          ...(result.modelVersions !== undefined && {
            modelVersions: result.modelVersions as JsonObject,
          }),
          ...(result.modelPredictions !== undefined && {
            modelPredictions: result.modelPredictions as JsonObject,
          }),
          cdr: result.cdr,
          cdrVertical: result.cdrVertical,
          quality: (result.quality ?? {}) as JsonObject,
          artifacts: (result.artifacts ?? {}) as JsonObject,
          elapsedSeconds: result.elapsedSeconds,
          gradcamPath: result.gradcamPath ?? null,
          ...(result.modelVersion !== undefined && { modelVersion: result.modelVersion }),
          ...(result.status !== undefined && { status: result.status }),
        },
      }),

    delete: (id: string) => db.inference.delete({ where: { id } }),
  };
}
export type InferenceRepository = ReturnType<typeof createInferenceRepository>;
