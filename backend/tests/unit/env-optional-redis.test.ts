import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract: REDIS_URL is optional. The inference queue is PostgreSQL-backed
 * and the backend never connects to Redis, so an absent REDIS_URL must not
 * break startup env parsing (BullMQ migration regression).
 */
vi.mock("dotenv", () => ({
  default: { config: () => ({ parsed: {} }) },
}));

const SAVED_REDIS_URL = process.env.REDIS_URL;

afterEach(() => {
  vi.resetModules();
  if (SAVED_REDIS_URL === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = SAVED_REDIS_URL;
  }
});

describe("optional REDIS_URL", () => {
  it("parses the environment without REDIS_URL and yields undefined", async () => {
    delete process.env.REDIS_URL;
    vi.resetModules();
    const { env } = await import("../../src/config/env.js");
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("carries a provided REDIS_URL through untouched for legacy environments", async () => {
    process.env.REDIS_URL = "redis://legacy.invalid:6379/0";
    vi.resetModules();
    const { env } = await import("../../src/config/env.js");
    expect(env.REDIS_URL).toBe("redis://legacy.invalid:6379/0");
  });
});
