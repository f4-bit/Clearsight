import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { MAX_ACCESS_TTL_SECONDS } from "../../src/services/auth-policy.js";
import type { AuthLoginProtection } from "../../src/services/login-guard.js";
import {
  assertValidDatabaseSchema,
  createAuthSessionService,
  DEFAULT_DATABASE_SCHEMA,
  SESSION_TTL_MS,
} from "../../src/services/session.js";

/**
 * Pure wiring double: every method is coherent and returns a constant. It never
 * runs the real guard; integration tests prove the production behavior.
 */
const loginProtection: AuthLoginProtection = {
  reserveIpAttempt: async () => ({ blocked: false }),
  precheckIdentifier: async () => ({ blocked: false }),
  recordFailure: async () => ({ blocked: false }),
  assertAndResetForSuccess: async () => undefined,
};

const baseOptions = { accessTtl: { seconds: 900, label: "15m" }, loginProtection };
const fakeDb = {} as PrismaClient;

function trapDb(): PrismaClient {
  return new Proxy({}, {
    get() {
      throw new Error("database must not be touched during construction");
    },
  }) as PrismaClient;
}

describe("auth session constructor policy", () => {
  it("requires an injected durable guard and never falls back to no protection", () => {
    expect(() =>
      createAuthSessionService(trapDb(), {
        accessTtl: { seconds: 900, label: "15m" },
      } as unknown as Parameters<typeof createAuthSessionService>[1]),
    ).toThrow(/loginProtection is required/);
    expect(() =>
      createAuthSessionService(trapDb(), {
        accessTtl: { seconds: 900, label: "15m" },
        loginProtection: null,
      } as unknown as Parameters<typeof createAuthSessionService>[1]),
    ).toThrow(/loginProtection is required/);
  });

  it("accepts the default and shorter trusted TTLs", () => {
    expect(() => createAuthSessionService(fakeDb, baseOptions)).not.toThrow();
    expect(() =>
      createAuthSessionService(fakeDb, {
        accessTtl: { seconds: 60, label: "1m" },
        sessionTtlMs: 60 * 60 * 1000,
        loginProtection,
      }),
    ).not.toThrow();
    expect(MAX_ACCESS_TTL_SECONDS).toBe(900);
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ["zero access TTL", { accessTtl: { seconds: 0, label: "0s" } }],
    ["negative access TTL", { accessTtl: { seconds: -1, label: "-1s" } }],
    ["fractional access TTL", { accessTtl: { seconds: 1.5, label: "1.5s" } }],
    ["access TTL over 900", { accessTtl: { seconds: 901, label: "901s" } }],
    ["NaN access TTL", { accessTtl: { seconds: NaN, label: "NaN" } }],
    ["Infinity access TTL", { accessTtl: { seconds: Infinity, label: "Infinity" } }],
  ])("rejects %s before touching the database", (_label, overrides) => {
    expect(() =>
      createAuthSessionService(trapDb(), {
        ...baseOptions,
        ...overrides,
      }),
    ).toThrow("accessTtl.seconds must be a positive integer no greater than 900");
  });

  it.each([
    ["zero session TTL", 0],
    ["negative session TTL", -1],
    ["fractional session TTL", 1.5],
    ["session TTL over seven days", SESSION_TTL_MS + 1],
    ["NaN session TTL", NaN],
    ["Infinity session TTL", Infinity],
  ])("rejects %s before touching the database", (_label, sessionTtlMs) => {
    expect(() =>
      createAuthSessionService(trapDb(), {
        ...baseOptions,
        sessionTtlMs,
      }),
    ).toThrow("sessionTtlMs must be a positive integer no greater than seven days");
  });

  it("defaults the schema to public and validates the explicit schema", () => {
    expect(DEFAULT_DATABASE_SCHEMA).toBe("public");
    for (const schema of ["public", "qa_auth_alt", "_internal", "A1", "a".repeat(63)]) {
      expect(() => assertValidDatabaseSchema(schema), schema).not.toThrow();
    }
  });

  it.each([
    ["empty", ""],
    ["blank", " "],
    ["leading digit", "1bad"],
    ["dash", "bad-name"],
    ["quote", 'bad"name'],
    ["semicolon", "bad;drop"],
    ["NUL", "bad\0name"],
    ["non-ASCII", "público"],
    ["over 63 bytes", "a".repeat(64)],
  ])("rejects an invalid schema identifier: %s", (_label, schema) => {
    expect(() => assertValidDatabaseSchema(schema)).toThrow(
      "databaseSchema must be a valid PostgreSQL identifier",
    );
    expect(() =>
      createAuthSessionService(trapDb(), {
        ...baseOptions,
        databaseSchema: schema,
      }),
    ).toThrow("databaseSchema must be a valid PostgreSQL identifier");
  });
});
