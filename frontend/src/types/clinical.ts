/**
 * ClearSight Clinical Data Contracts
 * Mirroring backend/app/schemas/consultation.py and ml/service/schemas.py
 */

export type EyeSide = "OD" | "OS";

export type JobStatus =
  | "QUEUED"
  | "DOWNLOADING"
  | "LOCALIZING"
  | "SEGMENTING"
  | "CLASSIFYING"
  | "COMPLETED"
  | "REVIEW_REQUIRED"
  | "FAILED";

export type DiagnosticClass = 0 | 1 | 2;

export type DiagnosticLabel = "Glaucoma" | "Non_Glaucoma" | "Suspicious_Glaucoma";

export type ClinicalPresentation = "Glaucoma" | "Normal" | "Suspect";

export interface ClinicalFeatures {
  Age: number;
  Gender: number; // 0 = F, 1 = M
  dioptre_1: number;
  dioptre_2: number;
  astigmatism: number;
  Phakic_Pseudophakic: number; // 0 = Pseudophakic, 1 = Phakic
  Pneumatic: number; // mmHg
  Perkins: number; // mmHg
  Pachymetry: number; // µm
  Axial_Length: number; // mm
  VF_DM: number; // dB
}

export interface ModelPrediction {
  probabilities: Record<DiagnosticLabel, number>;
  predicted_class: DiagnosticLabel;
  confidence: number;
}

export interface InferenceQuality {
  disc_detected: boolean;
  cup_detected: boolean;
  disc_area: number;
  cup_area: number;
  cdr_is_finite: boolean;
  cdr_in_range: boolean;
  cup_area_not_larger_than_disc: boolean;
  review_required: boolean;
}

export interface InferenceResult {
  inference_id: string;
  eye_side: EyeSide;
  label: DiagnosticLabel | null;
  confidence: number | null;
  probabilities: Record<DiagnosticLabel, number>;
  model_predictions: Record<string, ModelPrediction>;
  cdr: number | null; // Model Area CDR
  cdr_vertical: number | null; // Clinical Vertical vCDR
  quality: InferenceQuality;
  artifacts: {
    raw_image_url?: string;
    mask_url?: string;
    overlay_url?: string;
    gradcam_url?: string;
    [key: string]: string | undefined;
  };
  model_versions: Record<string, string>;
  elapsed_seconds: number;
  calipers?: {
    cup_height_mm: number;
    disc_height_mm: number;
  };
}

export interface BilateralStudy {
  consultation_id: string;
  patient_id: string;
  doctor_id: string;
  doctor_name: string;
  created_at: string;
  status: JobStatus;
  od: InferenceResult;
  os: InferenceResult;
  clinical_features: ClinicalFeatures;
  consensus_label: DiagnosticLabel;
  consensus_confidence: number;
  asymmetry_vcdr: number;
}

export interface FeedbackCreate {
  consultation_id: string;
  inference_id: string;
  doctor_id: string;
  validated_class: DiagnosticClass;
  predicted_class?: DiagnosticClass | null;
  confidence?: number | null;
  agreement?: boolean | null;
  doctor_notes?: string | null;
  is_gold_standard: boolean;
}

export interface FeedbackRead extends FeedbackCreate {
  id: string;
  created_at: string;
}

export const CLASS_TO_LABEL: Record<DiagnosticClass, DiagnosticLabel> = {
  0: "Glaucoma",
  1: "Non_Glaucoma",
  2: "Suspicious_Glaucoma",
};

export const LABEL_TO_CLASS: Record<DiagnosticLabel, DiagnosticClass> = {
  Glaucoma: 0,
  Non_Glaucoma: 1,
  Suspicious_Glaucoma: 2,
};

export const LABEL_TO_CLINICAL: Record<DiagnosticLabel, ClinicalPresentation> = {
  Glaucoma: "Glaucoma",
  Non_Glaucoma: "Normal",
  Suspicious_Glaucoma: "Suspect",
};
