"use client";

import React from "react";
import {
  countFilledFeatures,
  CLINICAL_FEATURE_COUNT,
  type CaptureClinicalValues,
} from "@/types/capture";

interface CaptureClinicalFormProps {
  values: CaptureClinicalValues;
  onChange: (field: keyof CaptureClinicalValues, value: string) => void;
}

export function CaptureClinicalForm({
  values,
  onChange,
}: CaptureClinicalFormProps) {
  const filledCount = countFilledFeatures(values);
  const isComplete = filledCount === CLINICAL_FEATURE_COUNT;
  const progressPercent = Math.min(
    100,
    Math.round((filledCount / CLINICAL_FEATURE_COUNT) * 100),
  );

  return (
    <aside className="w-[440px] xl:w-[480px] shrink-0 bg-cockpit-surface border-l border-cockpit-border flex flex-col justify-between p-5 overflow-y-auto">
      <div className="flex flex-col gap-5">
        {/* Section 1: DATOS DEL PACIENTE */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
              DATOS DEL PACIENTE
            </h2>
            <span className="text-[10px] text-cockpit-text-dim font-mono">
              Obligatorio
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 bg-cockpit-card/40 border border-cockpit-border/60 rounded-md p-3">
            {/* Edad */}
            <div className="flex flex-col gap-1">
              <label htmlFor="input-age" className="text-[10px] text-cockpit-text-muted font-medium">
                Edad
              </label>
              <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                <input
                  id="input-age"
                  type="text"
                  inputMode="numeric"
                  value={values.Age}
                  placeholder="ej. 63"
                  onChange={(e) => onChange("Age", e.target.value)}
                  className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                />
                <span className="text-[9px] text-cockpit-text-dim shrink-0">años</span>
              </div>
            </div>

            {/* Sexo */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-cockpit-text-muted font-medium">
                Sexo
              </span>
              <div className="grid grid-cols-2 gap-1 bg-cockpit-bg p-0.5 border border-cockpit-border rounded h-7 items-center">
                <button
                  type="button"
                  onClick={() => onChange("Gender", "1")}
                  className={`h-full rounded text-[10px] font-medium transition-colors ${
                    values.Gender === "1"
                      ? "bg-cockpit-card text-cockpit-text border border-cockpit-border-subtle shadow-sm"
                      : "text-cockpit-text-dim hover:text-cockpit-text"
                  }`}
                >
                  Masc.
                </button>
                <button
                  type="button"
                  onClick={() => onChange("Gender", "0")}
                  className={`h-full rounded text-[10px] font-medium transition-colors ${
                    values.Gender === "0"
                      ? "bg-cockpit-card text-cockpit-text border border-cockpit-border-subtle shadow-sm"
                      : "text-cockpit-text-dim hover:text-cockpit-text"
                  }`}
                >
                  Fem.
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: REFRACCIÓN Y BIOMETRÍA (11 biomarkers) */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase">
              REFRACCIÓN Y BIOMETRÍA
            </h2>
            <span className="text-[10px] text-cockpit-text-dim font-mono">
              9 biomarcadores
            </span>
          </div>

          <div className="flex flex-col gap-2.5">
            {/* Par 1: Esfera OD y Esfera OS */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="input-dioptre1" className="text-[10px] text-cockpit-text-muted">
                  Esfera OD
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-dioptre1"
                    type="text"
                    value={values.dioptre_1}
                    placeholder="-2.50"
                    onChange={(e) => onChange("dioptre_1", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-3 text-right">D</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="input-dioptre2" className="text-[10px] text-cockpit-text-muted">
                  Esfera OS
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-dioptre2"
                    type="text"
                    value={values.dioptre_2}
                    placeholder="-2.25"
                    onChange={(e) => onChange("dioptre_2", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-3 text-right">D</span>
                </div>
              </div>
            </div>

            {/* Par 2: Astigmatismo y Campo visual DM */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="input-astigmatism" className="text-[10px] text-cockpit-text-muted">
                  Astigmatismo
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-astigmatism"
                    type="text"
                    value={values.astigmatism}
                    placeholder="-0.75"
                    onChange={(e) => onChange("astigmatism", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-3 text-right">D</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="input-vfdm" className="text-[10px] text-cockpit-text-muted">
                  Campo visual · DM
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-vfdm"
                    type="text"
                    value={values.VF_DM}
                    placeholder="-1.8"
                    onChange={(e) => onChange("VF_DM", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-3 text-right">dB</span>
                </div>
              </div>
            </div>

            {/* Par 3: Tonómetros Neumático y Perkins */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="input-pneumatic" className="text-[10px] text-cockpit-text-muted">
                  Tonómetro neumático
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-pneumatic"
                    type="text"
                    value={values.Pneumatic}
                    placeholder="15"
                    onChange={(e) => onChange("Pneumatic", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-7 text-right">mmHg</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="input-perkins" className="text-[10px] text-cockpit-text-muted">
                  Tonómetro Perkins
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-perkins"
                    type="text"
                    value={values.Perkins}
                    placeholder="0"
                    onChange={(e) => onChange("Perkins", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-7 text-right">mmHg</span>
                </div>
              </div>
            </div>

            {/* Par 4: Paquimetría y Longitud Axial */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="input-pachymetry" className="text-[10px] text-cockpit-text-muted">
                  Paquimetría
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-pachymetry"
                    type="text"
                    value={values.Pachymetry}
                    placeholder="542"
                    onChange={(e) => onChange("Pachymetry", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-5 text-right">µm</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="input-axial" className="text-[10px] text-cockpit-text-muted">
                  Longitud axial
                </label>
                <div className="flex items-center gap-1 bg-cockpit-bg border border-cockpit-border rounded px-2 h-7 focus-within:border-cockpit-border-subtle">
                  <input
                    id="input-axial"
                    type="text"
                    value={values.Axial_Length}
                    placeholder="24.1"
                    onChange={(e) => onChange("Axial_Length", e.target.value)}
                    className="w-full text-right font-mono text-[11px] bg-transparent text-cockpit-text focus:outline-none"
                  />
                  <span className="text-[9px] text-cockpit-text-dim w-5 text-right">mm</span>
                </div>
              </div>
            </div>

            {/* Cristalino (Selector de ancho completo) */}
            <div className="flex items-center justify-between pt-1 border-t border-cockpit-border/40">
              <span className="text-[10px] text-cockpit-text-muted">Cristalino</span>
              <div className="flex items-center gap-1 bg-cockpit-bg p-0.5 border border-cockpit-border rounded h-7">
                <button
                  type="button"
                  onClick={() => onChange("Phakic_Pseudophakic", "1")}
                  className={`px-3 py-1 rounded text-[10px] font-medium transition-colors ${
                    values.Phakic_Pseudophakic === "1"
                      ? "bg-cockpit-card text-cockpit-text border border-cockpit-border-subtle shadow-sm"
                      : "text-cockpit-text-dim hover:text-cockpit-text"
                  }`}
                >
                  Fáquico
                </button>
                <button
                  type="button"
                  onClick={() => onChange("Phakic_Pseudophakic", "0")}
                  className={`px-3 py-1 rounded text-[10px] font-medium transition-colors ${
                    values.Phakic_Pseudophakic === "0"
                      ? "bg-cockpit-card text-cockpit-text border border-cockpit-border-subtle shadow-sm"
                      : "text-cockpit-text-dim hover:text-cockpit-text"
                  }`}
                >
                  Pseudofáquico
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section 3: Completeness progress card */}
      <div className="mt-4 p-3.5 bg-cockpit-panel border border-cockpit-border-subtle rounded flex flex-col gap-2">
        <div className="flex items-center justify-between text-[9px] font-bold">
          <span className="text-cockpit-text-dim tracking-wider uppercase">
            CAMPOS DEL MODELO
          </span>
          <span
            className={`font-mono text-[10px] ${
              isComplete ? "text-clinical-green" : "text-[#D4973B]"
            }`}
          >
            {filledCount} / {CLINICAL_FEATURE_COUNT}
          </span>
        </div>
        <div className="h-[3px] w-full bg-cockpit-border rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              isComplete ? "bg-clinical-green" : "bg-[#D4973B]"
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </aside>
  );
}
