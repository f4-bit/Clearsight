"use client";

import React, { useState } from "react";
import { TopBar } from "@/components/TopBar";
import { BilateralCanvas } from "@/components/BilateralCanvas";
import { TelemetrySidebar } from "@/components/TelemetrySidebar";
import { MOCK_STUDY } from "@/lib/mockData";
import { FeedbackCreate, FeedbackRead } from "@/types/clinical";

export default function ClinicalCockpitPage() {
  const [study] = useState(MOCK_STUDY);
  const [isSynced, setIsSynced] = useState(true);
  const [reportExportPending, setReportExportPending] = useState(false);
  const [lastSubmittedFeedback, setLastSubmittedFeedback] = useState<FeedbackRead | null>(null);

  const handleToggleSync = () => {
    setIsSynced((prev) => !prev);
  };

  const handleExportReport = () => {
    setReportExportPending(true);
    setTimeout(() => {
      setReportExportPending(false);
    }, 2500);
  };

  const handleSubmitFeedback = (feedback: FeedbackCreate) => {
    const recorded: FeedbackRead = {
      ...feedback,
      id: "fb-" + Date.now(),
      created_at: new Date().toISOString(),
    };
    setLastSubmittedFeedback(recorded);
  };

  return (
    <main className="h-screen w-screen flex flex-col bg-cockpit-bg text-cockpit-text overflow-hidden select-none">
      {/* 1. Top Instrument Bar */}
      <TopBar
        study={study}
        isSynced={isSynced}
        onToggleSync={handleToggleSync}
        onExportReport={handleExportReport}
        reportExportPending={reportExportPending}
      />

      {/* Degradation State Banner (REVIEW_REQUIRED) */}
      {(study.status === "REVIEW_REQUIRED" ||
        study.od.quality.review_required ||
        study.os.quality.review_required) && (
        <div className="bg-amber-500/20 border-b border-amber-800/60 px-4 py-2 text-amber-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold">⚠️ ADVERTENCIA CLÍNICA / REVIEW_REQUIRED:</span>
            <span>
              Opacidad de medios o calidad de segmentación limítrofe detectada. La clasificación automática se encuentra condicionada a supervisión presencial obligatoria.
            </span>
          </div>
          <span className="font-mono text-[11px] text-amber-400">Estado: REVISIÓN REQUERIDA</span>
        </div>
      )}

      {/* 2. Main Workspace (Canvas 65% + Telemetry 35%) */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Bilateral Retinal Viewports */}
        <BilateralCanvas od={study.od} os={study.os} isSynced={isSynced} />

        {/* Telemetry and HITL Review Sidebar */}
        <TelemetrySidebar
          study={study}
          onSubmitFeedback={handleSubmitFeedback}
          lastFeedback={lastSubmittedFeedback}
        />
      </div>
    </main>
  );
}
