"use client";

import React from "react";
import type { EyeSide } from "@/types/clinical";
import {
  CAPTURE_EYE_LABELS,
  CAPTURE_EYE_ORDER,
  CAPTURE_STAGE_LIST,
  type CaptureEyeRunBadge,
  type CaptureEyeSlot,
  type CaptureProcessingSnapshot,
} from "@/types/capture";
import {
  MOCK_TOTAL_PROCESSING_SECONDS,
  stageTimeLabel,
} from "@/lib/capture/mockStudy";

interface CaptureProcessingPanelProps {
  snapshot: CaptureProcessingSnapshot;
  eyeSlots: Record<EyeSide, CaptureEyeSlot>;
}

function formatElapsedTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function CaptureProcessingPanel({
  snapshot,
  eyeSlots,
}: CaptureProcessingPanelProps) {
  const progressRatio = Math.min(
    1,
    snapshot.elapsedSeconds / MOCK_TOTAL_PROCESSING_SECONDS,
  );
  const progressPercent = Math.round(progressRatio * 100);

  const badgeStyle = (badge: CaptureEyeRunBadge) => {
    switch (badge) {
      case "EN CURSO":
        return {
          container: "bg-[#17140C] border-[#3B2E15] text-[#D4973B]",
          dot: "bg-[#D4973B]",
        };
      case "LISTO":
        return {
          container: "bg-[#153B25] border-[#1E5136] text-clinical-green",
          dot: "bg-clinical-green",
        };
      case "EN COLA":
      default:
        return {
          container: "bg-cockpit-subtle border-[#27272A] text-zinc-400",
          dot: "bg-cockpit-text-dim",
        };
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 p-5 overflow-y-auto">
      {/* Header bar matching Frame bMne9 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
          ESTADO DEL ESTUDIO
        </span>
        <span className="text-[10px] text-cockpit-text-dim font-mono">
          Transcurrido {formatElapsedTimer(snapshot.elapsedSeconds)}
        </span>
      </div>

      {/* Progress track (3px, gold fill over #1C1C22) */}
      <div className="h-[3px] w-full bg-cockpit-border rounded-full overflow-hidden mb-5">
        <div
          className="h-full bg-clinical-gold transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Miniaturas OD / OS */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {CAPTURE_EYE_ORDER.map((side) => {
          const slot = eyeSlots[side];
          const badge = snapshot.eyeBadges[side];
          const badgeUi = badgeStyle(badge);

          return (
            <div
              key={side}
              className="flex flex-col bg-cockpit-card border border-cockpit-border rounded-md p-3"
            >
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
                  {CAPTURE_EYE_LABELS[side]}
                </span>
                <div
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-semibold ${badgeUi.container}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${badgeUi.dot}`} />
                  <span>{badge}</span>
                </div>
              </div>

              {/* Viewport canvas */}
              <div className="h-[180px] bg-[#08080A] border border-cockpit-border rounded flex items-center justify-center overflow-hidden relative">
                {slot.asset?.previewUrl ? (
                  <img
                    src={slot.asset.previewUrl}
                    alt={`Retinografía ${side}`}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <div
                    className="w-28 h-28 rounded-full shadow-lg relative flex items-center justify-center"
                    style={{
                      background:
                        "radial-gradient(circle at 45% 50%, #4A1B0E 0%, #301007 35%, #180603 65%, #0B0302 85%, #08080A 100%)",
                    }}
                  >
                    <div
                      className={`w-6 h-7 rounded-full absolute opacity-90 ${
                        side === "OD" ? "left-6" : "right-6"
                      }`}
                      style={{
                        background:
                          "radial-gradient(circle at 40% 45%, #F5CE7A 0%, #D89838 50%, #854817 90%)",
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pipeline de 7 Etapas */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] font-bold tracking-wider text-cockpit-text-dim uppercase mb-1">
          PIPELINE DE ANÁLISIS
        </span>

        {CAPTURE_STAGE_LIST.map((stage) => {
          const state = snapshot.stageStates[stage.id];
          const timeText = stageTimeLabel(stage.id, state);

          if (state === "active") {
            return (
              <div
                key={stage.id}
                className="flex items-center justify-between px-3 py-2 bg-cockpit-panel border border-cockpit-border-subtle rounded text-[11px]"
              >
                <div className="flex items-center gap-2.5">
                  <span className="h-2 w-2 rounded-full bg-[#D4973B] animate-pulse" />
                  <span className="font-semibold text-cockpit-text">
                    {stage.label}
                  </span>
                </div>
                <span className="font-mono text-[9px] text-[#D4973B]">
                  {timeText}
                </span>
              </div>
            );
          }

          if (state === "done") {
            return (
              <div
                key={stage.id}
                className="flex items-center justify-between px-3 py-1.5 text-[11px]"
              >
                <div className="flex items-center gap-2.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-clinical-green" />
                  <span className="text-zinc-400">{stage.label}</span>
                </div>
                <span className="font-mono text-[9px] text-cockpit-text-dim">
                  {timeText}
                </span>
              </div>
            );
          }

          // pending
          return (
            <div
              key={stage.id}
              className="flex items-center justify-between px-3 py-1.5 text-[11px]"
            >
              <div className="flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
                <span className="text-cockpit-text-dim">{stage.label}</span>
              </div>
              <span className="font-mono text-[9px] text-cockpit-text-dim">
                {timeText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
