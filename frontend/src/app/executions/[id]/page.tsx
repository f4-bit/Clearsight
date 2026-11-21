"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InferenceReport, InferenceSummary } from "@/components/InferenceDetails";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { errorMessage } from "@/lib/api";
import { evidenceUrl, getInference } from "@/lib/studies";
import { UUID_PATTERN, type EvidenceType, type Inference, type UserRole } from "@/types/api";

export default function ExecutionPage({ params }: { params: { id: string } }) {
  return <SessionGate>{(user) => UUID_PATTERN.test(params.id)
    ? <ExecutionWorkspace key={params.id} id={params.id.toLowerCase()} role={user.role} />
    : <main className="p-5"><p role="alert">El identificador de ejecución no es válido.</p><Link href="/">Volver al inicio</Link></main>
  }</SessionGate>;
}

function ExecutionWorkspace({ id, role }: { id: string; role: UserRole }) {
  const [result, setResult] = useState<Inference | null>(null);
  const [error, setError] = useState("");
  const [check, setCheck] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const deadline = Date.now() + 4 * 60 * 1000;
    let timer: number | undefined;
    async function load() {
      try {
        const next = await getInference(id, controller.signal);
        if (controller.signal.aborted) return;
        setResult(next.result);
        if (next.result.delivery.deliveryTerminal) return;
        if (Date.now() >= deadline) {
          setError("El servidor sigue procesando la ejecución. Puedes consultar de nuevo.");
          return;
        }
        timer = window.setTimeout(load, 1000 * Math.min(10, Math.max(2, next.retryAfter ?? 2)));
      } catch (failure) {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(errorMessage(failure));
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, check]);

  return (
    <main className="min-h-screen">
      <TopBar title="Consulta de ejecución" role={role} reference={id} />
      <div className="mx-auto grid max-w-3xl gap-4 p-5">
        <p className="break-all font-mono text-xs text-cockpit-text-muted">{id}</p>
        {result && <InferenceSummary result={result} />}
        {error ? <div className="grid justify-items-start gap-2">
          <p role="alert" className="text-xs text-amber-300">{error}</p>
          <button className="cockpit-button" onClick={() => { setError(""); setCheck((previous) => previous + 1); }}>Consultar de nuevo</button>
        </div> : !result && <p role="status" className="text-xs text-cockpit-text-muted">Consultando ejecución…</p>}
        <EvidenceLinks id={id} />
        <InferenceReport id={id} delivery={result?.delivery} />
      </div>
    </main>
  );
}

function EvidenceLinks({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const [image, setImage] = useState<{ url: string; label: string } | null>(null);
  const [error, setError] = useState("");
  const choices = [{ type: "overlay", label: "Contornos" }, { type: "mask", label: "Máscara" }] as const;

  async function view(type: EvidenceType, label: string) {
    setPending(true);
    setImage(null);
    setError("");
    try {
      const url = await evidenceUrl(id, type, AbortSignal.timeout(30_000));
      if (!url) setError("La evidencia seleccionada aún no está disponible.");
      else setImage({ url, label });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-3.5">
      <h2 className="cockpit-label">Evidencia de segmentación</h2>
      <div className="flex gap-2">
        {choices.map(({ type, label }) => <button key={type} type="button" className="cockpit-button"
          disabled={pending} onClick={() => void view(type, label)}>{label}</button>)}
      </div>
      {image && <img src={image.url} referrerPolicy="no-referrer" alt={image.label}
        className="max-h-80 w-full rounded border border-cockpit-border bg-[#08080A] object-contain"
        onError={() => { setImage(null); setError("No se pudo abrir la evidencia."); }} />}
      {error && <p className="text-xs text-amber-300" role="alert">{error}</p>}
    </section>
  );
}
