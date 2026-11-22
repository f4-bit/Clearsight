"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Pause, Play } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/Session";
import { ApiError, errorMessage } from "@/lib/api";
import styles from "./login.module.css";
import entry from "../entry.module.css";

const GhostFibers = dynamic(() => import("@/components/vendor/ghost-fibers/GhostFibers"), { ssr: false });

export default function LoginPage() {
  const { session, signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [backgroundPaused, setBackgroundPaused] = useState(false);
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
    <main className={`${entry.entry} ${styles.login}`}>
      <div className={styles.fibers} aria-hidden="true">
        <GhostFibers
          glowColor="#63afbf"
          lineColor="#d2f4f6"
          secondaryColor="#367687"
          layers={3}
          threads={72}
          fiberStyle="dots"
          depthOfField={0.85}
          hoverEffect="focus"
          intro={false}
          mouseInteraction={!backgroundPaused}
          mouseStrength={0.28}
          pulseOnClick={false}
          paused={backgroundPaused}
          rotation={18}
          speed={0.22}
          flow={0.14}
          rollSpeed={0.055}
          sparkle={0.24}
          glow={0.68}
          dpr={1.5}
          onReady={() => setBackgroundReady(true)}
        />
      </div>
      <header className={styles.masthead}>
        <span className={entry.wordmark}>Clear<b>Sight</b></span>
        {backgroundReady && <button className={styles.motion} type="button" onClick={() => setBackgroundPaused(!backgroundPaused)}>
          {backgroundPaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {backgroundPaused ? "Reanudar fondo" : "Pausar fondo"}
        </button>}
      </header>
      <div className={styles.content}>
        <p className={styles.descriptor}>Estación de diagnóstico<br className={styles.descriptorBreak} /> oftalmológico</p>
        <section className={styles.panel} aria-labelledby="login-title">
          <h1 id="login-title">Inicia sesión</h1>
          <form className={styles.form} onSubmit={submit}>
            <label className="grid gap-1.5">
              <span>Correo electrónico</span>
              <input className={styles.field} type="email" autoComplete="username" required
                value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <div className="grid gap-1.5">
              <label htmlFor="login-password">Contraseña</label>
              <div className="relative">
                <input id="login-password" className={`${styles.field} pr-14`} type={showPassword ? "text" : "password"} autoComplete="current-password" required
                  value={password} onChange={(event) => setPassword(event.target.value)} />
                <button type="button" className={styles.passwordToggle}
                  aria-label={showPassword ? "Ocultar clave" : "Mostrar clave"} onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                </button>
              </div>
            </div>
            {error && <p role="alert" className={styles.error}>{error}</p>}
            <button className={styles.submit}
              disabled={pending || wait > 0 || session.status === "loading" || session.status === "signed-in"}>
              {pending ? "Iniciando sesión…" : wait ? `Reintenta en ${wait} s` : "Iniciar sesión"}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
