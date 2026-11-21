import { describe, expect, it } from "vitest";
import {
  computeConsultationStates,
  computeExecutionDelivery,
  computeRetryAfterSeconds,
  type ArtifactStateInput,
  type ExecutionCompletionInput,
} from "../../src/services/consultation-completion.js";

const AVAILABLE: ArtifactStateInput = {
  status: "AVAILABLE",
  retryable: false,
};
const PENDING: ArtifactStateInput = { status: "PENDING", retryable: false };
const MISSING: ArtifactStateInput = { status: null, retryable: false };
const FAILED: ArtifactStateInput = { status: "FAILED", retryable: false };
const FAILED_RETRYABLE: ArtifactStateInput = {
  status: "FAILED",
  retryable: true,
};

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_EXTRA = "33333333-3333-4333-8333-333333333333";

function execution(
  inferenceId: string,
  overrides: Partial<ExecutionCompletionInput> = {},
): ExecutionCompletionInput {
  return {
    inferenceId,
    status: "COMPLETED",
    mask: AVAILABLE,
    overlay: AVAILABLE,
    pdf: AVAILABLE,
    pdfReport: AVAILABLE,
    ...overrides,
  };
}

describe("computeConsultationStates", () => {
  it("returns OPEN/NOT_REQUESTED/INCOMPLETE/CONTINUE for an empty set", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [],
        executions: [execution(ID_A)],
      }),
    ).toEqual({
      analysisState: "OPEN",
      reportState: "NOT_REQUESTED",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("completes only with every required result, mask/overlay and PDF", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [execution(ID_A), execution(ID_B)],
      }),
    ).toEqual({
      analysisState: "COMPLETED",
      reportState: "AVAILABLE",
      completionState: "COMPLETE",
      pollingStop: "COMPLETE",
    });
  });

  it("keeps analysis complete but report pending when the PDF is missing", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A],
        executions: [
          execution(ID_A, { pdf: MISSING, pdfReport: MISSING }),
        ],
      }),
    ).toEqual({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("reports partial PDF availability as REPORT_PENDING and incomplete", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [
          execution(ID_A),
          execution(ID_B, { pdf: PENDING, pdfReport: PENDING }),
        ],
      }),
    ).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("keeps FAILED ahead of REVIEW_REQUIRED and in-progress work", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [
          execution(ID_A, {
            status: "FAILED",
            mask: MISSING,
            overlay: MISSING,
            pdf: MISSING,
            pdfReport: MISSING,
          }),
          execution(ID_B, { status: "REVIEW_REQUIRED" }),
        ],
      }),
    ).toMatchObject({
      analysisState: "FAILED",
      reportState: "FAILED",
      completionState: "INCOMPLETE",
      pollingStop: "FAILED",
    });
  });

  it("returns REVIEW_REQUIRED/ACTION_REQUIRED without declaring completion", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [
          execution(ID_A, { status: "REVIEW_REQUIRED" }),
          execution(ID_B),
        ],
      }),
    ).toMatchObject({
      analysisState: "REVIEW_REQUIRED",
      reportState: "AVAILABLE",
      completionState: "INCOMPLETE",
      pollingStop: "ACTION_REQUIRED",
    });
  });

  it("keeps IN_PROGRESS while required evidence is pending", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A],
        executions: [
          execution(ID_A, { mask: PENDING, overlay: PENDING }),
        ],
      }),
    ).toMatchObject({
      analysisState: "IN_PROGRESS",
      reportState: "AVAILABLE",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("ignores executions outside the frozen required set", () => {
    const base = computeConsultationStates({
      requiredExecutionIds: [ID_A],
      executions: [execution(ID_A)],
    });
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A],
        executions: [
          execution(ID_A),
          execution(ID_EXTRA, {
            status: "FAILED",
            pdf: FAILED,
            pdfReport: FAILED,
          }),
        ],
      }),
    ).toEqual(base);
  });

  it("treats a retryable FAILED artifact as pending, not terminal", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A],
        executions: [
          execution(ID_A, {
            overlay: FAILED_RETRYABLE,
            pdf: FAILED_RETRYABLE,
            pdfReport: FAILED_RETRYABLE,
          }),
        ],
      }),
    ).toMatchObject({
      analysisState: "IN_PROGRESS",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("fails polling on a permanent evidence failure", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A],
        executions: [execution(ID_A, { mask: FAILED })],
      }),
    ).toMatchObject({
      analysisState: "PARTIAL",
      reportState: "AVAILABLE",
      completionState: "INCOMPLETE",
      pollingStop: "FAILED",
    });
  });

  it("keeps FAILED ahead of REVIEW_REQUIRED and a running execution in the same set", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B, ID_EXTRA],
        executions: [
          execution(ID_A, {
            status: "FAILED",
            mask: MISSING,
            overlay: MISSING,
            pdf: MISSING,
            pdfReport: MISSING,
          }),
          execution(ID_B, { status: "REVIEW_REQUIRED" }),
          execution(ID_EXTRA, {
            status: "SEGMENTING",
            mask: PENDING,
            overlay: PENDING,
            pdf: PENDING,
            pdfReport: PENDING,
          }),
        ],
      }),
    ).toEqual({
      analysisState: "FAILED",
      reportState: "FAILED",
      completionState: "INCOMPLETE",
      pollingStop: "FAILED",
    });
  });

  it("never completes when a required execution has no state row", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [execution(ID_A)],
      }),
    ).toEqual({
      analysisState: "IN_PROGRESS",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("reports PARTIAL for a mixed set with results but a permanent evidence failure", () => {
    expect(
      computeConsultationStates({
        requiredExecutionIds: [ID_A, ID_B],
        executions: [execution(ID_A), execution(ID_B, { overlay: FAILED })],
      }),
    ).toEqual({
      analysisState: "PARTIAL",
      reportState: "AVAILABLE",
      completionState: "INCOMPLETE",
      pollingStop: "FAILED",
    });
  });

  it("requires both the PDF artifact and its report row for AVAILABLE", () => {
    const withoutReport = computeConsultationStates({
      requiredExecutionIds: [ID_A],
      executions: [execution(ID_A, { pdf: AVAILABLE, pdfReport: MISSING })],
    });
    expect(withoutReport).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });

    const withoutArtifact = computeConsultationStates({
      requiredExecutionIds: [ID_A],
      executions: [execution(ID_A, { pdf: MISSING, pdfReport: AVAILABLE })],
    });
    expect(withoutArtifact).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });
});

