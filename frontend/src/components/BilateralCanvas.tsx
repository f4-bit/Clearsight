"use client";

import { ImageOff, Link2, Minus, Plus, RotateCcw, Unlink2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { GradCam } from "@/components/GradCam";
import { api, errorMessage } from "@/lib/api";
import { evidenceUrl } from "@/lib/studies";
import type { EvidenceType, EyeExecution } from "@/types/api";
import { CAPTURE_EYE_LABELS } from "@/types/capture";
import { CLASS_COLORS, CLASS_LABELS, type EyeSide } from "@/types/clinical";

type FilterMode = "rgb" | "red_free" | "contrast" | "clahe";
interface Transform { scale: number; x: number; y: number }
const INITIAL_VIEW: Transform = { scale: 1, x: 0, y: 0 };

export function BilateralCanvas({ od, os }: { od?: EyeExecution; os?: EyeExecution }) {
  const [linked, setLinked] = useState(true);
  const [views, setViews] = useState({ OD: INITIAL_VIEW, OS: INITIAL_VIEW });
  const bilateral = Boolean(od && os);

  function adjust(side: EyeSide, transform: Transform) {
    setViews((previous) => linked ? { OD: transform, OS: transform } : { ...previous, [side]: transform });
  }

  return (
    <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col gap-3 bg-cockpit-bg p-3.5">
      <svg aria-hidden="true" focusable="false" className="absolute h-0 w-0">
        <defs>
          <filter id="cs-aneritro" colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-cockpit-text">Visor de segmentación</h2>
        {bilateral && <button type="button" aria-pressed={linked} onClick={() => {
          if (!linked) setViews((previous) => ({ OD: previous.OD, OS: previous.OD }));
          setLinked(!linked);
        }} className={`cockpit-button ${linked ? "text-sky-300" : ""}`}>
          {linked ? <Link2 size={14} aria-hidden="true" /> : <Unlink2 size={14} aria-hidden="true" />}
          Vincular zoom y desplazamiento
        </button>}
      </div>
      <div className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${bilateral ? "sm:grid-cols-2" : ""}`}>
        {od && <RetinalViewport key={od.result.id} eye={od} transform={views.OD} adjust={(view) => adjust("OD", view)} />}
        {os && <RetinalViewport key={os.result.id} eye={os} transform={views.OS} adjust={(view) => adjust("OS", view)} />}
        {!od && !os && (
          <div role="status" className="grid min-h-[20rem] place-content-center justify-items-center gap-3 rounded-lg border border-cockpit-border bg-cockpit-card p-4 text-center text-sm text-cockpit-text-muted">
            <ImageOff size={22} aria-hidden="true" />
            Este estudio aún no tiene ejecuciones.
          </div>
        )}
      </div>
    </div>
  );
}

function RetinalViewport({ eye, transform, adjust }: {
  eye: EyeExecution;
  transform: Transform;
  adjust: (view: Transform) => void;
}) {
  const { side, result } = eye;
  const [type, setType] = useState<EvidenceType | "gradcam">("overlay");
  const [filter, setFilter] = useState<FilterMode>("rgb");
  const [source, setSource] = useState<{ key: string; url: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const id = result.id;
  const status = result.delivery.evidenceStatus;
  const resultStatus = result.delivery.resultStatus;
  const clahe = type === "overlay" && filter === "clahe";
  const sourceKey = `${id}-${type}-${clahe}-${attempt}-${status}`;
  const url = source?.key === sourceKey ? source.url : null;

  useEffect(() => {
    if (resultStatus === "PENDING" || type === "gradcam") return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    const signed = clahe ? api<{ url: string }>(`/inferences/${id}/clahe`, { signal: controller.signal }).then((item) => item.url)
      : evidenceUrl(id, type, controller.signal);
    signed.then(
      (signed) => {
        if (controller.signal.aborted) return;
        setSource(signed ? { key: sourceKey, url: signed } : null);
      },
      (error: unknown) => { if (!controller.signal.aborted) setLoadError(errorMessage(error)); },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, resultStatus, type, sourceKey, clahe]);

  function zoom(delta: number) {
    const scale = Math.max(1, Math.min(6, transform.scale + delta));
    adjust(scale === 1 ? INITIAL_VIEW : { ...transform, scale });
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    adjust({
      ...transform,
      x: Math.max(-320, Math.min(320, drag.current.x + event.clientX - drag.current.clientX)),
      y: Math.max(-320, Math.min(320, drag.current.y + event.clientY - drag.current.clientY)),
    });
  }

  const diagnostic = result.status === "COMPLETED" && !result.delivery.reviewRequired ? result.predictedClass : null;
  const label = diagnostic != null ? CLASS_LABELS[diagnostic] : null;
  const filterValue = filter === "red_free" ? "url(#cs-aneritro)"
    : filter === "contrast" ? "contrast(1.35) brightness(1.08)" : "none";
  const placeholder = loading ? "Cargando evidencia…"
    : status === "PENDING" ? "Esperando evidencia…" : "Evidencia no disponible";

  return (
    <section aria-label={CAPTURE_EYE_LABELS[side]} className="flex min-h-[20rem] min-w-0 flex-col overflow-hidden rounded-lg border border-cockpit-border bg-cockpit-card p-3">
      <div className="mb-2 flex min-h-6 flex-wrap items-center justify-between gap-2">
        <h3 className="cockpit-label">{CAPTURE_EYE_LABELS[side]}</h3>
        {label && diagnostic != null && (
          <span className={`rounded border px-2 py-1 text-[10px] ${CLASS_COLORS[diagnostic]}`}>{label}</span>
        )}
        {result.delivery.reviewRequired && (
          <span className="rounded border border-amber-800/60 bg-amber-500/20 px-2 py-1 text-[10px] text-amber-300">Revisión</span>
        )}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="cockpit-button py-1" onClick={() => setType("overlay")}
          aria-pressed={type === "overlay"}>Contornos</button>
        <button type="button" className="cockpit-button py-1" onClick={() => setType("mask")}
          aria-pressed={type === "mask"}>Máscara</button>
        {diagnostic != null && result.gradcamPath && <button type="button" className="cockpit-button py-1"
          onClick={() => setType("gradcam")} aria-pressed={type === "gradcam"}>Grad-CAM</button>}
        {type === "overlay" && (
          <select className="cockpit-input py-1 text-xs" aria-label={`Filtro ${side}`} value={filter}
            onChange={(event) => setFilter(event.target.value as FilterMode)}>
            <option value="rgb">RGB</option>
            <option value="red_free">Aneritro</option>
            <option value="contrast">Realce de contraste</option>
            {result.hasClahe && <option value="clahe">CLAHE</option>}
          </select>
        )}
      </div>
      <div className={`relative grid min-h-[13rem] flex-1 place-items-center overflow-hidden rounded border border-cockpit-border bg-[#08080a] ${url ? "touch-none cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={(event) => {
          if (!url || transform.scale === 1 || event.button !== 0) return;
          drag.current = { clientX: event.clientX, clientY: event.clientY, x: transform.x, y: transform.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onPointerMove={move}>
        {type === "gradcam" && diagnostic != null ? <GradCam id={id} /> : url && !loadError ? (
          <img src={url} referrerPolicy="no-referrer" draggable={false}
            alt={type === "overlay" ? `Recorte con contornos de disco y copa ${side}` : `Máscara de segmentación ${side}`}
            className="absolute inset-0 h-full w-full select-none object-contain p-2"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              filter: type === "overlay" ? filterValue : undefined,
            }}
            onError={() => setLoadError("No se pudo abrir la evidencia.")} />
        ) : (
          <div className="grid justify-items-center gap-2 px-3 text-center">
            <ImageOff size={18} className="text-cockpit-text-dim" aria-hidden="true" />
            <span className="text-xs text-cockpit-text-muted" role={loadError ? "alert" : "status"}>{loadError || placeholder}</span>
            {loadError && <button type="button" className="cockpit-button"
              onClick={() => setAttempt((value) => value + 1)}>Volver a cargar</button>}
          </div>
        )}
      </div>
      <footer className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-cockpit-text-muted">
          {result.delivery.reviewRequired ? "Revisión requerida"
            : type === "gradcam" ? "Activación del clasificador" : type === "overlay" ? "Recorte del disco óptico" : "Segmentación de disco y copa"}
        </span>
        {type !== "gradcam" && <div className="flex items-center gap-1.5">
          <button type="button" className="cockpit-button p-1.5" aria-label={`Reducir zoom ${side}`}
            disabled={!url || transform.scale === 1} onClick={() => zoom(-0.25)}><Minus size={13} /></button>
          <span className="min-w-10 text-center font-mono text-[10px] text-cockpit-text-muted">{Math.round(transform.scale * 100)}%</span>
          <button type="button" className="cockpit-button p-1.5" aria-label={`Aumentar zoom ${side}`}
            disabled={!url || transform.scale === 6} onClick={() => zoom(0.25)}><Plus size={13} /></button>
          <button type="button" className="cockpit-button p-1.5" aria-label={`Restablecer vista ${side}`}
            disabled={!url} onClick={() => adjust(INITIAL_VIEW)}><RotateCcw size={13} /></button>
        </div>}
      </footer>
    </section>
  );
}
