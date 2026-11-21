"use client";

import { useEffect, useState, type FormEvent } from "react";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { ApiError, api, errorMessage, jsonBody } from "@/lib/api";
import type { AdminUser, Page, UserRole } from "@/types/api";

const roles: ReadonlyArray<{ value: UserRole; label: string }> = [
  { value: "OFTALMOLOGO", label: "Oftalmólogo" },
  { value: "INVESTIGADOR", label: "Investigador" },
  { value: "ADMIN", label: "Administrador" },
];
const PAGE_SIZE = 20;

type UserEditorState = { mode: "create" } | { mode: "edit"; user: AdminUser };

export default function UsersPage() {
  return <SessionGate role="ADMIN">{() => <UsersWorkspace />}</SessionGate>;
}

function UsersWorkspace() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ q: "", role: "", active: "", offset: 0 });
  const [result, setResult] = useState<Page<AdminUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<UserEditorState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(filters.offset) });
    if (filters.q) params.set("q", filters.q);
    if (filters.role) params.set("role", filters.role);
    if (filters.active) params.set("isActive", filters.active);
    setLoading(true);
    setError("");
    api<Page<AdminUser>>(`/admin/users?${params}`, { signal: controller.signal }).then(
      (page) => { if (!controller.signal.aborted) setResult(page); },
      (failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(failure));
          setResult(null);
        }
      },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, reload]);

  return (
    <main className="min-h-screen">
      <TopBar title="Administración de usuarios" role="ADMIN" />
      <div className="mx-auto grid w-full max-w-6xl gap-4 p-5">
        <form className="flex flex-wrap items-end gap-3 rounded-md border border-cockpit-border bg-cockpit-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters((previous) => ({ ...previous, q: query.trim(), offset: 0 }));
          }}>
          <label className="grid flex-1 min-w-[11rem] gap-1">
            <span className="cockpit-label">Nombre o correo</span>
            <input className="cockpit-input" value={query} maxLength={255} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button className="cockpit-button" type="submit">Buscar</button>
          <label className="grid gap-1">
            <span className="cockpit-label">Rol</span>
            <select className="cockpit-input" value={filters.role}
              onChange={(event) => setFilters({ ...filters, role: event.target.value, offset: 0 })}>
              <option value="">Todos</option>
              {roles.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="cockpit-label">Estado</span>
            <select className="cockpit-input" value={filters.active}
              onChange={(event) => setFilters({ ...filters, active: event.target.value, offset: 0 })}>
              <option value="">Todos</option>
              <option value="true">Activos</option>
              <option value="false">Desactivados</option>
            </select>
          </label>
          <button type="button" className="cockpit-button cockpit-primary"
            onClick={() => { setMessage(""); setEditor({ mode: "create" }); }}>Crear usuario</button>
        </form>
        {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
        {error && <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-amber-300">{error}</p>
          <button type="button" className="cockpit-button" onClick={() => setReload((value) => value + 1)}>Reintentar</button>
        </div>}
        {editor && <UserEditor key={editor.mode === "edit" ? editor.user.id : "create"} editor={editor}
          onClose={() => setEditor(null)} onSaved={(created) => {
            setEditor(null);
            setMessage(created ? "Usuario creado." : "Cuenta actualizada.");
            setReload((value) => value + 1);
          }} />}
        <section className="overflow-x-auto rounded-md border border-cockpit-border bg-cockpit-card">
          <table className="w-full min-w-[35rem] text-left text-sm">
            <thead className="border-b border-cockpit-border">
              <tr>{["Usuario", "Correo", "Rol", "Estado", "Acción"].map((name) => (
                <th key={name} scope="col" className="cockpit-label p-3">{name}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-cockpit-border">
              {result?.items.map((user) => (
                <tr key={user.id}>
                  <td className="p-3">{user.fullName}</td>
                  <td className="p-3 text-cockpit-text-muted">{user.email}</td>
                  <td className="p-3 text-xs">{roles.find(({ value }) => value === user.role)?.label}</td>
                  <td className={`p-3 text-xs ${user.isActive ? "text-emerald-400" : "text-cockpit-text-muted"}`}>
                    {user.isActive ? "Activo" : "Desactivado"}
                  </td>
                  <td className="p-3"><button type="button" className="cockpit-button py-1" disabled={loading}
                    onClick={() => { setMessage(""); setEditor({ mode: "edit", user }); }}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(loading || result?.items.length === 0) && <p role="status" className="p-3 text-xs text-cockpit-text-muted">
            {loading ? "Cargando cuentas…" : "No hay cuentas con estos filtros."}
          </p>}
        </section>
        {result && <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-xs text-cockpit-text-muted">{result.total} cuentas</span>
          <div className="flex gap-2">
            <button type="button" className="cockpit-button" disabled={loading || filters.offset === 0}
              onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - PAGE_SIZE) })}>Anterior</button>
            <button type="button" className="cockpit-button" disabled={loading || filters.offset + PAGE_SIZE >= result.total}
              onClick={() => setFilters({ ...filters, offset: filters.offset + PAGE_SIZE })}>Siguiente</button>
          </div>
        </div>}
      </div>
    </main>
  );
}

function UserEditor({ editor, onClose, onSaved }: {
  editor: UserEditorState;
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const user = editor.mode === "edit" ? editor.user : null;
  const [fullName, setName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<UserRole>(user?.role ?? "OFTALMOLOGO");
  const [isActive, setActive] = useState(user?.isActive ?? true);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = fullName.trim();
  const changed = !user || cleanName !== user.fullName || cleanEmail !== user.email || role !== user.role || isActive !== user.isActive;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || pending || !cleanName) return;
    setError("");
    if (!user && (Array.from(password).length < 12 || new TextEncoder().encode(password).length > 72)) {
      setError("Usa al menos 12 caracteres y un máximo de 72 bytes.");
      return;
    }
    setPending(true);
    try {
      if (user) {
        const body = {
          ...(cleanName !== user.fullName ? { fullName: cleanName } : {}),
          ...(cleanEmail !== user.email ? { email: cleanEmail } : {}),
          ...(role !== user.role ? { role } : {}),
          ...(isActive !== user.isActive ? { isActive } : {}),
        };
        await api<AdminUser>(`/admin/users/${user.id}`, { method: "PATCH", ...jsonBody(body) });
      } else {
        await api<AdminUser>("/admin/users", {
          method: "POST", ...jsonBody({ fullName: cleanName, email: cleanEmail, password, role }),
        });
      }
      onSaved(!user);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409
        ? "El correo ya está en uso o el cambio dejaría al sistema sin administradores activos."
        : errorMessage(failure));
    } finally {
      setPending(false);
      setPassword("");
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-md border border-cockpit-border bg-cockpit-surface p-4">
      <h2 className="text-sm font-semibold">{user ? "Editar usuario" : "Crear usuario"}</h2>
      <fieldset disabled={pending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="grid gap-1"><span className="cockpit-label">Nombre completo</span>
          <input className="cockpit-input" required maxLength={255} value={fullName} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="grid gap-1"><span className="cockpit-label">Correo</span>
          <input className="cockpit-input" type="email" required maxLength={255} value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="grid gap-1"><span className="cockpit-label">Rol</span>
          <select className="cockpit-input" value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
            {roles.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {user ? <label className="flex items-center gap-2 self-end py-2 text-xs">
          <input type="checkbox" className="accent-sky-500" checked={isActive} onChange={(event) => setActive(event.target.checked)} /> Activo
        </label> : <label className="grid gap-1"><span className="cockpit-label">Contraseña inicial</span>
          <input className="cockpit-input" autoComplete="new-password" type="password" required value={password}
            onChange={(event) => setPassword(event.target.value)} />
        </label>}
      </fieldset>
      {user && (isActive !== user.isActive || role !== user.role || cleanEmail !== user.email) && (
        <p className="text-xs text-amber-300">Este cambio revoca las sesiones de la cuenta.</p>
      )}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="cockpit-button" disabled={pending} onClick={onClose}>Cancelar</button>
        <button className="cockpit-button cockpit-primary" disabled={pending || !changed || !cleanName}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </form>
  );
}
