import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workerInstance = { on: vi.fn() };
  const redisInstance = { on: vi.fn() };
  return {
    redis: vi.fn(function () {
      return redisInstance;
    }),
    redisInstance,
    worker: vi.fn(function (..._args: unknown[]) {
      return workerInstance;
    }),
    workerInstance,
  };
});

vi.mock("ioredis", () => ({ Redis: mocks.redis }));
vi.mock("bullmq", () => ({ Worker: mocks.worker }));

import { startInferenceWorker } from "../../src/workers/inference.worker.js";

describe("inference worker bootstrap", () => {
  beforeEach(() => {
    mocks.redis.mockClear();
    mocks.redisInstance.on.mockClear();
    mocks.worker.mockClear();
    mocks.workerInstance.on.mockClear();
  });

  it("does not open Redis at import and only does it inside the no-arg boot", () => {
    expect(mocks.redis).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();

    const worker = startInferenceWorker();

    expect(worker).toBe(mocks.workerInstance);
    expect(mocks.redis).toHaveBeenCalledTimes(1);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
    expect(mocks.redisInstance.on).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls[0]![0]).toBe("inference-jobs");
    expect(mocks.worker.mock.calls[0]![2]).toMatchObject({ concurrency: 4 });
    expect(mocks.workerInstance.on).toHaveBeenCalledTimes(2);
  });
});
