import { describe, expect, it } from "vitest";
import { FEATURES } from "../fixtures/clinical.js";
import { HttpError } from "../../src/lib/http-error.js";
import {
  buildIdempotencyPayloadHash,
  canonicalizeClinicalFeatures,
  parseAcceptedResponse,
  parseIdempotencyKey,
} from "../../src/services/idempotency.js";

const IMAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function expectHttpStatus(run: () => unknown, statusCode: number): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(statusCode);
    return;
  }
  throw new Error(`expected HttpError ${statusCode}`);
}

function baseInput() {
  return {
    imageId: IMAGE_ID,
    eyeSide: "OD" as const,
    clinicalFeatures: { ...FEATURES },
  };
}

describe("Idempotency-Key header", () => {
  it("accepts exactly one ASCII header in the 1..128 pattern", () => {
    expect(parseIdempotencyKey("abc.DEF_123:-xyz")).toBe("abc.DEF_123:-xyz");
    expect(parseIdempotencyKey("a".repeat(128))).toBe("a".repeat(128));
  });

  it("rejects missing, empty, whitespace, arrays, comma-joined and invalid values", () => {
    for (const value of [undefined, "", "   ", ["a", "b"], "a,b", "a b", "a/b", "a".repeat(129)]) {
      expectHttpStatus(() => parseIdempotencyKey(value), 400);
    }
  });
});

describe("canonical idempotency payload hash", () => {
  it("is stable across clone, feature key order and UUID casing", () => {
    const canonical = buildIdempotencyPayloadHash(baseInput());
    const reordered = Object.fromEntries(
      Object.entries(FEATURES).reverse(),
    ) as typeof FEATURES;

    expect(
      buildIdempotencyPayloadHash({
        ...baseInput(),
        imageId: IMAGE_ID.toUpperCase(),
        clinicalFeatures: reordered,
      }),
    ).toBe(canonical);
  });

  it("treats omitted and null optionals identically", () => {
    const canonical = buildIdempotencyPayloadHash(baseInput());
    expect(
      buildIdempotencyPayloadHash({
        ...baseInput(),
        modelVersion: null,
        reanalysisOf: null,
      }),
    ).toBe(canonical);
  });

  it("changes when the image, eye, feature, modelVersion or parent changes", () => {
    const canonical = buildIdempotencyPayloadHash(baseInput());
    const variants = [
      { ...baseInput(), imageId: PARENT_ID },
      { ...baseInput(), eyeSide: "OS" as const },
      {
        ...baseInput(),
        clinicalFeatures: { ...FEATURES, Age: FEATURES.Age + 1 },
      },
      { ...baseInput(), modelVersion: "2026-09-24" },
      { ...baseInput(), reanalysisOf: PARENT_ID },
    ];

    for (const variant of variants) {
      expect(buildIdempotencyPayloadHash(variant)).not.toBe(canonical);
    }
  });

  it("uses only the eleven canonical features and never mutates the input", () => {
    const features = { ...FEATURES, extra: "ignored" } as typeof FEATURES & {
      extra: string;
    };
    const snapshot = structuredClone(features);
    const canonical = buildIdempotencyPayloadHash({
      ...baseInput(),
      clinicalFeatures: features,
    });

    expect(features).toEqual(snapshot);
    expect(canonicalizeClinicalFeatures(features)).toEqual(FEATURES);

    const prototypeOnly = Object.create(null) as Record<string, number>;
    for (const [key, value] of Object.entries(FEATURES)) {
      prototypeOnly[key] = value;
    }
    expect(
      buildIdempotencyPayloadHash({
        ...baseInput(),
        clinicalFeatures: prototypeOnly as unknown as typeof FEATURES,
      }),
    ).toBe(canonical);
  });

  it("rejects malformed direct-service input without hashing raw values", () => {
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          imageId: "not-a-uuid",
        }),
      422,
    );
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          eyeSide: "XX" as never,
        }),
      422,
    );
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          clinicalFeatures: { ...FEATURES, Age: Number.NaN },
        }),
      422,
    );
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          clinicalFeatures: { ...FEATURES, Age: undefined } as never,
        }),
      422,
    );
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          reanalysisOf: "not-a-uuid",
        }),
      422,
    );
    expectHttpStatus(
      () =>
        buildIdempotencyPayloadHash({
          ...baseInput(),
          modelVersion: "",
        }),
      422,
    );
  });
});

describe("strict stored 202 replay", () => {
  const valid = {
    inferenceId: IMAGE_ID,
    jobId: IMAGE_ID,
    status: "QUEUED",
  };

  it("accepts only the exact accepted 202 shape", () => {
    expect(
      parseAcceptedResponse({
        inferenceId: IMAGE_ID,
        state: "ACCEPTED",
        responseStatus: 202,
        responseBody: valid,
      }),
    ).toEqual(valid);
  });

  it("rejects unknown fields, URLs, wrong status and mismatched execution", () => {
    const cases = [
      { ...valid, signedUrl: "https://example.test/x" },
      { ...valid, status: "COMPLETED" },
      { ...valid, inferenceId: PARENT_ID },
      { inferenceId: IMAGE_ID, jobId: "not-a-uuid", status: "QUEUED" },
    ];
    for (const body of cases) {
      expectHttpStatus(
        () =>
          parseAcceptedResponse({
            inferenceId: IMAGE_ID,
            state: "ACCEPTED",
            responseStatus: 202,
            responseBody: body,
          }),
        503,
      );
    }
    expectHttpStatus(
      () =>
        parseAcceptedResponse({
          inferenceId: IMAGE_ID,
          state: "PENDING",
          responseStatus: null,
          responseBody: null,
        }),
      503,
    );
  });
});
