"use client";

import { useState, type FormEvent } from "react";
import { InferenceReport, InferenceSummary } from "@/components/InferenceDetails";
import { Reanalysis } from "@/components/Reanalysis";
import { api, errorMessage, jsonBody } from "@/lib/api";
import type { Consultation, EyeExecution } from "@/types/api";
import { CAPTURE_EYE_ORDER, CLINICAL_FIELDS, formatClinicalValue } from "@/types/capture";
import { CLASS_LABELS, DIAGNOSTIC_CLASSES, type DiagnosticClass, type EyeSide, type FeedbackRead } from "@/types/clinical";

export function TelemetrySidebar({ consultation, executions }: {
  consultation: Consultation;
  executions: EyeExecution[];
}) {
  const [selectedSide, setSelectedSide] = useState<EyeSide>("OD");
  const [savedFeedback, setSavedFeedback] = useState<Record<string, FeedbackRead>>({});
  const eye = executions.find(({ side }) => side === selectedSide) ?? executions[0];
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 overflow-auto border-t border-cockpit-border bg-cockpit-surface p-4 lg:w-[365px] lg:border-l lg:border-t-0 xl:w-[410px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="cockpit-label">Resultados por ojo</h2>
        <div className="flex gap-1.5">
          {CAPTURE_EYE_ORDER.map((side) => (
            <button key={side} type="button"
              className={`cockpit-button py-1 ${side === eye?.side ? "cockpit-primary" : ""}`}
              disabled={!executions.some((item) => item.side === side)}
              aria-pressed={side === eye?.side}
              onClick={() => setSelectedSide(side)}>{side}</button>
          ))}
        </div>
      </div>
      {eye ? (
        <>
          <InferenceSummary result={eye.result} />
          <InferenceReport key={`report-${eye.result.id}`} id={eye.result.id} delivery={eye.result.delivery} />
          {eye.result.status === "COMPLETED" && eye.result.predictedClass !== null && (
            <FeedbackForm key={eye.result.id} consultationId={consultation.id} inferenceId={eye.result.id}
              saved={savedFeedback[eye.result.id]}
              onSaved={(record) => setSavedFeedback((previous) => ({ ...previous, [eye.result.id]: record }))} />
          )}
        </>
      ) : <p className="text-xs text-cockpit-text-muted">Esta consulta aún no tiene ejecuciones requeridas.</p>}
      {executions.filter(({ result }) => result.delivery.reviewRequired).map((review) => (
        <div key={review.result.id} hidden={eye?.result.id !== review.result.id}>
          <Reanalysis consultation={consultation} eye={review} />
        </div>
      ))}
      <details className="rounded-md border border-cockpit-border bg-cockpit-card p-3.5">
        <summary className="cockpit-label cursor-pointer">Variables clínicas registradas</summary>
        <dl className="mt-2 divide-y divide-cockpit-border">
          {CLINICAL_FIELDS.map(({ key, label, unit }) => (
            <div key={key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
              <dt className="text-cockpit-text-muted">{label}</dt>
              <dd className="font-mono">
                {formatClinicalValue(key, consultation.clinicalData[key] ??
                  (key === "Phakic/Pseudophakic" ? consultation.clinicalData.Phakic_Pseudophakic : undefined), unit)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
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
