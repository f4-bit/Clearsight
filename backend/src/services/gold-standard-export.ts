import { createHmac } from "node:crypto";
import type { FeedbackRepository } from "../repositories/feedback.repo.js";
import {
  CLINICAL_FEATURE_NAMES,
  extractClinicalFeatures,
  type ClinicalFeatureName,
} from "../schemas/clinical.js";
import { classLabel } from "../schemas/feedback.js";

export interface GoldStandardRow {
  inference_id: string;
  /** HMAC-SHA256 pseudonym of the doctor: stable, not reversible without the secret. */
  doctor_id: string;
  eye_side: string;
  /** Object-storage key (/year/month/uuid.jpg): sanitized, carries no patient data. */
  image_path: string;
  model_version: string | null;
  predicted_class: number | null;
  validated_class: number;
  validated_label: string | null;
  agreement: boolean | null;
  is_gold_standard: true;
  validated_at: string;
  features: Record<ClinicalFeatureName, number | null>;
}

export interface GoldStandardExport {
  rows: GoldStandardRow[];
  hasMore: boolean;
}

export function pseudonymize(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

/**
 * Anonymized gold-standard batch for retraining. Deliberately left out:
 * doctor_notes (free text may contain identifiers), patient/consultation ids,
 * real doctor ids.
 */
export async function buildGoldStandardExport(
  feedback: FeedbackRepository,
  opts: { since?: Date; limit: number; hmacSecret: string },
): Promise<GoldStandardExport> {
  const found = await feedback.listGoldStandard({ since: opts.since, limit: opts.limit });
  const hasMore = found.length > opts.limit;

  const rows = found.slice(0, opts.limit).map((row): GoldStandardRow => {
    let features = extractClinicalFeatures(row.clinicalData);
    // Mirrors the Python ETL: feedback snapshot first, consultation as fallback.
    if (Object.values(features).every((value) => value === null)) {
      features = extractClinicalFeatures(row.consultation.clinicalData);
    }
    const validated = row.validatedClass as number; // filtered: never null here

    return {
      inference_id: row.inferenceId,
      doctor_id: pseudonymize(opts.hmacSecret, row.doctorId),
      eye_side: row.inference.image.eyeSide,
      image_path: row.inference.image.storagePath,
      model_version: row.inference.modelVersion,
      predicted_class: row.predictedClass,
      validated_class: validated,
      validated_label: classLabel(validated),
      agreement: row.agreement,
      is_gold_standard: true,
      validated_at: row.updatedAt.toISOString(),
      features,
    };
  });

  return { rows, hasMore };
}

/**
 * Column names are the ones scripts/retrain_cycle.py reads
 * (`--samples file.csv`): inference_id, validated_class, predicted_class,
 * doctor_id, agreement, is_gold_standard + the eleven feature columns.
 */
export const CSV_COLUMNS = [
  "inference_id",
  "validated_class",
  "predicted_class",
  "doctor_id",
  "agreement",
  "is_gold_standard",
  "eye_side",
  "model_version",
  "image_path",
  "validated_at",
  ...CLINICAL_FEATURE_NAMES,
] as const;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvText(value: string | null): string {
  if (value === null) return "";
  // Neutralize spreadsheet formula injection in text columns.
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csvNumber = (value: number | null): string => (value === null ? "" : String(value));
const csvBool = (value: boolean | null): string => (value === null ? "" : String(value));

export function toCsv(rows: GoldStandardRow[]): string {
  const lines = [CSV_COLUMNS.map((name) => csvText(name)).join(",")];
  for (const row of rows) {
    const cells = [
      csvText(row.inference_id),
      csvNumber(row.validated_class),
      csvNumber(row.predicted_class),
      csvText(row.doctor_id),
      csvBool(row.agreement),
      csvBool(row.is_gold_standard),
      csvText(row.eye_side),
      csvText(row.model_version),
      csvText(row.image_path),
      csvText(row.validated_at),
      ...CLINICAL_FEATURE_NAMES.map((name) => csvNumber(row.features[name])),
    ];
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}
