import { describe, expect, it } from "vitest";
import {
  runBootstrapAdminCli,
  type BootstrapClientFactory,
  type BootstrapCliWriters,
} from "../../scripts/bootstrap-admin.js";
import { BootstrapAdminError } from "../../src/services/admin-bootstrap.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

const CLI_ENV: NodeJS.ProcessEnv = {
  MIGRATION_DATABASE_URL: "postgresql://synthetic:synthetic@owned.test:5432/clearsight",
  DATABASE_URL: "postgresql://synthetic:synthetic@owned.test:5432/clearsight",
  BOOTSTRAP_ADMIN_EMAIL: "cli-unit@clearsight.test",
  BOOTSTRAP_ADMIN_FULL_NAME: "CLI Unit",
  BOOTSTRAP_ADMIN_PASSWORD: "synthetic-password-123",
};

const DISCONNECT_WARNING =
  "[bootstrap] warning code=BOOTSTRAP_DISCONNECT_FAILED message=the bootstrap database connection could not be closed";

function collectWriters(): { out: string[]; err: string[]; writers: BootstrapCliWriters } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writers: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

function factoryFor(client: PrismaClient): BootstrapClientFactory {
  return (target) => {
    expect(target.url).toBe(CLI_ENV.MIGRATION_DATABASE_URL);
    return client;
  };
}

function successClient(disconnect: () => Promise<void>): PrismaClient {
  const tx = {
    $queryRawUnsafe: async () => [{ locked: 1 }],
    user: {
      findFirst: async () => null,
      create: async () => ({
        id: "55555555-5555-4555-8555-555555555555",
        role: "ADMIN",
        createdAt: new Date("2026-11-18T00:00:00.000Z"),
      }),
    },
    auditEvent: { create: async () => ({}) },
  };
  return {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    $disconnect: disconnect,
  } as unknown as PrismaClient;
}

function failureClient(disconnect: () => Promise<void>): PrismaClient {
  return {
    $transaction: async () => {
      throw new BootstrapAdminError(
        "BOOTSTRAP_DATABASE_FAILED",
        "the bootstrap transaction could not be completed",
      );
    },
    $disconnect: disconnect,
  } as unknown as PrismaClient;
}

describe("bootstrap CLI outcome and cleanup", () => {
  it("returns 0 with COMMITTED/COMPLETE on a clean success", async () => {
    let disconnectCalls = 0;
    const client = successClient(async () => {
      disconnectCalls += 1;
    });
    const { out, err, writers } = collectWriters();

    const exitCode = await runBootstrapAdminCli(CLI_ENV, writers, factoryFor(client));

    expect(exitCode).toBe(0);
    expect(disconnectCalls).toBe(1);
    expect(out).toEqual([
      "[bootstrap] ok userId=55555555-5555-4555-8555-555555555555 role=ADMIN operationStatus=COMMITTED cleanup=COMPLETE",
    ]);
    expect(out[0]).toMatch(/\[bootstrap\] ok userId=[0-9a-f-]+ role=ADMIN/);
    expect(err).toEqual([]);
  });

  it("returns 2 with COMMITTED/PENDING when disconnect fails after a committed result", async () => {
    const canary = "postgresql://CanarySecret:canary-password@canary-host/clearsight";
    const client = successClient(async () => {
      throw new Error(canary);
    });
    const { out, err, writers } = collectWriters();

    const exitCode = await runBootstrapAdminCli(CLI_ENV, writers, factoryFor(client));

    expect(exitCode).toBe(2);
    expect(out).toEqual([
      "[bootstrap] ok userId=55555555-5555-4555-8555-555555555555 role=ADMIN operationStatus=COMMITTED cleanup=PENDING",
    ]);
    expect(err).toEqual([DISCONNECT_WARNING]);
    expect(JSON.stringify({ out, err })).not.toContain("CanarySecret");
    expect(JSON.stringify({ out, err })).not.toContain("failed");
    expect(JSON.stringify({ out, err })).not.toContain("rollback");
  });

  it("returns 1 and preserves the primary error when cleanup also fails", async () => {
    let disconnectCalls = 0;
    const client = failureClient(async () => {
      disconnectCalls += 1;
      throw new Error("canary cleanup failure");
    });
    const { out, err, writers } = collectWriters();

    const exitCode = await runBootstrapAdminCli(CLI_ENV, writers, factoryFor(client));

    expect(exitCode).toBe(1);
    expect(disconnectCalls).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "[bootstrap] failed code=BOOTSTRAP_DATABASE_FAILED message=the bootstrap transaction could not be completed",
      DISCONNECT_WARNING,
    ]);
    expect(err.join("\n")).not.toContain("canary");
  });

  it("returns 1 with only the primary error when cleanup succeeds", async () => {
    let disconnectCalls = 0;
    const client = failureClient(async () => {
      disconnectCalls += 1;
    });
    const { out, err, writers } = collectWriters();

    const exitCode = await runBootstrapAdminCli(CLI_ENV, writers, factoryFor(client));

    expect(exitCode).toBe(1);
    expect(disconnectCalls).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toBe(
      "[bootstrap] failed code=BOOTSTRAP_DATABASE_FAILED message=the bootstrap transaction could not be completed",
    );
  });
});
