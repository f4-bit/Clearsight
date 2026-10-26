"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CaptureTopBar } from "@/components/capture/CaptureTopBar";
import { CaptureLoadPanel } from "@/components/capture/CaptureLoadPanel";
import { CaptureClinicalForm } from "@/components/capture/CaptureClinicalForm";
import { CaptureProcessingPanel } from "@/components/capture/CaptureProcessingPanel";
import { CaptureStudyPanel } from "@/components/capture/CaptureStudyPanel";
import {
  captureProcessingSnapshot,
  clampElapsed,
  MOCK_TOTAL_PROCESSING_SECONDS,
} from "@/lib/capture/mockStudy";
import {
  createMockClinicalValues,
  createMockEyeSlots,
  genderLabel,
  MOCK_CONSENSUS,
  MOCK_SUBMITTED_STUDY_ID,
} from "@/lib/capture/mockFixtures";
import {
  CAPTURE_EYE_ORDER,
  clinicalValuesAreValid,
  CONSENSUS_LABEL_ES,
  slotIsEyeValid,
  type CaptureClinicalValues,
  type CaptureEyeSlot,
  type CapturePhase,
  type CaptureProcessingSnapshot,
} from "@/types/capture";

function utcTimeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", { timeZone: "UTC" });
}

type CaptureEyeSlotsBySide = Record<"OD" | "OS", CaptureEyeSlot>;

