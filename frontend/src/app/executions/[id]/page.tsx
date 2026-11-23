"use client";

import "@fontsource-variable/space-grotesk";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { InferenceMetadata, InferenceReport, InferenceSummary } from "@/components/InferenceDetails";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { errorMessage } from "@/lib/api";
import { getInference } from "@/lib/studies";
import { UUID_PATTERN, type Inference, type UserRole } from "@/types/api";
import { EvidenceViewer } from "./EvidenceViewer";
import styles from "./execution.module.css";

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
    <main className={styles.page}>
      <TopBar title="Consulta de ejecución" role={role} reference={id} />
      <div className={styles.toolbar}>
        {role === "INVESTIGADOR" && <Link href="/" className={styles.returnLink}>
          <ArrowLeft size={14} aria-hidden="true" /> Volver a Investigación
        </Link>}
        <h2 id="execution-evidence-title">Evidencia de segmentación</h2>
      </div>
      <div className={styles.workspace}>
        <EvidenceViewer id={id} status={result?.delivery.evidenceStatus}
          gradcam={result ? result.status === "COMPLETED" && !result.delivery.reviewRequired && Boolean(result.gradcamPath) : Boolean(error)} />
        <aside aria-label="Resultados de la ejecución" className={styles.results}>
          {result && <InferenceSummary result={result} layout="viewer" />}
          {error ? <div className="grid justify-items-start gap-2">
            <p role="alert" className="text-xs text-amber-300">{error}</p>
            <button type="button" className="cockpit-button" onClick={() => { setError(""); setCheck((previous) => previous + 1); }}>Consultar de nuevo</button>
          </div> : !result && <p role="status" className={styles.empty}>Consultando ejecución…</p>}
        </aside>
      </div>
      <footer className={styles.footer}>
        <InferenceMetadata result={result} executionId={id} />
        <InferenceReport id={id} delivery={result?.delivery} layout="viewer" />
      </footer>
    </main>
  );
}
