import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prisma and repositories are mocked at the module boundary so this file stays
 * inside the pure unit allowlist: no generated client, no dotenv, no DB. The
 * code under test is the real `tests/helpers/db.ts` ownership plumbing.
 */
vi.mock("../../src/lib/prisma.js", () => ({
  createPrismaClient: vi.fn((connectionString: string) => ({ connectionString })),
  getPrisma: vi.fn(),
  prisma: {},
}));

vi.mock("../../src/repositories/index.js", () => ({
  createRepositories: vi.fn(() => ({})),
}));

import { createPrismaClient, type PrismaClient } from "../../src/lib/prisma.js";
import { assertTestDatabaseOwnership, createTestPrisma, resetDb } from "../helpers/db.js";

const CONTAINER_URL = "postgresql://clearsight:clearsight@127.0.0.1:55432/clearsight_test_deadbeef";
const RUN_ID = "11111111-2222-3333-4444-555555555555";
const TRUNCATE_SQL =
  "TRUNCATE TABLE inference_access_grants, auth_login_buckets, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE";
const MARKER_SELECT_SQL = "SELECT run_id FROM test_meta";

type ProvidedContext = Record<string, unknown>;

const workerState = globalThis as unknown as {
  __vitest_worker__?: { providedContext: ProvidedContext };
};

function currentProvidedContext(): ProvidedContext {
  const state = workerState.__vitest_worker__;
  if (!state) {
    throw new Error("this test must run inside the vitest worker runtime");
  }
  return state.providedContext;
}

function setContext(values: ProvidedContext): void {
  Object.assign(currentProvidedContext(), values);
}

function createFakePrisma(markerRows: unknown[]) {
  const calls: string[] = [];
  const queryRawUnsafe = vi.fn(async (sql: string) => {
    calls.push(`query:${sql}`);
    return markerRows;
  });
  const executeRawUnsafe = vi.fn(async (sql: string) => {
    calls.push(`execute:${sql}`);
  });
  const prisma = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe };
  return { prisma: prisma as unknown as PrismaClient, calls, queryRawUnsafe, executeRawUnsafe };
}

beforeEach(() => {
  vi.mocked(createPrismaClient).mockClear();
  setContext({ databaseUrl: CONTAINER_URL, databaseOwnership: RUN_ID });
});

afterEach(() => {
  const context = currentProvidedContext();
  delete context.databaseUrl;
  delete context.databaseOwnership;
});

describe("test database ownership binding", () => {
  it("truncates only after the ownership marker matches the injected run id", async () => {
    const fake = createFakePrisma([{ run_id: RUN_ID }]);

    await resetDb(fake.prisma);

    expect(fake.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fake.queryRawUnsafe).toHaveBeenCalledWith(MARKER_SELECT_SQL);
    expect(fake.executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fake.executeRawUnsafe).toHaveBeenCalledWith(TRUNCATE_SQL);
    expect(fake.calls).toEqual([`query:${MARKER_SELECT_SQL}`, `execute:${TRUNCATE_SQL}`]);
  });

  it("refuses to truncate when the marker table is empty", async () => {
    const fake = createFakePrisma([]);

    await expect(resetDb(fake.prisma)).rejects.toThrow(/exactly one ownership marker row/);
    expect(fake.executeRawUnsafe).not.toHaveBeenCalled();
    expect(fake.queryRawUnsafe).toHaveBeenCalledWith(MARKER_SELECT_SQL);
  });

  it("refuses to truncate when the marker belongs to another run", async () => {
    const fake = createFakePrisma([{ run_id: "another-run" }]);

    await expect(resetDb(fake.prisma)).rejects.toThrow(
      /ownership marker does not match the injected test run id/,
    );
    expect(fake.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("refuses to truncate when the marker table has more than one row", async () => {
    const fake = createFakePrisma([{ run_id: RUN_ID }, { run_id: RUN_ID }]);

    await expect(resetDb(fake.prisma)).rejects.toThrow(/exactly one ownership marker row/);
    expect(fake.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("refuses to run any query when the test context has no ownership run id", async () => {
    delete currentProvidedContext().databaseOwnership;
    const fake = createFakePrisma([{ run_id: RUN_ID }]);

    await expect(resetDb(fake.prisma)).rejects.toThrow(/missing the ownership run id/);
    expect(fake.queryRawUnsafe).not.toHaveBeenCalled();
    expect(fake.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("asserts the ownership marker through the fixed test_meta table", async () => {
    const fake = createFakePrisma([{ run_id: RUN_ID }]);

    await assertTestDatabaseOwnership(fake.prisma);

    expect(fake.queryRawUnsafe).toHaveBeenCalledWith(MARKER_SELECT_SQL);
    expect(fake.executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("test prisma creation binding", () => {
  it("creates the client only from the injected container URL", () => {
    const client = createTestPrisma();

    expect(client).toEqual({ connectionString: CONTAINER_URL });
    expect(createPrismaClient).toHaveBeenCalledTimes(1);
    expect(createPrismaClient).toHaveBeenCalledWith(CONTAINER_URL);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("refuses to create a client when the injected URL is %s", (_label, url) => {
    if (url === undefined) {
      delete currentProvidedContext().databaseUrl;
    } else {
      setContext({ databaseUrl: url });
    }

    expect(() => createTestPrisma()).toThrow(/missing the ephemeral database URL/);
    expect(createPrismaClient).not.toHaveBeenCalled();
  });

  it("refuses to create a client without the ownership run id even when a URL is present", () => {
    delete currentProvidedContext().databaseOwnership;

    expect(() => createTestPrisma()).toThrow(/missing the ownership run id/);
    expect(createPrismaClient).not.toHaveBeenCalled();
  });
});
