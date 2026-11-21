import { z } from "zod";

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

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

/** Canonical class index derived from the single class-label source. */
export const CLASS_LABEL_INDEX = Object.freeze(
  Object.fromEntries(CLASS_LABELS.map((label, index) => [label, index])),
) as Readonly<Record<DiagnosticLabel, number>>;

/** Exact canonical labels accepted for probability keys. */
export const CLASS_LABEL_SET: ReadonlySet<string> = new Set(CLASS_LABELS);

// Only casing aliases already accepted by the legacy worker; no new names,
// trimming, substring matching or model guessing.
const LEGACY_CLASS_ALIASES: Readonly<Record<string, DiagnosticLabel>> = Object.freeze({
  glaucoma: "Glaucoma",
  non_glaucoma: "Non_Glaucoma",
  suspicious_glaucoma: "Suspicious_Glaucoma",
});

/** Map a canonical or bounded legacy label to 0/1/2, otherwise null. */
export function canonicalClassIndex(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(CLASS_LABEL_INDEX, value)) {
    return CLASS_LABEL_INDEX[value as DiagnosticLabel];
  }
  const normalized = value.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEGACY_CLASS_ALIASES, normalized)) {
    return null;
  }
  const canonical = LEGACY_CLASS_ALIASES[normalized];
  return canonical === undefined ? null : CLASS_LABEL_INDEX[canonical];
}

export const Probabilities = z.record(z.string(), z.number().min(0).max(1));

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof Pagination>;
