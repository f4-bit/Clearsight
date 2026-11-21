import type { IdempotencyRecord } from "../generated/prisma/client.js";
import type { IdempotencyRepository } from "../repositories/idempotency.repo.js";
import type { DispatchPendingOutcome } from "../services/inference-dispatch.js";

export const DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS = 10_000;
export const DEFAULT_DISPATCH_RECONCILE_BATCH_SIZE = 20;
export const DEFAULT_PUBLICATION_RECONCILE_BATCH_SIZE = 20;

export interface DispatchReconcilerLogEvent {
  readonly code: string;
  readonly recordId?: string;
  readonly inferenceId?: string;
}

/** Structural subset of `ArtifactPublicationResult`; no service import here. */
export interface PublicationReconcilerOutcome {
  readonly report: {
    readonly status: string;
    readonly failureCode: string | null;
  } | null;
  readonly artifacts: readonly {
    readonly status: string;
    readonly failureCode: string | null;
  }[];
}

export interface PublicationReconcilerDeps {
  findCandidates(limit: number): Promise<readonly string[]>;
  publish(inferenceId: string): Promise<PublicationReconcilerOutcome>;
}

export interface DispatchReconcilerDeps {
  readonly repository: Pick<
    IdempotencyRepository,
    "claimPendingDispatchBatch" | "markDispatchOutcome"
  >;
  readonly dispatch: (record: IdempotencyRecord) => Promise<DispatchPendingOutcome>;
  /** Optional 3.6 publication reconciliation in the same bounded loop. */
  readonly publication?: PublicationReconcilerDeps;
  /** 0 disables the timer; `runOnce()` remains available for tests. */
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly publicationBatchSize?: number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly logger?: (event: DispatchReconcilerLogEvent) => void;
}

export interface DispatchReconciler {
  runOnce(): Promise<void>;
  stop(): void;
}

function defaultLogger(event: DispatchReconcilerLogEvent): void {
  console.error("[DispatchReconciler]", event);
}

function publicationFailureCode(
  outcome: PublicationReconcilerOutcome,
): string | null {
  if (outcome.report?.status === "FAILED") {
    return outcome.report.failureCode ?? "publication_failed";
  }
  const failedArtifact = outcome.artifacts.find(
    (artifact) => artifact.status === "FAILED",
  );
  return failedArtifact?.failureCode ?? null;
}

function publicationErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "publication_failed";
}

/**
 * Bounded, non-overlapping dispatch reconciliation: claim due PENDING rows,
 * dispatch each one, then record the outcome. The timer is intentionally
 * unref'd so tests or a worker shutdown are not kept alive by it.
 */
export function startDispatchReconciler(
  deps: DispatchReconcilerDeps,
): DispatchReconciler {
  const intervalMs =
    deps.intervalMs ?? DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS;
  const batchSize = deps.batchSize ?? DEFAULT_DISPATCH_RECONCILE_BATCH_SIZE;
  const logger = deps.logger ?? defaultLogger;
  const schedule = deps.setIntervalFn ?? setInterval;
  const unschedule = deps.clearIntervalFn ?? clearInterval;

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const reconciliateDispatch = async (): Promise<void> => {
    const claimed = await deps.repository.claimPendingDispatchBatch(batchSize);
    for (const record of claimed) {
      let outcome: DispatchPendingOutcome;
      try {
        outcome = await deps.dispatch(record);
      } catch {
        outcome = { ok: false, code: "dispatch_failed" };
      }

      try {
        await deps.repository.markDispatchOutcome(record.id, {
          dispatched: outcome.ok,
          lastErrorCode: outcome.ok ? null : outcome.code,
        });
      } catch {
        logger({
          code: "mark_outcome_failed",
          recordId: record.id,
          inferenceId: record.inferenceId,
        });
      }

      if (!outcome.ok) {
        logger({
          code: outcome.code,
          recordId: record.id,
          inferenceId: record.inferenceId,
        });
      }
    }
  };

  const reconcilePublication = async (): Promise<void> => {
    if (deps.publication === undefined) {
      return;
    }
    const publicationBatchSize =
      deps.publicationBatchSize ?? DEFAULT_PUBLICATION_RECONCILE_BATCH_SIZE;
    let candidates: readonly string[];
    try {
      candidates = await deps.publication.findCandidates(publicationBatchSize);
    } catch {
      logger({ code: "publication_candidates_failed" });
      return;
    }

    for (const inferenceId of candidates) {
      try {
        const outcome = await deps.publication.publish(inferenceId);
        const failureCode = publicationFailureCode(outcome);
        if (failureCode !== null) {
          logger({ code: failureCode, inferenceId });
        }
      } catch (error) {
        // Never log driver messages, references, URLs or PHI.
        logger({ code: publicationErrorCode(error), inferenceId });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      try {
        await reconciliateDispatch();
      } catch {
        logger({ code: "claim_failed" });
      }
      await reconcilePublication();
    } finally {
      running = false;
    }
  };

  if (intervalMs > 0) {
    timer = schedule(() => {
      void runOnce();
    }, intervalMs);
    timer.unref?.();
  }

  return {
    runOnce,
    stop() {
      if (timer !== null) {
        unschedule(timer);
        timer = null;
      }
    },
  };
}
