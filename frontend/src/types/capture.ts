import type { ClinicalFeatures, EyeSide } from "@/types/clinical";

export const CAPTURE_MIN_SHORTEST_SIDE_PX = 512;
export const CAPTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const CAPTURE_EYE_ORDER = ["OD", "OS"] as const;
export const CAPTURE_EYE_LABELS = {
  OD: "OD · Ojo derecho",
  OS: "OS · Ojo izquierdo",
} as const;

export interface CaptureEyeAsset {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export type CaptureEyeSlot =
  | { status: "empty" | "validating" }
  | { status: "invalid"; message: string }
  | { status: "ready"; asset: CaptureEyeAsset };

export type CaptureEyeSlots = Record<EyeSide, CaptureEyeSlot>;
export type CaptureClinicalValues = Record<keyof ClinicalFeatures, string>;

export const CLINICAL_FIELDS: ReadonlyArray<{
  key: keyof ClinicalFeatures;
  label: string;
  unit?: string;
}> = [
  { key: "Age", label: "Edad", unit: "años" },
  { key: "Gender", label: "Sexo" },
  { key: "dioptre_1", label: "Esfera refractiva", unit: "D" },
  { key: "dioptre_2", label: "Cilindro refractivo", unit: "D" },
  { key: "astigmatism", label: "Eje astigmático", unit: "°" },
  { key: "Phakic/Pseudophakic", label: "Cristalino (código del modelo)" },
  { key: "Pneumatic", label: "Tonómetro neumático", unit: "mmHg" },
  { key: "Perkins", label: "Tonómetro Perkins", unit: "mmHg" },
  { key: "Pachymetry", label: "Paquimetría", unit: "µm" },
  { key: "Axial_Length", label: "Longitud axial", unit: "mm" },
  { key: "VF_DM", label: "Desviación media del campo visual", unit: "dB" },
];

export function createEmptyClinicalValues(): CaptureClinicalValues {
  return Object.fromEntries(CLINICAL_FIELDS.map(({ key }) => [key, ""])) as CaptureClinicalValues;
}

export function parseClinicalValue(key: keyof ClinicalFeatures, input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (key === "Age" && (!Number.isInteger(value) || value < 0 || value > 130)) return null;
  if ((key === "Gender" || key === "Phakic/Pseudophakic") && value !== 0 && value !== 1) return null;
  return value;
}

export function clinicalFeaturesFromValues(values: CaptureClinicalValues): ClinicalFeatures | null {
  const entries = CLINICAL_FIELDS.map(({ key }) => [key, parseClinicalValue(key, values[key])] as const);
  if (entries.some(([, value]) => value === null)) return null;
  return Object.fromEntries(entries) as unknown as ClinicalFeatures;
}

export function formatClinicalValue(key: keyof ClinicalFeatures, value: unknown, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (key === "Gender") return value === 0 ? "Femenino" : value === 1 ? "Masculino" : "—";
  return unit ? `${value} ${unit}` : String(value);
}

export function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
