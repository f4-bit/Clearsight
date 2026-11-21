import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  containerCtor: vi.fn(),
  withDatabase: vi.fn(),
  withLabels: vi.fn(),
  start: vi.fn(),
  getConnectionUri: vi.fn(),
  stop: vi.fn(),
  clientCtor: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  currentRunId: undefined as string | undefined,
}));

vi.mock("@testcontainers/postgresql", () => {
  class PostgreSqlContainer {
    constructor(...args: unknown[]) {
      mocks.containerCtor(...args);
    }
    withDatabase(...args: unknown[]) {
      mocks.withDatabase(...args);
      return this;
    }
    withLabels(...args: unknown[]) {
      mocks.withLabels(...args);
      return this;
    }
    async start() {
      await mocks.start();
      return this;
    }
    getConnectionUri() {
      return mocks.getConnectionUri();
    }
    async stop() {
      await mocks.stop();
    }
  }
  return { PostgreSqlContainer };
});

vi.mock("pg", () => {
  class Client {
    constructor(...args: unknown[]) {
      mocks.clientCtor(...args);
    }
    async connect() {
      await mocks.connect();
    }
    async query(...args: unknown[]) {
      return mocks.query(...args);
    }
    async end() {
      await mocks.end();
    }
  }
  return { Client };
});

import setup from "../../tests/global-setup.js";

const CONTAINER_URL = "postgresql://clearsight:clearsight@127.0.0.1:55432/clearsight_test_deadbeef";
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

function createProject() {
  const provide = vi.fn();
  return { project: { provide } as unknown as Parameters<typeof setup>[0], provide };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TEST_DATABASE_URL;
  mocks.currentRunId = undefined;
  mocks.start.mockResolvedValue(undefined);
  mocks.getConnectionUri.mockReturnValue(CONTAINER_URL);
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO test_meta")) {
      mocks.currentRunId = params?.[0] as string | undefined;
      return { rows: [] };
    }
    if (typeof sql === "string" && sql.includes("SELECT run_id FROM test_meta")) {
      return { rows: mocks.currentRunId ? [{ run_id: mocks.currentRunId }] : [] };
    }
    return { rows: [] };
  });
});

afterEach(() => {
  if (originalTestDatabaseUrl === undefined) {
    delete process.env.TEST_DATABASE_URL;
  } else {
    process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("integration global setup", () => {
  it.each([
    ["non-empty URL", "postgresql://user:pass@localhost:5432/clearsight_test"],
    ["whitespace", "   "],
    ["malformed", "not a url"],
    ["empty", ""],
  ])("rejects a supplied TEST_DATABASE_URL (%s) before creating any client or container", async (_label, value) => {
    process.env.TEST_DATABASE_URL = value;
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/TEST_DATABASE_URL is not supported/);
    expect(mocks.containerCtor).not.toHaveBeenCalled();
    expect(mocks.clientCtor).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
  });

  it("does not echo a rejected external URL in the error", async () => {
    const secretUrl = "postgresql://user:super-secret@example.invalid:5432/clearsight_test";
    process.env.TEST_DATABASE_URL = secretUrl;
    const { project } = createProject();

    let message = "";
    try {
      await setup(project);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/TEST_DATABASE_URL is not supported/);
    expect(message).not.toContain(secretUrl);
    expect(message).not.toContain("super-secret");
  });

  it("creates a uniquely named owned container and only connects to its URI", async () => {
    process.env.DATABASE_URL = "postgresql://ambient:ambient@127.0.0.1:5432/clearsight";
    const { project, provide } = createProject();

    const teardown = await setup(project);

    const databaseName = mocks.withDatabase.mock.calls[0]?.[0];
    expect(typeof databaseName).toBe("string");
    expect(databaseName).toMatch(/^clearsight_test_[0-9a-f]{32}$/);

    const labels = mocks.withLabels.mock.calls[0]?.[0] as Record<string, string> | undefined;
    expect(labels?.["com.clearsight.test.run-id"]).toBeTruthy();
    expect(mocks.clientCtor).toHaveBeenCalledWith({ connectionString: CONTAINER_URL });
    expect(provide).toHaveBeenCalledWith("databaseUrl", CONTAINER_URL);

    const ownershipCall = provide.mock.calls.find(([key]) => key === "databaseOwnership");
    expect(ownershipCall?.[1]).toBe(labels?.["com.clearsight.test.run-id"]);

    await teardown();
    await teardown();
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("uses a different database name for every run", async () => {
    const first = await setup(createProject().project);
    const second = await setup(createProject().project);

    expect(mocks.withDatabase.mock.calls[0]?.[0]).not.toBe(mocks.withDatabase.mock.calls[1]?.[0]);
    await first();
    await second();
  });

  it("ends the client and stops the container when connect fails", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connect failed"));
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/connect failed/);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("ends the client and stops the container when a migration fails", async () => {
    mocks.query.mockRejectedValueOnce(new Error("migration failed"));
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/migration failed/);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("stops the container when providing the context fails", async () => {
    const { project, provide } = createProject();
    provide.mockImplementation(() => {
      throw new Error("provide failed");
    });

    await expect(setup(project)).rejects.toThrow(/provide failed/);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("propagates teardown failures instead of reporting a false success", async () => {
    const { project } = createProject();
    const teardown = await setup(project);
    mocks.stop.mockRejectedValueOnce(new Error("stop failed"));

    await expect(teardown()).rejects.toThrow(/stop failed/);
  });

  it("rejects the run when the ownership marker query yields no row", async () => {
    mocks.query.mockImplementation(async () => ({ rows: [] }));
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/exactly one ownership marker row/);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("rejects the run when the ownership marker belongs to a different run", async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === "string" && sql.includes("SELECT run_id FROM test_meta")) {
        return { rows: [{ run_id: "foreign-run" }] };
      }
      return { rows: [] };
    });
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/does not match the injected test run id/);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("rejects an empty container URI instead of silently connecting to a fallback", async () => {
    mocks.getConnectionUri.mockReturnValueOnce("");
    const { project, provide } = createProject();

    await expect(setup(project)).rejects.toThrow(/empty PostgreSQL connection URI/);
    expect(mocks.clientCtor).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("reports both errors when the setup fails and the container also fails to stop", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connect failed"));
    mocks.stop.mockRejectedValueOnce(new Error("stop failed"));
    const { project, provide } = createProject();

    let caught: unknown;
    try {
      await setup(project);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toMatch(/setup failed and cleanup was incomplete/);
    const messages = aggregate.errors.map((error) => (error as Error).message);
    expect(messages).toContain("connect failed");
    expect(messages).toContain("stop failed");
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });

  it("reports both errors when the migration fails and the client cannot be closed", async () => {
    mocks.query.mockRejectedValueOnce(new Error("migration failed"));
    mocks.end.mockRejectedValueOnce(new Error("end failed"));
    const { project, provide } = createProject();

    let caught: unknown;
    try {
      await setup(project);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toMatch(/setup and client cleanup both failed/);
    const messages = aggregate.errors.map((error) => (error as Error).message);
    expect(messages).toContain("migration failed");
    expect(messages).toContain("end failed");
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(provide).not.toHaveBeenCalled();
  });
});
