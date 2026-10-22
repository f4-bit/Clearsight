"use client";

import React from "react";
import { BilateralStudy } from "@/types/clinical";

interface TopBarProps {
  study: BilateralStudy;
  onExportReport?: () => void;
  reportExportPending?: boolean;
}

export function TopBar({
  study,
  onExportReport,
  reportExportPending = false,
}: TopBarProps) {
  return (
    <header className="h-[52px] w-full bg-cockpit-surface border-b border-cockpit-border px-5 flex items-center justify-between">
      {/* Left: Brand Lockup & Study Meta */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-base tracking-tight text-white">ClearSight</span>
          <span className="text-xs text-cockpit-text-dim">Estación de Diagnóstico Oftalmológico</span>
        </div>

        <div className="h-4 w-[1px] bg-cockpit-border-subtle" />

        <div className="flex items-center gap-3 text-xs">
          <span className="font-mono font-semibold text-cockpit-text-muted">
            ID: #{study.patient_id.slice(0, 8).toUpperCase()}
          </span>
          <span className="text-cockpit-text-dim">
            {study.clinical_features.Age} años ·{" "}
            {study.clinical_features.Gender === 1 ? "Masculino" : "Femenino"} · Estudio Bilateral
          </span>
          <span className="text-cockpit-text-dim font-mono text-[11px]">
            {new Date(study.created_at).toLocaleTimeString("es-ES", { timeZone: "UTC" })} UTC
          </span>
        </div>
      </div>

      {/* Right: Global Status & Actions */}
      <div className="flex items-center gap-3">
        {/* Consensus Triage Pill (sober dark amber badge) */}
        <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#17140C] border border-[#3B2E15] text-xs font-medium text-[#D4973B]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#D4973B]" />
          <span>
            {study.status === "REVIEW_REQUIRED"
              ? "Revisión Requerida (Opacidad)"
              : `Sospecha de Glaucoma (${(study.consensus_confidence * 100).toFixed(0)}% probabilidad)`}
          </span>
        </div>

        {/* Export PDF Report Button */}
        <button
          onClick={onExportReport}
          disabled={reportExportPending}
          aria-label="Exportar informe clínico en formato PDF"
          className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-[#1E1E24] hover:bg-[#25252D] text-cockpit-text border border-[#2E2E36] transition-colors disabled:opacity-50"
        >
          <span>{reportExportPending ? "Generando PDF..." : "Exportar Informe"}</span>
          <span className="text-[10px] text-cockpit-text-muted">↗</span>
        </button>
      </div>
    </header>
  );
}
