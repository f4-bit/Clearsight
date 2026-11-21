"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, errorMessage, login, logout, restoreSession } from "@/lib/api";
import type { SessionUser, UserRole } from "@/types/api";

type SessionState =
  | { status: "loading" | "signed-out" }
  | { status: "error"; message: string }
  | { status: "signed-in"; user: SessionUser };

interface SessionContextValue {
  session: SessionState;
  retry: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const end = () => setSession({ status: "signed-out" });
    window.addEventListener("clearsight-session-ended", end);
    restoreSession().then(
      (user) => { if (current) setSession({ status: "signed-in", user }); },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 401) end();
        else setSession({ status: "error", message: errorMessage(error) });
      },
    );
    return () => {
      current = false;
      window.removeEventListener("clearsight-session-ended", end);
    };
  }, [attempt]);

  async function signIn(email: string, password: string) {
    setSession({ status: "signed-in", user: await login(email, password) });
  }

  async function signOut() {
    await logout();
    setSession({ status: "signed-out" });
  }

  function retry() {
    setSession({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  return (
    <SessionContext.Provider value={{ session, retry, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("SessionProvider is required");
  return context;
}

export function SessionGate({
  role, children,
}: {
  role?: UserRole;
  children: (user: SessionUser) => ReactNode;
}) {
  const { session, retry } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === "signed-out") router.replace("/login");
  }, [session.status, router]);

  if (session.status === "error") {
    return (
      <main className="grid min-h-screen place-content-center gap-4 px-6">
        <p role="alert" className="text-sm text-amber-300">{session.message}</p>
        <button className="cockpit-button justify-self-start" onClick={retry}>Volver a conectar</button>
      </main>
    );
  }
  if (session.status !== "signed-in") {
    return <p role="status" className="p-6 text-sm text-cockpit-text-muted">Verificando sesión…</p>;
  }
  if (role && session.user.role !== role) {
    return (
      <main className="grid min-h-screen place-content-center gap-4 px-6">
        <p role="alert" className="text-sm text-amber-300">Esta pantalla requiere otro perfil.</p>
        <Link className="cockpit-button justify-self-start" href="/">Volver al inicio</Link>
      </main>
    );
  }
  return children(session.user);
}

export function LogoutButton() {
  const { signOut } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-amber-300" role="alert">{error}</span>}
      <button
        className="cockpit-button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try { await signOut(); }
          catch (failure) { setError(errorMessage(failure)); }
          finally { setPending(false); }
        }}
      >
        Cerrar sesión
      </button>
    </div>
  );
}
