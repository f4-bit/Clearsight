"use client";

import { ImagePlus } from "lucide-react";
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
  const [dragging, setDragging] = useState(false);
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
    <section onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void choose(file);
      }}
      className={`flex min-w-0 flex-col rounded-md border bg-cockpit-card p-3.5 ${compact ? "min-h-[11rem]" : "min-h-[17rem]"} ${dragging ? "border-sky-500" : "border-cockpit-border"}`}>
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="cockpit-label">{CAPTURE_EYE_LABELS[side]}</h2>
        {slot.status === "ready" && <span className="text-[10px] text-emerald-400">VALIDADA</span>}
      </header>
      <input ref={input} className="sr-only" tabIndex={-1} type="file"
        aria-label={`Archivo ${side}`} accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }} />
      <div className="relative grid flex-1 place-items-center overflow-hidden rounded border border-cockpit-border bg-[#08080A]">
        {slot.status === "ready" ? (
          <img className="absolute inset-0 h-full w-full object-contain p-2" src={slot.asset.previewUrl} alt={`Retinografía ${side}`} />
        ) : (
          <div className="grid justify-items-center gap-3 px-3 py-6 text-center">
            <ImagePlus className="h-6 w-6 text-cockpit-text-muted" aria-hidden="true" />
            {slot.status === "invalid" ? (
              <p role="alert" className="text-xs text-rose-300">{slot.message}</p>
            ) : (
              <p className="text-xs text-cockpit-text-muted" role="status">
                {slot.status === "validating" ? "Validando imagen…" : "Arrastra aquí la retinografía"}
              </p>
            )}
            <button type="button" className="cockpit-button" disabled={disabled} onClick={() => input.current?.click()}>Elegir archivo</button>
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="cockpit-label">Carga de retinografías</h2>
        <p className="text-xs text-cockpit-text-muted">Uno o ambos ojos · JPEG/PNG · 512 px por lado · hasta 20 MB</p>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
        {CAPTURE_EYE_ORDER.map((side) => (
          <CaptureEyeDropzone key={side} side={side} slot={eyeSlots[side]} onChange={(slot) => onChange(side, slot)} />
        ))}
      </div>
    </section>
  );
}
