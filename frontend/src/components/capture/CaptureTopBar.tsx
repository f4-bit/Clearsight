"use client";

import React from "react";

interface CaptureTopBarProps {
  phase: "draft" | "processing" | "completed";
  studyIdLabel: string;
  scopeLabel: string;
  timeLabel: string;
  pillText: string;
  actionLabel: string;
  onAction: () => void;
}

export function CaptureTopBar({
  phase,
  studyIdLabel,
  scopeLabel,
  timeLabel,
  pillText,
  actionLabel,
  onAction,
}: CaptureTopBarProps) {
  return (
    <header className="h-[52px] w-full bg-cockpit-surface border-b border-cockpit-border px-5 flex items-center justify-between">
      {/* Left: Brand lockup + study meta */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-base tracking-tight text-white">
            ClearSight
          </span>
          <span className="text-xs text-cockpit-text-dim">
            Estación de Diagnóstico Oftalmológico
          </span>
        </div>

        <div className="h-4 w-[1px] bg-cockpit-border-subtle" />

        <div className="flex items-center gap-3 text-xs">
          <span className="font-mono font-semibold text-cockpit-text-muted">
            ID: {studyIdLabel}
          </span>
          <span className="text-cockpit-text-dim">{scopeLabel}</span>
          <span className="font-mono text-[11px] text-cockpit-text-dim">
            {timeLabel} UTC
          </span>
        </div>
      </div>

      {/* Right: capture-phase pill + contextual action */}
      <div className="flex items-center gap-3">
        <div
          aria-live="polite"
          className="flex items-center gap-2 px-2.5 py-1 rounded bg-amber-950/50 border border-amber-800/60 text-xs font-medium text-amber-400"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span>{pillText}</span>
        </div>

        <button
          onClick={onAction}
          className="px-3 py-1 rounded text-xs font-medium bg-[#1E1E24] hover:bg-[#25252D] text-cockpit-text border border-[#2E2E36] transition-colors"
        >
          {actionLabel}
        </button>
      </div>
    </header>
  );
}