export default function CapturePage() {
  const router = useRouter();
  const [phase, setPhase] = useState<CapturePhase>("draft");
  const [studyId, setStudyId] = useState<string | null>(null);
  const [submittedAtIso, setSubmittedAtIso] = useState<string | null>(null);
  const [eyeSlots, setEyeSlots] = useState<CaptureEyeSlotsBySide>(() =>
    createMockEyeSlots(),
  );
  const [clinical, setClinical] = useState<CaptureClinicalValues>(() =>
    createMockClinicalValues(),
  );
  const [snapshot, setSnapshot] = useState<CaptureProcessingSnapshot | null>(null);
  const completionHandledRef = useRef(false);

  const validEyeCount = useMemo(
    () =>
      CAPTURE_EYE_ORDER.filter((side) => {
        const slot = eyeSlots[side];
        return slotIsEyeValid(slot);
      }).length,
    [eyeSlots],
  );

  /** Submit gate: every contract biomarker must be present and parseable. */
  const clinicalReady = useMemo(
    () => clinicalValuesAreValid(clinical),
    [clinical],
  );

  const startedAtMs = submittedAtIso
    ? new Date(submittedAtIso).getTime()
    : null;

  useEffect(() => {
    if (phase !== "processing" || startedAtMs === null) return;

    const tick = window.setInterval(() => {
      const elapsed = clampElapsed((Date.now() - startedAtMs) / 1000);
      const nextSnapshot = captureProcessingSnapshot(elapsed);
      setSnapshot(nextSnapshot);

      if (nextSnapshot.finished && !completionHandledRef.current) {
        completionHandledRef.current = true;
        setPhase("completed");
        window.clearInterval(tick);
      }
    }, 250);

    return () => window.clearInterval(tick);
  }, [phase, startedAtMs]);

  const handleCancelDraft = () => {
    setEyeSlots(createMockEyeSlots());
    setSubmittedAtIso(null);
  };

  const handleSubmitStudy = () => {
    if (validEyeCount === 0 || !clinicalReady) return;
    const submittedAt = new Date().toISOString();
    setStudyId(MOCK_SUBMITTED_STUDY_ID);
    setSubmittedAtIso(submittedAt);
    setSnapshot(captureProcessingSnapshot(0));
    setPhase("processing");
  };

  const handleCancelProcessing = () => {
    completionHandledRef.current = false;
    setSnapshot(null);
    setSubmittedAtIso(null);
    setStudyId(null);
    setPhase("draft");
  };

  const handleHideProcessing = () => {
    router.push("/");
  };

  const handleNewStudy = () => {
    completionHandledRef.current = false;
    setEyeSlots(createMockEyeSlots());
    setClinical(createMockClinicalValues());
    setSubmittedAtIso(null);
    setStudyId(null);
    setSnapshot(null);
    setPhase("draft");
  };

  const remainingSeconds = Math.max(
    0,
    Math.ceil(MOCK_TOTAL_PROCESSING_SECONDS - (snapshot?.elapsedSeconds ?? 0)),
  );

  const pillText =
    phase === "draft"
      ? `${validEyeCount} de 2 ojos cargados`
      : phase === "processing"
        ? `Procesando · ${snapshot?.activeStageLabel ?? "iniciando"}`
        : `${CONSENSUS_LABEL_ES[MOCK_CONSENSUS.label]} (${(MOCK_CONSENSUS.confidence * 100).toFixed(0)}% probabilidad)`;

  return (
    <main className="h-screen w-screen flex flex-col bg-cockpit-bg text-cockpit-text overflow-hidden">
      <CaptureTopBar
        phase={phase}
        studyIdLabel={studyId ?? "PENDIENTE"}
        scopeLabel={
          studyId
            ? `${clinical.Age} años · ${genderLabel(clinical.Gender)} · Bilateral`
            : "Carga bilateral"
        }
        timeLabel={utcTimeLabel(submittedAtIso ?? new Date().toISOString())}
        pillText={pillText}
        actionLabel={
          phase === "draft" ? "Cancelar" : phase === "processing" ? "Ocultar" : "Ir a la cola"
        }
        onAction={
          phase === "draft"
            ? handleCancelDraft
            : phase === "processing"
              ? handleHideProcessing
              : () => router.push("/")
        }
      />

      {/* Main workspace: per-phase body on the left, summary panel on the right */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {phase === "draft" ? (
          <>
            <CaptureLoadPanel
              eyeSlots={eyeSlots}
              onEyeSlotChange={(side, slot) =>
                setEyeSlots((prev) => ({ ...prev, [side]: slot }))
              }
            />
            <CaptureClinicalForm
              values={clinical}
              onChange={(field, value) =>
                setClinical((prev) => ({ ...prev, [field]: value }))
              }
            />
          </>
        ) : phase === "processing" ? (
          <>
            <CaptureProcessingPanel
              snapshot={snapshot ?? captureProcessingSnapshot(0)}
              eyeSlots={eyeSlots}
            />
            <CaptureStudyPanel
              phase="processing"
              clinical={clinical}
              eyeSlots={eyeSlots}
            />
          </>
        ) : (
          <section className="flex-1 min-w-0 flex flex-col px-5 py-4 overflow-hidden">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-cockpit-text-dim">
              <span>Estudio completado</span>
              <span className="font-normal font-mono">
                Finalizado {MOCK_CONSENSUS.elapsedSeconds.toFixed(1)} s
              </span>
            </div>
          </section>
        )}
      </div>

      {/* Footer action bar */}
      <footer className="h-12 w-full bg-cockpit-surface border-t border-cockpit-border px-5 flex items-center justify-between">
        <span className="text-[11px] text-cockpit-text-muted">
          {phase === "draft" &&
            "Se requiere al menos un ojo. El estudio entra en la cola al enviarse y podés seguir trabajando."}
          {phase === "processing" &&
            `Tiempo estimado restante: ${remainingSeconds} s · El estudio queda en la cola si salís de esta pantalla.`}
          {phase === "completed" &&
            "El estudio queda disponible en el historial y en la cola de validación."}
        </span>
        <div className="flex items-center gap-3">
          {phase === "draft" && (
            <>
              <button
                disabled
                title="No disponible en esta versión"
                className="px-3 py-1 rounded text-[11px] font-medium bg-cockpit-panel border border-cockpit-border-subtle text-zinc-400 opacity-50 cursor-not-allowed"
              >
                Guardar borrador
              </button>
              <button
                onClick={handleSubmitStudy}
                disabled={validEyeCount === 0 || !clinicalReady}
                title={
                  validEyeCount === 0
                    ? "Se requiere al menos un ojo"
                    : !clinicalReady
                      ? "Completá los 11 campos del modelo"
                      : undefined
                }
                className="px-3 py-1 rounded text-[11px] font-semibold bg-clinical-action-light hover:bg-white text-clinical-action-on-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Enviar estudio
              </button>
            </>
          )}
          {phase === "processing" && (
            <>
              <button
                onClick={handleCancelProcessing}
                className="px-3 py-1 rounded text-[11px] font-medium bg-cockpit-panel border border-cockpit-border-subtle text-zinc-400 hover:bg-cockpit-card transition-colors"
              >
                Cancelar estudio
              </button>
              <button
                disabled
                title="No disponible en esta versión"
                className="px-3 py-1 rounded text-[11px] font-semibold bg-clinical-action-light text-clinical-action-on-light opacity-50 cursor-not-allowed"
              >
                Ir a la cola de estudios
              </button>
            </>
          )}
          {phase === "completed" && (
            <>
              <button
                onClick={handleNewStudy}
                className="px-3 py-1 rounded text-[11px] font-medium bg-cockpit-panel border border-cockpit-border-subtle text-zinc-400 hover:bg-cockpit-card transition-colors"
              >
                Nuevo estudio
              </button>
              <button
                onClick={() => router.push("/")}
                className="px-3 py-1 rounded text-[11px] font-semibold bg-clinical-action-light hover:bg-white text-clinical-action-on-light transition-colors"
              >
                Ver estudio en el cockpit
              </button>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}
