import { isValidArtifactKey } from "../lib/artifact-key.js";
import { ArtifactRefSchema, type ArtifactRef } from "../schemas/inference.js";
import {
  assertAzureContainerName,
  assertMinioBucketName,
  isStorageProviderName,
  resolveStorageLogicalId,
  type StorageProviderName,
} from "./storage-provider.js";

/** Binary image vs Grad-CAM defaults. `result` intentionally has no default. */
export type ArtifactDefaultKind = "image" | "gradcam";

export interface ArtifactReferenceEnv {
  STORAGE_PROVIDER?: string | undefined;
  STORAGE_ID?: string | undefined;
  STORAGE_ALLOWED_BUCKETS?: string | undefined;
  MINIO_BUCKET_RAW: string;
  MINIO_BUCKET_GRADCAM: string;
  MINIO_BUCKET_MASK?: string | undefined;
  MINIO_BUCKET_OVERLAY?: string | undefined;
  MINIO_BUCKET_PDF?: string | undefined;
}

export interface ArtifactReferenceContext {
  readonly provider: StorageProviderName;
  readonly storageId: string;
  readonly allowedBuckets: readonly string[];
  readonly defaultBucket: string;
}

export interface StructuredArtifactLocation {
  readonly storageId: string;
  readonly bucketOrContainer: string;
  readonly key: string;
}

export type ArtifactReferenceInput = string | StructuredArtifactLocation;

/** Logical location resolved from trusted configuration; never a full ArtifactRef. */
export interface ArtifactLocation {
  readonly provider: StorageProviderName;
  readonly storageId: string;
  readonly bucketOrContainer: string;
  readonly key: string;
}

export type ArtifactReferenceErrorCode =
  | "artifact_reference_invalid"
  | "artifact_reference_invalid_config"
  | "artifact_reference_invalid_bucket"
  | "artifact_reference_invalid_key"
  | "artifact_reference_storage_mismatch"
  | "artifact_record_invalid";

const URI = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/;

/** Safe error: no raw reference, bucket, account or SDK details are exposed. */
export class ArtifactReferenceError extends Error {
  readonly code: ArtifactReferenceErrorCode;

  constructor(code: ArtifactReferenceErrorCode) {
    super("Artifact reference is invalid");
    this.name = "ArtifactReferenceError";
    this.code = code;
  }
}

function fail(code: ArtifactReferenceErrorCode): never {
  throw new ArtifactReferenceError(code);
}

function assertConfiguredBucket(
  provider: StorageProviderName,
  bucket: string,
): void {
  if (typeof bucket !== "string" || bucket.length === 0) {
    fail("artifact_reference_invalid_config");
  }
  try {
    if (provider === "minio") {
      assertMinioBucketName(bucket);
    } else {
      assertAzureContainerName(bucket);
    }
  } catch {
    fail("artifact_reference_invalid_config");
  }
}

function assertAllowedBucket(
  context: ArtifactReferenceContext,
  bucket: string,
): string {
  if (
    typeof bucket !== "string" ||
    bucket.length === 0 ||
    bucket.includes("@") ||
    bucket.includes(":")
  ) {
    fail("artifact_reference_invalid");
  }
  if (!context.allowedBuckets.includes(bucket)) {
    fail("artifact_reference_invalid_bucket");
  }
  try {
    if (context.provider === "minio") {
      assertMinioBucketName(bucket);
    } else {
      assertAzureContainerName(bucket);
    }
  } catch {
    fail("artifact_reference_invalid_bucket");
  }
  return bucket;
}

function assertArtifactKey(key: string): void {
  if (!isValidArtifactKey(key)) {
    fail("artifact_reference_invalid_key");
  }
}

function validateContext(context: ArtifactReferenceContext): void {
  if (!isStorageProviderName(context.provider)) {
    fail("artifact_reference_invalid_config");
  }
  if (typeof context.storageId !== "string") {
    fail("artifact_reference_invalid_config");
  }
  let normalizedStorageId: string;
  try {
    normalizedStorageId = resolveStorageLogicalId(
      context.provider,
      context.storageId,
    );
  } catch {
    return fail("artifact_reference_invalid_config");
  }
  if (normalizedStorageId !== context.storageId) {
    fail("artifact_reference_invalid_config");
  }
  if (
    !Array.isArray(context.allowedBuckets) ||
    context.allowedBuckets.length === 0
  ) {
    fail("artifact_reference_invalid_config");
  }
  for (const bucket of context.allowedBuckets) {
    assertConfiguredBucket(context.provider, bucket);
  }
  if (
    typeof context.defaultBucket !== "string" ||
    !context.allowedBuckets.includes(context.defaultBucket)
  ) {
    fail("artifact_reference_invalid_config");
  }
  assertConfiguredBucket(context.provider, context.defaultBucket);
}

