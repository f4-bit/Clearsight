"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ApiError, errorMessage, forgotPassword, resetPassword } from "@/lib/api";
import entry from "../../entry.module.css";
import styles from "../login.module.css";

export default function RecoveryPage() {
  const [step, setStep] = useState<"request" | "reset" | "done">("request");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  function go(next: typeof step) { setStep(next); setNotice(""); setError(""); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      if (step === "request") {
        await forgotPassword(String(fields.get("email")).trim());
        go("reset");
        setNotice("Si la cuenta está activa y tiene correo de recuperación, recibirás un código.");
      } else {
        const password = String(fields.get("password"));
        if (Array.from(password).length < 12 || new TextEncoder().encode(password).length > 72) {
          setError("Usa al menos 12 caracteres y un máximo de 72 bytes."); return;
        }
        await resetPassword(String(fields.get("code")).trim(), password);
        go("done");
      }
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? "El código es inválido o ya venció." : errorMessage(failure));
    } finally { setPending(false); }
  }
  return <main className={`${entry.entry} ${styles.login}`}>
    <header className={styles.masthead}><span className={entry.wordmark}>Clear<b>Sight</b></span></header>
    <div className={styles.content}><section className={styles.panel}>
      <h1>{step === "done" ? "Contraseña actualizada" : step === "reset" ? "Restablecer contraseña" : "Recuperar acceso"}</h1>
      {notice && <p className="mb-3 text-sm" role="status">{notice}</p>}
      {step !== "done" && <form className={styles.form} key={step} method="post" onSubmit={submit}>
        {step === "request" ? <label>Correo electrónico<input className={styles.field} type="email" name="email" required autoComplete="email" /></label> : <>
          <label>Código de recuperación<input className={styles.field} name="code" autoComplete="one-time-code" required maxLength={512} /></label>
          <label>Nueva contraseña<input className={styles.field} type="password" name="password" autoComplete="new-password" required /></label>
        </>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button className={styles.submit} disabled={pending}>{pending ? "Enviando…" : step === "request" ? "Solicitar código" : "Guardar contraseña"}</button>
        <button type="button" className="text-left text-sm text-sky-300" disabled={pending} onClick={() => go(step === "request" ? "reset" : "request")}>
          {step === "request" ? "Ya tengo un código" : "Solicitar otro código"}
        </button>
      </form>}
      <Link className="mt-4 inline-block text-sm text-sky-300" href="/login">Volver a iniciar sesión</Link>
    </section></div>
  </main>;
}
