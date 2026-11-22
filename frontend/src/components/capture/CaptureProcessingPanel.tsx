import dynamic from "next/dynamic";
import "@fontsource-variable/space-grotesk";
import Link from "next/link";
import { ArrowRight, Camera, Check, CircleCheck, ClipboardList, FileText, ScanLine, TriangleAlert, Upload } from "lucide-react";
import type { StudySnapshot, SubmissionEvent } from "@/lib/studies";
import type { CaptureEyeSlots } from "@/types/capture";
import type { ClinicalFeatures, JobStatus } from "@/types/clinical";
import { CaptureStudyImages } from "./CaptureStudyImages";
import { CaptureStudyPanel } from "./CaptureStudyPanel";
import styles from "./CaptureProcessingPanel.module.css";

const STEPS = [
  { label: "Registro", Icon: ClipboardList },
  { label: "Envío", Icon: Upload },
  { label: "Análisis", Icon: ScanLine },
  { label: "Informe", Icon: FileText },
];
const GhostFibers = dynamic(() => import("@/components/vendor/ghost-fibers/GhostFibers"), { ssr: false });

type TrackingStatus = {
  title: string;
  description: string;
  tone: "idle" | "active" | "complete" | "attention";
  checkpoint?: number;
};

const ANALYSIS_STEPS: Partial<Record<JobStatus, Omit<TrackingStatus, "tone">>> = {
  DOWNLOADING: { title: "Preparando la retinografía", description: "El servidor está preparando la imagen para el análisis.", checkpoint: 1 },
  LOCALIZING: { title: "Localizando el disco óptico", description: "El modelo está identificando el disco óptico en la retinografía.", checkpoint: 2 },
  SEGMENTING: { title: "Segmentando disco y copa", description: "El modelo está delimitando el disco óptico y la copa.", checkpoint: 3 },
  CLASSIFYING: { title: "Combinando imagen y variables", description: "El modelo está evaluando la retinografía junto con las mediciones clínicas.", checkpoint: 4 },
};

function submissionStatus(event: SubmissionEvent | null): TrackingStatus {
  const tone = "active";
  switch (event?.stage) {
    case "patient":
      return { tone, title: "Guardando paciente", description: "Estamos registrando el paciente pseudonimizado." };
    case "consultation":
      return { tone, title: "Registrando consulta", description: "Estamos guardando las variables clínicas del estudio." };
    case "upload":
      return { tone, title: `Subiendo retinografía ${event.side}`, description: "Mantén abierta esta pantalla mientras se envía la imagen." };
    case "inference":
      return { tone, title: "Solicitando análisis", description: `Estamos enviando la solicitud de análisis del ojo ${event.side}.` };
    case "freeze":
      return { tone, title: "Confirmando el envío", description: "Estamos vinculando los análisis a la consulta." };
    default:
      return { tone, title: "Preparando envío", description: "Estamos preparando el registro del estudio." };
  }
}

function trackingStatus(snapshot: StudySnapshot | null): TrackingStatus {
  if (!snapshot) {
    return { tone: "idle", title: "Consultando el estado", description: "El servidor recibió el estudio. Estamos consultando si el análisis ha comenzado." };
  }
  const { consultation, executions } = snapshot;
  if (consultation.completionState === "COMPLETE") {
    return { tone: "complete", title: "Estudio completado", description: "Los resultados y el informe están disponibles en el caso clínico." };
  }
  if (consultation.analysisState === "REVIEW_REQUIRED") {
    return { tone: "attention", title: "Revisión requerida", description: "Abre el caso clínico para revisar la evidencia disponible." };
  }
  if (consultation.analysisState === "FAILED") {
    return { tone: "attention", title: "Error en el análisis", description: "Consulta el detalle de las retinografías en el caso clínico." };
  }
  if (consultation.reportState === "FAILED") {
    return { tone: "attention", title: "Error al publicar el informe", description: "Abre el caso clínico para consultar los resultados disponibles." };
  }
  if (consultation.pollingStop === "FAILED") {
    return { tone: "attention", title: "Error al publicar la evidencia", description: "Abre el caso clínico para consultar los resultados disponibles." };
  }
  if (consultation.analysisState === "PARTIAL") {
    return { tone: "attention", title: "Resultados parciales", description: "Consulta los resultados y los estados por ojo en el caso clínico." };
  }
  if (consultation.analysisState === "COMPLETED") {
    return { tone: "active", title: "Publicando informe", description: "El análisis terminó. El informe aparecerá en el caso clínico cuando esté disponible." };
  }
  if (executions.length > 0 && executions.every(({ result }) => result.status === "QUEUED")) {
    return { tone: "idle", title: "Análisis en cola", description: "El estudio fue recibido y está en espera de procesamiento." };
  }
  if (executions.length > 0 && executions.every(({ result }) => result.status === "COMPLETED")) {
    return { tone: "active", title: "Preparando la evidencia", description: "El análisis terminó. Estamos esperando los archivos de evidencia.", checkpoint: 5 };
  }
  if (consultation.analysisState === "IN_PROGRESS") {
    const stage = executions[0]?.result.status;
    const confirmed = stage && executions.every(({ result }) => result.status === stage) ? ANALYSIS_STEPS[stage] : undefined;
    if (confirmed) return { tone: "active", ...confirmed };
    return { tone: "active", title: "Análisis en curso", description: "El servidor está procesando el estudio. El estado se actualiza automáticamente." };
  }
  return { tone: "idle", title: "Estudio recibido", description: "Estamos esperando la confirmación del estado del análisis." };
}

