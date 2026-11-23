"use client";

import Link from "next/link";
import { ArrowRight, Check, Circle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionGate } from "@/components/Session";
import { CaptureClinicalForm } from "@/components/capture/CaptureClinicalForm";
import { CaptureLoadPanel } from "@/components/capture/CaptureLoadPanel";
import { CaptureProcessingPanel } from "@/components/capture/CaptureProcessingPanel";
import { CaptureTopBar } from "@/components/capture/CaptureTopBar";
import { api, errorMessage } from "@/lib/api";
import { submitStudy, type Submission, type SubmissionEvent } from "@/lib/studies";
import { useStudy } from "@/lib/useStudy";
import type { Patient } from "@/types/api";
import {
  CAPTURE_EYE_ORDER, CLINICAL_FIELDS, createEmptyClinicalValues, clinicalFeaturesFromValues, parseClinicalValue,
  type CaptureEyeSlot, type CaptureEyeSlots,
} from "@/types/capture";
import type { EyeSide } from "@/types/clinical";

const PATIENTS_PER_PAGE = 20;
const emptySlots: CaptureEyeSlots = { OD: { status: "empty" }, OS: { status: "empty" } };

export default function CapturePage() {
  return <SessionGate role="OFTALMOLOGO">{() => <CaptureWorkspace />}</SessionGate>;
}

