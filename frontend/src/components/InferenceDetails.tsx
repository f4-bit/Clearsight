"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { reportUrl, reportUrls } from "@/lib/studies";
import type { Inference, ReportVersion } from "@/types/api";
import { CLASS_COLORS, CLASS_LABELS, DIAGNOSTIC_CLASSES, formatCdr, PROBABILITY_KEYS } from "@/types/clinical";

export function InferenceSummary({ result }: { result: Inference }) {
  const diagnostic = result.status === "COMPLETED" ? result.predictedClass : null;
  const label = diagnostic != null ? CLASS_LABELS[diagnostic] : null;
  const showMeasures =
    result.status === "COMPLETED" && !result.delivery.reviewRequired &&
    (result.cdr != null || result.cdrVertical != null);
  return (
    <section className="grid gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-3.5">
      <h3 className="cockpit-label">Predicción multimodal</h3>
      {label && diagnostic != null ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`rounded border px-2 py-1 text-xs ${CLASS_COLORS[diagnostic]}`}>{label}</span>
            {result.confidence !== null && <span className="font-mono text-xs">{(result.confidence * 100).toFixed(1)}%</span>}
          </div>
          <dl className="grid gap-2">
            {DIAGNOSTIC_CLASSES.map((item) => {
              const probability = result.probabilities[PROBABILITY_KEYS[item]];
              const present = typeof probability === "number" && Number.isFinite(probability) &&
                probability >= 0 && probability <= 1;
              return (
                <div key={item} className="grid gap-1">
                  <div className="flex justify-between gap-2 text-xs text-cockpit-text-muted">
                    <dt>{CLASS_LABELS[item]}</dt>
                    <dd className="font-mono">{present ? `${(probability * 100).toFixed(1)}%` : "—"}</dd>
                  </div>
                  {present && <div className="h-1 overflow-hidden rounded bg-cockpit-subtle">
                    <div className="h-full bg-sky-500/70" style={{ width: `${probability * 100}%` }} />
                  </div>}
                </div>
              );
            })}
          </dl>
        </>
      ) : (
        <p className={`text-xs ${result.delivery.reviewRequired ? "text-amber-300" : "text-cockpit-text-muted"}`}>
          {result.delivery.reviewRequired ? "Revisión requerida. Predicción y probabilidades suprimidas."
            : result.status === "FAILED" ? "El análisis falló."
            : result.status === "COMPLETED" ? "La ejecución no tiene una clase publicada."
            : "Predicción pendiente."}
        </p>
      )}
      {showMeasures && (
        <div className="grid gap-2 border-t border-cockpit-border pt-2">
          <h4 className="cockpit-label">Relación copa/disco</h4>
          <dl className="grid grid-cols-2 divide-x divide-cockpit-border rounded border border-cockpit-border bg-cockpit-surface">
            <div className="grid gap-1 p-2">
              <dt className="text-[11px] text-cockpit-text-muted">CDR por área</dt>
              <dd className="font-mono text-sm">{result.cdr != null ? formatCdr(result.cdr) : "—"}</dd>
            </div>
            <div className="grid gap-1 p-2">
              <dt className="text-[11px] text-cockpit-text-muted">vCDR vertical</dt>
              <dd className="font-mono text-sm">{result.cdrVertical != null ? formatCdr(result.cdrVertical) : "—"}</dd>
            </div>
          </dl>
        </div>
      )}
      <dl className="grid gap-2 border-t border-cockpit-border pt-2 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-cockpit-text-muted">Versión</dt>
          <dd className="break-all text-right font-mono">{result.modelVersion ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-cockpit-text-muted">Registro de ejecución</dt>
          <dd className="text-right font-mono">{new Date(result.createdAt).toLocaleString("es-CO")}</dd>
        </div>
      </dl>
    </section>
  );
}

export function InferenceReport({
  id, delivery,
}: {
  id: string;
  delivery?: Inference["delivery"];
}) {
  const [versions, setVersions] = useState<ReportVersion[] | null>(null);
  const [link, setLink] = useState<{ version: number; url: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function loadVersions() {
    setPending(true);
    setError("");
    setLink(null);
    try {
      setVersions(await reportUrls(id));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function sign(version: number) {
    setPending(true);
    setError("");
    setLink(null);
    try {
      const url = await reportUrl(id, version);
      if (url) setLink({ version, url });
      else setError("Esta versión aún no está disponible.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-2 rounded-md border border-cockpit-border bg-cockpit-card p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="cockpit-label">Informe PDF</h3>
        <button type="button" className="cockpit-button py-1"
          disabled={pending || delivery?.pdfStatus === "PENDING"}
          onClick={loadVersions}>{versions === null ? "Ver versiones" : "Actualizar"}</button>
      </div>
      {delivery && (
        <p className="text-xs text-cockpit-text-muted">
          {delivery.pdfStatus === "PENDING" ? "Generación pendiente."
            : delivery.pdfStatus === "FAILED" ? "La publicación del PDF falló."
            : delivery.reviewRequired ? "Informe parcial para revisión."
            : delivery.pdfStatus === "AVAILABLE" ? "Informe disponible." : "Informe no disponible."}
        </p>
      )}
      {versions?.map((report) => (
        <div key={report.reportId} className="flex flex-wrap items-center justify-between gap-2 border-t border-cockpit-border pt-2 text-xs">
          <span className="font-mono">Versión {report.version}</span>
          <button type="button" disabled={pending || report.status !== "AVAILABLE"} className="cockpit-button py-1"
            onClick={() => void sign(report.version)}>
            {report.status === "AVAILABLE" ? "Preparar descarga" : report.status === "FAILED" ? "Fallida" : "Pendiente"}
          </button>
        </div>
      ))}
      {versions?.length === 0 && <p className="text-xs text-cockpit-text-muted">Sin versiones publicadas.</p>}
      {link && <a className="cockpit-button cockpit-primary justify-self-start" href={link.url}
        target="_blank" rel="noreferrer" download>Descargar PDF · v{link.version}</a>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </section>
  );
}
