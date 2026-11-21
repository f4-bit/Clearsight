"use client";

import {
  CLINICAL_FIELDS,
  parseClinicalValue,
  type CaptureClinicalValues,
} from "@/types/capture";

interface CaptureClinicalFormProps {
  values: CaptureClinicalValues;
  onChange: (field: keyof CaptureClinicalValues, value: string) => void;
  disabled?: boolean;
}

export function CaptureClinicalForm({ values, onChange, disabled }: CaptureClinicalFormProps) {
  const validCount = CLINICAL_FIELDS.filter(({ key }) => parseClinicalValue(key, values[key]) !== null).length;

  return (
    <aside className="w-full lg:w-[400px] xl:w-[440px] shrink-0 bg-cockpit-surface border-t lg:border-t-0 lg:border-l border-cockpit-border p-5 overflow-y-auto">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="cockpit-label">Variables clínicas</h2>
        <span className="font-mono text-xs text-cockpit-text-muted">{validCount} / {CLINICAL_FIELDS.length}</span>
      </div>
      <fieldset disabled={disabled} className="divide-y divide-cockpit-border rounded-md border border-cockpit-border bg-cockpit-card px-3.5">
        {CLINICAL_FIELDS.map(({ key, label, unit }) => {
          const invalid = values[key] !== "" && parseClinicalValue(key, values[key]) === null;
          return (
            <label key={key} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
              <span className="text-xs text-cockpit-text-muted">{label}</span>
              <span className="flex shrink-0 items-center gap-2">
                {key === "Gender" ? (
                  <select className="cockpit-input h-7 py-0 text-xs" value={values[key]}
                    onChange={(event) => onChange(key, event.target.value)}>
                    <option value="">Seleccionar</option>
                    <option value="0">Femenino</option>
                    <option value="1">Masculino</option>
                  </select>
                ) : (
                  <input className="cockpit-input h-7 w-[5.5rem] py-0 text-right font-mono text-xs aria-[invalid=true]:border-rose-600"
                    type="text" inputMode={key === "Age" || key === "Phakic/Pseudophakic" ? "numeric" : "decimal"}
                    aria-invalid={invalid} value={values[key]}
                    placeholder={key === "Phakic/Pseudophakic" ? "0 / 1" : undefined}
                    onChange={(event) => onChange(key, event.target.value)} />
                )}
                {unit && <span className="w-8 text-right text-[10px] text-cockpit-text-muted">{unit}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="mt-3 text-xs text-cockpit-text-muted">
        El mismo vector clínico se aplica a los ojos incluidos. Registra estudios por separado si las mediciones difieren entre ojos.
      </p>
    </aside>
  );
}