function CaptureWorkspace() {
  const slots = useRef<CaptureEyeSlots>(emptySlots);
  const submission = useRef<Submission | null>(null);
  const busy = useRef(false);
  const [eyeSlots, setEyeSlots] = useState(emptySlots);
  const [clinical, setClinical] = useState(createEmptyClinicalValues);
  const [patientId, setPatientId] = useState("");
  const [externalCode, setExternalCode] = useState("");
  const [event, setEvent] = useState<SubmissionEvent | null>(null);
  const [consultationId, setConsultationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const features = clinicalFeaturesFromValues(clinical);
  const study = useStudy(consultationId);
  const attempt = submission.current;
  const selectedEyes = CAPTURE_EYE_ORDER.filter((side) => eyeSlots[side].status === "ready");
  const validCount = CLINICAL_FIELDS.filter(({ key }) => parseClinicalValue(key, clinical[key]) !== null).length;
  const invalidEye = CAPTURE_EYE_ORDER.some((side) => eyeSlots[side].status === "invalid");
  const validatingEye = CAPTURE_EYE_ORDER.some((side) => eyeSlots[side].status === "validating");
  const canSubmit = Boolean(features && patientId && selectedEyes.length &&
    CAPTURE_EYE_ORDER.every((side) => ["ready", "empty"].includes(eyeSlots[side].status)));
  const eyeStatus = invalidEye ? "Revisa o quita la imagen inválida"
    : validatingEye ? "Validando retinografía…"
    : selectedEyes.length === 2 ? "2 retinografías validadas"
    : selectedEyes.length === 1 ? "1 retinografía validada · segundo ojo opcional"
    : "Falta una retinografía";
  const checklist = [
    { label: patientId === "new" ? "Paciente por crear" : patientId ? "Paciente seleccionado" : "Paciente pendiente", ready: Boolean(patientId) },
    { label: eyeStatus, ready: selectedEyes.length > 0 && !invalidEye && !validatingEye },
    { label: `${validCount}/${CLINICAL_FIELDS.length} variables válidas`, ready: Boolean(features) },
  ];

  useEffect(() => () => {
    for (const slot of Object.values(slots.current)) {
      if (slot.status === "ready") URL.revokeObjectURL(slot.asset.previewUrl);
    }
  }, []);

  function changeSlot(side: EyeSide, slot: CaptureEyeSlot) {
    const previous = slots.current[side];
    if (previous.status === "ready") URL.revokeObjectURL(previous.asset.previewUrl);
    slots.current = { ...slots.current, [side]: slot };
    setEyeSlots(slots.current);
  }

  function reset() {
    CAPTURE_EYE_ORDER.forEach((side) => changeSlot(side, { status: "empty" }));
    submission.current = null;
    setClinical(createEmptyClinicalValues());
    setPatientId("");
    setExternalCode("");
    setEvent(null);
    setConsultationId(null);
    setError("");
  }

  async function send() {
    if (busy.current) return;
    let current = submission.current;
    if (!current) {
      if (!canSubmit || !features) return;
      const eyes: Submission["eyes"] = {};
      for (const side of selectedEyes) {
        const slot = eyeSlots[side];
        if (slot.status === "ready") eyes[side] = { asset: slot.asset, key: crypto.randomUUID() };
      }
      current = {
        patientId: patientId === "new" ? null : patientId,
        consultation: null,
        clinical: features,
        externalCode: externalCode.trim() || null,
        eyes,
      };
      submission.current = current;
    }
    if (current.creationUnconfirmed) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      setConsultationId((await submitStudy(current, setEvent)).id);
    } catch (failure) {
      setError(current.creationUnconfirmed
        ? `No se pudo confirmar la creación del ${current.creationUnconfirmed === "consulta" ? "caso" : "paciente"}. Puede haberse guardado. Verifica su registro antes de iniciar otro envío.`
        : errorMessage(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (attempt) {
    const retry = study.error ? { label: "Consultar estado", action: study.retry }
      : error && !consultationId && !attempt.creationUnconfirmed ? { label: "Reintentar envío", action: send }
      : undefined;
    return (
      <main className="flex min-h-dvh flex-col">
        <CaptureTopBar tracking studyId={attempt.consultation?.id} />
        <CaptureProcessingPanel event={event} eyeSlots={eyeSlots} snapshot={study.snapshot}
          clinical={attempt.clinical} caseId={attempt.consultation?.id} submitted={consultationId !== null}
          pending={pending} error={error || study.error} onReset={reset} retry={retry} />
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <CaptureTopBar />
      <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_clamp(26rem,39vw,38rem)]">
        <section className="flex min-w-0 flex-col gap-4 p-4 xl:p-5">
          <PatientPicker value={patientId} onChange={setPatientId}
            externalCode={externalCode} onCodeChange={setExternalCode} />
          <CaptureLoadPanel eyeSlots={eyeSlots} onChange={changeSlot} />
        </section>
        <CaptureClinicalForm values={clinical} validCount={validCount}
          onChange={(field, value) => setClinical((previous) => ({ ...previous, [field]: value }))} />
      </div>
      <footer className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-cockpit-border bg-cockpit-surface px-4 py-2 xl:px-5">
        <div role="status" aria-label="Preparación del estudio">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-cockpit-text-muted">
            {checklist.map(({ label, ready }) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                {ready ? <Check size={13} aria-hidden="true" className="shrink-0 text-emerald-300" /> :
                  <Circle size={10} aria-hidden="true" className="mx-px shrink-0" />}
                {label}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className="cockpit-button">Volver</Link>
          <button onClick={send} disabled={!canSubmit} className="cockpit-button cockpit-primary">Enviar estudio <ArrowRight size={14} aria-hidden="true" /></button>
        </div>
      </footer>
    </main>
  );
}

function PatientPicker({ value, onChange, externalCode, onCodeChange }: {
  value: string;
  onChange: (id: string) => void;
  externalCode: string;
  onCodeChange: (code: string) => void;
}) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Patient[]>(`/patients?limit=${PATIENTS_PER_PAGE}&offset=${page * PATIENTS_PER_PAGE}`, { signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setPatients(items); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, retry]);

  return (
    <section className="flex flex-wrap items-end gap-3 border-b border-cockpit-border pb-4">
      <label className="grid flex-1 min-w-[12rem] gap-1.5">
        <span className="cockpit-label">Paciente</span>
        <select value={value} onChange={(change) => onChange(change.target.value)} className="cockpit-input">
          <option value="">{loading ? "Cargando pacientes…" : "Seleccionar paciente"}</option>
          <option value="new">Crear paciente pseudonimizado</option>
          {patients.map((patient) => <option key={patient.id} value={patient.id}>
            {patient.externalCode || `#${patient.id.slice(0, 8).toUpperCase()}`}
          </option>)}
        </select>
      </label>
      {patients.some((patient) => patient.id === value) && <Link href={`/patients/${value}`} target="_blank" rel="noreferrer" className="cockpit-button">Ver ficha del paciente</Link>}
      {value === "new" && <label className="grid flex-1 min-w-[12rem] gap-1.5">
        <span className="cockpit-label">Código pseudónimo (opcional)</span>
        <input className="cockpit-input" maxLength={64} value={externalCode}
          onChange={(change) => onCodeChange(change.target.value)} />
      </label>}
      <div className="flex gap-2">
        <button className="cockpit-button" disabled={page === 0 || loading} onClick={() => {
          if (value !== "new") onChange("");
          setPage((current) => current - 1);
        }}>Anterior</button>
        <button className="cockpit-button" disabled={patients.length < PATIENTS_PER_PAGE || loading} onClick={() => {
          if (value !== "new") onChange("");
          setPage((current) => current + 1);
        }}>Siguiente</button>
      </div>
      {error && <div className="flex w-full items-center gap-2">
        <span role="alert" className="text-xs text-amber-300">{error}</span>
        <button className="cockpit-button" onClick={() => setRetry((current) => current + 1)}>Reintentar</button>
      </div>}
    </section>
  );
}
