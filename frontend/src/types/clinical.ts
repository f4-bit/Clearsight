export type EyeSide = "OD" | "OS";
export type JobStatus =
  | "QUEUED" | "DOWNLOADING" | "LOCALIZING" | "SEGMENTING"
  | "CLASSIFYING" | "COMPLETED" | "REVIEW_REQUIRED" | "FAILED";

export type DiagnosticClass = 0 | 1 | 2;

export interface ClinicalFeatures {
  Age: number;
  Gender: number;
  dioptre_1: number;
  dioptre_2: number;
  astigmatism: number;
  "Phakic/Pseudophakic": number;
  Pneumatic: number;
  Perkins: number;
  Pachymetry: number;
  Axial_Length: number;
  VF_DM: number;
}

export interface FeedbackCreate {
  consultation_id: string;
  inference_id: string;
  validated_class: DiagnosticClass | null;
  doctor_notes: string | null;
  is_gold_standard: boolean;
}

export interface FeedbackRead extends FeedbackCreate {
  id: string;
  created_at: string;
  updated_at: string;
  doctor_id: string;
  predicted_class: DiagnosticClass | null;
  confidence: number | null;
  agreement: boolean | null;
}

export const CLASS_LABELS = {
  0: "Glaucoma",
  1: "Normal",
  2: "Sospecha de glaucoma",
} as const;

export const CLASS_COLORS = {
  0: "text-rose-400 bg-rose-950/50 border-rose-800/60",
  1: "text-emerald-400 bg-emerald-950/50 border-emerald-800/60",
  2: "text-amber-400 bg-amber-950/50 border-amber-800/60",
} as const;

export const DIAGNOSTIC_CLASSES = [1, 2, 0] as const;
export const PROBABILITY_KEYS = {
  0: "Glaucoma",
  1: "Non_Glaucoma",
  2: "Suspicious_Glaucoma",
} as const;

const cdrFormat = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCdr(value: number): string {
  return cdrFormat.format(value);
}
