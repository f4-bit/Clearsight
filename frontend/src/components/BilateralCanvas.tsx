"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { InferenceResult, LABEL_TO_CLINICAL } from "@/types/clinical";

interface BilateralCanvasProps {
  od: InferenceResult;
  os: InferenceResult;
}

export type FilterMode = "rgb" | "red_free" | "clahe";

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MAX_PAN = 320;

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +value.toFixed(2)));

const clampPan = (value: number) => Math.min(MAX_PAN, Math.max(-MAX_PAN, value));

export function BilateralCanvas({ od, os }: BilateralCanvasProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("rgb");
  const [showDisc, setShowDisc] = useState<boolean>(true);
  const [showCup, setShowCup] = useState<boolean>(true);
  const [showGradCam, setShowGradCam] = useState<boolean>(true);
  const [gradCamOpacity, setGradCamOpacity] = useState<number>(60);
  const [showReticle, setShowReticle] = useState<boolean>(true);

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 bg-cockpit-bg p-3.5 gap-3">
      {/* Unified Toolbar */}
      <div className="min-h-9 w-full bg-cockpit-card border border-cockpit-border rounded px-3 py-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        {/* Left: Render Filters */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
            Filtro:
          </span>
          <div className="flex items-center gap-1 bg-cockpit-bg/60 p-0.5 rounded border border-cockpit-border">
            {(
              [
                ["rgb", "Color original"],
                ["red_free", "Aneritro (RNFL)"],
                ["clahe", "Realce de contraste"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                  filterMode === mode
                    ? "bg-cockpit-subtle text-cockpit-text font-medium shadow-sm"
                    : "text-cockpit-text-muted hover:text-cockpit-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Layer Toggles */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase mr-1">
            Capas:
          </span>
          {[
            { label: "Disco", active: showDisc, toggle: () => setShowDisc(!showDisc) },
            { label: "Copa", active: showCup, toggle: () => setShowCup(!showCup) },
            {
              label: "Mapa de calor",
              active: showGradCam,
              toggle: () => setShowGradCam(!showGradCam),
            },
          ].map((layer) => (
            <button
              key={layer.label}
              onClick={layer.toggle}
              aria-pressed={layer.active}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors border ${
                layer.active
                  ? "bg-[#1E1E24] border-[#3F3F46] text-white font-medium"
                  : "bg-transparent border-cockpit-border text-cockpit-text-dim hover:text-cockpit-text"
              }`}
            >
              {layer.label}
            </button>
          ))}
        </div>

        {/* Right: Grad-CAM Opacity, Reticle & Navigation Hint */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="gradcam-slider" className="text-[11px] text-cockpit-text-muted">
              Intensidad:
            </label>
            <input
              id="gradcam-slider"
              type="range"
              min="0"
              max="100"
              value={gradCamOpacity}
              aria-label="Intensidad del mapa de calor"
              onChange={(e) => setGradCamOpacity(Number(e.target.value))}
              disabled={!showGradCam}
              className="w-16 h-1 bg-cockpit-border rounded appearance-none cursor-pointer accent-white disabled:opacity-30"
            />
            <span className="font-mono text-[11px] text-cockpit-text w-8 text-right tabular-nums">
              {gradCamOpacity}%
            </span>
          </div>

          <div className="h-3.5 w-[1px] bg-cockpit-border" />

          <button
            onClick={() => setShowReticle(!showReticle)}
            aria-pressed={showReticle}
            aria-label="Alternar retícula de centroide"
            className={`px-2 py-0.5 rounded text-[11px] transition-colors border ${
              showReticle
                ? "bg-[#1E1E24] border-[#3F3F46] text-white font-medium"
                : "bg-transparent border-cockpit-border text-cockpit-text-dim hover:text-cockpit-text"
            }`}
          >
            ⌖ Retícula
          </button>
        </div>
      </div>

      {/* Dual Viewports Row (OD Left / OS Right) */}
      <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
        <RetinalViewport
          data={od}
          filterMode={filterMode}
          showDisc={showDisc}
          showCup={showCup}
          showGradCam={showGradCam}
          gradCamOpacity={gradCamOpacity}
          showReticle={showReticle}
        />
        <RetinalViewport
          data={os}
          filterMode={filterMode}
          showDisc={showDisc}
          showCup={showCup}
          showGradCam={showGradCam}
          gradCamOpacity={gradCamOpacity}
          showReticle={showReticle}
        />
      </div>
    </div>
  );
}

interface RetinalViewportProps {
  data: InferenceResult;
  filterMode: FilterMode;
  showDisc: boolean;
  showCup: boolean;
  showGradCam: boolean;
  gradCamOpacity: number;
  showReticle: boolean;
}

function RetinalViewport({
  data,
  filterMode,
  showDisc,
  showCup,
  showGradCam,
  gradCamOpacity,
  showReticle,
}: RetinalViewportProps) {
  const isOD = data.eye_side === "OD";
  const eyeLabel = isOD ? "ojo derecho (OD)" : "ojo izquierdo (OS)";
  const isReviewRequired = data.quality.review_required;
  const clinicalPresentation = LABEL_TO_CLINICAL[data.label ?? "Non_Glaucoma"] ?? "Normal";

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const zoomBy = useCallback((delta: number) => {
    setZoom((prev) => clampZoom(prev + delta));
  }, []);

  const resetViewport = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Wheel zoom scoped to this viewport only (non-passive so the page does not scroll)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((prev) => clampZoom(prev - event.deltaY * 0.0015));
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({
      x: clampPan(drag.panX + (event.clientX - drag.x)),
      y: clampPan(drag.panY + (event.clientY - drag.y)),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const getTriageColor = () => {
    if (isReviewRequired) return "text-amber-300";
    if (clinicalPresentation === "Glaucoma") return "text-rose-400";
    if (clinicalPresentation === "Suspect") return "text-clinical-gold";
    return "text-clinical-green";
  };

  const getFilterClass = () => {
    switch (filterMode) {
      case "red_free":
        return "hue-rotate-90 saturate-150 contrast-125";
      case "clahe":
        return "contrast-150 brightness-110 saturate-125";
      default:
        return "";
    }
  };

  return (
    <div className="flex flex-col h-full bg-cockpit-card border border-cockpit-border rounded-md overflow-hidden">
      {/* Header Bar */}
      <div className="h-9 px-3.5 bg-cockpit-surface border-b border-cockpit-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-xs tracking-wide text-cockpit-text">
            {isOD ? "OD · OCULUS DEXTER (OJO DERECHO)" : "OS · OCULUS SINISTER (OJO IZQUIERDO)"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-medium ${getTriageColor()}`}>
            {isReviewRequired
              ? "Revisión Requerida (Opacidad)"
              : data.cdr_vertical != null
              ? `vCDR ${data.cdr_vertical.toFixed(2)} · ${
                  clinicalPresentation === "Normal"
                    ? "Fisiológico normal"
                    : clinicalPresentation === "Suspect"
                    ? "Excavación límite"
                    : "Glaucomatoso"
                }`
              : "vCDR no disponible"}
          </span>
        </div>
      </div>

      {/* Retinal Canvas Stage */}
      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ touchAction: "none" }}
        className={`relative flex-1 bg-[#060608] flex items-center justify-center overflow-hidden ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        {/* Anatomical Quadrant Markers (S, I, N, T) */}
        <span className="absolute top-2.5 font-mono text-[9px] text-zinc-600">S</span>
        <span
          className={`absolute bottom-2.5 font-mono text-[9px] ${
            isOD && clinicalPresentation === "Suspect" ? "text-clinical-gold/80" : "text-zinc-600"
          }`}
        >
          I
        </span>
        <span className="absolute left-3.5 font-mono text-[9px] text-zinc-600">
          {isOD ? "T" : "N"}
        </span>
        <span className="absolute right-3.5 font-mono text-[9px] text-zinc-600">
          {isOD ? "N" : "T"}
        </span>

        {/* Retinal Simulation Sphere */}
        <div
          className={`relative w-[360px] h-[360px] rounded-full overflow-hidden ${getFilterClass()} ${
            isDragging ? "" : "transition-transform duration-150"
          }`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            background: "radial-gradient(circle, #3D140B 0%, #240B06 65%, #100403 100%)",
            boxShadow: "inset 0 0 60px rgba(0,0,0,0.85)",
            willChange: "transform",
          }}
        >
          {/* Simulated Retinal Blood Vessels */}
          <svg className="absolute inset-0 w-full h-full opacity-40 pointer-events-none">
            <path
              d="M 180 180 Q 200 120 260 80 Q 220 50 210 20"
              stroke="#6B1D11"
              strokeWidth="2.5"
              fill="none"
            />
            <path
              d="M 180 180 Q 150 110 110 70 Q 90 40 70 20"
              stroke="#6B1D11"
              strokeWidth="2"
              fill="none"
            />
            <path
              d="M 180 180 Q 210 240 250 290 Q 280 320 300 350"
              stroke="#7A1F13"
              strokeWidth="3"
              fill="none"
            />
            <path
              d="M 180 180 Q 140 230 110 280 Q 80 320 60 350"
              stroke="#6B1D11"
              strokeWidth="2"
              fill="none"
            />
          </svg>

          {/* Grad-CAM Thermal Heatmap Layer */}
          {showGradCam && data.artifacts.gradcam_url && (
            <div
              className="absolute pointer-events-none transition-opacity duration-150"
              style={{
                top: isOD ? "175px" : "185px",
                left: isOD ? "135px" : "175px",
                width: "115px",
                height: "95px",
                borderRadius: "50%",
                background: isOD
                  ? "radial-gradient(circle, rgba(225,29,72,0.95) 0%, rgba(245,158,11,0.65) 55%, rgba(6,182,212,0) 100%)"
                  : "radial-gradient(circle, rgba(56,189,248,0.7) 0%, rgba(16,185,129,0.3) 50%, rgba(0,0,0,0) 100%)",
                filter: "blur(14px)",
                opacity: gradCamOpacity / 100,
              }}
            />
          )}

          {/* SVG Vector Overlays */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {showDisc && (
              <ellipse
                cx="180"
                cy="180"
                rx={isOD ? "55" : "58"}
                ry="65"
                fill="rgba(180, 83, 9, 0.12)"
                stroke="#38BDF8"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />
            )}

            {showCup && (
              <ellipse
                cx="180"
                cy={isOD ? "184" : "180"}
                rx={isOD ? "38" : "24"}
                ry={isOD ? "46" : "27"}
                fill="rgba(254, 240, 138, 0.16)"
                stroke="#F59E0B"
                strokeWidth="1.5"
              />
            )}

            {showReticle && (
              <g stroke="rgba(255, 255, 255, 0.25)" strokeWidth="1">
                <line x1="180" y1="100" x2="180" y2="260" strokeDasharray="3 3" />
                <line x1="100" y1="180" x2="260" y2="180" strokeDasharray="3 3" />
                <circle cx="180" cy="180" r="3" fill="none" stroke="#38BDF8" strokeWidth="1.5" />
              </g>
            )}
          </svg>
        </div>

        {/* Per-viewport navigation controls */}
        <div
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          title="Rueda: zoom · Arrastrar: desplazar"
          className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 rounded border border-cockpit-border bg-cockpit-bg/90 px-1 py-0.5 backdrop-blur-sm"
        >
          <button
            onClick={() => zoomBy(-ZOOM_STEP)}
            aria-label={`Reducir zoom del ${eyeLabel}`}
            className="h-5 w-5 rounded text-cockpit-text text-xs leading-none hover:bg-cockpit-subtle"
          >
            −
          </button>
          <span className="w-10 text-center font-mono text-[10px] text-cockpit-text-muted tabular-nums">
            {(zoom * 100).toFixed(0)}%
          </span>
          <button
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-label={`Aumentar zoom del ${eyeLabel}`}
            className="h-5 w-5 rounded text-cockpit-text text-xs leading-none hover:bg-cockpit-subtle"
          >
            +
          </button>
          <div className="mx-0.5 h-3 w-[1px] bg-cockpit-border" />
          <button
            onClick={resetViewport}
            aria-label={`Restablecer vista del ${eyeLabel}`}
            className="h-5 rounded px-1.5 font-mono text-[10px] text-cockpit-text-muted hover:bg-cockpit-subtle hover:text-cockpit-text"
          >
            1:1
          </button>
        </div>
      </div>

      {/* Structured Footer */}
      <div className="h-10 px-4 bg-cockpit-surface border-t border-cockpit-border flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-cockpit-text-muted text-[11px]">vCDR:</span>
          <span className={`font-mono font-bold text-[13px] tabular-nums ${getTriageColor()}`}>
            {isReviewRequired
              ? "--"
              : data.cdr_vertical != null
              ? data.cdr_vertical.toFixed(2)
              : "--"}
          </span>
          <span className="text-[11px] text-cockpit-text-dim">
            ·{" "}
            {isReviewRequired
              ? "Baja fiabilidad"
              : clinicalPresentation === "Normal"
              ? "Fisiológico"
              : "Excavación límite"}
          </span>
        </div>

        <div className="flex items-center gap-2 text-cockpit-text-muted text-[11px] font-mono tabular-nums">
          <span>
            Copa:{" "}
            {data.calipers?.cup_height_mm ? `${data.calipers.cup_height_mm.toFixed(2)} mm` : "--"}
          </span>
          <span className="text-cockpit-text-dim">·</span>
          <span>
            Disco:{" "}
            {data.calipers?.disc_height_mm
              ? `${data.calipers.disc_height_mm.toFixed(2)} mm`
              : "--"}
          </span>
        </div>
      </div>
    </div>
  );
}
