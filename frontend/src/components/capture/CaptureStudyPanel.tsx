"use client";

import React from "react";
import type { EyeSide } from "@/types/clinical";
import {
  type CaptureClinicalValues,
  type CaptureEyeSlot,
  type CapturePhase,
} from "@/types/capture";
import { crystalineLabel, genderLabel, MOCK_CONSENSUS } from "@/lib/capture/mockFixtures";

interface CaptureStudyPanelProps {
  phase: CapturePhase;
  clinical: CaptureClinicalValues;
  eyeSlots: Record<EyeSide, CaptureEyeSlot>;
}

export function CaptureStudyPanel({
  phase,
  clinical,
  eyeSlots,
}: CaptureStudyPanelProps) {
  const isCompleted = phase === "completed";

  return (
    <aside className="w-[440px] xl:w-[480px] shrink-0 bg-cockpit-surface border-l border-cockpit-border flex flex-col justify-between p-5 overflow-y-auto">
      <div className="flex flex-col gap-4">
        {/* Section 1: DATOS DEL PACIENTE */}
        <div>
          <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase mb-2.5">
            DATOS DEL PACIENTE
          </h2>
          <div className="grid grid-cols-3 gap-2 p-2.5 bg-cockpit-card/40 border border-cockpit-border/60 rounded text-[10px]">
            <div className="flex flex-col">
              <span className="text-cockpit-text-dim text-[9px]">Edad</span>
              <span className="font-mono text-zinc-300 font-medium">{clinical.Age || "—"} años</span>
            </div>
            <div className="flex flex-col">
              <span className="text-cockpit-text-dim text-[9px]">Sexo</span>
              <span className="text-zinc-300 font-medium">{genderLabel(clinical.Gender)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-cockpit-text-dim text-[9px]">Lateralidad</span>
              <span className="text-zinc-300 font-medium">Bilateral</span>
            </div>
          </div>
        </div>

        <div className="h-[1px] w-full bg-cockpit-border" />

        {/* Section 2: REFRACCIÓN Y BIOMETRÍA (11 biomarkers in 2-column paired layout) */}
        <div>
          <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase mb-2.5">
            REFRACCIÓN Y BIOMETRÍA
          </h2>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Esfera OD</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.dioptre_1 ? `${clinical.dioptre_1} D` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Esfera OS</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.dioptre_2 ? `${clinical.dioptre_2} D` : "—"}
              </span>
            </div>

            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Astigmatismo</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.astigmatism ? `${clinical.astigmatism} D` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Campo visual · DM</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.VF_DM ? `${clinical.VF_DM} dB` : "—"}
              </span>
            </div>

            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Tonómetro neumático</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.Pneumatic ? `${clinical.Pneumatic} mmHg` : "0 mmHg"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Tonómetro Perkins</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.Perkins ? `${clinical.Perkins} mmHg` : "0 mmHg"}
              </span>
            </div>

            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Paquimetría</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.Pachymetry ? `${clinical.Pachymetry} µm` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Longitud axial</span>
              <span className="font-mono text-zinc-300 font-medium">
                {clinical.Axial_Length ? `${clinical.Axial_Length} mm` : "—"}
              </span>
            </div>

            <div className="col-span-2 flex items-center justify-between py-1 border-b border-cockpit-border/40">
              <span className="text-cockpit-text-dim">Cristalino</span>
              <span className="text-zinc-300 font-medium">
                {crystalineLabel(clinical.Phakic_Pseudophakic)}
              </span>
            </div>
          </div>
        </div>

        <div className="h-[1px] w-full bg-cockpit-border" />

        {/* Section 3: ARCHIVOS (shown in Processing) OR DISTRIBUCIÓN (shown in Completed) */}
        {!isCompleted ? (
          <div>
            <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase mb-2">
              ARCHIVOS
            </h2>
            <div className="flex flex-col gap-1.5 text-[10px]">
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    eyeSlots.OD.asset ? "bg-clinical-green" : "bg-zinc-700"
                  }`}
                />
                <span className="font-mono text-[9px] text-cockpit-text-muted truncate">
                  {eyeSlots.OD.asset?.fileName ?? "Sin imagen"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    eyeSlots.OS.asset ? "bg-clinical-green" : "bg-zinc-700"
                  }`}
                />
                <span className="font-mono text-[9px] text-cockpit-text-muted truncate">
                  {eyeSlots.OS.asset?.fileName ?? "Sin imagen"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-[10px] font-bold tracking-wider text-cockpit-text-dim uppercase mb-2.5">
              DISTRIBUCIÓN
            </h2>
            <div className="flex flex-col gap-2.5 text-[10px]">
              {/* Normal */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-cockpit-text-muted">Normal</span>
                  <span className="font-mono text-[10px] text-clinical-green">
                    {Math.round(MOCK_CONSENSUS.probabilities.Non_Glaucoma * 100)}%
                  </span>
                </div>
                <div className="h-1 w-full bg-cockpit-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-clinical-green"
                    style={{
                      width: `${Math.round(
                        MOCK_CONSENSUS.probabilities.Non_Glaucoma * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Sospecha */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-cockpit-text">Sospecha</span>
                  <span className="font-mono text-[10px] font-semibold text-[#D4973B]">
                    {Math.round(
                      MOCK_CONSENSUS.probabilities.Suspicious_Glaucoma * 100,
                    )}%
                  </span>
                </div>
                <div className="h-1 w-full bg-cockpit-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#D4973B]"
                    style={{
                      width: `${Math.round(
                        MOCK_CONSENSUS.probabilities.Suspicious_Glaucoma * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Glaucoma */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-cockpit-text-muted">Glaucoma</span>
                  <span className="font-mono text-[10px] text-clinical-red">
                    {Math.round(MOCK_CONSENSUS.probabilities.Glaucoma * 100)}%
                  </span>
                </div>
                <div className="h-1 w-full bg-cockpit-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-clinical-red"
                    style={{
                      width: `${Math.round(
                        MOCK_CONSENSUS.probabilities.Glaucoma * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Panel Note Footer */}
      <div className="mt-4 pt-3 border-t border-cockpit-border">
        <p className="text-[10px] text-cockpit-text-muted leading-relaxed">
          {!isCompleted
            ? "El procesamiento continúa en el servidor. Puede cerrar esta vista y volver más tarde."
            : "Resultado orientativo. Requiere validación del oftalmólogo antes de incorporarse al entrenamiento."}
        </p>
      </div>
    </aside>
  );
}
