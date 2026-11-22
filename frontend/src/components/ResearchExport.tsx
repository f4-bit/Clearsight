"use client";

import { Download } from "lucide-react";
import { useState, type FormEvent } from "react";
import { clsx } from "clsx";
import { ApiError, apiResponse, errorMessage } from "@/lib/api";
import styles from "@/app/research.module.css";

const FORMATS = ["csv", "json"] as const;
type ExportFormat = (typeof FORMATS)[number];

export function ResearchExport({ layout = "panel", onFocus }: { layout?: "panel" | "strip"; onFocus?: () => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const strip = layout === "strip";

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const since = String(fields.get("since") ?? "");
    const limit = String(fields.get("limit") ?? "");
    setPending(true);
    setMessage("");
    setError("");
    try {
      const query = new URLSearchParams({ format });
      if (since) query.set("since", new Date(`${since}T00:00:00`).toISOString());
      if (limit) query.set("limit", limit);
      const result = await apiResponse(`/export/gold-standard?${query}`);
      const file = await result.blob();
      const empty = format === "json"
        ? (JSON.parse(await file.text()) as { count: number }).count === 0
        : !(await file.slice(0, 4096).text()).trimEnd().includes("\n");
      if (empty) {
        setMessage("No hay referencias validadas autorizadas con estos filtros.");
        return;
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `clearsight-gold-standard.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(result.headers.get("x-has-more") === "true"
        ? "La descarga alcanzó el límite. Quedan registros autorizados para estos filtros."
        : "Descarga iniciada.");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 403
        ? "Tu cuenta necesita un permiso vigente de exportación."
        : errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={clsx(styles.exportPanel, strip && styles.exportStrip)} aria-labelledby="research-export-title"
      onSubmit={download} onFocus={onFocus} aria-busy={pending}>
      <div className={styles.exportIntro}>
        {!strip && <Download className={styles.exportIcon} size={26} aria-hidden="true" />}
        <h2 id="research-export-title">Exportar referencias validadas</h2>
        <p>{strip ? "Descarga datos pseudonimizados." : "Descarga datos pseudonimizados de las ejecuciones autorizadas que el médico marcó como referencia validada."}</p>
      </div>
      <div className={styles.exportContent}>
        <fieldset disabled={pending} className={styles.exportFields}>
          <fieldset>
            <legend>Formato</legend>
            <div className={styles.formats}>
              {FORMATS.map((option) => <label key={option}>
                <input type="radio" name="format" value={option} checked={option === format} onChange={() => setFormat(option)} />
                <span>{option.toUpperCase()}</span>
              </label>)}
            </div>
          </fieldset>
          <div className={styles.filters}>
            <label>{strip ? "Desde (opcional)" : "Desde"}<input className="cockpit-input" name="since" type="date" /></label>
            <label>Límite de registros<input className="cockpit-input" name="limit" type="number" min={1} max={50000} step={1} placeholder="5000" /></label>
          </div>
          <button className={strip ? styles.download : styles.open} type="submit">
            {pending ? "Preparando exportación…" : `Descargar ${format.toUpperCase()}`}
            <Download size={16} aria-hidden="true" />
          </button>
        </fieldset>
        <div className={styles.exportFeedback}>
          {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
          {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
        </div>
      </div>
    </form>
  );
}
