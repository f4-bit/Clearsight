import { CLINICAL_FIELDS, formatClinicalValue } from "@/types/capture";
import type { ClinicalFeatures } from "@/types/clinical";

export function CaptureStudyPanel({ clinical }: { clinical: ClinicalFeatures }) {
  return (
    <aside className="w-full shrink-0 border-t border-cockpit-border bg-cockpit-surface p-5 lg:w-[400px] lg:border-l lg:border-t-0 xl:w-[440px]">
      <h2 className="cockpit-label mb-3">Datos enviados a inferencia</h2>
      <dl className="rounded-md border border-cockpit-border bg-cockpit-card px-3.5 divide-y divide-cockpit-border">
        {CLINICAL_FIELDS.map(({ key, label, unit }) => (
          <div key={key} className="flex min-h-9 items-center justify-between gap-3 py-2 text-xs">
            <dt className="text-cockpit-text-muted">{label}</dt>
            <dd className="text-right font-mono">{formatClinicalValue(key, clinical[key], unit)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
