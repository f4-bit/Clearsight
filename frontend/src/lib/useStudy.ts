"use client";

import { useEffect, useState } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import { getStudy, studyNeedsPolling, type StudySnapshot } from "@/lib/studies";

const POLLING_DEADLINE_MS = 4 * 60 * 1000;

export function useStudy(id: string | null) {
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    const consultationId = id;
    let timer: number | undefined;
    let failures = 0;
    const controller = new AbortController();
    const deadline = Date.now() + POLLING_DEADLINE_MS;

    function schedule(seconds: number) {
      if (Date.now() + seconds * 1000 >= deadline) {
        setError("El servidor sigue procesando el caso. Puedes volver a consultar su estado.");
        return;
      }
      timer = window.setTimeout(poll, seconds * 1000);
    }

    async function poll() {
      try {
        const next = await getStudy(consultationId, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        setSnapshot(next);
        if (studyNeedsPolling(next)) schedule(next.retryAfter);
      } catch (failure) {
        if (controller.signal.aborted) return;
        const transient = !(failure instanceof ApiError) || failure.status >= 500 || failure.status === 429;
        if (transient && failures < 3) {
          failures += 1;
          schedule(failure instanceof ApiError && failure.retryAfter
            ? failure.retryAfter
            : 2 ** failures);
          return;
        }
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) setSnapshot(null);
        setError(errorMessage(failure));
      }
    }

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, attempt]);

  function retry() {
    setError("");
    setAttempt((value) => value + 1);
  }

  return {
    snapshot: snapshot?.consultation.id === id ? snapshot : null,
    error,
    retry,
  };
}
