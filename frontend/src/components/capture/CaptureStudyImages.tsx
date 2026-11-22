"use client";

import { useState } from "react";
import type { EyeExecution } from "@/types/api";
import { CAPTURE_EYE_LABELS, CAPTURE_EYE_ORDER, type CaptureEyeSlots } from "@/types/capture";
import { CLASS_COLORS, CLASS_LABELS, formatCdr, type EyeSide, type JobStatus } from "@/types/clinical";
import styles from "./CaptureProcessingPanel.module.css";

const EYE_STATUS: Record<JobStatus, string> = {
  QUEUED: "En cola de análisis",
  DOWNLOADING: "Preparando la retinografía",
  LOCALIZING: "Localizando el disco óptico",
  SEGMENTING: "Segmentando disco y copa",
  CLASSIFYING: "Combinando imagen y variables",
  COMPLETED: "Análisis completado",
  REVIEW_REQUIRED: "Revisión requerida",
  FAILED: "Error en el análisis",
};

export function CaptureStudyImages({ eyeSlots, executions }: {
  eyeSlots: CaptureEyeSlots;
  executions: EyeExecution[];
}) {
  const [side, setSide] = useState<EyeSide>(eyeSlots.OD.status === "ready" ? "OD" : "OS");
  const bilateral = eyeSlots.OD.status === "ready" && eyeSlots.OS.status === "ready";
  const slot = eyeSlots[side];
  const result = executions.find((eye) => eye.side === side)?.result;
  const review = result?.delivery.reviewRequired || result?.status === "REVIEW_REQUIRED";
  const diagnostic = result?.status === "COMPLETED" && !review ? result.predictedClass : null;
  const eyeStatus = review ? "Revisión requerida"
    : result?.status === "FAILED" ? EYE_STATUS.FAILED
    : result?.delivery.failed ? "Error al publicar el resultado"
    : result && bilateral ? EYE_STATUS[result.status] : null;

  return (
    <section className={styles.preview} aria-labelledby="study-images-title">
      <h2 id="study-images-title">Retinografías del estudio</h2>
      <div className={styles.mat} id="study-image-preview">
        {slot.status === "ready" && (
          <img className={styles.image} src={slot.asset.previewUrl} alt={`Retinografía ${side}`} />
        )}
      </div>
      <div role="group" aria-label="Ojo de la vista previa" className={styles.eyes}>
        {CAPTURE_EYE_ORDER.map((eye) => {
          const available = eyeSlots[eye].status === "ready";
          return (
            <button key={eye} type="button"
              aria-pressed={eye === side} aria-controls="study-image-preview" disabled={!available} onClick={() => setSide(eye)}>
              <span className="font-mono">{eye}</span>
              <span>{available ? CAPTURE_EYE_LABELS[eye].split(" · ")[1] : "Sin imagen"}</span>
            </button>
          );
        })}
      </div>
      {(eyeStatus || diagnostic !== null) && (
        <div className={styles.imageDetails} aria-live="polite">
          {eyeStatus && <span className={review || result?.delivery.failed ? "text-amber-300" : undefined}>{eyeStatus}</span>}
          {diagnostic !== null && (
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-cockpit-text-muted">Predicción del modelo</span>
              <span className={`rounded border px-2 py-1 ${CLASS_COLORS[diagnostic]}`}>{CLASS_LABELS[diagnostic]}</span>
              {result?.confidence != null && <span className="font-mono">{(result.confidence * 100).toFixed(1)}%</span>}
            </p>
          )}
          {diagnostic !== null && result?.cdrVertical != null && (
            <p>vCDR vertical <span className="ml-1 font-mono text-cockpit-text">{formatCdr(result.cdrVertical)}</span></p>
          )}
        </div>
      )}
    </section>
  );
}
