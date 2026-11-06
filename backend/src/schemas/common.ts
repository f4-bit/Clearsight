import { z } from "zod";

export const Uuid = z.uuid();

export const EyeSide = z.enum(["OD", "OS"]);
export type EyeSide = z.infer<typeof EyeSide>;

/** Same vocabulary as ml/service/schemas.py -> JobStatus (enforced by a DB CHECK). */
export const JOB_STATUSES = [
  "QUEUED",
  "DOWNLOADING",
  "LOCALIZING",
  "SEGMENTING",
  "CLASSIFYING",
  "COMPLETED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

export const USER_ROLES = ["OFTALMOLOGO", "INVESTIGADOR", "ADMIN"] as const;
export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

/**
 * Class indices of the ML service (ml/models/manifest.json -> class_names).
 * NOTE the order: 0 is Glaucoma, not "Normal".
 */
export const CLASS_LABELS = ["Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma"] as const;
export type DiagnosticLabel = (typeof CLASS_LABELS)[number];
export const DiagnosticClass = z.number().int().min(0).max(CLASS_LABELS.length - 1);

export const Probabilities = z.record(z.string(), z.number().min(0).max(1));

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof Pagination>;
