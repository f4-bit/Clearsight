import type {
  AnalysisState,
  CompletionState,
  PollingStop,
  ReportState,
} from "../schemas/consultation.js";
import type { ArtifactStatus } from "../schemas/inference.js";

export interface ArtifactStateInput {
  readonly status: ArtifactStatus | null;
  readonly retryable: boolean;
}

export interface ExecutionCompletionInput {
  readonly inferenceId: string;
  readonly status: string | null;
  readonly mask: ArtifactStateInput;
  readonly overlay: ArtifactStateInput;
  readonly pdf: ArtifactStateInput;
  readonly pdfReport: ArtifactStateInput;
}

export interface ConsultationCompletionInput {
  readonly requiredExecutionIds: readonly string[];
  readonly executions: readonly ExecutionCompletionInput[];
}

export interface ConsultationStates {
  readonly analysisState: AnalysisState;
  readonly reportState: ReportState;
  readonly completionState: CompletionState;
  readonly pollingStop: PollingStop;
}

export interface ExecutionDelivery {
  readonly resultStatus: ArtifactStatus;
  readonly evidenceStatus: ArtifactStatus;
  readonly pdfStatus: ArtifactStatus;
  readonly complete: boolean;
  readonly reviewRequired: boolean;
  readonly failed: boolean;
  readonly deliveryTerminal: boolean;
}

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "REVIEW_REQUIRED",
  "FAILED",
]);

const STAGE_RETRY_AFTER_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  QUEUED: 2,
  DOWNLOADING: 4,
  LOCALIZING: 6,
  SEGMENTING: 8,
  CLASSIFYING: 10,
});

function missingExecution(inferenceId: string): ExecutionCompletionInput {
  const missing: ArtifactStateInput = { status: null, retryable: false };
  return {
    inferenceId,
    status: null,
    mask: missing,
    overlay: missing,
    pdf: missing,
    pdfReport: missing,
  };
}

function requiredExecutions(
  input: ConsultationCompletionInput,
): ExecutionCompletionInput[] {
  const byId = new Map(
    input.executions.map((execution) => [execution.inferenceId, execution]),
  );
  return input.requiredExecutionIds.map(
    (inferenceId) => byId.get(inferenceId) ?? missingExecution(inferenceId),
  );
}

function normalizeArtifactStatus(
  artifact: ArtifactStateInput,
  executionStatus: string | null,
): ArtifactStatus {
  if (artifact.status === "AVAILABLE") {
    return "AVAILABLE";
  }
  if (artifact.status === "FAILED") {
    return artifact.retryable ? "PENDING" : "FAILED";
  }
  // A failed execution never produces evidence; missing/stale rows are
  // terminal FAILED, not an endless PENDING for polling.
  if (executionStatus === "FAILED") {
    return "FAILED";
  }
  return "PENDING";
}

function pdfStatusFor(execution: ExecutionCompletionInput): ArtifactStatus {
  const artifact = normalizeArtifactStatus(execution.pdf, execution.status);
  const report = normalizeArtifactStatus(
    execution.pdfReport,
    execution.status,
  );
  if (artifact === "FAILED" || report === "FAILED") {
    return "FAILED";
  }
  if (artifact === "AVAILABLE" && report === "AVAILABLE") {
    return "AVAILABLE";
  }
  return "PENDING";
}

function evidenceStatusFor(
  execution: ExecutionCompletionInput,
): ArtifactStatus {
  const mask = normalizeArtifactStatus(execution.mask, execution.status);
  const overlay = normalizeArtifactStatus(
    execution.overlay,
    execution.status,
  );
  if (mask === "FAILED" || overlay === "FAILED") {
    return "FAILED";
  }
  if (mask === "AVAILABLE" && overlay === "AVAILABLE") {
    return "AVAILABLE";
  }
  return "PENDING";
}

function resultStatusFor(status: string | null): ArtifactStatus {
  if (status === "FAILED") {
    return "FAILED";
  }
  if (status === "COMPLETED" || status === "REVIEW_REQUIRED") {
    return "AVAILABLE";
  }
  return "PENDING";
}

/**
 * Pure consultation aggregation. It only consumes persisted states and never
 * writes to the database or persists an aggregate enum.
 */
