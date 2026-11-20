import { z } from "zod";
import { isValidArtifactKey } from "../lib/artifact-key.js";
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

/** Binary artifact types. `result` is intentionally not one of them. */
export const ARTIFACT_TYPES = ["mask", "overlay", "pdf", "gradcam", "shap"] as const;
export const ArtifactType = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof ArtifactType>;

/** Logical catalog includes `result`, which stays inline in `ExecutionResult`. */
export const ARTIFACT_CATALOG_TYPES = ["result", ...ARTIFACT_TYPES] as const;
export const ArtifactCatalogType = z.enum(ARTIFACT_CATALOG_TYPES);
export type ArtifactCatalogType = z.infer<typeof ArtifactCatalogType>;

export const ARTIFACT_STATUSES = [
  "NOT_SUPPORTED",
  "NOT_REQUESTED",
  "PENDING",
  "AVAILABLE",
  "FAILED",
] as const;
export const ArtifactStatus = z.enum(ARTIFACT_STATUSES);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

const ARTIFACT_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT_FAILURE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const nonBlankString = (max?: number) =>
  z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "Must not be blank")
    .refine((value) => max === undefined || value.length <= max, "Value is too long");

const artifactStorageId = z.string().regex(ARTIFACT_STORAGE_ID).nullable();
const artifactBucketOrContainer = nonBlankString(255)
  .refine((value) => ARTIFACT_BUCKET.test(value), "Invalid bucket or container")
  .nullable();
const artifactKey = nonBlankString()
  .refine(isValidArtifactKey, "Invalid artifact key")
  .nullable();
const artifactContentType = nonBlankString(255)
  .refine((value) => !value.includes("://"), "Invalid content type")
  .nullable();
const artifactSizeBytes = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const artifactChecksum = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const artifactFailureCode = z.string().regex(ARTIFACT_FAILURE_CODE).nullable();

const ARTIFACT_LOCATION_FIELDS = [
  "storageId",
  "bucketOrContainer",
  "key",
  "contentType",
  "sizeBytes",
  "checksumSha256",
] as const;

/** Strict binary `ArtifactRef` DTO. `result` is excluded by `ArtifactType`. */
export const ArtifactRefSchema = z
  .object({
    artifactType: ArtifactType,
    status: ArtifactStatus,
    storageId: artifactStorageId,
    bucketOrContainer: artifactBucketOrContainer,
    key: artifactKey,
    contentType: artifactContentType,
    sizeBytes: artifactSizeBytes,
    checksumSha256: artifactChecksum,
    failureCode: artifactFailureCode,
    retryable: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    const available = ref.status === "AVAILABLE";
    for (const field of ARTIFACT_LOCATION_FIELDS) {
      const value = ref[field];
      if (available ? value === null : value !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: available
            ? "Required for AVAILABLE artifacts"
            : "Must be null for non-AVAILABLE artifacts",
        });
      }
    }

    if (
      ref.artifactType === "pdf" &&
      ref.status === "AVAILABLE" &&
      ref.contentType !== "application/pdf"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["contentType"],
        message: "AVAILABLE PDF artifacts require application/pdf",
      });
    }

    if (ref.status === "FAILED") {
      if (ref.failureCode === null) {
        ctx.addIssue({
          code: "custom",
          path: ["failureCode"],
          message: "FAILED artifacts require a failure code",
        });
      }
      return;
    }

    if (ref.failureCode !== null || ref.retryable) {
      ctx.addIssue({
        code: "custom",
        path: ref.failureCode === null ? ["retryable"] : ["failureCode"],
        message: "Only FAILED artifacts carry failure metadata",
      });
    }
  });

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Postgres `integer` upper bound for an explicit artifact version. */
export const ARTIFACT_VERSION_MAX = 2_147_483_647;

export const ArtifactListItemSchema = z
  .object({
    artifactId: z.uuid(),
    version: z.number().int().positive().max(ARTIFACT_VERSION_MAX),
    reference: ArtifactRefSchema,
  })
  .strict();

export type ArtifactListItem = z.infer<typeof ArtifactListItemSchema>;

export const ArtifactListResponseSchema = z
  .object({
    items: z.array(ArtifactListItemSchema),
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(ARTIFACT_VERSION_MAX),
  })
  .strict();

export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;

/** Strict query for the server-side list; unknown keys are rejected. */
export const ArtifactListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(ARTIFACT_VERSION_MAX).default(0),
    type: ArtifactType.optional(),
  })
  .strict();

export type ArtifactListQuery = z.infer<typeof ArtifactListQuerySchema>;

/** An explicit, positive int32 version is mandatory; there is no `latest`. */
export const ArtifactUrlQuerySchema = z
  .object({
    version: z.coerce
      .number()
      .int()
      .positive()
      .max(ARTIFACT_VERSION_MAX),
  })
  .strict();

export type ArtifactUrlQuery = z.infer<typeof ArtifactUrlQuerySchema>;

export const ArtifactUrlSchema = z
  .object({
    artifactType: ArtifactType,
    status: ArtifactStatus,
    url: z.string().url().nullable(),
    expiresInSeconds: z.number().int().min(1).max(3600).nullable(),
    contentType: nonBlankString(255).nullable(),
    reportVersion: z
      .number()
      .int()
      .positive()
      .max(ARTIFACT_VERSION_MAX)
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "AVAILABLE") {
      if (value.url === null) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "Required for AVAILABLE" });
      }
      if (value.expiresInSeconds === null) {
        ctx.addIssue({
          code: "custom",
          path: ["expiresInSeconds"],
          message: "Required for AVAILABLE",
        });
      }
      if (value.contentType === null) {
        ctx.addIssue({
          code: "custom",
          path: ["contentType"],
          message: "Required for AVAILABLE",
        });
      }
      return;
    }

    for (const field of ["url", "expiresInSeconds", "contentType"] as const) {
      if (value[field] !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Must be null for non-AVAILABLE artifacts",
        });
      }
    }
  });

export type ArtifactUrl = z.infer<typeof ArtifactUrlSchema>;

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
