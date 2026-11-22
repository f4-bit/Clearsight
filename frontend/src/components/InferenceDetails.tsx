"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { reportUrl, reportUrls } from "@/lib/studies";
import type { Inference, ReportVersion } from "@/types/api";
import { CLASS_COLORS, CLASS_LABELS, DIAGNOSTIC_CLASSES, formatCdr, PROBABILITY_KEYS } from "@/types/clinical";
import styles from "@/app/executions/[id]/execution.module.css";

const viewerPercent = new Intl.NumberFormat("es-CO", {
  style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
});

export function InferenceSummary({ result, layout = "panel" }: { result: Inference; layout?: "panel" | "viewer" }) {
  const viewer = layout === "viewer";
  const diagnostic = result.status === "COMPLETED" && !result.delivery.reviewRequired ? result.predictedClass : null;
  const label = diagnostic != null ? CLASS_LABELS[diagnostic] : null;
  const showMeasures =
    result.status === "COMPLETED" && !result.delivery.reviewRequired &&
    (result.cdr != null || result.cdrVertical != null);
  const probabilities = DIAGNOSTIC_CLASSES.map((item) => {
    const probability = result.probabilities[PROBABILITY_KEYS[item]];
    const valid = typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1;
    return { item, probability: valid ? probability : null };
  });
  const totalProbability = probabilities.reduce((sum, { probability }) => sum + (probability ?? 0), 0);
  const formatProbability = (value: number) => viewer ? viewerPercent.format(value) : `${(value * 100).toFixed(1)}%`;

  return (
    <section className={viewer ? styles.summary : "grid gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-3.5"}>
      <h3 className={viewer ? styles.sectionTitle : "cockpit-label"}>Predicción multimodal</h3>
      {label && diagnostic != null ? (
        <>
          <div className={viewer ? styles.prediction : "flex flex-wrap items-center justify-between gap-3 border-b border-cockpit-border pb-3"}>
            <span className={viewer ? styles.predictedClass : `rounded border px-2 py-1 text-xs font-semibold ${CLASS_COLORS[diagnostic]}`} data-class={diagnostic}>{label}</span>
            {result.confidence !== null && <span className={viewer ? styles.confidence : "flex flex-wrap items-center gap-x-2 text-right"}>
              <span className={viewer ? undefined : "text-xs text-cockpit-text-muted"}>Confianza</span>
              <span className={viewer ? "font-mono" : "font-mono text-sm"}>{formatProbability(result.confidence)}</span>
            </span>}
          </div>
          {viewer && totalProbability > 0 && (
            <div className={styles.probabilityTrack} aria-hidden="true">
              {probabilities.map(({ item, probability }) => probability !== null && probability > 0 && (
                <span key={item} data-class={item} style={{ flexGrow: probability }} />
              ))}
              {totalProbability < .999 && <span style={{ flexGrow: 1 - totalProbability }} />}
            </div>
          )}
          <dl className={viewer ? styles.probabilities : "grid gap-2"}>
            {probabilities.map(({ item, probability }) => (
              <div key={item} className={viewer ? undefined : "grid gap-1"}>
                <div className={viewer ? styles.probabilityRow : "flex justify-between gap-2 text-xs text-cockpit-text-muted"}>
                  <dt>{viewer && <span className={styles.probabilityKey} data-class={item} aria-hidden="true" />}{CLASS_LABELS[item]}</dt>
                  <dd className="font-mono">{probability === null ? "—" : formatProbability(probability)}</dd>
                </div>
                {!viewer && probability !== null && <div className="h-1 overflow-hidden rounded bg-cockpit-subtle">
                  <div className={`h-full ${item === diagnostic ? "bg-sky-500/70" : "bg-zinc-500"}`} style={{ width: `${probability * 100}%` }} />
                </div>}
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className={result.delivery.reviewRequired ? (viewer ? styles.reviewNotice : "text-xs text-amber-300") : "text-xs text-cockpit-text-muted"}>
          {result.delivery.reviewRequired ? "Revisión requerida. Predicción y probabilidades suprimidas."
            : result.status === "FAILED" ? "El análisis falló."
            : result.status === "COMPLETED" ? "La ejecución no tiene una clase publicada."
            : "Predicción pendiente."}
        </p>
      )}
      {showMeasures && (
        <div className={viewer ? styles.cdr : "grid gap-2 border-t border-cockpit-border pt-3"}>
          <h4 className={viewer ? styles.sectionTitle : "cockpit-label"}>Relación copa/disco</h4>
          <dl className={viewer ? styles.measures : "grid grid-cols-2 divide-x divide-cockpit-border rounded border border-cockpit-border bg-cockpit-surface"}>
            <div className={viewer ? undefined : "grid gap-1 p-2.5"}>
              <dt className={viewer ? undefined : "text-[11px] text-cockpit-text-muted"}>CDR por área</dt>
              <dd className={viewer ? "font-mono" : "font-mono text-base"}>{result.cdr != null ? formatCdr(result.cdr) : "—"}</dd>
            </div>
            <div className={viewer ? undefined : "grid gap-1 p-2.5"}>
              <dt className={viewer ? undefined : "text-[11px] text-cockpit-text-muted"}>vCDR vertical</dt>
              <dd className={viewer ? "font-mono" : "font-mono text-base"}>{result.cdrVertical != null ? formatCdr(result.cdrVertical) : "—"}</dd>
            </div>
          </dl>
        </div>
      )}
      {!viewer && <InferenceMetadata result={result} />}
    </section>
  );
}

export function InferenceMetadata({ result, executionId }: { result: Inference | null; executionId?: string }) {
  const row = executionId ? undefined : "flex justify-between gap-2";
  const value = executionId ? "font-mono" : "break-all text-right font-mono";
  return (
    <dl className={executionId ? styles.metadata : "grid gap-2 border-t border-cockpit-border pt-2 text-xs"}>
      <div className={row}>
        <dt className={executionId ? undefined : "text-cockpit-text-muted"}>{executionId ? "Versión del modelo" : "Versión"}</dt>
        <dd className={value}>{result?.modelVersion ?? "—"}</dd>
      </div>
      <div className={row}>
        <dt className={executionId ? undefined : "text-cockpit-text-muted"}>Registro de ejecución</dt>
        <dd className={executionId ? "font-mono" : "text-right font-mono"}>{result ? new Date(result.createdAt).toLocaleString("es-CO") : "—"}</dd>
      </div>
      {executionId && <div><dt>ID de ejecución</dt><dd className="font-mono">{executionId}</dd></div>}
    </dl>
  );
}

export function InferenceReport({
  id, delivery, layout = "panel",
}: {
  id: string;
  delivery?: Inference["delivery"];
  layout?: "panel" | "viewer";
}) {
  const [versions, setVersions] = useState<ReportVersion[] | null>(null);
  const [link, setLink] = useState<{ version: number; url: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const viewer = layout === "viewer";
  const reportStatus = delivery && (
    <p className={viewer ? styles.reportStatus : "text-xs text-cockpit-text-muted"}>
      {delivery.pdfStatus === "PENDING" ? "Generación pendiente."
        : delivery.pdfStatus === "FAILED" ? "La publicación del PDF falló."
        : delivery.reviewRequired ? "Informe parcial para revisión."
        : delivery.pdfStatus === "AVAILABLE" ? "Informe disponible." : "Informe no disponible."}
    </p>
  );

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
    <section className={viewer ? styles.report : "grid gap-2 rounded-md border border-cockpit-border bg-cockpit-card p-3.5"}>
      <div className={viewer ? styles.reportHeading : "flex flex-wrap items-center justify-between gap-2"}>
        <div>
          <h3 className={viewer ? styles.reportTitle : "cockpit-label"}>Informe PDF</h3>
          {viewer && reportStatus}
        </div>
        <button type="button" className={viewer ? styles.reportAction : "cockpit-button py-1"}
          disabled={pending || delivery?.pdfStatus === "PENDING"}
          onClick={loadVersions}>{versions === null ? "Ver versiones" : "Actualizar"}</button>
      </div>
      {!viewer && reportStatus}
      {versions?.map((report) => (
        <div key={report.reportId} className={viewer ? styles.reportVersion : "flex flex-wrap items-center justify-between gap-2 border-t border-cockpit-border pt-2 text-xs"}>
          <span className="font-mono">Versión {report.version}</span>
          <button type="button" disabled={pending || report.status !== "AVAILABLE"} className={viewer ? styles.reportAction : "cockpit-button py-1"}
            onClick={() => void sign(report.version)}>
            {report.status === "AVAILABLE" ? "Preparar descarga" : report.status === "FAILED" ? "Fallida" : "Pendiente"}
          </button>
        </div>
      ))}
      {versions?.length === 0 && <p className="text-xs text-cockpit-text-muted">Sin versiones publicadas.</p>}
      {link && <a className={viewer ? `${styles.reportAction} justify-self-start` : "cockpit-button cockpit-primary justify-self-start"} href={link.url}
        target="_blank" rel="noreferrer" download>Descargar PDF · v{link.version}</a>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </section>
  );
}