describe("computeExecutionDelivery", () => {
  it("marks a complete delivery", () => {
    expect(computeExecutionDelivery(execution(ID_A))).toEqual({
      resultStatus: "AVAILABLE",
      evidenceStatus: "AVAILABLE",
      pdfStatus: "AVAILABLE",
      complete: true,
      reviewRequired: false,
      failed: false,
      deliveryTerminal: true,
    });
  });

  it("keeps delivery open after ML COMPLETED when the PDF is missing", () => {
    expect(
      computeExecutionDelivery(
        execution(ID_A, { pdf: MISSING, pdfReport: MISSING }),
      ),
    ).toMatchObject({
      resultStatus: "AVAILABLE",
      evidenceStatus: "AVAILABLE",
      pdfStatus: "PENDING",
      complete: false,
      failed: false,
      deliveryTerminal: false,
    });
  });

  it("never marks REVIEW_REQUIRED as complete", () => {
    expect(
      computeExecutionDelivery(
        execution(ID_A, { status: "REVIEW_REQUIRED" }),
      ),
    ).toMatchObject({
      resultStatus: "AVAILABLE",
      reviewRequired: true,
      complete: false,
      deliveryTerminal: true,
    });
  });

  it("marks a failed execution as terminal and failed", () => {
    expect(
      computeExecutionDelivery(
        execution(ID_A, {
          status: "FAILED",
          mask: MISSING,
          overlay: MISSING,
          pdf: MISSING,
          pdfReport: MISSING,
        }),
      ),
    ).toMatchObject({
      resultStatus: "FAILED",
      complete: false,
      failed: true,
      deliveryTerminal: true,
    });
  });

  it("never completes delivery while the result is still running", () => {
    expect(
      computeExecutionDelivery(execution(ID_A, { status: "CLASSIFYING" })),
    ).toEqual({
      resultStatus: "PENDING",
      evidenceStatus: "AVAILABLE",
      pdfStatus: "AVAILABLE",
      complete: false,
      reviewRequired: false,
      failed: false,
      deliveryTerminal: false,
    });
  });
});

describe("computeRetryAfterSeconds", () => {
  it("uses 2s initially and caps at 10s by stage", () => {
    expect(computeRetryAfterSeconds("QUEUED", "CONTINUE")).toBe(2);
    expect(computeRetryAfterSeconds("DOWNLOADING", "CONTINUE")).toBe(4);
    expect(computeRetryAfterSeconds("CLASSIFYING", "CONTINUE")).toBe(10);
    expect(computeRetryAfterSeconds("COMPLETED", "CONTINUE")).toBe(2);
  });

  it("omits Retry-After when polling stops", () => {
    expect(computeRetryAfterSeconds("QUEUED", "COMPLETE")).toBeNull();
    expect(computeRetryAfterSeconds("QUEUED", "ACTION_REQUIRED")).toBeNull();
    expect(computeRetryAfterSeconds("QUEUED", "FAILED")).toBeNull();
  });

  it("covers the full stage ladder and never exceeds the 10s ceiling", () => {
    expect(computeRetryAfterSeconds("LOCALIZING", "CONTINUE")).toBe(6);
    expect(computeRetryAfterSeconds("SEGMENTING", "CONTINUE")).toBe(8);
    for (const stage of [
      "QUEUED",
      "DOWNLOADING",
      "LOCALIZING",
      "SEGMENTING",
      "CLASSIFYING",
      "COMPLETED",
      "NOT_A_STAGE",
    ]) {
      const seconds = computeRetryAfterSeconds(stage, "CONTINUE");
      expect(seconds).toBeGreaterThanOrEqual(2);
      expect(seconds).toBeLessThanOrEqual(10);
    }
    expect(computeRetryAfterSeconds("NOT_A_STAGE", "CONTINUE")).toBe(2);
  });
});
