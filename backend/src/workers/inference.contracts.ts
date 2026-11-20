import type { ClinicalFeatures } from "../schemas/clinical.js";

export const INFERENCE_QUEUE_NAME = "inference-jobs";
export const INFERENCE_POLL_INTERVAL_MS = 2_000;
export const INFERENCE_MAX_POLLS = 60;

export const INFERENCE_TERMINAL_STATUSES = [
  "COMPLETED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const;
export type InferenceTerminalStatus = (typeof INFERENCE_TERMINAL_STATUSES)[number];

export function isTerminalInferenceStatus(
  status: string | null | undefined,
): status is InferenceTerminalStatus {
  return (
    status === "COMPLETED" ||
    status === "REVIEW_REQUIRED" ||
    status === "FAILED"
  );
}

export interface InferenceExpectedContext {
  schemaVersion: string;
  fingerprintSha256: string;
}

export interface InferenceJobData {
  inferenceId: string;
  imageId: string;
  imageUrl: string;
  eyeSide: "OD" | "OS";
  clinicalFeatures: ClinicalFeatures;
  modelVersion?: string | null;
  /** 2.2 pin; the worker transmits it to ML as expected_context. */
  expectedContext?: InferenceExpectedContext;
}
