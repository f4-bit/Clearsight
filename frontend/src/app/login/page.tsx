"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/Session";
import { ApiError, errorMessage } from "@/lib/api";

export default function LoginPage() {
  const { session, signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (session.status === "signed-in") router.replace("/");
  }, [session.status, router]);

  useEffect(() => {
    if (!wait) return;
    const timer = window.setTimeout(() => setWait((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (wait || pending) return;
    setPending(true);
    setError("");
    try {
      await signIn(email.trim(), password);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 429) setWait(failure.retryAfter ?? 60);
      setError(failure instanceof ApiError && failure.status === 401
        ? "Las credenciales ingresadas no son válidas."
        : errorMessage(failure));
    } finally {
      setPassword("");
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <section className="w-full max-w-[25rem] rounded-md border border-cockpit-border bg-cockpit-surface">
        <header className="border-b border-cockpit-border px-6 py-5">
          <p className="text-base font-bold text-white">ClearSight</p>
          <h1 className="mt-1 text-sm text-cockpit-text-muted">Acceso a la estación oftalmológica</h1>
        </header>
        <form className="grid gap-4 p-6" onSubmit={submit}>
          <label className="grid gap-1.5">
            <span className="cockpit-label">Correo electrónico</span>
            <input className="cockpit-input" type="email" autoComplete="username" required
              value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-1.5">
            <span className="cockpit-label">Contraseña</span>
            <input className="cockpit-input" type="password" autoComplete="current-password" required
              value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
          <button className="cockpit-button cockpit-primary mt-1"
            disabled={pending || wait > 0 || session.status === "loading" || session.status === "signed-in"}>
            {pending ? "Iniciando sesión…" : wait ? `Reintenta en ${wait} s` : "Iniciar sesión"}
          </button>
        </form>
      </section>
    </main>
  );
}
