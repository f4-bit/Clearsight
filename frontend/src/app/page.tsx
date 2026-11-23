"use client";

import "@fontsource-variable/space-grotesk";
import Link from "next/link";
import { ArrowRight, FolderSearch, ScanLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type FormEvent } from "react";
import { ResearchExport } from "@/components/ResearchExport";
import { ResearchWorkspace } from "@/components/ResearchWorkspace";
import { LogoutButton, SessionGate } from "@/components/Session";
import { StationGridEffect } from "@/components/StationGridEffect";
import { TopBar } from "@/components/TopBar";
import { UUID_PATTERN, type SessionUser } from "@/types/api";
import entry from "./entry.module.css";
import station from "./station.module.css";
import research from "./research.module.css";

const GRID_CELL_SIZE = 60;
const stationGridStyle = { "--grid-cell-size": `${GRID_CELL_SIZE}px` } as CSSProperties;

export default function HomePage() {
  return <SessionGate>{(user) => <Workspace user={user} />}</SessionGate>;
}

function Workspace({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const clinical = user.role === "OFTALMOLOGO";
  const researcher = user.role === "INVESTIGADOR";

  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = id.trim().toLowerCase();
    if (!UUID_PATTERN.test(key)) {
      setError("Ingresa el identificador completo en formato UUID.");
      return;
    }
    router.push(`/${clinical ? "studies" : "executions"}/${key}`);
  }

  function updateId(value: string) {
    setId(value);
    setError("");
  }

  if (researcher) {
    return (
      <ResearchWorkspace>
        <form className={research.lookup} aria-labelledby="research-lookup-title" onSubmit={open}>
          <h2 id="research-lookup-title">Consultar análisis por ojo</h2>
          <p id="research-lookup-help" className={research.subtitle}>Usa el ID de una ejecución autorizada.</p>
          <label className={research.lookupLabel} htmlFor="research-execution-id">ID de ejecución</label>
          <div className={research.command}>
            <input id="research-execution-id" className="cockpit-input font-mono" required value={id} maxLength={50}
              autoComplete="off" placeholder="Pega el UUID completo" spellCheck={false} aria-invalid={Boolean(error)}
              aria-describedby={error ? "research-lookup-help lookup-error" : "research-lookup-help"}
              onChange={(event) => updateId(event.target.value)} />
            <button className={research.openAnalysis} type="submit">
              Abrir análisis <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={research.lookupFeedback}>
            {error && <p id="lookup-error" role="alert" className="text-xs text-amber-300">{error}</p>}
          </div>
        </form>
      </ResearchWorkspace>
    );
  }

  const lookup = (
    <form aria-labelledby="open-study" className={clinical ? station.lookup : "grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5"} onSubmit={open}>
      <div>
        <h2 id="open-study" className="flex items-center gap-2.5 text-sm font-semibold">
          <FolderSearch size={19} className="text-sky-300" aria-hidden="true" />
          {clinical ? "Abrir estudio" : "Consultar ejecución autorizada"}
        </h2>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1">
            <span className="cockpit-label">{clinical ? "ID de consulta" : "ID de ejecución"}</span>
            <input className="cockpit-input min-w-0 font-mono" required value={id} maxLength={50}
              spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? "lookup-error" : undefined}
              onChange={(event) => updateId(event.target.value)} />
          </label>
          <button className="cockpit-button h-[38px]">
            Abrir <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        {error && <p id="lookup-error" role="alert" className="mt-2 text-xs text-amber-300">{error}</p>}
      </div>
    </form>
  );

  if (clinical) {
    return (
      <main className={`${entry.entry} ${station.page}`} style={stationGridStyle}>
        <div className={station.illustration} aria-hidden="true">
          <span className={station.grid}>
            <StationGridEffect cellSize={GRID_CELL_SIZE} className={station.gridEffect} />
          </span>
          <span className={station.retina} />
          <span className={station.reticle} />
        </div>
        <header className={station.header}>
          <span className={entry.wordmark}>Clear<b>Sight</b></span>
          <div className={station.session}>
            <span>{user.email}</span>
            <LogoutButton />
          </div>
        </header>
        <div className={station.workspace}>
          <div className={station.intro}>
            <h1>Estudios clínicos</h1>
            <p>Estación de diagnóstico oftalmológico</p>
          </div>
          <Link href="/capture" className={station.capture} aria-labelledby="capture-link" aria-describedby="capture-description">
            <span className={station.scanIcon}><ScanLine size={23} aria-hidden="true" /></span>
            <div className={station.captureContent}>
              <h2>Nueva captura</h2>
              <p id="capture-description">Adjunta retinografías y registra las mediciones clínicas.</p>
            </div>
            <span className={station.captureAction} id="capture-link">
              <span className={station.actionLabel}>Iniciar captura</span>
              <span className={station.arrow}><ArrowRight size={23} aria-hidden="true" /></span>
            </span>
          </Link>
          {lookup}
          <Link href="/patients" className="text-sm text-sky-300">Pacientes e historial de estudios</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <TopBar title="Estación de diagnóstico oftalmológico" role={user.role} showCapture={false} />
      <div className="mx-auto grid w-full max-w-6xl gap-5 p-5 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight">Estación de trabajo</h2>
          <span className="text-xs text-cockpit-text-muted">{user.email}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {user.role === "ADMIN" && (
            <section className="grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5">
              <h3 className="text-sm font-semibold">Administración</h3>
              <p className="text-xs text-cockpit-text-muted">Consulta y gestiona las cuentas y sus perfiles de acceso.</p>
              <Link className="cockpit-button justify-self-start" href="/admin/users">Gestionar usuarios</Link>
            </section>
          )}
          {lookup}
          <ResearchExport />
        </div>
      </div>
    </main>
  );
}
