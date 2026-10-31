import type { Db, JsonObject } from "./types.js";

export interface FeedbackVerdictInput {
  consultationId: string;
  inferenceId: string;
  doctorId: string;
  predictedClass: number | null;
  /** null = "no concluyente". */
  validatedClass: number | null;
  confidence: number | null;
  agreement: boolean | null;
  doctorNotes: string | null;
  isGoldStandard: boolean;
  /** Snapshot of the clinical features used by the model at validation time. */
  clinicalData: Record<string, unknown>;
}

export function createFeedbackRepository(db: Db) {
  return {
    /**
     * One verdict per (inference, doctor): inserts, or overwrites the doctor's
     * previous verdict for that inference. Atomic (INSERT ... ON CONFLICT).
     */
    upsertVerdict: (input: FeedbackVerdictInput) => {
      const fields = {
        consultationId: input.consultationId,
        predictedClass: input.predictedClass,
        validatedClass: input.validatedClass,
        confidence: input.confidence,
        agreement: input.agreement,
        doctorNotes: input.doctorNotes,
        isGoldStandard: input.isGoldStandard,
        clinicalData: input.clinicalData as JsonObject,
      };
      return db.clinicalFeedback.upsert({
        where: {
          inferenceId_doctorId: { inferenceId: input.inferenceId, doctorId: input.doctorId },
        },
        create: { ...fields, inferenceId: input.inferenceId, doctorId: input.doctorId },
        update: fields,
      });
    },

    findById: (id: string) => db.clinicalFeedback.findUnique({ where: { id } }),

    findByInferenceAndDoctor: (inferenceId: string, doctorId: string) =>
      db.clinicalFeedback.findUnique({
        where: { inferenceId_doctorId: { inferenceId, doctorId } },
      }),

    listByConsultation: (consultationId: string) =>
      db.clinicalFeedback.findMany({
        where: { consultationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),

    countGoldStandard: (since?: Date) =>
      db.clinicalFeedback.count({
        where: { isGoldStandard: true, validatedClass: { not: null }, ...(since && { updatedAt: { gt: since } }) },
      }),

    /**
     * Gold-standard rows for retraining, oldest-updated first. Fetches
     * `limit + 1` so callers can tell whether more rows exist.
     */
    listGoldStandard: (opts: { since?: Date; limit: number }) =>
      db.clinicalFeedback.findMany({
        where: {
          isGoldStandard: true,
          validatedClass: { not: null },
          ...(opts.since && { updatedAt: { gt: opts.since } }),
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: opts.limit + 1,
        select: {
          inferenceId: true,
          doctorId: true,
          validatedClass: true,
          predictedClass: true,
          agreement: true,
          isGoldStandard: true,
          clinicalData: true,
          updatedAt: true,
          consultation: { select: { clinicalData: true } },
          inference: {
            select: {
              modelVersion: true,
              image: { select: { eyeSide: true, storagePath: true } },
            },
          },
        },
      }),

    delete: (id: string) => db.clinicalFeedback.delete({ where: { id } }),
  };
}
export type FeedbackRepository = ReturnType<typeof createFeedbackRepository>;
