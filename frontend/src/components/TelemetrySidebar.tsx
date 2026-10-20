"use client";

import React, { useState } from "react";
import {
  BilateralStudy,
  DiagnosticClass,
  FeedbackCreate,
  FeedbackRead,
  LABEL_TO_CLASS,
  LABEL_TO_CLINICAL,
} from "@/types/clinical";

interface TelemetrySidebarProps {
  study: BilateralStudy;
  onSubmitFeedback?: (feedback: FeedbackCreate) => void;
  lastFeedback?: FeedbackRead | null;
}

export function TelemetrySidebar({
  study,
  onSubmitFeedback,
  lastFeedback,
}: TelemetrySidebarProps) {
  const [activeTab, setActiveTab] = useState<"evidence" | "review">("evidence");

  // Determine model predicted class from the study payload
  const modelPredictedClass: DiagnosticClass =
    LABEL_TO_CLASS[study.od.label ?? "Suspicious_Glaucoma"] ?? 2;

  const [selectedClass, setSelectedClass] = useState<DiagnosticClass>(modelPredictedClass);
  const [doctorNotes, setDoctorNotes] = useState<string>(
    "Copa aumentada en OD con adelgazamiento neurorretiniano inferior. Solicitar campo visual Humphrey y OCT de CFNR."
  );
  const [isGoldStandard, setIsGoldStandard] = useState<boolean>(true);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  const clinicalLabel = LABEL_TO_CLINICAL[study.consensus_label] ?? "Suspect";
  const isReviewRequired =
    study.status === "REVIEW_REQUIRED" ||
    study.od.quality.review_required ||
    study.os.quality.review_required;

  const getTriageStyle = () => {
    if (isReviewRequired) return "text-amber-300";
    if (clinicalLabel === "Glaucoma") return "text-rose-400";
    if (clinicalLabel === "Suspect") return "text-clinical-gold";
    return "text-clinical-green";
  };

  const handleSubmit = () => {
    const feedback: FeedbackCreate = {
      consultation_id: study.consultation_id,
      inference_id: study.od.inference_id,
      doctor_id: study.doctor_id,
      validated_class: selectedClass,
      predicted_class: modelPredictedClass,
      confidence: study.od.confidence ?? study.consensus_confidence,
      agreement: selectedClass === modelPredictedClass,
      doctor_notes: doctorNotes,
      is_gold_standard: isGoldStandard,
    };
    if (onSubmitFeedback) {
      onSubmitFeedback(feedback);
    }
    setIsSubmitted(true);
  };

  // Probabilities derived from actual study payload
  const probSuspect = Math.round((study.od.probabilities.Suspicious_Glaucoma ?? 0) * 100);
  const probGlaucoma = Math.round((study.od.probabilities.Glaucoma ?? 0) * 100);
  const probNormal = Math.round((study.od.probabilities.Non_Glaucoma ?? 0) * 100);

  return (
    <aside className="w-[560px] xl:w-[580px] shrink-0 h-full bg-cockpit-surface border-l border-cockpit-border p-7 flex flex-col gap-6 overflow-y-auto">
      {/* SECTION 1: MODEL PREDICTION (Derived strictly from schema) */}
      <section className="flex flex-col gap-2.5">
        <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
          Predicción del Modelo
        </span>

        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight text-white">
            {isReviewRequired
              ? "Revisión Requerida (Opacidad de medios)"
              : clinicalLabel === "Normal"
              ? "Diagnóstico Normal"
              : clinicalLabel === "Suspect"
              ? "Sospecha de Glaucoma"
              : "Glaucoma Confirmado"}
          </h2>
          <span className={`font-mono text-xs font-semibold tabular-nums ${getTriageStyle()}`}>
            {isReviewRequired ? "--" : `${(study.consensus_confidence * 100).toFixed(1)}% certeza`}
          </span>
        </div>

        {/* Minimal Precision Bar - Suppressed when review is required */}
        <div className="w-full h-1 bg-cockpit-subtle rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isReviewRequired
                ? "bg-amber-400"
                : clinicalLabel === "Glaucoma"
                ? "bg-rose-400"
                : clinicalLabel === "Suspect"
                ? "bg-clinical-gold"
                : "bg-clinical-green"
            }`}
            style={{ width: isReviewRequired ? "0%" : `${study.consensus_confidence * 100}%` }}
          />
        </div>

        {/* Derived Distribution Line - Suppressed when review is required */}
        <div className="flex items-center justify-between text-xs text-cockpit-text-muted">
          <span>
            {isReviewRequired
              ? "Distribución de probabilidad suprimida por estudio degradado"
              : `Sospecha (OD): ${probSuspect}% · Glaucoma (OD): ${probGlaucoma}% · Normal (OD): ${probNormal}%`}
          </span>
          <span className="text-[11px] text-cockpit-text-dim font-mono">
            {study.od.model_versions.resnet50} + {study.od.model_versions.efficientnet_b3}
          </span>
        </div>
      </section>

      <div className="h-[1px] w-full bg-cockpit-border" />

      {/* SECTION 2: VERTICAL CUP-TO-DISC RATIO (vCDR Scale) */}
      <section className="flex flex-col gap-2.5">
        <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
          Excavación Papilar (vCDR)
        </span>

        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-cockpit-text-muted">OD:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                study.od.cdr_vertical != null && study.od.cdr_vertical >= 0.5
                  ? "text-clinical-gold"
                  : "text-cockpit-text"
              }`}
            >
              {study.od.cdr_vertical != null ? study.od.cdr_vertical.toFixed(2) : "--"}
            </span>
            <span className="text-cockpit-text-dim text-[11px]">
              {study.od.cdr_vertical != null && study.od.cdr_vertical >= 0.5
                ? "(Límite)"
                : "(Normal)"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-cockpit-text-muted">OS:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                study.os.cdr_vertical != null && study.os.cdr_vertical >= 0.5
                  ? "text-clinical-gold"
                  : "text-cockpit-text"
              }`}
            >
              {study.os.cdr_vertical != null ? study.os.cdr_vertical.toFixed(2) : "--"}
            </span>
            <span className="text-cockpit-text-dim text-[11px]">
              {study.os.cdr_vertical != null && study.os.cdr_vertical >= 0.5
                ? "(Límite)"
                : "(Normal)"}
            </span>
          </div>

          <div className="flex items-center gap-1 text-[11px] font-medium text-clinical-gold">
            <span>Asimetría:</span>
            <span className="font-mono font-bold tabular-nums">Δ {study.asymmetry_vcdr.toFixed(2)}</span>
          </div>
        </div>

        {/* Minimalist Calibrated Scale Track */}
        <div className="relative w-full h-3 bg-cockpit-bg border border-cockpit-border rounded overflow-hidden">
          {/* Subtle tick markers at 0.50 (50%) and 0.70 (70%) */}
          <div className="absolute top-0 bottom-0 left-[50%] w-[1px] bg-cockpit-border-subtle" />
          <div className="absolute top-0 bottom-0 left-[70%] w-[1px] bg-cockpit-border-subtle" />

          {/* Marker OS */}
          {study.os.cdr_vertical != null && (
            <div
              className="absolute top-0.5 bottom-0.5 w-1 bg-cockpit-text-muted rounded-full"
              style={{ left: `${Math.min(100, study.os.cdr_vertical * 100)}%` }}
            />
          )}

          {/* Marker OD */}
          {study.od.cdr_vertical != null && (
            <div
              className="absolute top-0.5 bottom-0.5 w-1 bg-clinical-gold rounded-full"
              style={{ left: `${Math.min(100, study.od.cdr_vertical * 100)}%` }}
            />
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] text-cockpit-text-dim">
          <span>0.0 (Fisiológico)</span>
          <span className="text-cockpit-text-dim">0.50 (Límite sospecha)</span>
          <span>0.70 (Patológico)</span>
        </div>
      </section>

      <div className="h-[1px] w-full bg-cockpit-border" />

      {/* PROGRESSIVE DISCLOSURE TABS */}
      <div className="flex items-center p-0.5 bg-cockpit-bg border border-cockpit-border rounded text-xs">
        <button
          onClick={() => setActiveTab("evidence")}
          className={`flex-1 py-1.5 rounded transition-colors text-center font-medium ${
            activeTab === "evidence"
              ? "bg-cockpit-card text-cockpit-text shadow-sm"
              : "text-cockpit-text-muted hover:text-cockpit-text"
          }`}
        >
          1. Evidencia y Biomarcadores (11)
        </button>
        <button
          onClick={() => setActiveTab("review")}
          className={`flex-1 py-1.5 rounded transition-colors text-center font-medium ${
            activeTab === "review"
              ? "bg-cockpit-card text-cockpit-text shadow-sm"
              : "text-cockpit-text-muted hover:text-cockpit-text"
          }`}
        >
          2. Dictamen y Firma Médica
        </button>
      </div>

      {/* TAB 1: 11 CLINICAL BIOMARKERS TABLE */}
      {activeTab === "evidence" && (
        <section className="flex flex-col gap-3.5 flex-1 min-h-0">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
              Biomarcadores Clínicos Estructurados (11)
            </span>
            <span className="text-[10px] text-cockpit-text-dim">Normalizado Z-Score Fold 4</span>
          </div>

          {/* Formal Bordered Table Grid */}
          <div className="w-full bg-cockpit-card border border-cockpit-border-subtle rounded overflow-hidden text-xs">
            {/* Header Row */}
            <div className="h-8 px-4 bg-cockpit-bg border-b border-cockpit-border-subtle grid grid-cols-[210px_130px_1fr] items-center text-[9px] font-bold tracking-wider text-cockpit-text-dim uppercase">
              <span>Parámetro Clínico (Contrato)</span>
              <span className="text-clinical-gold">Valor Estudio</span>
              <span>Rango de Referencia</span>
            </div>

            {/* Matrix Rows (Derived strictly from study.clinical_features) */}
            {[
              {
                param: "Pneumatic (PIO Neumática)",
                val: `${study.clinical_features.Pneumatic.toFixed(1)} mmHg`,
                ref: "< 21.0 mmHg",
                alert: study.clinical_features.Pneumatic > 21,
              },
              {
                param: "Perkins (PIO Aplanación)",
                val: `${study.clinical_features.Perkins.toFixed(1)} mmHg`,
                ref: "< 21.0 mmHg",
                alert: study.clinical_features.Perkins > 21,
              },
              {
                param: "Pachymetry (Espesor CCT)",
                val: `${study.clinical_features.Pachymetry.toFixed(0)} µm`,
                ref: "540 - 560 µm",
                alert: study.clinical_features.Pachymetry < 540,
              },
              {
                param: "VF_DM (Campo Visual)",
                val: `${study.clinical_features.VF_DM.toFixed(1)} dB`,
                ref: "> -2.0 dB",
                alert: study.clinical_features.VF_DM < -2.0,
              },
              {
                param: "Axial_Length (Longitud Axial)",
                val: `${study.clinical_features.Axial_Length.toFixed(1)} mm`,
                ref: "22.0 - 24.5 mm",
                alert:
                  study.clinical_features.Axial_Length < 22.0 ||
                  study.clinical_features.Axial_Length > 24.5,
              },
              {
                param: "Phakic/Pseudophakic",
                val: study.clinical_features.Phakic_Pseudophakic === 1 ? "Fáquico" : "Pseudofáquico",
                ref: "--",
                alert: false,
              },
              {
                param: "Age (Edad)",
                val: `${study.clinical_features.Age.toFixed(0)} años`,
                ref: "Riesgo > 60 años",
                alert: study.clinical_features.Age >= 60,
              },
              {
                param: "Gender (Sexo Biológico)",
                val: study.clinical_features.Gender === 1 ? "Masculino" : "Femenino",
                ref: "--",
                alert: false,
              },
              {
                param: "dioptre_1 (Esfera Refracción)",
                val: `${study.clinical_features.dioptre_1 >= 0 ? "+" : ""}${study.clinical_features.dioptre_1.toFixed(2)} D`,
                ref: "--",
                alert: false,
              },
              {
                param: "dioptre_2 (Cilindro)",
                val: `${study.clinical_features.dioptre_2.toFixed(2)} D`,
                ref: "--",
                alert: false,
              },
              {
                param: "astigmatism (Eje Astigmático)",
                val: `${study.clinical_features.astigmatism.toFixed(0)}°`,
                ref: "--",
                alert: false,
              },
            ].map((row, idx, arr) => (
              <div
                key={row.param}
                className={`h-9 px-4 grid grid-cols-[210px_130px_1fr] items-center ${
                  idx !== arr.length - 1 ? "border-b border-cockpit-border" : ""
                } ${idx % 2 === 0 ? "bg-cockpit-card" : "bg-cockpit-panel"}`}
              >
                <span className="text-cockpit-text-muted text-[11px]">{row.param}</span>
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    row.alert ? "text-clinical-gold font-semibold" : "text-cockpit-text"
                  }`}
                >
                  {row.val} {row.alert ? "▲" : ""}
                </span>
                <span className="font-mono text-[11px] text-cockpit-text-dim tabular-nums">
                  {row.ref}
                </span>
              </div>
            ))}
          </div>

          {/* Next Step Transition Button */}
          <div className="mt-auto pt-2 flex items-center justify-between text-xs">
            <span className="text-[11px] text-cockpit-text-dim">
              11 biomarcadores validados en contrato
            </span>
            <button
              onClick={() => setActiveTab("review")}
              className="px-3.5 py-1.5 rounded bg-cockpit-subtle hover:bg-[#282832] text-cockpit-text border border-cockpit-border-subtle text-[11px] font-medium transition-colors"
            >
              Pasar a Dictamen y Firma →
            </button>
          </div>
        </section>
      )}

      {/* TAB 2: PHYSICIAN VALIDATION DOCK */}
      {activeTab === "review" && (
        <section className="flex flex-col gap-3.5 flex-1 min-h-0">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
            Dictamen Clínico (Human-in-the-Loop)
          </span>

          {/* 3-State Decision Buttons */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 2 as DiagnosticClass, label: "Sospechoso" },
              { id: 1 as DiagnosticClass, label: "No Glaucoma" },
              { id: 0 as DiagnosticClass, label: "Glaucoma" },
            ].map((btn) => (
              <button
                key={btn.id}
                onClick={() => setSelectedClass(btn.id)}
                className={`py-2 px-1 rounded text-xs font-medium text-center transition-colors border ${
                  selectedClass === btn.id
                    ? "bg-[#1E1810] border-clinical-gold-dim text-clinical-gold shadow-sm"
                    : "bg-cockpit-panel border-cockpit-border text-cockpit-text-muted hover:text-cockpit-text"
                }`}
              >
                {selectedClass === btn.id ? `✓ ${btn.label}` : btn.label}
              </button>
            ))}
          </div>

          {/* Clinical Concordance Status (Dynamic) */}
          <div
            className={`text-[11px] font-medium flex items-center gap-1.5 ${
              selectedClass === modelPredictedClass ? "text-clinical-green" : "text-clinical-gold"
            }`}
          >
            <span>{selectedClass === modelPredictedClass ? "✓" : "⚠"}</span>
            <span>
              {selectedClass === modelPredictedClass
                ? "Criterio clínico concordante con la predicción del modelo (agreement = True)"
                : "Criterio clínico con rectificación diagnóstica (agreement = False)"}
            </span>
          </div>

          {/* Doctor Notes Box */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-cockpit-text-muted">
              Observaciones del especialista ({study.doctor_name}):
            </label>
            <textarea
              value={doctorNotes}
              onChange={(e) => setDoctorNotes(e.target.value)}
              rows={3}
              className="w-full bg-cockpit-panel border border-cockpit-border rounded p-2.5 text-xs text-cockpit-text placeholder-cockpit-text-dim focus:outline-none focus:border-cockpit-border-subtle resize-none leading-relaxed"
            />
          </div>

          {/* Reference Case Toggle (is_gold_standard) */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-cockpit-text-muted select-none mt-1">
            <input
              type="checkbox"
              checked={isGoldStandard}
              onChange={(e) => setIsGoldStandard(e.target.checked)}
              className="rounded bg-cockpit-bg border-cockpit-border text-clinical-green focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5"
            />
            <span>Aprobar como caso de referencia clínica (is_gold_standard)</span>
          </label>

          {/* Commit Button */}
          <div className="mt-auto pt-2 flex items-center justify-between">
            <button
              onClick={() => setActiveTab("evidence")}
              className="text-xs text-cockpit-text-dim hover:text-cockpit-text"
            >
              ← Volver a evidencia
            </button>

            <button
              onClick={handleSubmit}
              disabled={isSubmitted || lastFeedback != null}
              className={`px-4 py-2 rounded text-xs font-semibold transition-colors ${
                isSubmitted || lastFeedback != null
                  ? "bg-cockpit-subtle text-clinical-green border border-clinical-green/40"
                  : "bg-white text-black hover:bg-neutral-200"
              }`}
            >
              {isSubmitted || lastFeedback != null ? "✓ Diagnóstico Firmado" : "Guardar y Firmar Diagnóstico"}
            </button>
          </div>
        </section>
      )}
    </aside>
  );
}
