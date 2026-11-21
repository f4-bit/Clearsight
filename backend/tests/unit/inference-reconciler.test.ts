import { describe, expect, it, vi } from "vitest";
import type { IdempotencyRecord } from "../../src/generated/prisma/client.js";
import { startDispatchReconciler } from "../../src/workers/inference.reconciler.js";

function record(id: string, inferenceId: string): IdempotencyRecord {
  return { id, inferenceId, state: "PENDING" } as IdempotencyRecord;
}

describe("dispatch reconciler", () => {
  it("claims a bounded batch and records success/failure without overlap", async () => {
    const claimed = [
      record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "11111111-1111-4111-8111-111111111111"),
      record("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "22222222-2222-4222-8222-222222222222"),
    ];
    const claimPendingDispatchBatch = vi.fn(async () => claimed);
    const markDispatchOutcome = vi.fn(async () => 1);
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        inferenceId: claimed[0]!.inferenceId,
        alreadyTerminal: false,
      })
      .mockResolvedValueOnce({ ok: false, code: "enqueue_failed" });
    const logger = vi.fn();

    const reconciler = startDispatchReconciler({
      repository: { claimPendingDispatchBatch, markDispatchOutcome },
      dispatch,
      intervalMs: 0,
      batchSize: 2,
      logger,
    });
    await reconciler.runOnce();
    reconciler.stop();

    expect(claimPendingDispatchBatch).toHaveBeenCalledWith(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(markDispatchOutcome).toHaveBeenNthCalledWith(1, claimed[0]!.id, {
      dispatched: true,
      lastErrorCode: null,
    });
    expect(markDispatchOutcome).toHaveBeenNthCalledWith(2, claimed[1]!.id, {
      dispatched: false,
      lastErrorCode: "enqueue_failed",
    });
    expect(logger).toHaveBeenCalledWith({
      code: "enqueue_failed",
      recordId: claimed[1]!.id,
      inferenceId: claimed[1]!.inferenceId,
    });
  });

  it("does not overlap runOnce invocations", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimPendingDispatchBatch = vi.fn(async () => {
      await gate;
      return [];
    });
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch,
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch: vi.fn(),
      intervalMs: 0,
      logger: vi.fn(),
    });

    const first = reconciler.runOnce();
    await expect(reconciler.runOnce()).resolves.toBeUndefined();
    expect(claimPendingDispatchBatch).toHaveBeenCalledTimes(1);
    release();
    await first;
    reconciler.stop();
  });

  it("logs a safe claim_failed code and stops cleanly", async () => {
    const logger = vi.fn();
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch: vi.fn(async () => {
          throw new Error("db down");
        }),
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch: vi.fn(),
      intervalMs: 0,
      logger,
    });

    await reconciler.runOnce();
    reconciler.stop();

    expect(logger).toHaveBeenCalledWith({ code: "claim_failed" });
  });

  it("does not start a second claim while a previous dispatch is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimed = [
      record(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "11111111-1111-4111-8111-111111111111",
      ),
    ];
    const claimPendingDispatchBatch = vi.fn(async () => claimed);
    const dispatch = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        inferenceId: claimed[0]!.inferenceId,
        alreadyTerminal: false,
      };
    });
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch,
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch,
      intervalMs: 0,
      logger: vi.fn(),
    });

    const first = reconciler.runOnce();
    await reconciler.runOnce();
    expect(claimPendingDispatchBatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await first;
    reconciler.stop();
  });

  it("resets the overlap guard so a later runOnce claims again", async () => {
    const claimPendingDispatchBatch = vi.fn(async () => []);
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch,
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch: vi.fn(),
      intervalMs: 0,
      logger: vi.fn(),
    });

    await reconciler.runOnce();
    await reconciler.runOnce();
    reconciler.stop();

    expect(claimPendingDispatchBatch).toHaveBeenCalledTimes(2);
  });

  it("records dispatch_failed when the dispatch helper throws", async () => {
    const claimed = [
      record(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "11111111-1111-4111-8111-111111111111",
      ),
    ];
    const markDispatchOutcome = vi.fn(async () => 1);
    const logger = vi.fn();
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch: vi.fn(async () => claimed),
        markDispatchOutcome,
      },
      dispatch: vi.fn(async () => {
        throw new Error("boom");
      }),
      intervalMs: 0,
      logger,
    });

    await reconciler.runOnce();
    reconciler.stop();

    expect(markDispatchOutcome).toHaveBeenCalledWith(claimed[0]!.id, {
      dispatched: false,
      lastErrorCode: "dispatch_failed",
    });
    expect(logger).toHaveBeenCalledWith({
      code: "dispatch_failed",
      recordId: claimed[0]!.id,
      inferenceId: claimed[0]!.inferenceId,
    });
  });

  it("logs mark_outcome_failed without throwing when recording the outcome fails", async () => {
    const claimed = [
      record(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "11111111-1111-4111-8111-111111111111",
      ),
    ];
    const logger = vi.fn();
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch: vi.fn(async () => claimed),
        markDispatchOutcome: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
      dispatch: vi.fn(async () => ({
        ok: true as const,
        inferenceId: claimed[0]!.inferenceId,
        alreadyTerminal: false,
      })),
      intervalMs: 0,
      logger,
    });

    await expect(reconciler.runOnce()).resolves.toBeUndefined();
    reconciler.stop();

    expect(logger).toHaveBeenCalledWith({
      code: "mark_outcome_failed",
      recordId: claimed[0]!.id,
      inferenceId: claimed[0]!.inferenceId,
    });
  });

  it("schedules a non-blocking interval and clears it on stop", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn((..._args: unknown[]) => timer);
    const clearIntervalFn = vi.fn();
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch: vi.fn(async () => []),
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch: vi.fn(),
      intervalMs: 5_000,
      setIntervalFn,
      clearIntervalFn,
      logger: vi.fn(),
    });

    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0]![1]).toBe(5_000);
    expect(unref).toHaveBeenCalledTimes(1);

    reconciler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    reconciler.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a timer when the interval is disabled", () => {
    const setIntervalFn = vi.fn();
    const reconciler = startDispatchReconciler({
      repository: {
        claimPendingDispatchBatch: vi.fn(async () => []),
        markDispatchOutcome: vi.fn(async () => 1),
      },
      dispatch: vi.fn(),
      intervalMs: 0,
      setIntervalFn,
      clearIntervalFn: vi.fn(),
      logger: vi.fn(),
    });

    expect(setIntervalFn).not.toHaveBeenCalled();
    reconciler.stop();
  });
});
