import type { ClinicalFeatures } from "../schemas/clinical.js";

/** Due time and explicit claim lease for the PostgreSQL-backed poller. */
export const INFERENCE_PROCESS_POLL_INTERVAL_MS = 1_000;
export const INFERENCE_PROCESS_BATCH_SIZE = 4;
export const INFERENCE_PROCESS_MAX_ATTEMPTS = 3;
export const INFERENCE_PROCESS_CLAIM_LEASE_SECONDS = 300;

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

/**
 * Exponential retry policy for the durable queue: 2s * 2^attempts, capped.
 * The repository applies it in SQL so the increment and the schedule are one
 * atomic statement.
 */
export const INFERENCE_PROCESS_RETRY_CAP_SECONDS = 120;

export interface InferenceExpectedContext {
  schemaVersion: string;
  fingerprintSha256: string;
}

export interface InferenceJobData {
  inferenceId: string;
  imageId: string;
  /** Legacy compatibility only; new jobs sign from the trusted DB storagePath. */
  imageUrl?: string;
  eyeSide: "OD" | "OS";
  clinicalFeatures: ClinicalFeatures;
  modelVersion?: string | null;
  /** 2.2 pin; the worker transmits it to ML as expected_context. */
  expectedContext?: InferenceExpectedContext;
}
