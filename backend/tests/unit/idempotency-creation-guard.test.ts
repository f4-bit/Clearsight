import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/lib/http-error.js";
import type { PrismaClient } from "../../src/lib/prisma.js";
import {
  createInferenceCreationService,
  type InferenceCreationDeps,
} from "../../src/services/inference-creation.js";
import { FEATURES } from "../fixtures/clinical.js";

const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const IMAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface SeamCalls {
  verifySession: number;
  getOwnedImageContext: number;
  prepareClinicalSnapshot: number;
  enqueue: number;
  transaction: number;
}

/**
 * Every dependency seam counts its calls and throws if it is ever reached, so
 * a default key generation or a reordered validation cannot pass silently.
 */
function stubDeps() {
  const calls: SeamCalls = {
    verifySession: 0,
    getOwnedImageContext: 0,
    prepareClinicalSnapshot: 0,
    enqueue: 0,
    transaction: 0,
  };
  const deps = {
    prisma: {
      $transaction: vi.fn(async () => {
        calls.transaction += 1;
        throw new Error("prisma.$transaction must not run");
      }),
    } as unknown as PrismaClient,
    access: {
      getOwnedImageContext: vi.fn(async () => {
        calls.getOwnedImageContext += 1;
        throw new Error("access.getOwnedImageContext must not run");
      }),
      getInferenceForRead: vi.fn(),
    },
    authService: {
      verifySession: vi.fn(async () => {
        calls.verifySession += 1;
        throw new Error("authService.verifySession must not run");
      }),
    },
    mlClient: {
      prepareClinicalSnapshot: vi.fn(async () => {
        calls.prepareClinicalSnapshot += 1;
        throw new Error("mlClient.prepareClinicalSnapshot must not run");
      }),
    },
    enqueue: vi.fn(async () => {
      calls.enqueue += 1;
      throw new Error("enqueue must not run");
    }),  };
  return { deps: deps as unknown as InferenceCreationDeps, calls };
}

function makeInput(idempotencyKey: unknown, role: "OFTALMOLOGO" | "INVESTIGADOR" = "OFTALMOLOGO") {
  return {
    subject: { id: SUBJECT_ID, role },
    claims: {
      sub: SUBJECT_ID,
      role,
      sessionId: SESSION_ID,
      tokenVersion: 0,
    },
    idempotencyKey: idempotencyKey as string,
    imageId: IMAGE_ID,
    eyeSide: "OD" as const,
    clinicalFeatures: FEATURES,
  };
}

describe("creation service never defaults or generates an Idempotency-Key", () => {
  it("rejects a missing, empty, whitespace, array, comma-joined or overlong key before any dependency", async () => {
    const invalidKeys = [
      undefined,
      null,
      "",
      "   ",
      ["a", "b"],
      "a,b",
      "a b",
      "a".repeat(129),
    ];
    for (const key of invalidKeys) {
      const { deps, calls } = stubDeps();
      const service = createInferenceCreationService(deps);
      let caught: unknown;
      try {
        await service.create(makeInput(key));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).statusCode).toBe(400);
      expect(calls).toEqual({
        verifySession: 0,
        getOwnedImageContext: 0,
        prepareClinicalSnapshot: 0,
        enqueue: 0,
        transaction: 0,
      });
    }
  });

  it("keeps the role guard ahead of the header error at the service seam", async () => {
    const { deps, calls } = stubDeps();
    const service = createInferenceCreationService(deps);
    await expect(
      service.create(makeInput(undefined, "INVESTIGADOR")),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual({
      verifySession: 0,
      getOwnedImageContext: 0,
      prepareClinicalSnapshot: 0,
      enqueue: 0,
      transaction: 0,
    });
  });
});
