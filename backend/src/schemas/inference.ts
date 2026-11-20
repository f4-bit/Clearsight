import { z } from "zod";
import { ClinicalFeaturesSchema } from "./clinical.js";
import { DiagnosticClass, JobStatus, Probabilities, Uuid } from "./common.js";
import { eyeSideEnum } from "./image.js";

export const jobStatusEnum = JobStatus;

export const inferenceCreateSchema = z
  .object({
    imageId: z.string().uuid(),
    // The execution id and the image URL are server-owned. A client-supplied
    // `imageId` PK alias (`inferenceId`) or `imageUrl` is an unknown strict
    // field and is rejected before any lookup/write/sign/queue.
    eyeSide: eyeSideEnum,
    clinicalFeatures: ClinicalFeaturesSchema,
    modelVersion: z.string().min(1).optional().nullable(),
    reanalysisOf: z.string().uuid().optional().nullable(),
  })
  .strict();

export type InferenceApiCreate = z.infer<typeof inferenceCreateSchema>;

/** Repository-layer create input (Keren's canonical data contract). */
export const RepoInferenceCreate = z.object({
  imageId: Uuid,
  jobId: Uuid.nullish(),
  modelVersion: z.string().max(128).nullish(),
  consultationId: Uuid.nullish(),
  eyeSide: eyeSideEnum.nullish(),
  snapshotId: Uuid.nullish(),
  reanalysisOfId: Uuid.nullish(),
  status: JobStatus.nullish(),
});
export type InferenceCreate = z.input<typeof RepoInferenceCreate>;

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
  status: JobStatus.nullish(),
});
export type InferenceResultUpdate = z.input<typeof InferenceResultUpdate>;

export const modelPredictionSchema = z.object({
  probabilities: z.record(z.string(), z.number()),
  predictedClass: z.string(),
  confidence: z.number(),
});

export type ModelPrediction = z.infer<typeof modelPredictionSchema>;

export const inferenceResultSchema = z.object({
  inferenceId: z.string().uuid(),
  eyeSide: eyeSideEnum,
  label: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  probabilities: z.record(z.string(), z.number()),
  modelPredictions: z.record(z.string(), modelPredictionSchema),
  cdr: z.number().nullable().optional(),
  cdrVertical: z.number().nullable().optional(),
  quality: z.record(z.string(), z.unknown()),
  artifacts: z.record(z.string(), z.string()),
  modelVersions: z.record(z.string(), z.string()),
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
