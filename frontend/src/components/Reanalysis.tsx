"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CaptureEyeDropzone } from "@/components/capture/CaptureLoadPanel";
import { ApiError, errorMessage } from "@/lib/api";
import { createInference, uploadRetinography } from "@/lib/studies";
import type { Consultation, EyeExecution } from "@/types/api";
import { CLINICAL_FIELDS, clinicalFeaturesFromValues, createEmptyClinicalValues, type CaptureEyeSlot } from "@/types/capture";
import type { ClinicalFeatures } from "@/types/clinical";

export function Reanalysis({ consultation, eye }: {
  consultation: Consultation;
  eye: EyeExecution;
}) {
  const selected = useRef<CaptureEyeSlot>({ status: "empty" });
  const intent = useRef<{ key: string; imageId: string; clinicalFeatures: ClinicalFeatures } | null>(null);
  const [slot, setSlot] = useState<CaptureEyeSlot>({ status: "empty" });
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [uploadUnconfirmed, setUploadUnconfirmed] = useState(false);
  const [error, setError] = useState("");
  const values = createEmptyClinicalValues();
  for (const { key } of CLINICAL_FIELDS) {
    const source = consultation.clinicalData[key] ??
      (key === "Phakic/Pseudophakic" ? consultation.clinicalData.Phakic_Pseudophakic : undefined);
    if (typeof source === "number" || typeof source === "string") values[key] = String(source);
  }
  const clinicalFeatures = clinicalFeaturesFromValues(values);

  useEffect(() => () => {
    if (selected.current.status === "ready") URL.revokeObjectURL(selected.current.asset.previewUrl);
  }, []);

  function changeSlot(next: CaptureEyeSlot) {
    if (selected.current.status === "ready") URL.revokeObjectURL(selected.current.asset.previewUrl);
    selected.current = next;
    setSlot(next);
    setError("");
  }

  async function submit() {
    if (!clinicalFeatures || slot.status !== "ready" || pending || uploadUnconfirmed) return;
    setPending(true);
    setError("");
    try {
      if (!intent.current) {
        try {
          const image = await uploadRetinography(consultation.id, eye.side, slot.asset.file, setProgress);
          intent.current = { key: crypto.randomUUID(), imageId: image.id, clinicalFeatures };
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500) {
            setUploadUnconfirmed(true);
            setError("No se pudo confirmar la carga. Verifica la consulta antes de volver a subir la imagen.");
            return;
          }
          throw failure;
        }
      }
      setProgress(null);
      const recorded = intent.current;
      setExecutionId(await createInference(recorded.key, recorded.imageId, eye.side, recorded.clinicalFeatures, eye.result.id));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <details className="grid gap-2 rounded-md border border-amber-800/60 bg-cockpit-card p-3.5">
      <summary className="cockpit-label cursor-pointer text-amber-300">Reanalizar {eye.side}</summary>
      <div className="mt-3 grid gap-2">
        {!clinicalFeatures ? (
          <p className="text-xs text-cockpit-text-muted">
            Faltan variables clínicas en esta consulta. Inicia una captura para registrarlas.
          </p>
        ) : executionId ? (
          <Link href={`/executions/${executionId}`} className="cockpit-button cockpit-primary justify-self-start">
            Abrir nueva ejecución
          </Link>
        ) : (
          <>
            <p className="text-xs text-cockpit-text-muted">
              Adjunta una nueva retinografía del mismo ojo. El reanálisis usa las variables registradas y genera una ejecución independiente.
            </p>
            <CaptureEyeDropzone compact side={eye.side} slot={slot} onChange={changeSlot}
              disabled={pending || intent.current !== null || uploadUnconfirmed} />
            <button type="button" className="cockpit-button cockpit-primary justify-self-start"
              disabled={slot.status !== "ready" || pending || uploadUnconfirmed} onClick={submit}>
              {pending
                ? progress != null ? `Subiendo ${progress}%` : "Enviando…"
                : intent.current ? "Reintentar reanálisis" : "Enviar reanálisis"}
            </button>
          </>
        )}
        {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
      </div>
    </details>
  );
}
