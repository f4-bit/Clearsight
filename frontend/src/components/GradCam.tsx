"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";

export function GradCam({ id }: { id: string }) {
  const [images, setImages] = useState<{ url: string; baseUrl?: string }>();
  const [opacity, setOpacity] = useState(50);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setImages(undefined);
    api<{ url: string; baseUrl?: string }>(`/inferences/${id}/gradcam`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setImages(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [id, attempt]);
  if (error) return <div className="grid justify-items-center gap-2 p-3">
    <p className="text-xs text-amber-300" role="alert">{error}</p>
    <button className="cockpit-button" onClick={() => setAttempt((n) => n + 1)}>Volver a cargar</button>
  </div>;
  if (!images) return <p className="text-xs text-cockpit-text-muted" role="status">Cargando Grad-CAM…</p>;
  const failed = () => setError("No se pudo abrir el mapa de activación.");
  const imageClass = "absolute inset-0 h-full w-full object-contain";
  return <div className="flex h-full min-h-0 w-full flex-col gap-2 p-2">
    <div className="relative min-h-40 flex-1">
      {images.baseUrl && <img className={imageClass} src={images.baseUrl} alt="Recorte de entrada del clasificador"
        referrerPolicy="no-referrer" draggable={false} onError={failed} />}
      <img className={imageClass} src={images.url} alt="Grad-CAM de la clase predicha" referrerPolicy="no-referrer"
        draggable={false} style={{ opacity: images.baseUrl ? opacity / 100 : 1 }} onError={failed} />
    </div>
    {images.baseUrl && <label className="flex flex-wrap items-center justify-center gap-2 text-xs text-cockpit-text-muted">
      Opacidad del mapa
      <input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
      <span className="w-9 font-mono">{opacity}%</span>
    </label>}
  </div>;
}