interface CaptureProcessingPanelProps {
  event: SubmissionEvent | null;
  eyeSlots: CaptureEyeSlots;
  snapshot: StudySnapshot | null;
  clinical: ClinicalFeatures;
  caseId?: string;
  submitted: boolean;
  pending: boolean;
  error: string;
  onReset: () => void;
  retry?: { label: string; action: () => void };
}

export function CaptureProcessingPanel({
  event, eyeSlots, snapshot, clinical, caseId, submitted, pending, error, onReset, retry,
}: CaptureProcessingPanelProps) {
  const status: TrackingStatus = error
    ? { tone: "attention", title: submitted ? "Seguimiento interrumpido" : "Envío interrumpido", description: error }
    : submitted ? trackingStatus(snapshot) : submissionStatus(event);
  const complete = snapshot?.consultation.completionState === "COMPLETE";
  const publishing = snapshot?.consultation.analysisState === "COMPLETED";
  const phase = complete ? 4 : publishing ? 3 : submitted ? 2 : caseId ? 1 : 0;
  const caseReady = complete || status.tone === "attention" && submitted && !error;
  const upload = pending && event?.stage === "upload" ? event : null;

  return (
    <div className={styles.background} data-tone={status.tone}>
      <div className={styles.fibers} aria-hidden="true">
        <GhostFibers glowColor="#5c9ba9" lineColor="#b1d6dd" secondaryColor="#3c6b78"
          layers={2} threads={56} depthOfField={0.84} intro={false} mouseInteraction={false}
          pulseOnClick={false} rotation={-31} speed={0.15} flow={0.1}
          rollSpeed={0.038} sparkle={0.14} glow={0.55} grain={0.024} dpr={1.2} />
      </div>
      <div className={styles.layout}>
        <section className={styles.tracking} aria-label="Estado del estudio">
          <div role={error ? "alert" : "status"} aria-atomic="true">
            <div key={status.title} className={styles.headline}>
              {status.tone === "attention" && <TriangleAlert size={22} className={styles.stateIcon} aria-hidden="true" />}
              {status.tone === "complete" && <Check size={24} className={styles.stateIcon} aria-hidden="true" />}
              <h2>{status.title === "Análisis en cola"
                ? <>Análisis en <br className={styles.titleBreak} />cola</>
                : status.title}</h2>
              <p>{status.description}</p>
            </div>
          </div>
          {upload && (
            <div className={styles.upload}>
              <progress max={100} value={upload.percent ?? undefined} aria-label={`Carga de imagen ${upload.side}`} />
              {upload.percent !== null && <span className="font-mono text-xs">{upload.percent}%</span>}
            </div>
          )}
        </section>
        <ol aria-label="Etapas del estudio" className={styles.segments}>
          {STEPS.map(({ label, Icon }, index) => {
            const current = index === phase;
            const done = index < phase;
            const checkpoint = index === 2 && current && status.checkpoint;
            return (
              <li key={label} aria-current={current ? "step" : undefined}
                data-state={done ? "done" : current ? "current" : "upcoming"}>
                <Icon className={styles.stepIcon} aria-hidden="true" />
                {done && <CircleCheck className={styles.stepDone} aria-hidden="true" />}
                <span className={styles.stepLabel}>{label}</span>
                <span className={styles.track} aria-hidden="true">
                  <span className={styles.fill} style={checkpoint ? { width: `${100 * checkpoint / 6}%` } : undefined} />
                </span>
                {done && <span className="sr-only"> (completada)</span>}
              </li>
            );
          })}
        </ol>
        <CaptureStudyImages eyeSlots={eyeSlots} executions={snapshot?.executions ?? []} />
        <div className={styles.actions}>
          {!pending && (retry || caseId) && <div className={styles.primaryActions}>
            {retry && <button type="button" onClick={retry.action} className={styles.retryButton}>{retry.label}</button>}
            {caseId && (
              <Link href={`/studies/${caseId}`} className={styles.caseLink}>
                <span>{caseReady ? "Abrir caso clínico" : "Ver seguimiento del caso"}</span>
                <span className={styles.arrowWell} aria-hidden="true"><ArrowRight size={19} /></span>
              </Link>
            )}
          </div>}
          <div className={styles.utilities}>
            <CaptureStudyPanel clinical={clinical} />
            {!pending && (
              <button type="button" onClick={onReset} className={styles.resetButton}>
                <Camera size={16} aria-hidden="true" /> Nueva captura
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