export function computeConsultationStates(
  input: ConsultationCompletionInput,
): ConsultationStates {
  if (input.requiredExecutionIds.length === 0) {
    return {
      analysisState: "OPEN",
      reportState: "NOT_REQUESTED",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    };
  }

  const executions = requiredExecutions(input);
  const maskStatuses = executions.map((execution) =>
    normalizeArtifactStatus(execution.mask, execution.status),
  );
  const overlayStatuses = executions.map((execution) =>
    normalizeArtifactStatus(execution.overlay, execution.status),
  );
  const pdfStatuses = executions.map(pdfStatusFor);

  const allSatisfied =
    executions.every(
      (execution, index) =>
        execution.status === "COMPLETED" &&
        maskStatuses[index] === "AVAILABLE" &&
        overlayStatuses[index] === "AVAILABLE",
    );
  const anyFailed = executions.some(
    (execution) => execution.status === "FAILED",
  );
  const anyReview = executions.some(
    (execution) => execution.status === "REVIEW_REQUIRED",
  );
  const anyNonTerminal = executions.some(
    (execution) =>
      execution.status === null ||
      !TERMINAL_STATUSES.has(execution.status),
  );
  const anyEvidencePending = maskStatuses.some(
    (status) => status === "PENDING",
  ) || overlayStatuses.some((status) => status === "PENDING");
  const anyResultOrEvidence = executions.some(
    (execution, index) =>
      execution.status === "COMPLETED" ||
      execution.status === "REVIEW_REQUIRED" ||
      maskStatuses[index] === "AVAILABLE" ||
      overlayStatuses[index] === "AVAILABLE",
  );

  let analysisState: AnalysisState;
  if (allSatisfied) {
    analysisState = "COMPLETED";
  } else if (anyFailed) {
    analysisState = "FAILED";
  } else if (anyReview) {
    analysisState = "REVIEW_REQUIRED";
  } else if (anyNonTerminal || anyEvidencePending) {
    analysisState = "IN_PROGRESS";
  } else if (anyResultOrEvidence) {
    analysisState = "PARTIAL";
  } else {
    analysisState = "OPEN";
  }

  let reportState: ReportState;
  if (pdfStatuses.some((status) => status === "FAILED")) {
    reportState = "FAILED";
  } else if (pdfStatuses.some((status) => status !== "AVAILABLE")) {
    reportState = "REPORT_PENDING";
  } else {
    reportState = "AVAILABLE";
  }

  const completionState: CompletionState =
    executions.every(
      (execution, index) =>
        execution.status === "COMPLETED" &&
        maskStatuses[index] === "AVAILABLE" &&
        overlayStatuses[index] === "AVAILABLE" &&
        pdfStatuses[index] === "AVAILABLE",
    )
      ? "COMPLETE"
      : "INCOMPLETE";

  const hasTerminalEvidenceFailure = maskStatuses.some(
    (status) => status === "FAILED",
  ) || overlayStatuses.some((status) => status === "FAILED");

  let pollingStop: PollingStop;
  if (completionState === "COMPLETE") {
    pollingStop = "COMPLETE";
  } else if (
    analysisState === "FAILED" ||
    reportState === "FAILED" ||
    hasTerminalEvidenceFailure
  ) {
    pollingStop = "FAILED";
  } else if (analysisState === "REVIEW_REQUIRED") {
    pollingStop = "ACTION_REQUIRED";
  } else {
    pollingStop = "CONTINUE";
  }

  return {
    analysisState,
    reportState,
    completionState,
    pollingStop,
  };
}

/** Per-execution delivery used by GET /inferences/:id (no locators). */
export function computeExecutionDelivery(
  execution: ExecutionCompletionInput,
): ExecutionDelivery {
  const resultStatus = resultStatusFor(execution.status);
  const evidenceStatus = evidenceStatusFor(execution);
  const pdfStatus = pdfStatusFor(execution);
  const reviewRequired = execution.status === "REVIEW_REQUIRED";
  const failed =
    execution.status === "FAILED" ||
    evidenceStatus === "FAILED" ||
    pdfStatus === "FAILED";
  const complete =
    resultStatus === "AVAILABLE" &&
    evidenceStatus === "AVAILABLE" &&
    pdfStatus === "AVAILABLE" &&
    !reviewRequired;
  const deliveryTerminal =
    execution.status !== null &&
    TERMINAL_STATUSES.has(execution.status) &&
    resultStatus !== "PENDING" &&
    evidenceStatus !== "PENDING" &&
    pdfStatus !== "PENDING";

  return {
    resultStatus,
    evidenceStatus,
    pdfStatus,
    complete,
    reviewRequired,
    failed,
    deliveryTerminal,
  };
}

/**
 * Backend hint for polling. The frontend still owns its final backoff; this is
 * 2s initially, progressing by stage to the 10s ceiling.
 */
export function computeRetryAfterSeconds(
  status: string | null,
  pollingStop: PollingStop,
): number | null {
  if (pollingStop !== "CONTINUE") {
    return null;
  }
  const stage = status ?? "QUEUED";
  return Math.min(10, Math.max(2, STAGE_RETRY_AFTER_SECONDS[stage] ?? 2));
}
