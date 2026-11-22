"use client";

import { ArrowDownToLine, Check, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EyeSide } from "@/types/clinical";
import {
  CAPTURE_EYE_LABELS,
  CAPTURE_EYE_ORDER,
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MIN_SHORTEST_SIDE_PX,
  formatFileSize,
  type CaptureEyeSlot,
  type CaptureEyeSlots,
} from "@/types/capture";
import styles from "./CaptureLoadPanel.module.css";

interface CaptureLoadPanelProps {
  eyeSlots: CaptureEyeSlots;
  onChange: (side: EyeSide, slot: CaptureEyeSlot) => void;
}

async function isJpegOrPng(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg || [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

function readDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = url;
  });
}

export function CaptureEyeDropzone({
  side, slot, onChange, compact = false, disabled = false,
}: {
  side: EyeSide;
  slot: CaptureEyeSlot;
  onChange: (slot: CaptureEyeSlot) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dropActive = dragging && !disabled;
  useEffect(() => () => { selection.current += 1; }, []);

  async function choose(file: File) {
    if (disabled) return;
    const sequence = ++selection.current;
    if (file.size > CAPTURE_MAX_FILE_BYTES) {
      onChange({ status: "invalid", message: "El archivo supera el límite de 20 MB." });
      return;
    }
    onChange({ status: "validating" });
    let previewUrl: string | undefined;
    try {
      if (!await isJpegOrPng(file)) {
        if (sequence === selection.current) onChange({ status: "invalid", message: "Selecciona una imagen JPEG o PNG." });
        return;
      }
      previewUrl = URL.createObjectURL(file);
      const { width, height } = await readDimensions(previewUrl);
      if (sequence !== selection.current) return;
      if (Math.min(width, height) < CAPTURE_MIN_SHORTEST_SIDE_PX) {
        onChange({ status: "invalid", message: "La imagen debe tener al menos 512 px por lado." });
        return;
      }
      onChange({ status: "ready", asset: { file, previewUrl, width, height } });
      previewUrl = undefined;
    } catch {
      if (sequence === selection.current) onChange({ status: "invalid", message: "La imagen está dañada o no se puede leer." });
    } finally {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    }
  }

  return (
    <section aria-label={CAPTURE_EYE_LABELS[side]}
      onDragEnter={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes("Files")) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void choose(file);
      }}
      className={`flex min-w-0 flex-col rounded-lg border bg-cockpit-card p-3 ${compact ? "min-h-[11rem]" : "min-h-[15rem]"} ${dropActive ? "border-sky-800" : "border-cockpit-border"}`}>
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 text-xs font-medium text-cockpit-text">
          <span className="rounded border border-sky-900/75 bg-sky-950/35 px-1.5 py-0.5 font-mono text-[11px] text-sky-200">{side}</span>
          {side === "OD" ? "Ojo derecho" : "Ojo izquierdo"}
        </h3>
        {slot.status === "ready" && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300"><Check size={13} aria-hidden="true" /> Validada</span>}
      </header>
      <input ref={input} className="sr-only" tabIndex={-1} type="file"
        aria-label={`Archivo ${side}`} accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }} />
      <div className={`${styles.viewport} relative grid min-h-[10rem] flex-1 place-items-center overflow-hidden rounded-md border border-cockpit-border`}
        data-dragging={dropActive} data-preview={slot.status === "ready"}>
        {(slot.status !== "ready" || dropActive) && <span aria-hidden="true" className={`${styles.frame} z-10`} />}
        {slot.status === "ready" ? (
          <img className="absolute inset-0 h-full w-full object-contain p-2" src={slot.asset.previewUrl} alt={`Retinografía ${side}`} />
        ) : (
          <div className="grid justify-items-center gap-3 px-3 py-6 text-center">
            <span className="grid size-10 place-items-center rounded-lg border border-sky-900/60 bg-sky-950/35 text-sky-200" aria-hidden="true">
              {dropActive ? <ArrowDownToLine size={20} /> : <ImagePlus size={20} />}
            </span>
            {slot.status === "invalid" ? (
              <p role="alert" className="text-xs text-rose-300">{slot.message}</p>
            ) : (
              <p className="text-xs text-cockpit-text-muted" role="status">
                {slot.status === "validating" ? "Validando imagen…" : dropActive ? "Suelta la retinografía aquí" : "Arrastra aquí la retinografía"}
              </p>
            )}
            <button type="button" className="cockpit-button cockpit-primary" disabled={disabled} onClick={() => input.current?.click()}>Elegir archivo</button>
          </div>
        )}
      </div>
      {slot.status === "ready" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs">
          <span className="min-w-0 truncate font-mono text-cockpit-text-muted">
            {slot.asset.file.name} · {slot.asset.width} × {slot.asset.height} · {formatFileSize(slot.asset.file.size)}
          </span>
          <div className="flex items-center gap-3">
            <button type="button" className="text-sky-400 hover:underline disabled:opacity-50" disabled={disabled} onClick={() => input.current?.click()}>Reemplazar</button>
            <button type="button" className="text-cockpit-text-muted hover:underline disabled:opacity-50" disabled={disabled} onClick={() => {
              selection.current += 1;
              onChange({ status: "empty" });
            }}>Quitar</button>
          </div>
        </div>
      ) : slot.status === "invalid" && (
        <button type="button" className="mt-2 self-end text-xs text-cockpit-text-muted hover:underline"
          disabled={disabled} onClick={() => onChange({ status: "empty" })}>Quitar archivo</button>
      )}
    </section>
  );
}

export function CaptureLoadPanel({ eyeSlots, onChange }: CaptureLoadPanelProps) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Carga de retinografías</h2>
        <p className="text-xs text-cockpit-text-muted">Uno o ambos ojos · JPEG o PNG · mínimo 512 px por lado · hasta 20 MB</p>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
        {CAPTURE_EYE_ORDER.map((side) => (
          <CaptureEyeDropzone key={side} side={side} slot={eyeSlots[side]} onChange={(slot) => onChange(side, slot)} />
        ))}
      </div>
    </section>
  );
}
