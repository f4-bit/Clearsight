"use client";

import React from "react";
import type { EyeSide, InferenceResult } from "@/types/clinical";
import {
  CAPTURE_EYE_LABELS,
  CAPTURE_EYE_ORDER,
  type CaptureEyeSlot,
} from "@/types/capture";
import { MOCK_CONSENSUS } from "@/lib/capture/mockFixtures";

interface CaptureCompletedPanelProps {
  eyeSlots: Record<EyeSide, CaptureEyeSlot>;
  results: Record<EyeSide, InferenceResult>;
  completedAtIso: string;
}

function utcTimeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", { timeZone: "UTC" });
}

export function CaptureCompletedPanel({
  eyeSlots,
  results,
  completedAtIso,
}: CaptureCompletedPanelProps) {
  return (
    <div className="flex-1 h-full min-w-0 flex flex-col p-5 overflow-hidden">
      {/* Header bar matching Frame ZKc1O */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
          ESTUDIO COMPLETADO
        </span>
        <span className="text-[10px] text-cockpit-text-dim font-mono">
          Finalizado {utcTimeLabel(completedAtIso)} UTC ·{" "}
          {MOCK_CONSENSUS.elapsedSeconds.toFixed(1)} s
        </span>
      </div>

      {/* Miniaturas OD / OS with vCDR footers - fills available vertical space */}
      <div className="grid grid-cols-2 gap-4 mb-4 flex-1 min-h-0">
        {CAPTURE_EYE_ORDER.map((side) => {
          const slot = eyeSlots[side];
          const result = results[side];
          const vCdrFormatted = result.cdr_vertical?.toFixed(2) ?? "—";

          return (
            <div
              key={side}
              className="flex flex-col h-full min-h-0 bg-cockpit-card border border-cockpit-border rounded-md p-3.5 overflow-hidden"
            >
              {/* Card Header */}
              <div className="flex items-center justify-between mb-2 shrink-0">
                <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
                  {CAPTURE_EYE_LABELS[side]}
                </span>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-[#1E5136] bg-[#153B25] text-[9px] font-semibold text-clinical-green">
                  <span className="h-1.5 w-1.5 rounded-full bg-clinical-green" />
                  <span>LISTO</span>
                </div>
              </div>

              {/* Viewport canvas */}
              <div className="flex-1 min-h-0 bg-[#08080A] border border-cockpit-border rounded flex items-center justify-center overflow-hidden relative">
                {slot.asset?.previewUrl ? (
                  <img
                    src={slot.asset.previewUrl}
                    alt={`Retinografía ${side}`}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <div
                    className="w-[280px] h-[280px] max-w-[85%] max-h-[85%] aspect-square rounded-full shadow-lg relative flex items-center justify-center"
                    style={{
                      background:
                        "radial-gradient(circle at 45% 50%, #4A1B0E 0%, #301007 35%, #180603 65%, #0B0302 85%, #08080A 100%)",
                    }}
                  >
                    <div
                      className={`w-10 h-12 rounded-full absolute opacity-90 ${
                        side === "OD" ? "left-[60px]" : "right-[60px]"
                      }`}
                      style={{
                        background:
                          "radial-gradient(circle at 40% 45%, #F5CE7A 0%, #D89838 50%, #854817 90%)",
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Card Footer: vCDR label and value */}
              <div className="h-8 px-1 mt-2 shrink-0 flex items-center justify-between text-[11px] border-t border-cockpit-border/60">
                <span className="text-[9px] font-bold text-cockpit-text-dim uppercase tracking-wider">
                  vCDR
                </span>
                <span className="font-mono text-[11px] font-semibold text-clinical-gold">
                  {vCdrFormatted}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bilateral Consensus Box matching Frame ZKc1O */}
      <div className="p-4 bg-cockpit-panel border border-cockpit-border-subtle rounded-md flex flex-col gap-1.5 shrink-0">
        <span className="text-[9px] font-bold tracking-wider text-cockpit-text-dim uppercase">
          CONSENSO BILATERAL
        </span>
        <h2 className="text-[17px] font-bold text-white tracking-tight">
          Sospecha de Glaucoma
        </h2>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="font-mono text-[13px] font-semibold text-clinical-gold">
            {Math.round(MOCK_CONSENSUS.confidence * 100)}%
          </span>
          <span className="text-cockpit-text-muted">
            de probabilidad · disco y copa segmentados en ambos ojos
          </span>
        </div>
      </div>
    </div>
  );
}
