import type { StudySnapshot, SubmissionEvent } from "@/lib/studies";
import type { CaptureEyeSlots } from "@/types/capture";
import { CaptureCompletedPanel } from "./CaptureCompletedPanel";

function submissionLabel(event: SubmissionEvent | null) {
  switch (event?.stage) {
    case "patient": return "Guardando paciente…";
    case "consultation": return "Registrando consulta…";
    case "upload": return `Subiendo retinografía ${event.side}…`;
    case "inference": return `Enviando análisis ${event.side}…`;
    case "freeze": return "Registrando los análisis del caso…";
    default: return "Preparando envío…";
  }
}

export function CaptureProcessingPanel({
  event, eyeSlots, snapshot, submitted,
}: {
  event: SubmissionEvent | null;
  eyeSlots: CaptureEyeSlots;
  snapshot: StudySnapshot | null;
  submitted: boolean;
}) {
  const label = !submitted ? submissionLabel(event)
    : !snapshot ? "Consultando estado del estudio…"
    : snapshot.consultation.completionState === "COMPLETE" ? "Estudio completado"
    : snapshot.consultation.analysisState === "REVIEW_REQUIRED" ? "Revisión requerida"
    : snapshot.consultation.pollingStop === "FAILED" ? "Análisis o publicación con errores"
    : snapshot.consultation.analysisState === "COMPLETED" ? "Publicando informe…"
    : "En cola o en análisis";

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="cockpit-label">Estado del estudio</h2>
        <p role="status" className="text-xs text-amber-300">{label}</p>
      </div>
      {!submitted && event?.stage === "upload" && (
        <div className="flex items-center gap-3">
          <progress className="h-2 flex-1 accent-amber-400" max={100}
            value={event.percent ?? undefined} aria-label={`Carga de imagen ${event.side}`} />
          {event.percent !== null && <span className="font-mono text-xs">{event.percent}%</span>}
        </div>
      )}
      <CaptureCompletedPanel eyeSlots={eyeSlots} executions={snapshot?.executions ?? []} />
    </section>
  );
}