function parseStructured(
  input: StructuredArtifactLocation,
  context: ArtifactReferenceContext,
): ArtifactLocation {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.storageId !== "string" ||
    input.storageId !== context.storageId
  ) {
    fail("artifact_reference_storage_mismatch");
  }
  const bucketOrContainer = assertAllowedBucket(
    context,
    input.bucketOrContainer,
  );
  assertArtifactKey(input.key);
  return {
    provider: context.provider,
    storageId: context.storageId,
    bucketOrContainer,
    key: input.key,
  };
}

function parseString(
  reference: string,
  context: ArtifactReferenceContext,
): ArtifactLocation {
  if (reference.length === 0 || reference.trim().length === 0) {
    fail("artifact_reference_invalid");
  }

  const uri = URI.exec(reference);
  if (uri !== null) {
    const scheme = uri[1]!.toLowerCase();
    if (scheme !== "s3" && scheme !== "azure") {
      fail("artifact_reference_invalid");
    }
    if (
      (scheme === "s3" && context.provider !== "minio") ||
      (scheme === "azure" && context.provider !== "azure")
    ) {
      fail("artifact_reference_invalid");
    }

    const remainder = uri[2]!;
    const separator = remainder.indexOf("/");
    if (separator <= 0) {
      fail("artifact_reference_invalid");
    }
    const bucketOrContainer = remainder.slice(0, separator);
    const key = remainder.slice(separator + 1);
    assertArtifactKey(key);
    return {
      provider: context.provider,
      storageId: context.storageId,
      bucketOrContainer: assertAllowedBucket(context, bucketOrContainer),
      key,
    };
  }

  const separator = reference.indexOf("/");
  const firstSegment =
    separator === -1 ? reference : reference.slice(0, separator);

  if (context.allowedBuckets.includes(firstSegment)) {
    if (separator === -1 || separator === reference.length - 1) {
      fail("artifact_reference_invalid");
    }
    const key = reference.slice(separator + 1);
    assertArtifactKey(key);
    return {
      provider: context.provider,
      storageId: context.storageId,
      bucketOrContainer: assertAllowedBucket(context, firstSegment),
      key,
    };
  }

  assertArtifactKey(reference);
  return {
    provider: context.provider,
    storageId: context.storageId,
    bucketOrContainer: context.defaultBucket,
    key: reference,
  };
}

/**
 * Pure parser. It never loads an SDK, performs network I/O, reads the
 * filesystem or consults global environment variables.
 */
export function parseArtifactLocation(
  input: ArtifactReferenceInput,
  context: ArtifactReferenceContext,
): ArtifactLocation {
  validateContext(context);
  if (typeof input === "string") {
    return parseString(input, context);
  }
  return parseStructured(input, context);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function resolveProviderIdentity(
  input: ArtifactReferenceEnv,
): { provider: StorageProviderName; storageId: string } {
  const rawProvider = input.STORAGE_PROVIDER ?? "minio";
  if (!isStorageProviderName(rawProvider)) {
    fail("artifact_reference_invalid_config");
  }
  const provider = rawProvider;
  let storageId: string;
  try {
    storageId = resolveStorageLogicalId(provider, input.STORAGE_ID);
  } catch {
    return fail("artifact_reference_invalid_config");
  }
  return { provider, storageId };
}

/**
 * Resolves only the configured allowlist. It intentionally accepts an explicit
 * list that contains artifact buckets (mask/overlay/pdf) without forcing the
 * raw/Grad-CAM defaults into it. Row-context callers use this together with a
 * check that the row bucket was already configured; they never extend the list.
 */
export function resolveAllowedBuckets(
  input: ArtifactReferenceEnv,
  provider: StorageProviderName,
): string[] {
  const rawBucket = input.MINIO_BUCKET_RAW;
  const gradcamBucket = input.MINIO_BUCKET_GRADCAM;
  assertConfiguredBucket(provider, rawBucket);
  assertConfiguredBucket(provider, gradcamBucket);

  // Mask/overlay/PDF defaults are additive when the operator configures them
  // explicitly. An explicit STORAGE_ALLOWED_BUCKETS still wins and must contain
  // the bucket a caller wants to use; no bucket is ever added implicitly.
  const artifactBuckets = [
    input.MINIO_BUCKET_MASK,
    input.MINIO_BUCKET_OVERLAY,
    input.MINIO_BUCKET_PDF,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );

  let allowedBuckets: string[];
  if (input.STORAGE_ALLOWED_BUCKETS === undefined) {
    allowedBuckets = dedupe([rawBucket, gradcamBucket, ...artifactBuckets]);
  } else {
    const entries = input.STORAGE_ALLOWED_BUCKETS.split(",").map((entry) =>
      entry.trim(),
    );
    if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
      fail("artifact_reference_invalid_config");
    }
    allowedBuckets = dedupe(entries);
  }

  if (allowedBuckets.length === 0) {
    fail("artifact_reference_invalid_config");
  }
  for (const bucket of allowedBuckets) {
    assertConfiguredBucket(provider, bucket);
  }
  return allowedBuckets;
}

