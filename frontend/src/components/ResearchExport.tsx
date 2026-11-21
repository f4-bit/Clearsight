"use client";

import { useState } from "react";
import { apiResponse, errorMessage } from "@/lib/api";

export function ResearchExport() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function download() {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await apiResponse("/export/gold-standard?format=csv");
      const url = URL.createObjectURL(await result.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "clearsight-gold-standard.csv";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(result.headers.get("x-has-more") === "true"
        ? "Se descargó el lote máximo admitido por la API. Hay más registros autorizados."
        : "Exportación preparada.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid content-start gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-5">
      <h3 className="text-sm font-semibold">Exportación para investigación</h3>
      <p className="text-xs text-cockpit-text-muted">CSV pseudonimizado de los casos con permiso de exportación.</p>
      <button className="cockpit-button justify-self-start" type="button" disabled={pending} onClick={download}>
        {pending ? "Preparando exportación…" : "Descargar CSV"}
      </button>
      {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </section>
  );
}
