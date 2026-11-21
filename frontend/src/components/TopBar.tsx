import Link from "next/link";
import { LogoutButton } from "@/components/Session";
import type { UserRole } from "@/types/api";

export function TopBar({ title, role, reference }: {
  title: string;
  role: UserRole;
  reference?: string;
}) {
  return (
    <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-cockpit-border bg-cockpit-surface px-5 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href="/" className="text-base font-bold tracking-tight text-white">ClearSight</Link>
        <h1 className="text-sm font-medium text-cockpit-text-muted">{title}</h1>
        {reference && <span className="font-mono text-xs text-cockpit-text-muted">#{reference.slice(0, 8).toUpperCase()}</span>}
      </div>
      <nav className="flex flex-wrap items-center gap-2" aria-label="Navegación principal">
        {role === "OFTALMOLOGO" && <Link href="/capture" className="cockpit-button cockpit-primary">Nueva captura</Link>}
        {role === "ADMIN" && <Link href="/admin/users" className="cockpit-button">Usuarios</Link>}
        <LogoutButton />
      </nav>
    </header>
  );
}