/**
 * Resolves trusted metadata without requiring Azure account credentials. The
 * actual signer still resolves the active provider lazily from its own config.
 */
export function resolveArtifactReferenceContext(
  input: ArtifactReferenceEnv,
  defaultKind: ArtifactDefaultKind,
): ArtifactReferenceContext {
  const { provider, storageId } = resolveProviderIdentity(input);
  const defaultBucket =
    defaultKind === "image" ? input.MINIO_BUCKET_RAW : input.MINIO_BUCKET_GRADCAM;
  const allowedBuckets = resolveAllowedBuckets(input, provider);
  if (!allowedBuckets.includes(defaultBucket)) {
    fail("artifact_reference_invalid_config");
  }
  return {
    provider,
    storageId,
    allowedBuckets,
    defaultBucket,
  };
}

/**
 * Builds a trusted context for one already-persisted row bucket. The bucket
 * must be in the configured allowlist; it is never added to it and no default
 * is invented. This lets an explicit list such as mask/overlay/pdf work without
 * requiring the image/Grad-CAM defaults to be present.
 */
export function resolveArtifactReferenceContextForBucket(
  input: ArtifactReferenceEnv,
  bucketOrContainer: string,
): ArtifactReferenceContext {
  const { provider, storageId } = resolveProviderIdentity(input);
  const allowedBuckets = resolveAllowedBuckets(input, provider);
  assertConfiguredBucket(provider, bucketOrContainer);
  if (!allowedBuckets.includes(bucketOrContainer)) {
    fail("artifact_reference_invalid_bucket");
  }
  return {
    provider,
    storageId,
    allowedBuckets,
    defaultBucket: bucketOrContainer,
  };
}

export interface ArtifactRecordReferenceRow {
  readonly artifactType: string;
  readonly status: string;
  readonly storageId: string | null;
  readonly bucketOrContainer: string | null;
  readonly key: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: bigint | number | null;
  readonly checksumSha256: string | null;
  readonly failureCode: string | null;
  readonly retryable: boolean;
  readonly updatedAt: Date | string;
}

/** Converts a DB row to the strict binary DTO without inventing metadata. */
export function mapArtifactRecordToRef(
  row: ArtifactRecordReferenceRow,
): ArtifactRef {
  try {
    let sizeBytes: number | null;
    if (row.sizeBytes === null) {
      sizeBytes = null;
    } else if (typeof row.sizeBytes === "bigint") {
      if (
        row.sizeBytes < 0n ||
        row.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        fail("artifact_record_invalid");
      }
      sizeBytes = Number(row.sizeBytes);
    } else if (
      typeof row.sizeBytes === "number" &&
      Number.isSafeInteger(row.sizeBytes) &&
      row.sizeBytes >= 0
    ) {
      sizeBytes = row.sizeBytes;
    } else {
      fail("artifact_record_invalid");
    }

    const updatedAt =
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt;
    const parsed = ArtifactRefSchema.safeParse({
      artifactType: row.artifactType,
      status: row.status,
      storageId: row.storageId,
      bucketOrContainer: row.bucketOrContainer,
      key: row.key,
      contentType: row.contentType,
      sizeBytes,
      checksumSha256: row.checksumSha256,
      failureCode: row.failureCode,
      retryable: row.retryable,
      updatedAt,
    });
    if (!parsed.success) {
      fail("artifact_record_invalid");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ArtifactReferenceError) {
      throw error;
    }
    return fail("artifact_record_invalid");
  }
}
