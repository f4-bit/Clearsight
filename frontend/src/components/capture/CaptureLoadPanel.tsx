"use client";

import React, { useRef } from "react";
import type { EyeSide } from "@/types/clinical";
import {
  CAPTURE_ACCEPTED_FORMATS,
  CAPTURE_EYE_LABELS,
  CAPTURE_EYE_ORDER,
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MIN_SHORTEST_SIDE_PX,
  formatDimension,
  formatFileSize,
  type CaptureAcceptedFormat,
  type CaptureEyeAsset,
  type CaptureEyeSlot,
  type CaptureEyeValidation,
} from "@/types/capture";

interface CaptureLoadPanelProps {
  eyeSlots: Record<EyeSide, CaptureEyeSlot>;
  onEyeSlotChange: (side: EyeSide, slot: CaptureEyeSlot) => void;
}

function detectFormat(file: File): CaptureAcceptedFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg") || file.type === "image/jpeg") {
    return "JPG";
  }
  if (name.endsWith(".png") || file.type === "image/png") {
    return "PNG";
  }
  return null;
}

export function CaptureLoadPanel({
  eyeSlots,
  onEyeSlotChange,
}: CaptureLoadPanelProps) {
  const odFileInputRef = useRef<HTMLInputElement>(null);
  const osFileInputRef = useRef<HTMLInputElement>(null);

  const getFileInputRef = (side: EyeSide) =>
    side === "OD" ? odFileInputRef : osFileInputRef;

  const handleFileProcess = (side: EyeSide, file: File) => {
    const format = detectFormat(file);
    const sizeOk = file.size > 0 && file.size <= CAPTURE_MAX_FILE_BYTES;
    const formatOk = format !== null;

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const minDimension = Math.min(img.width, img.height);
      const resolutionOk = minDimension >= CAPTURE_MIN_SHORTEST_SIDE_PX;

      const validation: CaptureEyeValidation = {
        formatLabel: format,
        formatOk,
        resolutionOk,
        sizeOk,
      };

      const asset: CaptureEyeAsset = {
        fileName: file.name,
        bytes: file.size,
        widthPx: img.width,
        heightPx: img.height,
        previewUrl: objectUrl,
      };

      onEyeSlotChange(side, { asset, validation });
    };

    img.onerror = () => {
      const validation: CaptureEyeValidation = {
        formatLabel: format,
        formatOk: false,
        resolutionOk: false,
        sizeOk,
      };
      const asset: CaptureEyeAsset = {
        fileName: file.name,
        bytes: file.size,
        widthPx: 0,
        heightPx: 0,
        previewUrl: null,
      };
      onEyeSlotChange(side, { asset, validation });
    };

    img.src = objectUrl;
  };

  const handleDrop = (side: EyeSide, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileProcess(side, e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 p-5 overflow-y-auto">
      {/* Header bar matching Frame g1U4Y */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
          CARGA DE RETINOGRAFÍAS
        </span>
        <span className="text-[10px] text-cockpit-text-dim font-normal">
          Un ojo por estudio · mínimo 512 px
        </span>
      </div>

      {/* Bilateral Retinal Dropzones: OD on the LEFT, OS on the RIGHT (AGENTS.md §3.2) */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-[580px]">
        {CAPTURE_EYE_ORDER.map((side) => {
          const slot = eyeSlots[side];
          const isLoaded = slot.asset !== null && slot.validation !== null;
          const isAllValid =
            isLoaded &&
            slot.validation!.formatOk &&
            slot.validation!.resolutionOk &&
            slot.validation!.sizeOk;

          const fileInputRef = getFileInputRef(side);

          return (
            <div
              key={side}
              className="flex flex-col bg-cockpit-card border border-cockpit-border rounded-md p-3"
            >
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFileProcess(side, e.target.files[0]);
                  }
                }}
              />

              {/* Card Header */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
                  {CAPTURE_EYE_LABELS[side]}
                </span>

                {isLoaded ? (
                  <div
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-semibold ${
                      isAllValid
                        ? "bg-[#153B25] border-[#1E5136] text-clinical-green"
                        : "bg-rose-950/40 border-rose-800/60 text-clinical-red"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isAllValid ? "bg-clinical-green" : "bg-clinical-red"
                      }`}
                    />
                    <span>{isAllValid ? "CARGADO" : "INVÁLIDO"}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-cockpit-subtle border border-[#27272A] text-[9px] font-semibold text-zinc-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-cockpit-text-dim" />
                    <span>PENDIENTE</span>
                  </div>
                )}
              </div>

              {/* Card Body: Retinal Viewport (Loaded) OR Dropzone (Empty) */}
              <div
                onDrop={(e) => handleDrop(side, e)}
                onDragOver={handleDragOver}
                className="flex-1 flex flex-col justify-between bg-cockpit-bg border border-cockpit-border rounded min-h-[420px] overflow-hidden"
              >
                {isLoaded && slot.asset ? (
                  <>
                    {/* Retinal Canvas */}
                    <div className="flex-1 flex items-center justify-center bg-[#08080A] relative overflow-hidden p-4">
                      {slot.asset.previewUrl ? (
                        <img
                          src={slot.asset.previewUrl}
                          alt={`Retinografía ${side}`}
                          className="max-h-full max-w-full object-contain rounded"
                        />
                      ) : (
                        /* Anatomical fundus radial ellipse matching cockpit grammar (S14) */
                        <div
                          className="w-[340px] h-[340px] rounded-full shadow-2xl relative flex items-center justify-center"
                          style={{
                            background:
                              "radial-gradient(circle at 45% 50%, #4A1B0E 0%, #301007 35%, #180603 65%, #0B0302 85%, #08080A 100%)",
                          }}
                        >
                          {/* Inner optic disc representation */}
                          <div
                            className={`w-14 h-16 rounded-full absolute opacity-90 shadow-inner ${
                              side === "OD" ? "left-[85px]" : "right-[85px]"
                            }`}
                            style={{
                              background:
                                "radial-gradient(circle at 40% 45%, #F5CE7A 0%, #D89838 50%, #854817 90%)",
                              filter: "blur(1px)",
                            }}
                          >
                            <div className="w-6 h-8 rounded-full bg-[#FFE4A0] opacity-80 m-auto mt-3 blur-[0.5px]" />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* File Meta Row */}
                    <div className="h-9 px-3 bg-cockpit-surface border-t border-cockpit-border flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[10px] font-mono text-cockpit-text truncate max-w-[70%]">
                        <span className="truncate">{slot.asset.fileName}</span>
                        <span className="text-cockpit-text-dim shrink-0">
                          {formatDimension(slot.asset)} · {formatFileSize(slot.asset.bytes)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[10px] text-clinical-sky hover:underline font-medium shrink-0"
                      >
                        Reemplazar
                      </button>
                    </div>
                  </>
                ) : (
                  /* Empty Dropzone State */
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 flex flex-col items-center justify-center cursor-pointer p-6 hover:bg-cockpit-card/40 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-cockpit-subtle border border-cockpit-border flex items-center justify-center mb-3 text-cockpit-text-muted">
                      <svg
                        className="w-5 h-5 text-cockpit-text-dim"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <span className="text-[11px] text-cockpit-text-muted mb-1 text-center font-medium">
                      Arrastrá o seleccioná la retinografía
                    </span>
                    <span className="text-[10px] text-cockpit-text-dim mb-4 text-center">
                      JPG o PNG · desde 512 px
                    </span>
                    <button
                      type="button"
                      className="px-3 py-1 rounded bg-cockpit-subtle border border-[#27272A] text-[10px] font-medium text-cockpit-text hover:bg-cockpit-panel transition-colors"
                    >
                      Elegir archivo
                    </button>
                  </div>
                )}
              </div>

              {/* Card Validations Footer */}
              <div className="mt-3 pt-2 border-t border-cockpit-border flex flex-col gap-1.5 text-[10px]">
                {isLoaded && slot.validation ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          slot.validation.formatOk ? "bg-clinical-green" : "bg-clinical-red"
                        }`}
                      />
                      <span
                        className={
                          slot.validation.formatOk ? "text-cockpit-text-muted" : "text-clinical-red"
                        }
                      >
                        {slot.validation.formatOk
                          ? `Formato compatible · ${slot.validation.formatLabel ?? "JPG"}`
                          : "Formato no compatible (solo JPG o PNG)"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          slot.validation.resolutionOk
                            ? "bg-clinical-green"
                            : "bg-clinical-red"
                        }`}
                      />
                      <span
                        className={
                          slot.validation.resolutionOk
                            ? "text-cockpit-text-muted"
                            : "text-clinical-red"
                        }
                      >
                        {slot.validation.resolutionOk
                          ? `Resolución ${Math.min(
                              slot.asset?.widthPx ?? 0,
                              slot.asset?.heightPx ?? 0,
                            )} px ≥ mínimo 512 px`
                          : "Resolución insuficiente (lado menor < 512 px)"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          slot.validation.sizeOk ? "bg-clinical-green" : "bg-clinical-red"
                        }`}
                      />
                      <span
                        className={
                          slot.validation.sizeOk ? "text-cockpit-text-muted" : "text-clinical-red"
                        }
                      >
                        {slot.validation.sizeOk
                          ? `Peso ${formatFileSize(slot.asset?.bytes ?? 0)} dentro del límite`
                          : "Peso de archivo superior al límite de 20 MB"}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
                      <span className="text-cockpit-text-dim">Sin imagen cargada</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
                      <span className="text-cockpit-text-dim">
                        Formatos aceptados · JPG, PNG
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
