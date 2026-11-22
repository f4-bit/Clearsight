"use client";

import {
  CLINICAL_FIELDS,
  CLINICAL_FIELD_GROUPS,
  parseClinicalValue,
  type CaptureClinicalValues,
} from "@/types/capture";

interface CaptureClinicalFormProps {
  values: CaptureClinicalValues;
  validCount: number;
  onChange: (field: keyof CaptureClinicalValues, value: string) => void;
  disabled?: boolean;
}

export function CaptureClinicalForm({ values, validCount, onChange, disabled }: CaptureClinicalFormProps) {
  return (
    <aside className="flex min-w-0 flex-col border-t border-cockpit-border bg-cockpit-surface p-4 lg:border-l lg:border-t-0 xl:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Variables clínicas</h2>
        <span className={`font-mono text-xs ${validCount === CLINICAL_FIELDS.length ? "text-emerald-300" : "text-cockpit-text-muted"}`}>
          {validCount} / {CLINICAL_FIELDS.length} válidas
        </span>
      </div>
      <div className="mb-4 h-0.5 overflow-hidden rounded-full bg-cockpit-border" aria-hidden="true">
        <div className="h-full bg-sky-400/80 motion-safe:transition-[width]" style={{ width: `${(validCount / CLINICAL_FIELDS.length) * 100}%` }} />
      </div>
      <fieldset disabled={disabled} className="grid min-w-0 gap-3">
        {CLINICAL_FIELD_GROUPS.map((group) => (
          <section key={group.label} className="min-w-0 overflow-hidden rounded-md border border-cockpit-border bg-cockpit-card">
            <h3 className="cockpit-label border-b border-cockpit-border bg-cockpit-panel px-3.5 py-2">
              {group.label}
            </h3>
            <div className="divide-y divide-cockpit-border px-3.5">
              {group.fields.map(({ key, label, unit }) => {
                const invalid = values[key] !== "" && parseClinicalValue(key, values[key]) === null;
                return (
                  <label key={key} className="grid min-h-11 grid-cols-[minmax(0,1fr)_6.75rem_2.25rem] items-center gap-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_8rem_2.5rem] sm:gap-3">
                    <span className="text-[13px] leading-snug text-cockpit-text">{label}</span>
                    {key === "Gender" ? (
                      <select className="cockpit-input h-8 min-w-0 px-2 py-0 text-xs" value={values[key]}
                        onChange={(event) => onChange(key, event.target.value)}>
                        <option value="">Seleccionar</option>
                        <option value="0">Femenino</option>
                        <option value="1">Masculino</option>
                      </select>
                    ) : (
                      <input className="cockpit-input h-8 min-w-0 px-2 py-0 text-right font-mono text-xs aria-[invalid=true]:border-rose-500"
                        type="text" inputMode={key === "Age" || key === "Phakic/Pseudophakic" ? "numeric" : "decimal"}
                        aria-invalid={invalid} value={values[key]}
                        placeholder={key === "Phakic/Pseudophakic" ? "0 / 1" : undefined}
                        onChange={(event) => onChange(key, event.target.value)} />
                    )}
                    <span className="font-mono text-[11px] text-cockpit-text-muted">{unit}</span>
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      </fieldset>
      <p className="mt-3 text-xs leading-relaxed text-cockpit-text-muted">
        Estas variables se aplican a los ojos incluidos. Si las mediciones difieren entre ojos, registra un estudio por cada uno.
      </p>
    </aside>
  );
}
