import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CLINICAL_FEATURE_NAMES,
  type ClinicalFeatures,
} from "../schemas/clinical.js";
import { Uuid } from "../schemas/common.js";
import {
  badRequest,
  serviceUnavailable,
  unprocessable,
} from "../lib/http-error.js";

/** Versioned hash algorithm. A new algorithm requires a new scope. */
export const IDEMPOTENCY_SCOPE = "inferences:create:v1" as const;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface IdempotencyPayloadInput {
  readonly imageId: string;
  readonly eyeSide: "OD" | "OS";
  readonly clinicalFeatures: ClinicalFeatures;
  readonly modelVersion?: string | null;
  readonly reanalysisOf?: string | null;
}

export interface IdempotencyRecordLike {
  readonly inferenceId: string;
  readonly state: string;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
}

export const AcceptedIdempotencyResponseSchema = z.strictObject({
  inferenceId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: z.literal("QUEUED"),
});

export type AcceptedIdempotencyResponse = z.infer<
  typeof AcceptedIdempotencyResponseSchema
>;

/**
 * Exactly one ASCII header value. Missing, empty, whitespace-only, array,
 * comma-joined duplicates and out-of-pattern values are a safe 400 before any
 * ML call, signed URL, queue dispatch or row creation. The key is never echoed.
 */
export function parseIdempotencyKey(raw: unknown): string {
  if (Array.isArray(raw)) {
    throw badRequest("Idempotency-Key must be a single header value");
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.trim().length === 0) {
    throw badRequest("Idempotency-Key is required");
  }
  if (raw.includes(",")) {
    throw badRequest("Idempotency-Key must be a single header value");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw badRequest("Idempotency-Key is invalid");
  }
  return raw;
}

/**
 * Builds a fresh object with only the eleven canonical model inputs, in the
 * exact manifest order. It never mutates the caller's object and never copies
 * extra/prototype keys into the hash payload.
 */
export function canonicalizeClinicalFeatures(
  features: unknown,
): ClinicalFeatures {
  if (features === null || typeof features !== "object" || Array.isArray(features)) {
    throw unprocessable("Invalid clinical features");
  }
  const source = features as Record<string, unknown>;
  const canonical = {} as ClinicalFeatures;
  for (const name of CLINICAL_FEATURE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) {
      throw unprocessable("Invalid clinical features");
    }
    const value = source[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw unprocessable("Invalid clinical features");
    }
    canonical[name] = value;
  }
  return canonical;
}

function lowercaseUuid(value: unknown, field: string): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(`Invalid ${field}`);
  }
  return parsed.data.toLowerCase();
}

function normalizeModelVersion(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw unprocessable("Invalid modelVersion");
  }
  return value;
}

/**
 * SHA-256 over the closed, flat canonical payload:
 * imageId (lowercase UUID), eyeSide, the eleven clinical features in canonical
 * order, modelVersion (null when omitted) and reanalysisOf (null when omitted,
 * lowercase UUID). Signed URLs, timestamps, server IDs and server-resolved
 * defaults are intentionally excluded.
 */
export function buildIdempotencyPayloadHash(
  input: IdempotencyPayloadInput,
): string {
  if (input.eyeSide !== "OD" && input.eyeSide !== "OS") {
    throw unprocessable("Invalid eyeSide");
  }
  const canonical = {
    imageId: lowercaseUuid(input.imageId, "imageId"),
    eyeSide: input.eyeSide,
    clinicalFeatures: canonicalizeClinicalFeatures(input.clinicalFeatures),
    modelVersion: normalizeModelVersion(input.modelVersion),
    reanalysisOf:
      input.reanalysisOf === null || input.reanalysisOf === undefined
        ? null
        : lowercaseUuid(input.reanalysisOf, "reanalysisOf"),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/**
 * Strict replay validation. Unknown fields, URLs, a non-202 status, a
 * different inferenceId or a non-QUEUED body are a safe 503, never an echoed
 * driver/payload error.
 */
export function parseAcceptedResponse(
  record: IdempotencyRecordLike,
): AcceptedIdempotencyResponse {
  if (
    record.state !== "ACCEPTED" ||
    record.responseStatus !== 202 ||
    record.responseBody === null
  ) {
    throw serviceUnavailable("Idempotency record is inconsistent");
  }
  const parsed = AcceptedIdempotencyResponseSchema.safeParse(
    record.responseBody,
  );
  if (!parsed.success || parsed.data.inferenceId !== record.inferenceId) {
    throw serviceUnavailable("Idempotency record is inconsistent");
  }
  return parsed.data;
}
