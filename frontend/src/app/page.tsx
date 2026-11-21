"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ResearchExport } from "@/components/ResearchExport";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { UUID_PATTERN, type SessionUser } from "@/types/api";

export default function HomePage() {
  return <SessionGate>{(user) => <Workspace user={user} />}</SessionGate>;
}

function Workspace({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const clinical = user.role === "OFTALMOLOGO";

  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = id.trim().toLowerCase();
    if (!UUID_PATTERN.test(key)) {
      setError("Ingresa el identificador completo en formato UUID.");
      return;
    }
    router.push(`/${clinical ? "studies" : "executions"}/${key}`);
  }

  return (
    <main className="flex min-h-screen flex-col">
      <TopBar title="Estación de diagnóstico oftalmológico" role={user.role} />
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-5 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{clinical ? "Estudios clínicos" : "Estación de trabajo"}</h2>
          <span className="text-xs text-cockpit-text-muted">{user.email}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {clinical ? (
            <section className="grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5">
              <h3 className="text-sm font-semibold">Nueva captura</h3>
              <p className="text-xs text-cockpit-text-muted">Selecciona un paciente y adjunta una o dos retinografías para análisis.</p>
              <Link className="cockpit-button cockpit-primary justify-self-start" href="/capture">Iniciar captura</Link>
            </section>
          ) : user.role === "ADMIN" ? (
            <section className="grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5">
              <h3 className="text-sm font-semibold">Administración</h3>
              <p className="text-xs text-cockpit-text-muted">Consulta y gestiona las cuentas y sus perfiles de acceso.</p>
              <Link className="cockpit-button justify-self-start" href="/admin/users">Gestionar usuarios</Link>
            </section>
          ) : null}
          <form className="grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5" onSubmit={open}>
            <h3 className="text-sm font-semibold">{clinical ? "Abrir estudio" : "Consultar ejecución autorizada"}</h3>
            <label className="grid gap-1">
              <span className="cockpit-label">{clinical ? "ID de consulta" : "ID de ejecución"}</span>
              <input className="cockpit-input font-mono" required value={id} maxLength={50}
                onChange={(event) => { setId(event.target.value); setError(""); }} />
            </label>
            {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
            <button className="cockpit-button justify-self-start">Abrir</button>
          </form>
          {!clinical && <ResearchExport />}
        </div>
      </div>
    </main>
  );
}
