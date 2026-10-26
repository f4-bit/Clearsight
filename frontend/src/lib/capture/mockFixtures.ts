/**
 * Demo fixtures for the capture slice. Everything is mock data honoring the
 * real contracts (ClinicalFeatures / InferenceResult from types/clinical.ts),
 * so swapping the simulator for the live API only replaces the transport.
 */

import type {
  DiagnosticLabel,
  EyeSide,
  InferenceResult,
  ModelPrediction,
} from "@/types/clinical";
import {
  CAPTURE_EYE_ORDER,
  type CaptureClinicalValues,
  type CaptureEyeSlot,
} from "@/types/capture";

/** Opaque study number shown once the study enters the queue. */
export const MOCK_SUBMITTED_STUDY_ID = "#A3F1-9C2B";

/** Consensus label used across mock results (see CONSENSUS_LABEL_ES). */
export const MOCK_CONSENSUS = {
  label: "Suspicious_Glaucoma" as DiagnosticLabel,
  confidence: 0.74,
  probabilities: {
    Non_Glaucoma: 0.18,
    Suspicious_Glaucoma: 0.74,
    Glaucoma: 0.08,
  } as Record<DiagnosticLabel, number>,
  /** "8.4 s" shown on the completed header, matching engine totals. */
  elapsedSeconds: 8.4,
};

export function createMockCompletedResults(): Record<EyeSide, InferenceResult> {
  const eyeResult = (
    side: EyeSide,
    cdrVertical: number,
    cdr: number,
    discArea: number,
    cupArea: number,
  ): InferenceResult => {
    const predictions: Record<string, ModelPrediction> = {
      resnet50_multimodal: {
        probabilities: MOCK_CONSENSUS.probabilities,
        predicted_class: MOCK_CONSENSUS.label,
        confidence: MOCK_CONSENSUS.confidence,
      },
      efficientnetb3_multimodal: {
        probabilities: MOCK_CONSENSUS.probabilities,
        predicted_class: MOCK_CONSENSUS.label,
        confidence: MOCK_CONSENSUS.confidence,
      },
    };
    return {
      inference_id: `mock-${side.toLowerCase()}-0001`,
      eye_side: side,
      label: MOCK_CONSENSUS.label,
      confidence: MOCK_CONSENSUS.confidence,
      probabilities: MOCK_CONSENSUS.probabilities,
      model_predictions: predictions,
      cdr,
      cdr_vertical: cdrVertical,
      quality: {
        disc_detected: true,
        cup_detected: true,
        disc_area: discArea,
        cup_area: cupArea,
        cdr_is_finite: true,
        cdr_in_range: true,
        cup_area_not_larger_than_disc: true,
        review_required: false,
      },
      artifacts: {},
      model_versions: { segmentation: "fpn-resnet18", ensemble: "5ch-v1" },
      elapsed_seconds: MOCK_CONSENSUS.elapsedSeconds,
    };
  };
  // vCDR matches the maqueta (OD 0.64, OS 0.41); area CDR = sqrt(cup_area / disc_area) per AGENTS.md §5.3.
  return {
    OD: eyeResult("OD", 0.64, 0.58, 21400.0, 7200.0),
    OS: eyeResult("OS", 0.41, 0.38, 21000.0, 3030.0),
  };
}

/** Demo asset reproducing the maqueta: OD loaded (1536 px, 2.4 MB), OS empty. */
export function createMockEyeSlots(): Record<EyeSide, CaptureEyeSlot> {
  const emptySlot: CaptureEyeSlot = { asset: null, validation: null };
  const odSlot: CaptureEyeSlot = {
    asset: {
      fileName: "od_retina_2026-10-14.jpg",
      bytes: 2_516_582,
      widthPx: 1536,
      heightPx: 1536,
      previewUrl: null,
    },
    validation: {
      formatLabel: "JPG",
      formatOk: true,
      resolutionOk: true,
      sizeOk: true,
    },
  };
  return { OD: odSlot, OS: emptySlot };
}

export { CAPTURE_EYE_ORDER };

/** Draft form seeded with the maqueta's 11 contract values (11 / 11). */
export function createMockClinicalValues(): CaptureClinicalValues {
  return {
    Age: "63",
    Gender: "1",
    dioptre_1: "-2.50",
    dioptre_2: "-2.25",
    astigmatism: "-0.75",
    Phakic_Pseudophakic: "1",
    Pneumatic: "15",
    Perkins: "0",
    Pachymetry: "542",
    Axial_Length: "24.1",
    VF_DM: "-1.8",
  };
}

export function genderLabel(genderCode: string): string {
  if (genderCode === "1") return "Masculino";
  if (genderCode === "0") return "Femenino";
  return "Sin especificar";
}

export function crystalineLabel(phakicCode: string): string {
  if (phakicCode === "1") return "Fáquico";
  if (phakicCode === "0") return "Pseudofáquico";
  return "Sin especificar";
}
