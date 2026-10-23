import { z } from "zod";
import { clinicalFeaturesSchema } from "./clinical.js";
import { eyeSideEnum } from "./image.js";

export const jobStatusEnum = z.enum([
  "QUEUED",
  "DOWNLOADING",
  "LOCALIZING",
  "SEGMENTING",
  "CLASSIFYING",
  "COMPLETED",
  "REVIEW_REQUIRED",
  "FAILED",
]);

export type JobStatus = z.infer<typeof jobStatusEnum>;

export const inferenceCreateSchema = z.object({
  inferenceId: z.string().uuid().optional(),
  imageId: z.string().uuid(),
  imageUrl: z.string().url().optional(),
  eyeSide: eyeSideEnum,
  clinicalFeatures: clinicalFeaturesSchema,
  modelVersion: z.string().optional().nullable(),
});

export type InferenceCreate = z.infer<typeof inferenceCreateSchema>;

export const modelPredictionSchema = z.object({
  probabilities: z.record(z.number()),
  predictedClass: z.string(),
  confidence: z.number(),
});

export type ModelPrediction = z.infer<typeof modelPredictionSchema>;

export const inferenceResultSchema = z.object({
  inferenceId: z.string().uuid(),
  eyeSide: eyeSideEnum,
  label: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  probabilities: z.record(z.number()),
  modelPredictions: z.record(modelPredictionSchema),
  cdr: z.number().nullable().optional(),
  cdrVertical: z.number().nullable().optional(),
  quality: z.record(z.any()),
  artifacts: z.record(z.string()),
  modelVersions: z.record(z.string()),
  elapsedSeconds: z.number(),
});

export type InferenceResult = z.infer<typeof inferenceResultSchema>;

export const jobAcceptedSchema = z.object({
  inferenceId: z.string().uuid(),
  jobId: z.string(),
  status: jobStatusEnum,
});

export type JobAccepted = z.infer<typeof jobAcceptedSchema>;

export const jobResponseSchema = z.object({
  inferenceId: z.string().uuid(),
  jobId: z.string(),
  status: jobStatusEnum,
  stage: z.string(),
  message: z.string().nullable().optional(),
  result: inferenceResultSchema.nullable().optional(),
});

export type JobResponse = z.infer<typeof jobResponseSchema>;
