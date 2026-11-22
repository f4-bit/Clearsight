"use client";

import { useEffect, useRef } from "react";

export function StationGridEffect({ cellSize, className }: { cellSize: number; className: string }) {
  const linesRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const lines = linesRef.current;
    const station = lines?.closest("main");
    if (!lines || !station) return;

    const motion = window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)");
    let active: "a" | "b" = "b";
    let previousX = -1;
    let previousY = -1;

    function leave() {
      if (lines) delete lines.dataset.gridHover;
      previousX = previousY = -1;
    }

    function move(event: PointerEvent) {
      if (!lines || !motion.matches || event.pointerType !== "mouse" ||
          (event.target instanceof Element && event.target.closest("a, form, header"))) {
        leave();
        return;
      }

      const bounds = lines.getBoundingClientRect();
      const x = Math.floor((event.clientX - bounds.left) / cellSize) * cellSize;
      const y = Math.floor((event.clientY - bounds.top) / cellSize) * cellSize;
      if (x === previousX && y === previousY) return;

      active = active === "a" ? "b" : "a";
      previousX = x;
      previousY = y;
      lines.style.setProperty(`--grid-x-${active}`, `${x}px`);
      lines.style.setProperty(`--grid-y-${active}`, `${y}px`);
      lines.dataset.gridHover = active;
    }

    station.addEventListener("pointermove", move, { passive: true });
    station.addEventListener("pointerleave", leave);
    motion.addEventListener("change", leave);
    return () => {
      station.removeEventListener("pointermove", move);
      station.removeEventListener("pointerleave", leave);
      motion.removeEventListener("change", leave);
      leave();
    };
  }, [cellSize]);

  return <span ref={linesRef} className={className} aria-hidden="true" />;
}
