"use client";

import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ClinicalValues } from "@/components/ClinicalValues";
import { InferenceReport, InferenceSummary } from "@/components/InferenceDetails";
import { Reanalysis } from "@/components/Reanalysis";
import { api, errorMessage, jsonBody } from "@/lib/api";
import type { Consultation, EyeExecution } from "@/types/api";
import { CAPTURE_EYE_ORDER } from "@/types/capture";
import { CLASS_LABELS, DIAGNOSTIC_CLASSES, type DiagnosticClass, type EyeSide, type FeedbackRead } from "@/types/clinical";

const SECTIONS = [
  { id: "result", label: "Resultados" },
  { id: "variables", label: "Variables clínicas" },
  { id: "report", label: "Informe" },
  { id: "feedback", label: "Dictamen" },
] as const;

export function TelemetrySidebar({ consultation, executions }: {
  consultation: Consultation;
  executions: EyeExecution[];
}) {
  const [selectedSide, setSelectedSide] = useState<EyeSide>("OD");
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("result");
  const [savedFeedback, setSavedFeedback] = useState<Record<string, FeedbackRead>>({});
  const eye = executions.find(({ side }) => side === selectedSide) ?? executions[0];
  return (
    <aside aria-label="Panel del caso" className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-cockpit-border bg-cockpit-surface lg:w-[clamp(23rem,27.5vw,29rem)] lg:border-l lg:border-t-0">
      <div className="grid shrink-0 gap-2.5 px-4 py-3">
        <h2 className="text-base font-semibold text-cockpit-text">Revisión del caso</h2>
        <div role="group" aria-label="Ojo de la revisión" className="grid grid-cols-2 gap-2">
          {CAPTURE_EYE_ORDER.map((side) => {
            const available = executions.some((item) => item.side === side);
            const selected = side === eye?.side;
            return (
              <button key={side} type="button"
                className="cockpit-button min-h-12 min-w-0 justify-start gap-2 rounded-md px-2 py-1.5 text-left enabled:hover:border-sky-700 aria-pressed:border-sky-500/70 aria-pressed:bg-sky-950/60 disabled:cursor-not-allowed disabled:bg-cockpit-bg disabled:text-cockpit-text-muted disabled:opacity-100"
                disabled={!available}
                aria-pressed={selected}
                onClick={() => setSelectedSide(side)}>
                <span className="rounded border border-current px-1 py-0.5 font-mono text-[10px]">{side}</span>
                <span className="min-w-0 leading-tight">
                  <span className="block">{side === "OD" ? "Ojo derecho" : "Ojo izquierdo"}</span>
                  {!available && <span className="mt-0.5 block text-[10px] text-cockpit-text-muted">Sin ejecución</span>}
                </span>
                {selected && <Check size={14} className="ml-auto shrink-0 text-sky-300" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
      <div role="group" aria-label="Secciones del caso" className="grid shrink-0 grid-cols-[1fr_1.55fr_1fr_1fr] gap-1 border-y border-cockpit-border bg-cockpit-bg px-3">
        {SECTIONS.map(({ id, label }) => (
          <button key={id} type="button" aria-controls={`case-${id}`} aria-pressed={section === id}
            onClick={() => setSection(id)}
            className="min-h-10 border-b-2 border-transparent px-1 text-xs font-medium text-cockpit-text-muted transition-colors hover:bg-cockpit-card hover:text-cockpit-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 aria-pressed:border-sky-500 aria-pressed:text-sky-200">
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 p-4 lg:overflow-y-auto">
        <div id="case-result" hidden={section !== "result"}>
          {eye ? <InferenceSummary result={eye.result} /> :
            <p className="text-sm text-cockpit-text-muted">Esta consulta aún no tiene ejecuciones requeridas.</p>}
          {executions.filter(({ result }) => result.delivery.reviewRequired).map((review) => (
            <div className="mt-3" key={review.result.id} hidden={eye?.result.id !== review.result.id}>
              <Reanalysis consultation={consultation} eye={review} />
            </div>
          ))}
        </div>
        <div id="case-variables" hidden={section !== "variables"}>
          <h3 className="mb-3 text-sm font-semibold">Variables clínicas registradas</h3>
          <ClinicalValues values={consultation.clinicalData} compact />
        </div>
        <div id="case-report" hidden={section !== "report"}>
          {eye ? <InferenceReport key={eye.result.id} id={eye.result.id} delivery={eye.result.delivery} /> :
            <p className="text-sm text-cockpit-text-muted">El informe estará disponible tras el análisis.</p>}
        </div>
        <div id="case-feedback" hidden={section !== "feedback"}>
          {eye?.result.status === "COMPLETED" && eye.result.predictedClass !== null ? (
            <FeedbackForm key={eye.result.id} consultationId={consultation.id} inferenceId={eye.result.id}
              saved={savedFeedback[eye.result.id]}
              onSaved={(record) => setSavedFeedback((previous) => ({ ...previous, [eye.result.id]: record }))} />
          ) : <p className="text-sm text-cockpit-text-muted">El dictamen se habilita cuando el ojo seleccionado tiene un resultado.</p>}
        </div>
      </div>
    </aside>
  );
}

function FeedbackForm({ consultationId, inferenceId, saved, onSaved }: {
  consultationId: string;
  inferenceId: string;
  saved?: FeedbackRead;
  onSaved: (feedback: FeedbackRead) => void;
}) {
  const [choice, setChoice] = useState(saved ? String(saved.validated_class ?? "none") : "");
  const [notes, setNotes] = useState(saved?.doctor_notes ?? "");
  const [gold, setGold] = useState(saved?.is_gold_standard ?? false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(saved ? "Dictamen guardado." : "");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice || pending) return;
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await api<FeedbackRead>("/feedback", {
        method: "POST",
        ...jsonBody({
          consultation_id: consultationId,
          inference_id: inferenceId,
          validated_class: choice === "none" ? null : Number(choice) as DiagnosticClass,
          doctor_notes: notes.trim() || null,
          is_gold_standard: choice !== "none" && gold,
        }),
      });
      onSaved(result);
      setMessage("Dictamen guardado.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-2 rounded-md border border-cockpit-border bg-cockpit-card p-3.5" onSubmit={submit}>
      <h3 className="cockpit-label">Dictamen médico</h3>
      <label className="grid gap-1 text-xs text-cockpit-text-muted">
        Clasificación clínica
        <select required className="cockpit-input py-1.5 text-xs" value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            if (event.target.value === "none" || event.target.value === "") setGold(false);
            setMessage("");
          }}>
          <option value="">Seleccionar</option>
          {DIAGNOSTIC_CLASSES.map((item) => <option key={item} value={item}>{CLASS_LABELS[item]}</option>)}
          <option value="none">No concluyente</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-cockpit-text-muted">
        Notas clínicas
        <textarea className="cockpit-input py-1.5 text-xs" rows={2} maxLength={5000}
          value={notes} onChange={(event) => { setNotes(event.target.value); setMessage(""); }} />
      </label>
      <label className="flex items-center gap-2 text-xs text-cockpit-text-muted">
        <input type="checkbox" className="accent-sky-500" checked={gold} disabled={!choice || choice === "none"}
          onChange={(event) => { setGold(event.target.checked); setMessage(""); }} />
        Marcar como referencia validada (gold standard)
      </label>
      <button className="cockpit-button cockpit-primary justify-self-start" disabled={!choice || pending}>
        {pending ? "Guardando…" : "Guardar dictamen"}
      </button>
      <p className="text-[11px] text-cockpit-text-muted">Guardar actualiza el dictamen de esta ejecución.</p>
      {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </form>
  );
}
