/**
 * ClearSight Capture Flow (frontend slice).
 * Domain shapes mirror types/clinical.ts and ml/service/schemas.py.
 * The capture study collects a retinography per eye plus the 11-contract
 * clinical features and hands a bilateral study to the inference queue.
 */

import type {
  ClinicalFeatures,
  DiagnosticLabel,
  EyeSide,
  JobStatus,
} from "@/types/clinical";

/** Shortest-side resolution gate (frontend counterpart of AGENTS.md §3.3). */
export const CAPTURE_MIN_SHORTEST_SIDE_PX = 512;

/** File size limit. Assumption until the ingestion API publishes its bound. */
export const CAPTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Mandatory bilateral order: never mirrored or inverted (AGENTS.md §3.2). */
export const CAPTURE_EYE_ORDER: EyeSide[] = ["OD", "OS"];

export const CAPTURE_EYE_LABELS: Record<EyeSide, string> = {
  OD: "OD · OJO DERECHO",
  OS: "OS · OJO IZQUIERDO",
};

/** A loaded retinography for one eye before the study is submitted. */
export interface CaptureEyeAsset {
  fileName: string;
  bytes: number;
  widthPx: number;
  heightPx: number;
  /** Local object URL for preview; null when the asset is a canned mock. */
  previewUrl: string | null;
}

/** Format labels accepted by the ingestion pipeline. */
export const CAPTURE_ACCEPTED_FORMATS = ["JPG", "PNG"] as const;
export type CaptureAcceptedFormat = (typeof CAPTURE_ACCEPTED_FORMATS)[number];

/** Per-eye validation outcome for the three visible quality checks. */
export interface CaptureEyeValidation {
  formatLabel: CaptureAcceptedFormat | null;
  formatOk: boolean;
  resolutionOk: boolean;
  sizeOk: boolean;
}

export interface CaptureEyeSlot {
  asset: CaptureEyeAsset | null;
  validation: CaptureEyeValidation | null;
}

export function slotIsEyeValid(slot: CaptureEyeSlot): boolean {
  return (
    slot.asset !== null &&
    slot.validation !== null &&
    slot.validation.formatOk &&
    slot.validation.resolutionOk &&
    slot.validation.sizeOk
  );
}

/** Returns true if an asset is present but failed any quality/format validation. */
export function slotHasValidationError(slot: CaptureEyeSlot): boolean {
  if (slot.asset === null || slot.validation === null) return false;
  return (
    !slot.validation.formatOk ||
    !slot.validation.resolutionOk ||
    !slot.validation.sizeOk
  );
}

/** Form draft state: string values so inputs can stay incomplete. */
export type CaptureClinicalValues = Record<keyof ClinicalFeatures, string>;

export function createEmptyClinicalValues(): CaptureClinicalValues {
  return {
    Age: "",
    Gender: "",
    dioptre_1: "",
    dioptre_2: "",
    astigmatism: "",
    Phakic_Pseudophakic: "",
    Pneumatic: "",
    Perkins: "",
    Pachymetry: "",
    Axial_Length: "",
    VF_DM: "",
  };
}

export function countFilledFeatures(values: CaptureClinicalValues): number {
  let filled = 0;
  for (const key of Object.keys(values) as (keyof CaptureClinicalValues)[]) {
    if (values[key].trim() !== "") filled += 1;
  }
  return filled;
}

export const CLINICAL_FEATURE_COUNT = 11;

/**
 * Submit gate: every one of the 11 contract biomarkers must be present and
 * parseable. Fabricated `0` defaults are never sent to the classifier.
 */
export function clinicalValuesAreValid(values: CaptureClinicalValues): boolean {
  for (const key of Object.keys(values) as (keyof CaptureClinicalValues)[]) {
    if (values[key].trim() === "") return false;
    const parsed = Number.parseFloat(values[key].trim().replace(",", "."));
    if (!Number.isFinite(parsed)) return false;
  }
  return true;
}

/** Strict mapping onto the inference contract; callers must gate on clinicalValuesAreValid. */
export function clinicalFeaturesFromValues(
  values: CaptureClinicalValues,
): ClinicalFeatures {
  if (!clinicalValuesAreValid(values)) {
    throw new Error(
      "Incomplete clinical feature values cannot enter the inference contract",
    );
  }
  const num = (key: keyof CaptureClinicalValues): number =>
    Number.parseFloat(values[key].trim().replace(",", "."));
  return {
    Age: num("Age"),
    Gender: num("Gender"),
    dioptre_1: num("dioptre_1"),
    dioptre_2: num("dioptre_2"),
    astigmatism: num("astigmatism"),
    Phakic_Pseudophakic: num("Phakic_Pseudophakic"),
    Pneumatic: num("Pneumatic"),
    Perkins: num("Perkins"),
    Pachymetry: num("Pachymetry"),
    Axial_Length: num("Axial_Length"),
    VF_DM: num("VF_DM"),
  };
}

export type CapturePhase = "draft" | "processing" | "completed";

/**
 * Visible pipeline labels, 1:1 with the mockup copy and the JobStatus contract.
 * Client-side submission hops carry no jobStatus; every service stage maps to it.
 */
export interface CaptureFlowStage {
  id: "verification" | "upload" | "downloading" | "localizing" | "segmenting" | "classifying" | "result";
  label: string;
  jobStatus?: JobStatus;
}

export const CAPTURE_STAGE_LIST: CaptureFlowStage[] = [
  { id: "verification", label: "Verificación y anonimizado" },
  { id: "upload", label: "Envío al servicio de análisis" },
  { id: "downloading", label: "Descarga de la retinografía", jobStatus: "DOWNLOADING" },
  { id: "localizing", label: "Localización del disco óptico", jobStatus: "LOCALIZING" },
  { id: "segmenting", label: "Segmentación de disco y copa", jobStatus: "SEGMENTING" },
  { id: "classifying", label: "Clasificación multimodal", jobStatus: "CLASSIFYING" },
  { id: "result", label: "Resultado clínico" },
];

export type CaptureStageState = "done" | "active" | "pending";

export type CaptureEyeRunBadge = "EN COLA" | "EN CURSO" | "LISTO";

export interface CaptureProcessingSnapshot {
  stageStates: Record<CaptureFlowStage["id"], CaptureStageState>;
  eyeBadges: Record<EyeSide, CaptureEyeRunBadge>;
  activeStageLabel: string | null;
  elapsedSeconds: number;
  finished: boolean;
}

export interface CaptureStudySummary {
  /** Study identifier assigned on submit; null while the draft is pending. */
  studyId: string | null;
  createdAtIso: string;
}

/** Human-safe presentation of the tri-class model label on the capture seat. */
export const CONSENSUS_LABEL_ES: Record<DiagnosticLabel, string> = {
  Non_Glaucoma: "Normal",
  Suspicious_Glaucoma: "Sospecha de Glaucoma",
  Glaucoma: "Glaucoma",
};

export function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDimension(eye: CaptureEyeAsset): string {
  return `${eye.widthPx} × ${eye.heightPx} px`;
}
