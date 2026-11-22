"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ResearchExport } from "@/components/ResearchExport";
import { TopBar } from "@/components/TopBar";
import entry from "@/app/entry.module.css";
import styles from "@/app/research.module.css";

const layers = [
  { id: "retina", label: "Retinografía" },
  { id: "segmentation", label: "Segmentación" },
  { id: "data", label: "Datos" },
] as const;

type Layer = (typeof layers)[number]["id"];

export function ResearchWorkspace({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<Layer>("segmentation");
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const scene = sceneRef.current;
    if (!stage || !scene) return;

    const motion = window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)");

    const resetPerspective = () => {
      scene.style.removeProperty("--pointer-x");
      scene.style.removeProperty("--pointer-y");
    };

    const movePerspective = (event: PointerEvent) => {
      if (!motion.matches || event.pointerType !== "mouse") return;
      const bounds = stage.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      scene.style.setProperty("--pointer-x", `${x * 19}px`);
      scene.style.setProperty("--pointer-y", `${y * 13}px`);
    };

    stage.addEventListener("pointermove", movePerspective, { passive: true });
    stage.addEventListener("pointerleave", resetPerspective);
    motion.addEventListener("change", resetPerspective);
    return () => {
      stage.removeEventListener("pointermove", movePerspective);
      stage.removeEventListener("pointerleave", resetPerspective);
      motion.removeEventListener("change", resetPerspective);
    };
  }, []);

  return (
    <main className={`${entry.entry} ${styles.page}`} data-layer={layer}>
      <TopBar title="Investigación" role="INVESTIGADOR" />
      <div ref={stageRef} className={styles.stage}>
        <div className={styles.lookupArea} onFocus={() => setLayer("retina")}>{children}</div>
        <figure className={styles.example}>
          <figcaption>Ejemplo de análisis</figcaption>
          <div className={styles.layerControls} role="group" aria-label="Capas del análisis de ejemplo">
            {layers.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={layer === id} onClick={() => setLayer(id)}>{label}</button>
            ))}
          </div>
          <div ref={sceneRef} className={styles.scene} aria-hidden="true">
            <div className={styles.registration} />
            <div className={styles.plane} data-plane="retina">
              <Image className={styles.fundus} src="/retina-investigacion.webp" alt="" width={480} height={480} unoptimized />
            </div>
            <div className={styles.plane} data-plane="segmentation">
              <svg className={styles.contours} viewBox="0 0 120 150" fill="none">
                <path d="M60 23 C77 22 89 37 96 56 C103 77 101 96 91 115 C84 130 67 136 54 132 C38 130 24 118 22 101 C17 78 22 58 31 43 C40 29 49 24 60 23Z" stroke="currentColor" strokeWidth="1.6" />
                <path d="M61 48 C70 49 79 56 82 68 C86 81 81 100 74 107 C67 115 55 113 47 105 C40 98 37 89 39 76 C40 64 47 53 55 50Z" stroke="#88deea" strokeWidth="2" />
              </svg>
            </div>
            <div className={styles.plane} data-plane="data">
              <div className={styles.sampleTable}><span>CDR</span><span>vCDR</span><span>Clase</span></div>
            </div>
          </div>
        </figure>
        <div className={styles.connector} aria-hidden="true" />
      </div>
      <ResearchExport layout="strip" onFocus={() => setLayer("data")} />
    </main>
  );
}
