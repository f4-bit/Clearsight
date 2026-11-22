import { CLINICAL_FIELD_GROUPS, formatClinicalValue } from "@/types/capture";
import type { ClinicalFeatures } from "@/types/clinical";

type ClinicalValuesData = Partial<Record<keyof ClinicalFeatures, unknown>> & {
  Phakic_Pseudophakic?: unknown;
};

export function ClinicalValues({ values, stretch = false, compact = false }: {
  values: ClinicalValuesData;
  stretch?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`grid items-start ${compact ? "gap-2" : "gap-3"} ${stretch ? "xl:grid-cols-2" : ""}`}>
      {CLINICAL_FIELD_GROUPS.map(({ label, fields }) => (
        <section key={label} className="min-w-0 overflow-hidden rounded-md border border-cockpit-border bg-cockpit-card">
          <h3 className={`cockpit-label border-b border-cockpit-border bg-cockpit-panel px-3.5 ${compact ? "py-1.5" : "py-2"}`}>{label}</h3>
          <dl className="divide-y divide-cockpit-border px-3.5">
            {fields.map((field) => (
              <div key={field.key} className={`flex items-center justify-between gap-3 py-1.5 text-xs ${compact ? "min-h-8" : "min-h-9"}`}>
                <dt className="text-cockpit-text-muted">{field.label}</dt>
                <dd className="shrink-0 text-right font-mono">{formatClinicalValue(
                  field.key,
                  values[field.key] ?? (field.key === "Phakic/Pseudophakic" ? values.Phakic_Pseudophakic : undefined),
                  field.unit,
                )}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
