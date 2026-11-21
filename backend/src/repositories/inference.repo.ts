import type { InferenceCreate } from "../schemas/inference.js";
import type { Db } from "./types.js";

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

    delete: (id: string) => db.inference.delete({ where: { id } }),
  };
}
export type InferenceRepository = ReturnType<typeof createInferenceRepository>;
