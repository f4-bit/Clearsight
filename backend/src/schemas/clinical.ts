import { z } from "zod";

/**
 * The eleven model inputs, exactly as declared in ml/service/schemas.py
 * (`ClinicalFeatures`) and ml/models/manifest.json. Order matters: it is the
 * column order of the model's feature vector and of the CSV export.
 */
export const CLINICAL_FEATURE_NAMES = [
  "Age",
  "Gender",
  "dioptre_1",
  "dioptre_2",
  "astigmatism",
  "Phakic/Pseudophakic",
  "Pneumatic",
  "Perkins",
  "Pachymetry",
  "Axial_Length",
  "VF_DM",
] as const;
export type ClinicalFeatureName = (typeof CLINICAL_FEATURE_NAMES)[number];

/** Strict, like the ML contract (`extra="forbid"`): no extra, renamed or missing fields. */
export const ClinicalFeaturesSchema = z.strictObject({
  Age: z.number(),
  Gender: z.number(),
  dioptre_1: z.number(),
  dioptre_2: z.number(),
  astigmatism: z.number(),
  "Phakic/Pseudophakic": z.number(),
  Pneumatic: z.number(),
  Perkins: z.number(),
  Pachymetry: z.number(),
  Axial_Length: z.number(),
  VF_DM: z.number(),
});
export type ClinicalFeatures = z.infer<typeof ClinicalFeaturesSchema>;

/** The frontend types call it `Phakic_Pseudophakic`; the ML contract uses a slash. */
const ALIASES: Record<string, ClinicalFeatureName> = {
  Phakic_Pseudophakic: "Phakic/Pseudophakic",
};

/**
 * Pulls the model features out of a free-form `clinical_data` JSONB value.
 * Unknown keys are ignored; values that are not finite numbers become `null`.
 * Never throws: the DB column is JSONB and may hold partial legacy data.
 */
export function extractClinicalFeatures(
  raw: unknown,
): Record<ClinicalFeatureName, number | null> {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const out = {} as Record<ClinicalFeatureName, number | null>;
  for (const name of CLINICAL_FEATURE_NAMES) {
    out[name] = toFiniteNumber(source[name]);
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (out[canonical] === null) out[canonical] = toFiniteNumber(source[alias]);
  }
  return out;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
