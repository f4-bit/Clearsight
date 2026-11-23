"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { ClinicalValues } from "@/components/ClinicalValues";
import { api, errorMessage } from "@/lib/api";
import { type Patient, UUID_PATTERN } from "@/types/api";

interface StudyEntry { id: string; createdAt: string }
interface Directory { patient?: Patient; patients?: Patient[]; studies?: StudyEntry[]; hasMore: boolean }
const pageSize = 20;

export default function PatientsPage({ params }: { params: { profile?: string[] } }) {
  const path = params.profile ?? [];
  return <SessionGate role="OFTALMOLOGO">{() => <>
    <TopBar title="Pacientes" role="OFTALMOLOGO" />
    {path.length <= 1 && (!path.length || UUID_PATTERN.test(path[0]))
      ? <DirectoryView key={path[0] ?? "all"} id={path[0]} />
      : <p role="alert" className="p-6">El identificador del paciente no es válido.</p>}
  </>}</SessionGate>;
}

function DirectoryView({ id }: { id?: string }) {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const query = `?limit=${pageSize + 1}&offset=${page * pageSize}`;
    async function load(): Promise<Directory> {
      if (!id) {
        const rows = await api<Patient[]>("/patients" + query, options);
        return { patients: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
      }
      const [patient, rows] = await Promise.all([
        api<Patient>(`/patients/${id}`, options),
        api<StudyEntry[]>(`/patients/${id}/consultations${query}`, options),
      ]);
      return { patient, studies: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
    }
    setDirectory(null);
    setError("");
    load().then((data) => { if (!controller.signal.aborted) setDirectory(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [id, page, attempt]);
  const patient = directory?.patient;
  const flags = Object.entries(patient?.clinicalHistoryFlags ?? {}).filter(([, value]) => value === true);
  return <main className="mx-auto grid max-w-5xl gap-5 px-5 py-8">
    <Link className="text-sm text-sky-300" href={id ? "/patients" : "/"}>← {id ? "Pacientes" : "Estación clínica"}</Link>
    <h1 className="border-b border-cockpit-border pb-4 text-2xl font-semibold">{id ? patient?.externalCode || "Ficha del paciente" : "Mis pacientes"}</h1>
    {error && <div role="alert">{error} <button className="cockpit-button" onClick={() => setAttempt(attempt + 1)}>Reintentar</button></div>}
    {!error && !directory && <p role="status">Cargando…</p>}
    {patient && <section className="grid gap-2 text-sm text-cockpit-text-muted">
      <p className="break-all font-mono">ID {patient.id}</p>
      {patient.age != null && <p>Edad registrada · {patient.age} años</p>}
      {patient.gender && <p>Sexo registrado · {patient.gender}</p>}
      {flags.length > 0 && <p>Antecedentes registrados · {flags.map(([name]) => name).join(", ")}</p>}
      {patient.clinicalData && Object.keys(patient.clinicalData).length > 0 && <ClinicalValues values={patient.clinicalData} compact />}
    </section>}
    {directory && <section className="divide-y divide-cockpit-border border-y border-cockpit-border">
      {directory.studies && <h2 className="py-3 font-semibold">Historial de estudios</h2>}
      {directory.patients?.map((row) => <Link key={row.id} href={`/patients/${row.id}`} className="block py-3 text-sky-300">{row.externalCode || row.id}</Link>)}
      {directory.studies?.map((row) => <Link key={row.id} href={`/studies/${row.id}`} className="flex flex-wrap justify-between gap-2 py-3 text-sky-300">
        <span>Estudio · {new Date(row.createdAt).toLocaleString("es-CO")}</span><span className="font-mono">#{row.id.slice(0, 8)}</span>
      </Link>)}
      {directory.studies?.length === 0 && <p className="py-3">Sin estudios registrados.</p>}
      {directory.patients?.length === 0 && <p className="py-3">Sin pacientes registrados.</p>}
    </section>}
    {(page > 0 || directory?.hasMore) && <nav aria-label="Paginación" className="flex gap-2">
      <button className="cockpit-button" disabled={!page || !directory} onClick={() => setPage(page - 1)}>Anterior</button>
      <button className="cockpit-button" disabled={!directory?.hasMore} onClick={() => setPage(page + 1)}>Siguiente</button>
    </nav>}
  </main>;
}
