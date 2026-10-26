/**
 * Deterministic processing simulator for the capture demo slice.
 * Progress is derived purely from wall-clock elapsed time, no internal timers:
 * closing the view and coming back later keeps the study exactly where it was,
 * mirroring the shipped promise "podés cerrar esta vista y volver más tarde".
 * When the real API lands, this module is swapped for status polling.
 */

import type { EyeSide } from "@/types/clinical";
import {
  CAPTURE_STAGE_LIST,
  type CaptureEyeRunBadge,
  type CaptureProcessingSnapshot,
  type CaptureStageState,
} from "@/types/capture";

/** Study-level session hops. */
const SESSION_STAGE_SECONDS = {
  verification: 0.4,
  upload: 0.2,
} as const;

/** Per-eye job stages, run sequentially (OD first, OS right after). */
const EYE_STAGE_SECONDS = {
  downloading: 0.8,
  localizing: 0.9,
  segmenting: 0.7,
  classifying: 1.1,
} as const;

const EYE_STAGE_ORDER = [
  "downloading",
  "localizing",
  "segmenting",
  "classifying",
] as const;

const RESULT_STAGE_SECONDS = 0.8;

const PER_EYE_JOB_SECONDS = EYE_STAGE_ORDER.reduce(
  (sum, id) => sum + EYE_STAGE_SECONDS[id],
  0,
);

export const MOCK_TOTAL_PROCESSING_SECONDS =
  SESSION_STAGE_SECONDS.verification +
  SESSION_STAGE_SECONDS.upload +
  2 * PER_EYE_JOB_SECONDS +
  RESULT_STAGE_SECONDS;

/** Windows of the two session hops; both eyes stay queued until upload ends. */
const SESSION_START =
  SESSION_STAGE_SECONDS.verification + SESSION_STAGE_SECONDS.upload;

function sessionWindow(stage: keyof typeof SESSION_STAGE_SECONDS): {
  start: number;
  end: number;
} {
  return {
    verification: { start: 0, end: SESSION_STAGE_SECONDS.verification },
    upload: {
      start: SESSION_STAGE_SECONDS.verification,
      end: SESSION_START,
    },
  }[stage];
}

function eyeStageWindow(side: EyeSide, stage: (typeof EYE_STAGE_ORDER)[number]): {
  start: number;
  end: number;
} {
  const index = EYE_STAGE_ORDER.indexOf(stage);
  const queueOffset = side === "OD" ? 0 : PER_EYE_JOB_SECONDS;
  const start = SESSION_START + queueOffset + EYE_STAGE_ORDER.slice(0, index)
    .reduce((sum, id) => sum + EYE_STAGE_SECONDS[id], 0);
  return { start, end: start + EYE_STAGE_SECONDS[stage] };
}

function eyeJobWindow(side: EyeSide): { start: number; end: number } {
  const start = SESSION_START + (side === "OD" ? 0 : PER_EYE_JOB_SECONDS);
  return { start, end: start + PER_EYE_JOB_SECONDS };
}

function eyeBadge(side: EyeSide, elapsed: number): CaptureEyeRunBadge {
  const job = eyeJobWindow(side);
  if (elapsed < job.start) return "EN COLA";
  if (elapsed >= job.end) return "LISTO";
  return "EN CURSO";
}

export function captureProcessingSnapshot(
  elapsed: number,
): CaptureProcessingSnapshot {
  const stageStates: CaptureProcessingSnapshot["stageStates"] = {
    verification: "pending",
    upload: "pending",
    downloading: "pending",
    localizing: "pending",
    segmenting: "pending",
    classifying: "pending",
    result: "pending",
  };

  for (const stage of ["verification", "upload"] as const) {
    const window = sessionWindow(stage);
    stageStates[stage] =
      elapsed >= window.end ? "done" : elapsed >= window.start ? "active" : "pending";
  }

  for (const stage of EYE_STAGE_ORDER) {
    const od = eyeStageWindow("OD", stage);
    const os = eyeStageWindow("OS", stage);
    if (elapsed >= od.end && elapsed >= os.end) stageStates[stage] = "done";
    else if (elapsed >= od.start) stageStates[stage] = "active";
  }

  const resultStart = SESSION_START + 2 * PER_EYE_JOB_SECONDS;
  stageStates.result =
    elapsed >= MOCK_TOTAL_PROCESSING_SECONDS
      ? "done"
      : elapsed >= resultStart
        ? "active"
        : "pending";

  const activeStageLabel =
    CAPTURE_STAGE_LIST.find((stage) => stageStates[stage.id] === "active")
      ?.label ?? null;

  return {
    stageStates,
    eyeBadges: { OD: eyeBadge("OD", elapsed), OS: eyeBadge("OS", elapsed) },
    activeStageLabel,
    elapsedSeconds: elapsed,
    finished: elapsed >= MOCK_TOTAL_PROCESSING_SECONDS,
  };
}

/** Formatted demo timings shown next to each pipeline row's label. */
export function stageTimeLabel(
  stageId: keyof CaptureProcessingSnapshot["stageStates"],
  stage: CaptureStageState,
): string {
  if (stage === "pending") return "—";
  if (stage === "active") return "en curso";
  const seconds =
    stageId in SESSION_STAGE_SECONDS
      ? SESSION_STAGE_SECONDS[stageId as keyof typeof SESSION_STAGE_SECONDS]
      : stageId in EYE_STAGE_SECONDS
        ? EYE_STAGE_SECONDS[stageId as keyof typeof EYE_STAGE_SECONDS]
        : RESULT_STAGE_SECONDS;
  return `${seconds.toFixed(1)} s`;
}

export function clampElapsed(elapsed: number): number {
  return Math.max(0, Math.min(elapsed, MOCK_TOTAL_PROCESSING_SECONDS));
}
