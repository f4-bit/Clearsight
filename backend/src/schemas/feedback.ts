import { z } from "zod";
import { CLASS_LABELS, DiagnosticClass, Uuid } from "./common.js";

/**
 * Body of POST /feedback.
 *
 * `predicted_class`, `confidence`, `agreement` and `doctor_id` are still
 * accepted (the current frontend contract sends them) but the server never
 * trusts them: they are derived from the stored inference and the JWT.
 *
 * `validated_class: null` means "no concluyente" (PROJECT.md) and can never be
 * flagged as gold standard.
 */
export const FeedbackCreate = z
  .object({
    consultation_id: Uuid,
    inference_id: Uuid,
    validated_class: DiagnosticClass.nullable(),
    doctor_notes: z.string().max(5000).nullish(),
    is_gold_standard: z.boolean().default(false),
    // Accepted for backward compatibility, ignored / cross-checked server-side.
    doctor_id: Uuid.optional(),
    predicted_class: DiagnosticClass.nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    agreement: z.boolean().nullish(),
  })
  .refine((value) => !(value.validated_class === null && value.is_gold_standard), {
    path: ["is_gold_standard"],
    message: "A 'no concluyente' verdict (validated_class = null) cannot be gold standard",
  });
export type FeedbackCreate = z.infer<typeof FeedbackCreate>;

export const FeedbackRead = z.object({
  id: Uuid,
  consultation_id: Uuid,
  inference_id: Uuid,
  doctor_id: Uuid,
  validated_class: DiagnosticClass.nullable(),
  predicted_class: DiagnosticClass.nullable(),
  confidence: z.number().nullable(),
  agreement: z.boolean().nullable(),
  doctor_notes: z.string().nullable(),
  is_gold_standard: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FeedbackRead = z.infer<typeof FeedbackRead>;

export const GoldStandardQuery = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  /** Only rows validated/updated strictly after this instant (ISO-8601). */
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50_000).default(5_000),
});
export type GoldStandardQuery = z.infer<typeof GoldStandardQuery>;

export const classLabel = (value: number | null): string | null =>
  value === null ? null : (CLASS_LABELS[value] ?? null);
