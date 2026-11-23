"use client";

import { Activity, Scan, ScanLine } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GradCam } from "@/components/GradCam";
import { errorMessage } from "@/lib/api";
import { evidenceUrl } from "@/lib/studies";
import type { ArtifactStatus, EvidenceType } from "@/types/api";
import styles from "./execution.module.css";

const modes = [
  { type: "overlay", label: "Contornos", Icon: ScanLine },
  { type: "mask", label: "Máscara", Icon: Scan },
] as const;

type Evidence =
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "error"; message: string };

export function EvidenceViewer({ id, status, gradcam }: { id: string; status?: ArtifactStatus; gradcam: boolean }) {
  const [selection, setSelection] = useState<EvidenceType | "gradcam">("overlay");
  const [images, setImages] = useState<Partial<Record<EvidenceType, Evidence>>>({});
  const requests = useRef<Partial<Record<EvidenceType, AbortController>>>({});

  const load = useCallback(async (type: EvidenceType) => {
    if (requests.current[type]) return;
    const request = new AbortController();
    requests.current[type] = request;
    setImages((current) => ({ ...current, [type]: { state: "loading" } }));

    try {
      const url = await evidenceUrl(id, type, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]));
      if (request.signal.aborted) return;
      const image: Evidence = url ? { state: "ready", url }
        : { state: "error", message: "La evidencia seleccionada aún no está disponible." };
      setImages((current) => ({ ...current, [type]: image }));
    } catch (failure) {
      if (!request.signal.aborted) {
        setImages((current) => ({ ...current, [type]: { state: "error", message: errorMessage(failure) } }));
      }
    } finally {
      if (requests.current[type] === request) delete requests.current[type];
    }
  }, [id]);

  useEffect(() => () => {
    for (const request of Object.values(requests.current)) request.abort();
    requests.current = {};
  }, [id]);

  useEffect(() => {
    if (status === "AVAILABLE") for (const { type } of modes) void load(type);
  }, [load, status]);

  function select(type: EvidenceType) {
    setSelection(type);
    if (images[type]?.state !== "ready") void load(type);
  }

  function failedImage(type: EvidenceType, url: string) {
    setImages((current) => {
      const image = current[type];
      if (image?.state !== "ready" || image.url !== url) return current;
      return { ...current, [type]: { state: "error", message: "No se pudo abrir la evidencia." } };
    });
  }

  const showingMap = gradcam && selection === "gradcam";
  const active = selection === "gradcam" ? undefined : images[selection];
  const error = active?.state === "error" ? active.message : null;

  return (
    <section className={styles.evidence} aria-labelledby="execution-evidence-title">
      <div className={styles.filmstrip} role="group" aria-label="Modo de evidencia">
        {modes.map(({ type, label, Icon }) => {
          const image = images[type];
          return (
            <button key={type} className={styles.mode} type="button" aria-pressed={selection === type} onClick={() => select(type)}>
              <span className={styles.thumbnail} aria-hidden="true">
                {image?.state === "ready" ? (
                  // These URLs are signed by the storage provider and must be loaded directly.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.url} referrerPolicy="no-referrer" alt="" />
                ) : <Icon size={19} />}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
        {gradcam && <button className={styles.mode} type="button" aria-pressed={showingMap} onClick={() => setSelection("gradcam")}>
          <span className={styles.thumbnail} aria-hidden="true"><Activity size={19} /></span>
          Grad-CAM
        </button>}
      </div>
      <figure className={styles.viewer} aria-busy={active?.state === "loading"}>
        {modes.map(({ type, label }) => {
          const image = images[type];
          if (image?.state !== "ready") return null;
          return (
            // Use the delivered artifact as-is, without Next.js image optimization.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={type} className={styles.artifact} src={image.url} referrerPolicy="no-referrer" alt={label}
              hidden={selection !== type} onError={() => failedImage(type, image.url)} />
          );
        })}
        {showingMap && <GradCam key={id} id={id} />}
        {!showingMap && active?.state !== "ready" && (
          <p className={`${styles.empty} ${styles.evidenceMessage}`} role={error ? "alert" : "status"}>
            <ScanLine size={22} aria-hidden="true" />
            {error || (active?.state === "loading" ? "Cargando evidencia…" : "Selecciona contornos o máscara para ver la evidencia.")}
          </p>
        )}
      </figure>
    </section>
  );
}
