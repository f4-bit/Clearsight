"use client";

import React, { useState } from "react";
import { InferenceResult, LABEL_TO_CLINICAL } from "@/types/clinical";

interface BilateralCanvasProps {
  od: InferenceResult;
  os: InferenceResult;
  isSynced?: boolean;
}

export type FilterMode = "rgb" | "red_free" | "clahe";

export function BilateralCanvas({ od, os, isSynced = true }: BilateralCanvasProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("rgb");
  const [showDisc, setShowDisc] = useState<boolean>(true);
  const [showCup, setShowCup] = useState<boolean>(true);
  const [showGradCam, setShowGradCam] = useState<boolean>(true);
  const [gradCamOpacity, setGradCamOpacity] = useState<number>(60);
  const [showReticle, setShowReticle] = useState<boolean>(true);
  const [zoomOD, setZoomOD] = useState<number>(1);
  const [zoomOS, setZoomOS] = useState<number>(1);

  const handleZoom = (delta: number) => {
    if (isSynced) {
      const nextZoom = Math.min(2.5, Math.max(0.75, +(zoomOD + delta).toFixed(2)));
      setZoomOD(nextZoom);
      setZoomOS(nextZoom);
    } else {
      setZoomOD((prev) => Math.min(2.5, Math.max(0.75, +(prev + delta).toFixed(2))));
    }
  };

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 bg-cockpit-bg p-3.5 gap-3">
      {/* Unified Toolbar */}
      <div className="h-9 w-full bg-cockpit-card border border-cockpit-border rounded px-3 flex items-center justify-between text-xs">
        {/* Left: Render Filters */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase">
            Filtro:
          </span>
          <div className="flex items-center gap-1 bg-cockpit-bg/60 p-0.5 rounded border border-cockpit-border">
            {(
              [
                ["rgb", "Color RGB"],
                ["red_free", "Aneritro (RNFL)"],
                ["clahe", "Contraste CLAHE"],
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

        {/* Center: Custom Sober Layer Toggles */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-cockpit-text-dim tracking-wider uppercase mr-1">
            Capas:
          </span>
          {[
            { label: "Disco", active: showDisc, toggle: () => setShowDisc(!showDisc) },
            { label: "Copa", active: showCup, toggle: () => setShowCup(!showCup) },
            { label: "Grad-CAM", active: showGradCam, toggle: () => setShowGradCam(!showGradCam) },
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
              {layer.active ? "✓ " : ""}{layer.label}
            </button>
          ))}
        </div>

        {/* Right: Grad-CAM Opacity Slider, Zoom & Reticle */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="gradcam-slider" className="text-[11px] text-cockpit-text-muted">
              Calor:
            </label>
            <input
              id="gradcam-slider"
              type="range"
              min="0"
              max="100"
              value={gradCamOpacity}
              aria-label="Opacidad de mapa térmico Grad-CAM"
              onChange={(e) => setGradCamOpacity(Number(e.target.value))}
              disabled={!showGradCam}
              className="w-16 h-1 bg-cockpit-border rounded appearance-none cursor-pointer accent-white disabled:opacity-30"
            />
            <span className="font-mono text-[11px] text-cockpit-text w-7 text-right tabular-nums">
              {gradCamOpacity}%
            </span>
          </div>

          <div className="h-3.5 w-[1px] bg-cockpit-border" />

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleZoom(-0.25)}
              aria-label="Reducir zoom"
              className="px-1.5 py-0.5 rounded bg-cockpit-subtle border border-cockpit-border text-cockpit-text text-xs hover:bg-[#25252E]"
            >
              -
            </button>
            <span className="font-mono text-[10px] text-cockpit-text-muted w-9 text-center tabular-nums">
              {(zoomOD * 100).toFixed(0)}%
            </span>
            <button
              onClick={() => handleZoom(0.25)}
              aria-label="Aumentar zoom"
              className="px-1.5 py-0.5 rounded bg-cockpit-subtle border border-cockpit-border text-cockpit-text text-xs hover:bg-[#25252E]"
            >
              +
            </button>
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
          zoomScale={zoomOD}
        />
        <RetinalViewport
          data={os}
          filterMode={filterMode}
          showDisc={showDisc}
          showCup={showCup}
          showGradCam={showGradCam}
          gradCamOpacity={gradCamOpacity}
          showReticle={showReticle}
          zoomScale={isSynced ? zoomOD : zoomOS}
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
  zoomScale: number;
}

function RetinalViewport({
  data,
  filterMode,
  showDisc,
  showCup,
  showGradCam,
  gradCamOpacity,
  showReticle,
  zoomScale,
}: RetinalViewportProps) {
  const isOD = data.eye_side === "OD";
  const isReviewRequired = data.quality.review_required;
  const clinicalPresentation = LABEL_TO_CLINICAL[data.label ?? "Non_Glaucoma"] ?? "Normal";

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
              ? `vCDR ${data.cdr_vertical.toFixed(2)} · ${clinicalPresentation === "Normal" ? "Fisiológico normal" : clinicalPresentation === "Suspect" ? "Excavación límite" : "Glaucomatoso"}`
              : "vCDR no disponible"}
          </span>
        </div>
      </div>

      {/* Retinal Canvas Stage */}
      <div className="relative flex-1 bg-[#060608] flex items-center justify-center overflow-hidden">
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
          className={`relative w-[360px] h-[360px] rounded-full overflow-hidden transition-transform duration-150 ${getFilterClass()}`}
          style={{
            transform: `scale(${zoomScale})`,
            background: "radial-gradient(circle, #3D140B 0%, #240B06 65%, #100403 100%)",
            boxShadow: "inset 0 0 60px rgba(0,0,0,0.85)",
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
      </div>

      {/* Clean Structured Footer */}
      <div className="h-10 px-4 bg-cockpit-surface border-t border-cockpit-border flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-cockpit-text-muted text-[11px]">vCDR:</span>
          <span className={`font-mono font-bold text-[13px] tabular-nums ${getTriageColor()}`}>
            {isReviewRequired ? "--" : data.cdr_vertical != null ? data.cdr_vertical.toFixed(2) : "--"}
          </span>
          <span className="text-[11px] text-cockpit-text-dim">
            · {isReviewRequired ? "Baja fiabilidad" : clinicalPresentation === "Normal" ? "Fisiológico" : "Excavación límite"}
          </span>
        </div>

        <div className="flex items-center gap-2 text-cockpit-text-muted text-[11px] font-mono tabular-nums">
          <span>Copa: {data.calipers?.cup_height_mm ? `${data.calipers.cup_height_mm.toFixed(2)} mm` : "--"}</span>
          <span className="text-cockpit-text-dim">·</span>
          <span>Disco: {data.calipers?.disc_height_mm ? `${data.calipers.disc_height_mm.toFixed(2)} mm` : "--"}</span>
        </div>
      </div>
    </div>
  );
}
