import type { EyeExecution } from "@/types/api";
import { CAPTURE_EYE_LABELS, CAPTURE_EYE_ORDER, type CaptureEyeSlots } from "@/types/capture";
import { CLASS_COLORS, CLASS_LABELS, formatCdr } from "@/types/clinical";

export function CaptureCompletedPanel({ eyeSlots, executions }: {
  eyeSlots: CaptureEyeSlots;
  executions: EyeExecution[];
}) {
  return (
    <div className="grid min-h-[18rem] flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
      {CAPTURE_EYE_ORDER.map((side) => {
        const slot = eyeSlots[side];
        const result = executions.find((eye) => eye.side === side)?.result;
        const diagnostic = result?.status === "COMPLETED" ? result.predictedClass : null;
        const label = diagnostic != null ? CLASS_LABELS[diagnostic] : null;
        return (
          <section key={side} className="flex min-h-[15rem] min-w-0 flex-col rounded-md border border-cockpit-border bg-cockpit-card p-3.5">
            <header className="mb-2.5 flex items-center justify-between gap-2">
              <h2 className="cockpit-label">{CAPTURE_EYE_LABELS[side]}</h2>
              {label && diagnostic != null && (
                <span className={`rounded border px-2 py-1 text-[10px] font-medium ${CLASS_COLORS[diagnostic]}`}>{label}</span>
              )}
            </header>
            <div className="relative grid min-h-[10rem] flex-1 place-items-center rounded border border-cockpit-border bg-[#08080A]">
              {slot.status === "ready" ? (
                <img src={slot.asset.previewUrl} alt={`Retinografía ${side}`}
                  className="absolute inset-0 h-full w-full object-contain p-2" />
              ) : <span className="text-xs text-cockpit-text-muted">Ojo sin retinografía</span>}
            </div>
            <p className="mt-2 flex min-h-5 items-center justify-between text-xs text-cockpit-text-muted">
              {result?.delivery.reviewRequired ? <span className="text-amber-300">Revisión requerida</span>
                : result?.delivery.failed ? <span className="text-rose-300">Error en análisis o publicación</span>
                : label ? <span>Predicción multimodal</span>
                : slot.status === "ready" ? <span>En espera de resultado</span> : null}
              {label && result?.confidence != null && (
                <span className="font-mono">{(result.confidence * 100).toFixed(1)}%</span>
              )}
            </p>
            {result?.status === "COMPLETED" && !result.delivery.reviewRequired && result.cdrVertical != null && (
              <p className="mt-1 border-t border-cockpit-border pt-2 text-xs text-cockpit-text-muted">
                vCDR vertical <span className="ml-1 font-mono text-cockpit-text">{formatCdr(result.cdrVertical)}</span>
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
