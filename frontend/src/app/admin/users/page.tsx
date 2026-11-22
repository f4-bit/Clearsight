"use client";

import "@fontsource-variable/space-grotesk";
import { Pencil, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SessionGate } from "@/components/Session";
import { TopBar } from "@/components/TopBar";
import { ApiError, api, errorMessage, jsonBody } from "@/lib/api";
import type { AdminUser, Page, UserRole } from "@/types/api";
import entry from "@/app/entry.module.css";
import styles from "./users.module.css";

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
      (page) => {
        if (controller.signal.aborted) return;
        const lastOffset = Math.max(0, Math.ceil(page.total / PAGE_SIZE) - 1) * PAGE_SIZE;
        if (filters.offset > lastOffset) {
          setFilters((current) => current === filters ? { ...current, offset: lastOffset } : current);
          return;
        }
        setResult(page);
      },
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
    <main className={`${entry.entry} ${styles.page}`}>
      <TopBar title="Administración de usuarios" role="ADMIN" />
      <div className={styles.workspace}>
        <div className={styles.heading}>
          <h2 id="users-heading">Usuarios y permisos</h2>
          <button type="button" className={styles.primary} onClick={() => { setMessage(""); setEditor({ mode: "create" }); }}>
            <Plus size={16} aria-hidden="true" /> Crear usuario
          </button>
        </div>
        {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
        {error && <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-amber-300">{error}</p>
          <button type="button" className="cockpit-button" onClick={() => setReload((value) => value + 1)}>Reintentar</button>
        </div>}
        <section className={styles.directory} aria-labelledby="users-heading">
          <form className={styles.filters} aria-label="Filtrar cuentas"
            onSubmit={(event) => {
              event.preventDefault();
              setFilters((previous) => ({ ...previous, q: query.trim(), offset: 0 }));
            }}>
            <div className={styles.search}>
              <label className={styles.label} htmlFor="users-query">Nombre o correo</label>
              <div className={styles.searchField}>
                <input id="users-query" className={`cockpit-input ${styles.input}`} type="search" value={query} maxLength={255}
                  onChange={(event) => setQuery(event.target.value)} />
                <button className={`${styles.secondary} ${styles.searchButton}`} type="submit"><Search size={15} aria-hidden="true" /> Buscar</button>
              </div>
            </div>
            <div className={styles.selects}>
              <label className={styles.field}>
                <span className={styles.label}>Rol</span>
                <select className={`cockpit-input ${styles.input}`} value={filters.role}
                  onChange={(event) => setFilters({ ...filters, role: event.target.value, offset: 0 })}>
                  <option value="">Todos</option>
                  {roles.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Estado</span>
                <select className={`cockpit-input ${styles.input}`} value={filters.active}
                  onChange={(event) => setFilters({ ...filters, active: event.target.value, offset: 0 })}>
                  <option value="">Todos</option>
                  <option value="true">Activos</option>
                  <option value="false">Desactivados</option>
                </select>
              </label>
            </div>
          </form>
          <table className={styles.table} aria-busy={loading}>
            <thead>
              <tr>
                <th scope="col">Cuenta</th>
                <th scope="col" className={styles.roleColumn}>Rol</th>
                <th scope="col" className={styles.stateColumn}>Estado</th>
                <th scope="col" className={styles.actionColumn}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {result?.items.map((user) => {
                const role = roles.find(({ value }) => value === user.role)?.label;
                return (
                  <tr key={user.id}>
                    <td>
                      <span className={styles.accountName}>{user.fullName}</span>
                      <span className={styles.accountEmail}>{user.email}</span>
                      <span className={styles.mobileRole}>{role}</span>
                    </td>
                    <td className={styles.roleColumn}>{role}</td>
                    <td className={styles.stateColumn}>
                      <span className={styles.state} data-active={user.isActive}>{user.isActive ? "Activo" : "Desactivado"}</span>
                    </td>
                    <td className={styles.actionColumn}>
                      <button type="button" className={`${styles.secondary} ${styles.edit}`} disabled={loading}
                        aria-label={`Editar ${user.fullName}`} onClick={() => { setMessage(""); setEditor({ mode: "edit", user }); }}>
                        <Pencil size={14} aria-hidden="true" /> Editar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(loading || result?.items.length === 0) && <p role="status" className={styles.tableStatus}>
            {loading ? "Cargando cuentas…" : "No hay cuentas con estos filtros."}
          </p>}
          {result && <div className={styles.directoryFooter}>
            <span className="font-mono">{result.total === 1 ? "1 cuenta" : `${result.total} cuentas`}</span>
            {result.total > PAGE_SIZE && <nav aria-label="Páginas de cuentas" className={styles.pagination}>
              <button type="button" className={styles.secondary} disabled={loading || filters.offset === 0}
                onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - PAGE_SIZE) })}>Anterior</button>
              <button type="button" className={styles.secondary} disabled={loading || filters.offset + PAGE_SIZE >= result.total}
                onClick={() => setFilters({ ...filters, offset: filters.offset + PAGE_SIZE })}>Siguiente</button>
            </nav>}
          </div>}
        </section>
      </div>
      {editor && <UserEditor key={editor.mode === "edit" ? editor.user.id : "create"} editor={editor}
        onClose={() => setEditor(null)} onSaved={(created) => {
          setEditor(null);
          setMessage(created ? "Usuario creado." : "Cuenta actualizada.");
          setReload((value) => value + 1);
        }} />}
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = fullName.trim();
  const changed = !user || cleanName !== user.fullName || cleanEmail !== user.email || role !== user.role || isActive !== user.isActive;
  const revokesSessions = user && (isActive !== user.isActive || role !== user.role || cleanEmail !== user.email);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    nameRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  function cancel() {
    if (pending) return;
    dialogRef.current?.close();
    onClose();
  }

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
      dialogRef.current?.close();
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
    <dialog ref={dialogRef} className={styles.drawer} aria-labelledby="user-editor-title"
      onCancel={(event) => { event.preventDefault(); cancel(); }}>
      <form onSubmit={submit} className={styles.drawerForm} aria-busy={pending}>
        <div className={styles.drawerHeading}>
          <h2 id="user-editor-title">{user ? "Editar usuario" : "Crear usuario"}</h2>
          <button type="button" className={styles.closeDrawer} aria-label="Cerrar formulario" disabled={pending} onClick={cancel}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.drawerBody}>
          <fieldset disabled={pending} className={styles.drawerFields}>
            <label className={styles.field}><span className={styles.label}>Nombre completo</span>
              <input ref={nameRef} className={`cockpit-input ${styles.input}`} required maxLength={255} value={fullName}
                onChange={(event) => setName(event.target.value)} />
            </label>
            <label className={styles.field}><span className={styles.label}>Correo</span>
              <input className={`cockpit-input ${styles.input}`} type="email" required maxLength={255} value={email}
                onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className={styles.field}><span className={styles.label}>Rol</span>
              <select className={`cockpit-input ${styles.input}`} value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
                {roles.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {user ? <label className={styles.activeField}>
              <input type="checkbox" checked={isActive} onChange={(event) => setActive(event.target.checked)} /> Activo
            </label> : <label className={styles.field}><span className={styles.label}>Contraseña inicial</span>
              <input className={`cockpit-input ${styles.input}`} autoComplete="new-password" type="password" required value={password}
                onChange={(event) => setPassword(event.target.value)} />
            </label>}
          </fieldset>
        </div>
        <div className={styles.drawerFooter}>
          {revokesSessions && <p className={styles.notice} role="status">Este cambio revoca las sesiones de la cuenta.</p>}
          {error && <p role="alert" className={styles.notice}>{error}</p>}
          <div className={styles.drawerActions}>
            <button type="button" className={styles.secondary} disabled={pending} onClick={cancel}>Cancelar</button>
            <button type="submit" className={styles.primary} disabled={pending || !changed || !cleanName}>
              {pending ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
