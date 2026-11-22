"use client";

import { ClipboardList, X } from "lucide-react";
import { useRef } from "react";
import { ClinicalValues } from "@/components/ClinicalValues";
import { CLINICAL_FIELDS } from "@/types/capture";
import type { ClinicalFeatures } from "@/types/clinical";
import styles from "./CaptureProcessingPanel.module.css";

export function CaptureStudyPanel({ clinical }: { clinical: ClinicalFeatures }) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className={styles.variablesButton}
        aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
        <ClipboardList size={17} aria-hidden="true" /> Variables clínicas registradas
      </button>
      <dialog ref={dialog} className={styles.variablesDialog} aria-labelledby="study-variables-title"
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <div>
              <h2 id="study-variables-title">Variables clínicas registradas</h2>
              <p className="font-mono">{CLINICAL_FIELDS.length} variables</p>
            </div>
            <form method="dialog">
              <button type="submit" className={styles.dialogClose} aria-label="Cerrar variables clínicas" autoFocus>
                <X size={18} aria-hidden="true" />
              </button>
            </form>
          </header>
          <div className={styles.dialogValues}>
            <ClinicalValues values={clinical} />
          </div>
        </div>
      </dialog>
    </>
  );
}
