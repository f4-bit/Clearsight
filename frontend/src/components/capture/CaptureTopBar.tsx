"use client";

import Link from "next/link";
import { LogoutButton } from "@/components/Session";

export function CaptureTopBar({ studyId }: { studyId?: string }) {
  return (
    <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-cockpit-border bg-cockpit-surface px-5 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href="/" className="text-base font-bold tracking-tight text-white">ClearSight</Link>
        <h1 className="text-sm font-medium text-cockpit-text-muted">Captura de estudio</h1>
        {studyId && <span className="font-mono text-xs text-cockpit-text-muted">#{studyId.slice(0, 8).toUpperCase()}</span>}
      </div>
      <LogoutButton />
    </header>
  );
}
