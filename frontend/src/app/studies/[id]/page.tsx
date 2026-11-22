"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { BilateralCanvas } from "@/components/BilateralCanvas";
import { SessionGate } from "@/components/Session";
import { TelemetrySidebar } from "@/components/TelemetrySidebar";
import { TopBar } from "@/components/TopBar";
import { useStudy } from "@/lib/useStudy";
import { UUID_PATTERN } from "@/types/api";

export default function StudyPage({ params }: { params: { id: string } }) {
  return (
    <SessionGate role="OFTALMOLOGO">
      {() => UUID_PATTERN.test(params.id) ? <StudyWorkspace key={params.id} id={params.id.toLowerCase()} />
        : <main className="p-5"><p role="alert">El identificador de consulta no es válido.</p><Link href="/">Volver al inicio</Link></main>}
    </SessionGate>
  );
}

function StudyWorkspace({ id }: { id: string }) {
  const { snapshot, error, retry } = useStudy(id);
  const consultation = snapshot?.consultation;
  const executions = snapshot?.executions ?? [];
  const review = consultation?.analysisState === "REVIEW_REQUIRED" ||
    executions.some(({ result }) => result.delivery.reviewRequired);
  const failed = consultation?.pollingStop === "FAILED";
  const active = !error && !review && consultation?.pollingStop === "CONTINUE";
  const state = consultation?.completionState === "COMPLETE" ? "Completo"
    : failed ? "Con errores" : review ? "Revisión requerida"
    : consultation?.analysisState === "IN_PROGRESS" ? "En cola o en análisis"
    : consultation?.reportState === "REPORT_PENDING" ? "Informe pendiente"
    : consultation?.analysisState === "OPEN" ? "Abierto"
    : "En procesamiento";

  return (
    <main className="flex min-h-screen flex-col lg:h-screen">
      <TopBar title="Caso clínico" role="OFTALMOLOGO" reference={id} />
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-amber-800/60 bg-amber-500/20 px-5 py-2 text-xs text-amber-300">
          {error}
          <button className="cockpit-button" onClick={retry}>Consultar de nuevo</button>
        </div>
      )}
      {review && <div role="status" className="border-b border-amber-800/60 bg-amber-500/20 px-5 py-2 text-xs text-amber-300">
        Revisión requerida. La predicción del ojo afectado se limita por calidad. Selecciona ese ojo para enviar otra retinografía a reanálisis.
      </div>}
      {consultation ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cockpit-border px-5 py-2 text-xs text-cockpit-text-muted">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-mono" title={consultation.patientId}>Paciente #{consultation.patientId.slice(0, 8).toUpperCase()}</span>
              <span>{new Date(consultation.createdAt).toLocaleString("es-CO")}</span>
            </div>
            <span role="status" className={`flex items-center gap-2 ${failed || review ? "text-amber-300" : active ? "text-sky-300" : ""}`}>
              {active && <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
              {state}
            </span>
          </div>
          <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
            <BilateralCanvas od={executions.find(({ side }) => side === "OD")}
              os={executions.find(({ side }) => side === "OS")} />
            <TelemetrySidebar consultation={consultation} executions={executions} />
          </div>
        </>
      ) : !error && <p role="status" className="p-5 text-sm text-cockpit-text-muted">Cargando caso…</p>}
    </main>
  );
}
