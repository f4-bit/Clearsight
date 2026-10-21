"use client";

import React, { useMemo, useState } from "react";
import {
  BilateralStudy,
  ClinicalFeatures,
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

type BiomarkerTone = "neutral" | "attention";

interface BiomarkerItem {
  label: string;
  value: string;
  reference?: string;
  hint?: string;
  tone?: BiomarkerTone;
  span?: boolean;
}

interface BiomarkerGroup {
  title: string;
  items: BiomarkerItem[];
}

/**
 * Presenta las 11 variables del contrato clínico con nombres profesionales.
 * No se agregan valores por ojo: el contrato sólo define un registro por estudio.
 */
function buildBiomarkerGroups(features: ClinicalFeatures): BiomarkerGroup[] {
  const refractionSign = features.dioptre_1 >= 0 ? "+" : "";

  return [
    {
      title: "Presión y córnea",
      items: [
        {
          label: "Presión intraocular (neumática)",
          value: `${features.Pneumatic.toFixed(1)} mmHg`,
          reference: "< 21 mmHg",
          hint: features.Pneumatic > 21 ? "Elevada" : undefined,
          tone: features.Pneumatic > 21 ? "attention" : "neutral",
        },
        {
          label: "Presión intraocular (aplanación)",
          value: `${features.Perkins.toFixed(1)} mmHg`,
          reference: "< 21 mmHg",
          hint: features.Perkins > 21 ? "Elevada" : undefined,
          tone: features.Perkins > 21 ? "attention" : "neutral",
        },
        {
          label: "Espesor corneal central",
          value: `${features.Pachymetry.toFixed(0)} µm`,
          reference: "540–560 µm",
          hint: features.Pachymetry < 540 ? "Córnea delgada" : undefined,
          tone: features.Pachymetry < 540 ? "attention" : "neutral",
          span: true,
        },
      ],
    },
    {
      title: "Función y biometría",
      items: [
        {
          label: "Defecto medio del campo visual",
          value: `${features.VF_DM.toFixed(1)} dB`,
          reference: "> −2.0 dB",
          hint: features.VF_DM < -2 ? "Escotoma" : undefined,
          tone: features.VF_DM < -2 ? "attention" : "neutral",
        },
        {
          label: "Longitud axial",
          value: `${features.Axial_Length.toFixed(1)} mm`,
          reference: "22.0–24.5 mm",
          hint:
            features.Axial_Length > 24.5
              ? "Ojo largo"
              : features.Axial_Length < 22
              ? "Ojo corto"
              : undefined,
          tone:
            features.Axial_Length < 22 || features.Axial_Length > 24.5 ? "attention" : "neutral",
        },
        {
          label: "Cristalino",
          value: features.Phakic_Pseudophakic === 1 ? "Fáquico" : "Pseudofáquico",
          hint: features.Phakic_Pseudophakic === 1 ? "Cristalino natural" : "Cirugía previa",
          tone: "neutral",
          span: true,
        },
      ],
    },
    {
      title: "Refracción y perfil del paciente",
      items: [
        {
          label: "Refracción",
          value: `${refractionSign}${features.dioptre_1.toFixed(2)} D esf · ${features.dioptre_2.toFixed(
            2
          )} D cil · ${features.astigmatism.toFixed(0)}° eje`,
          tone: "neutral",
          span: true,
        },
        {
          label: "Edad",
          value: `${features.Age.toFixed(0)} años`,
          tone: "neutral",
        },
        {
          label: "Sexo",
          value: features.Gender === 1 ? "Masculino" : "Femenino",
          tone: "neutral",
        },
      ],
    },
  ];
}

export function TelemetrySidebar({
  study,
  onSubmitFeedback,
  lastFeedback,
}: TelemetrySidebarProps) {
  const [activeTab, setActiveTab] = useState<"evidence" | "review">("evidence");

  const modelPredictedClass: DiagnosticClass =
    LABEL_TO_CLASS[study.od.label ?? "Suspicious_Glaucoma"] ?? 2;

  const [selectedClass, setSelectedClass] = useState<DiagnosticClass>(modelPredictedClass);
  const [doctorNotes, setDoctorNotes] = useState<string>("");
  const [isGoldStandard, setIsGoldStandard] = useState<boolean>(false);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  const biomarkerGroups = useMemo(
    () => buildBiomarkerGroups(study.clinical_features),
    [study.clinical_features]
  );

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

  const probSuspect = Math.round((study.od.probabilities.Suspicious_Glaucoma ?? 0) * 100);
  const probGlaucoma = Math.round((study.od.probabilities.Glaucoma ?? 0) * 100);
  const probNormal = Math.round((study.od.probabilities.Non_Glaucoma ?? 0) * 100);

  return (
    <aside className="w-[600px] xl:w-[640px] shrink-0 h-full bg-cockpit-surface border-l border-cockpit-border flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto px-8 pt-7 pb-6 flex flex-col gap-7">
      {/* SECTION 1: MODEL PREDICTION */}
      <section className="flex flex-col gap-3">
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
          <span
            className={`font-mono text-sm font-semibold tabular-nums ${getTriageStyle()}`}
          >
            {isReviewRequired
              ? "--"
              : `${(study.consensus_confidence * 100).toFixed(1)}% certeza`}
          </span>
        </div>

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

        <div className="flex items-center justify-between gap-4 text-xs text-cockpit-text-muted">
          <span>
            {isReviewRequired
              ? "Distribución de probabilidad suprimida por estudio degradado"
              : `Sospecha (OD) ${probSuspect}% · Glaucoma (OD) ${probGlaucoma}% · Normal (OD) ${probNormal}%`}
          </span>
          <span className="text-[11px] text-cockpit-text-dim whitespace-nowrap">
            Predicción combinada de 2 modelos
          </span>
        </div>
      </section>

      <div className="h-[1px] w-full bg-cockpit-border" />

      {/* SECTION 2: VERTICAL CUP-TO-DISC RATIO */}
      <section className="flex flex-col gap-3">
        <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
          Excavación Papilar (vCDR)
        </span>

        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-cockpit-text-muted">OD:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                isReviewRequired
                  ? "text-cockpit-text-dim"
                  : study.od.cdr_vertical != null && study.od.cdr_vertical >= 0.5
                  ? "text-clinical-gold"
                  : "text-cockpit-text"
              }`}
            >
              {isReviewRequired || study.od.cdr_vertical == null
                ? "--"
                : study.od.cdr_vertical.toFixed(2)}
            </span>
            <span className="text-cockpit-text-dim text-[11px]">
              {isReviewRequired
                ? "(No concluyente)"
                : study.od.cdr_vertical != null && study.od.cdr_vertical >= 0.5
                ? "(Límite)"
                : "(Normal)"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-cockpit-text-muted">OS:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                isReviewRequired
                  ? "text-cockpit-text-dim"
                  : study.os.cdr_vertical != null && study.os.cdr_vertical >= 0.5
                  ? "text-clinical-gold"
                  : "text-cockpit-text"
              }`}
            >
              {isReviewRequired || study.os.cdr_vertical == null
                ? "--"
                : study.os.cdr_vertical.toFixed(2)}
            </span>
            <span className="text-cockpit-text-dim text-[11px]">
              {isReviewRequired
                ? "(No concluyente)"
                : study.os.cdr_vertical != null && study.os.cdr_vertical >= 0.5
                ? "(Límite)"
                : "(Normal)"}
            </span>
          </div>

          <div className="flex items-center gap-1 text-[11px] font-medium text-clinical-gold">
            <span>Asimetría:</span>
            <span className="font-mono font-bold tabular-nums">
              {isReviewRequired ? "--" : `Δ ${study.asymmetry_vcdr.toFixed(2)}`}
            </span>
          </div>
        </div>

        <div className="relative w-full h-3 bg-cockpit-bg border border-cockpit-border rounded overflow-hidden">
          <div className="absolute top-0 bottom-0 left-[50%] w-[1px] bg-cockpit-border-subtle" />
          <div className="absolute top-0 bottom-0 left-[70%] w-[1px] bg-cockpit-border-subtle" />

          {!isReviewRequired && study.os.cdr_vertical != null && (
            <div
              className="absolute top-0.5 bottom-0.5 w-1 bg-cockpit-text-muted rounded-full"
              style={{ left: `${Math.min(100, study.os.cdr_vertical * 100)}%` }}
            />
          )}

          {!isReviewRequired && study.od.cdr_vertical != null && (
            <div
              className="absolute top-0.5 bottom-0.5 w-1 bg-clinical-gold rounded-full"
              style={{ left: `${Math.min(100, study.od.cdr_vertical * 100)}%` }}
            />
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] text-cockpit-text-dim">
          <span>0.0 (Fisiológico)</span>
          <span>0.50 (Límite sospecha)</span>
          <span>0.70 (Patológico)</span>
        </div>

        {isReviewRequired && (
          <span className="text-[11px] text-amber-300/90">
            Medición de excavación suprimida: la segmentación no es fiable en este estudio.
          </span>
        )}
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
          1. Biomarcadores Clínicos
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

      {/* TAB 1: CLINICAL BIOMARKERS */}
      {activeTab === "evidence" && (
        <section className="flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
              Variables clínicas del estudio
            </span>
            <span className="text-[10px] text-cockpit-text-dim">
              11 variables registradas para este paciente
            </span>
          </div>

          {biomarkerGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-2.5">
              <span className="text-[10px] font-semibold text-cockpit-text-muted tracking-wide uppercase">
                {group.title}
              </span>

              <div className="grid grid-cols-2 gap-2.5">
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className={`rounded-md border border-cockpit-border bg-cockpit-panel px-4 py-3 ${
                      item.span ? "col-span-2" : ""
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[11px] leading-tight text-cockpit-text-muted">
                        {item.label}
                      </span>
                      {item.reference && (
                        <span className="shrink-0 font-mono text-[9px] text-cockpit-text-dim tabular-nums">
                          {item.reference}
                        </span>
                      )}
                    </div>

                    <div className="mt-2 flex items-baseline justify-between gap-3">
                      <span className="font-mono text-[17px] font-semibold leading-none text-cockpit-text tabular-nums">
                        {item.value}
                      </span>
                      {item.hint && (
                        <span
                          className={`shrink-0 text-[10px] font-semibold ${
                            item.tone === "attention"
                              ? "text-clinical-gold"
                              : "text-cockpit-text-dim"
                          }`}
                        >
                          {item.hint}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* TAB 2: PHYSICIAN VALIDATION DOCK */}
      {activeTab === "review" && (
        <section className="flex flex-col gap-4">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
            Dictamen Clínico
          </span>

          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 2 as DiagnosticClass, label: "Sospechoso" },
              { id: 1 as DiagnosticClass, label: "No Glaucoma" },
              { id: 0 as DiagnosticClass, label: "Glaucoma" },
            ].map((btn) => (
              <button
                key={btn.id}
                onClick={() => setSelectedClass(btn.id)}
                className={`py-2.5 px-1 rounded text-xs font-medium text-center transition-colors border ${
                  selectedClass === btn.id
                    ? "bg-[#1E1810] border-clinical-gold-dim text-clinical-gold shadow-sm"
                    : "bg-cockpit-panel border-cockpit-border text-cockpit-text-muted hover:text-cockpit-text"
                }`}
              >
                {selectedClass === btn.id ? `✓ ${btn.label}` : btn.label}
              </button>
            ))}
          </div>

          <div
            className={`text-[11px] font-medium flex items-center gap-1.5 ${
              selectedClass === modelPredictedClass ? "text-clinical-green" : "text-clinical-gold"
            }`}
          >
            <span>{selectedClass === modelPredictedClass ? "✓" : "⚠"}</span>
            <span>
              {selectedClass === modelPredictedClass
                ? "Criterio clínico concordante con la predicción del modelo."
                : "Criterio clínico con rectificación diagnóstica."}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[11px] text-cockpit-text-muted">
              Observaciones del especialista ({study.doctor_name}):
            </label>
            <textarea
              value={doctorNotes}
              onChange={(e) => setDoctorNotes(e.target.value)}
              rows={4}
              className="w-full bg-cockpit-panel border border-cockpit-border rounded p-3 text-xs text-cockpit-text placeholder-cockpit-text-dim focus:outline-none focus:border-cockpit-border-subtle resize-none leading-relaxed"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-xs text-cockpit-text-muted select-none mt-1">
            <input
              type="checkbox"
              checked={isGoldStandard}
              onChange={(e) => setIsGoldStandard(e.target.checked)}
              className="rounded bg-cockpit-bg border-cockpit-border text-clinical-green focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5"
            />
            <span>Aprobar como caso de referencia clínica</span>
          </label>
        </section>
      )}
      </div>

      {/* PERSISTENT ACTION BAR — always reachable, independent of scroll */}
      <div className="shrink-0 border-t border-cockpit-border bg-cockpit-surface px-8 py-4 flex items-center justify-between gap-3">
        {activeTab === "evidence" ? (
          <>
            <span className="text-[11px] text-cockpit-text-dim">Datos vigentes del estudio</span>
            <button
              onClick={() => setActiveTab("review")}
              className="px-5 py-2.5 rounded bg-cockpit-subtle hover:bg-[#282832] text-cockpit-text border border-cockpit-border-subtle text-xs font-medium transition-colors"
            >
              Pasar a Dictamen y Firma →
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setActiveTab("evidence")}
              className="text-xs text-cockpit-text-dim hover:text-cockpit-text"
            >
              ← Volver a evidencia
            </button>

            <button
              onClick={handleSubmit}
              disabled={isSubmitted || lastFeedback != null}
              className={`px-5 py-2.5 rounded text-xs font-semibold transition-colors ${
                isSubmitted || lastFeedback != null
                  ? "bg-cockpit-subtle text-clinical-green border border-clinical-green/40"
                  : "bg-white text-black hover:bg-neutral-200"
              }`}
            >
              {isSubmitted || lastFeedback != null
                ? "✓ Diagnóstico Firmado"
                : "Guardar y Firmar Diagnóstico"}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
