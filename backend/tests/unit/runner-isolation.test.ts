import http from "node:http";
import https from "node:https";
import net from "node:net";
import { describe, expect, it } from "vitest";
import integrationConfig from "../../vitest.integration.config.js";
import legacyConfig from "../../vitest.config.js";
import unitConfig from "../../vitest.unit.config.js";
import { assertNoExternalDatabaseUrl, assertOwnershipRunId } from "../helpers/ownership.js";

const UNIT_INCLUDE = ["tests/schemas.test.ts", "tests/sanitizer.test.ts", "tests/unit/**/*.test.ts"];
const INTEGRATION_INCLUDE = [
  "tests/repositories.test.ts",
  "tests/rbac.test.ts",
  "tests/migrations.test.ts",
  "tests/artifact-migrations.test.ts",
  "tests/identity-migrations.test.ts",
  "tests/integrity-migrations.test.ts",
  "tests/migration-deploy.integration.test.ts",
  "tests/admin-bootstrap.integration.test.ts",
  "tests/jwt.test.ts",
  "tests/auth-sessions.integration.test.ts",
  "tests/login-protection.integration.test.ts",
  "tests/feedback.route.test.ts",
  "tests/export.route.test.ts",
  "tests/etl.test.ts",
  "tests/health.test.ts",
  "tests/audit.integration.test.ts",
  "tests/user-admin.integration.test.ts",
  "tests/user-lifecycle.integration.test.ts",
];

describe("unit runner isolation", () => {
  it("uses an explicit pure allowlist and no globalSetup", () => {
    expect(unitConfig.test?.include).toEqual(UNIT_INCLUDE);
    expect(unitConfig.test?.globalSetup).toBeUndefined();
    expect(unitConfig.test?.setupFiles).toEqual(["./tests/unit/network-guard.ts"]);
  });

  it("keeps the legacy/default config unit-safe for raw `npx vitest`", () => {
    expect(legacyConfig.test?.include).toEqual(UNIT_INCLUDE);
    expect(legacyConfig.test?.globalSetup).toBeUndefined();
  });

  it("keeps every original non-pure test in the explicit integration allowlist", () => {
    expect(integrationConfig.test?.include).toEqual(INTEGRATION_INCLUDE);
    expect(integrationConfig.test?.globalSetup).toEqual(["./tests/global-setup.ts"]);
    expect(integrationConfig.test?.setupFiles).toEqual(["./tests/integration-setup.ts"]);
  });

  it("does not include any integration file in the unit allowlist", () => {
    for (const file of INTEGRATION_INCLUDE) {
      expect(UNIT_INCLUDE).not.toContain(file);
    }
  });
});

describe("unit network trap", () => {
  it("blocks fetch", async () => {
    await expect(fetch("http://127.0.0.1:9/")).rejects.toThrow(/may not access the network/);
  });

  it("blocks direct TCP sockets", () => {
    expect(() => net.connect({ host: "127.0.0.1", port: 9 })).toThrow(/may not access the network/);
  });

  it("blocks http and https entry points", () => {
    expect(() => http.request("http://127.0.0.1:9/")).toThrow(/may not access the network/);
    expect(() => https.get("https://127.0.0.1:9/")).toThrow(/may not access the network/);
  });

  it("blocks a raw options object passed straight to Socket.prototype.connect", () => {
    const socket = new net.Socket();
    try {
      expect(() => socket.connect({ host: "127.0.0.1", port: 9 })).toThrow(/may not access the network/);
    } finally {
      socket.destroy();
    }
  });

  it("blocks the normalized argument-array form net.connect uses internally", () => {
    const socket = new net.Socket();
    try {
      expect(() =>
        (socket.connect as unknown as (...args: unknown[]) => unknown)([
          { port: 9, host: "127.0.0.1" },
          undefined,
        ]),
      ).toThrow(/may not access the network/);
    } finally {
      socket.destroy();
    }
  });
});

describe("integration ownership guards", () => {
  it("rejects any supplied TEST_DATABASE_URL, including empty/whitespace values", () => {
    for (const value of ["", "   ", "not a url", "postgresql://u:p@localhost:5432/clearsight_test"]) {
      expect(() => assertNoExternalDatabaseUrl({ TEST_DATABASE_URL: value })).toThrow(
        /TEST_DATABASE_URL is not supported/,
      );
    }
    expect(() => assertNoExternalDatabaseUrl({})).not.toThrow();
  });

  it("accepts only one matching ownership marker row", () => {
    expect(() => assertOwnershipRunId([{ run_id: "run-1" }], "run-1")).not.toThrow();
    expect(() => assertOwnershipRunId([{ run_id: "other" }], "run-1")).toThrow(/does not match/);
    expect(() => assertOwnershipRunId([], "run-1")).toThrow(/exactly one/);
    expect(() => assertOwnershipRunId([{ run_id: "run-1" }, { run_id: "run-1" }], "run-1")).toThrow(
      /exactly one/,
    );
    expect(() => assertOwnershipRunId([{}], "run-1")).toThrow(/does not match/);
    expect(() => assertOwnershipRunId([{ run_id: "run-1" }], "")).toThrow(/run id is missing/);
    expect(() => assertOwnershipRunId([{ run_id: "run-1" }], undefined as unknown as string)).toThrow(
      /run id is missing/,
    );
  });
});
