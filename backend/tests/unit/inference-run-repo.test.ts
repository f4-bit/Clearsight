import { describe, expect, it } from "vitest";

import { createInferenceRunRepository } from "../../src/repositories/inference-run.repo.js";
import type { Db } from "../../src/repositories/types.js";

function noIoDb(): Db {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("repository construction must not touch the database");
      },
    },
  ) as unknown as Db;
}

describe("inference run repository schema option", () => {
  it("rejects invalid or empty schema identifiers before any IO", () => {
    const db = noIoDb();

    expect(() =>
      createInferenceRunRepository(db, { databaseSchema: "public;drop" }),
    ).toThrow(/databaseSchema/);
    expect(() =>
      createInferenceRunRepository(db, { databaseSchema: "" }),
    ).toThrow(/databaseSchema/);
  });

  it("accepts the default and an explicit validated schema without IO", () => {
    const db = noIoDb();

    expect(() => createInferenceRunRepository(db)).not.toThrow();
    expect(() =>
      createInferenceRunRepository(db, { databaseSchema: "public" }),
    ).not.toThrow();
  });
});
