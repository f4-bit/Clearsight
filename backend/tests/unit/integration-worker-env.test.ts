import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `tests/integration-setup.ts` must bind DATABASE_URL to the injected container
 * URL before any test module (and therefore `src/config/env.ts`) is imported,
 * so the env singleton can never fall back to a development database.
 */
const CONTAINER_URL = "postgresql://clearsight:clearsight@127.0.0.1:55432/clearsight_test_deadbeef";
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

type ProvidedContext = Record<string, unknown>;

const workerState = globalThis as unknown as {
  __vitest_worker__?: { providedContext: ProvidedContext };
};

function setContext(values: ProvidedContext): void {
  const state = workerState.__vitest_worker__;
  if (!state) {
    throw new Error("this test must run inside the vitest worker runtime");
  }
  Object.assign(state.providedContext, values);
}

afterEach(() => {
  vi.resetModules();
  const context = workerState.__vitest_worker__?.providedContext;
  if (context) {
    delete context.databaseUrl;
    delete context.databaseOwnership;
  }
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe("integration worker environment binding", () => {
  it("binds DATABASE_URL to the injected container URL and forces NODE_ENV=test", async () => {
    setContext({ databaseUrl: CONTAINER_URL });
    vi.resetModules();

    await import("../integration-setup.js");

    expect(process.env.DATABASE_URL).toBe(CONTAINER_URL);
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("fails loudly without an injected URL instead of falling back to development", async () => {
    delete workerState.__vitest_worker__?.providedContext.databaseUrl;
    vi.resetModules();

    await expect(import("../integration-setup.js")).rejects.toThrow(
      /missing the ephemeral database URL/,
    );
    expect(process.env.DATABASE_URL).toBe(ORIGINAL_DATABASE_URL);
  });

  it("fails loudly when the injected URL is empty", async () => {
    setContext({ databaseUrl: "" });
    vi.resetModules();

    await expect(import("../integration-setup.js")).rejects.toThrow(
      /missing the ephemeral database URL/,
    );
    expect(process.env.DATABASE_URL).toBe(ORIGINAL_DATABASE_URL);
  });
});
