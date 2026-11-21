import { z } from "zod";
import { Uuid } from "./common.js";

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
  Age: z.number().finite(),
  Gender: z.number().finite(),
  dioptre_1: z.number().finite(),
  dioptre_2: z.number().finite(),
  astigmatism: z.number().finite(),
  "Phakic/Pseudophakic": z.number().finite(),
  Pneumatic: z.number().finite(),
  Perkins: z.number().finite(),
  Pachymetry: z.number().finite(),
  Axial_Length: z.number().finite(),
  VF_DM: z.number().finite(),
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

/** Values PostgreSQL can store in a JSONB column, including nested objects. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObjectValue;
export type JsonObjectValue = { [key: string]: JsonValue };

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Structural JSON check used before any snapshot insert. It deliberately does
 * not coerce: `Date`, `Map`, functions, bigints, `undefined`, `NaN`, `Infinity`
 * and cycles are rejected at any depth instead of being silently stringified.
 */
function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) {
        if (ancestors.has(value)) return false;
        ancestors.add(value);
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value) || !isJsonValue(value[index], ancestors)) {
            ancestors.delete(value);
            return false;
          }
        }
        ancestors.delete(value);
        return true;
      }
      if (!isPlainJsonObject(value) || ancestors.has(value)) return false;
      ancestors.add(value);
      for (const nested of Object.values(value)) {
        if (!isJsonValue(nested, ancestors)) {
          ancestors.delete(value);
          return false;
        }
      }
      ancestors.delete(value);
      return true;
    }
    default:
      return false;
  }
}

function isJsonObjectValue(value: unknown): value is JsonObjectValue {
  return isPlainJsonObject(value) && isJsonValue(value, new Set());
}

/** Top-level JSONB object with JSON-only values at every depth. */
export const JsonObjectValueSchema = z.custom<JsonObjectValue>(isJsonObjectValue, {
  message: "must be a JSON object with JSON-only values",
});

/**
 * Input for one immutable clinical snapshot. `rawPayload` and
 * `normalizedPayload` are independent required copies; `schemaVersion` has no
 * default and accepts at most the DB column width. `modelVersions` defaults to
 * `{}` ("not resolved") but accepts any nested JSON object. This schema does
 * not normalize clinical data or resolve model revisions: task 2.2 owns that.
 */
export const ClinicalSnapshotCreateSchema = z.strictObject({
  consultationId: Uuid,
  rawPayload: JsonObjectValueSchema,
  normalizedPayload: JsonObjectValueSchema,
  schemaVersion: z
    .string()
    .max(128)
    .refine((value) => value.trim().length > 0, {
      message: "schemaVersion must not be blank",
    }),
  modelVersions: JsonObjectValueSchema.optional().default({}),
});
export type ClinicalSnapshotCreate = z.input<typeof ClinicalSnapshotCreateSchema>;
