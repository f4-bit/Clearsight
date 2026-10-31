import { z } from "zod";
import { DiagnosticClass, Probabilities, Uuid } from "./common.js";

export const InferenceCreate = z.object({
  imageId: Uuid,
  jobId: Uuid.nullish(),
  modelVersion: z.string().max(128).nullish(),
});
export type InferenceCreate = z.input<typeof InferenceCreate>;

/** What the worker writes back when the ML service finishes (InferenceResult). */
export const InferenceResultUpdate = z.object({
  predictedClass: DiagnosticClass.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  probabilities: Probabilities,
  cdr: z.number().nullable(),
  cdrVertical: z.number().nullable(),
  quality: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.string()).default({}),
  elapsedSeconds: z.number().min(0).nullable(),
  gradcamPath: z.string().nullish(),
  modelVersion: z.string().max(128).nullish(),
});
export type InferenceResultUpdate = z.input<typeof InferenceResultUpdate>;
