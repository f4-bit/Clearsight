import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { env } from "../config/env.js";
import {
  ArtifactReferenceError,
  parseArtifactLocation,
  resolveArtifactReferenceContextForBucket,
  type ArtifactLocation,
  type ArtifactReferenceEnv,
  type ArtifactReferenceInput,
} from "./artifact-reference.js";
import { StorageService } from "./storage.js";
import {
  assertValidContentType,
  normalizeContentType,
  StorageProviderError,
} from "./storage-provider.js";

/**
 * Binary artifact kinds this seam can load. `result` is never a stored object.
 * `image` is the original upload referenced by `Image.storagePath`; it is used
 * only as the PDF source and is not published as an ArtifactRecord.
 */
export const ARTIFACT_CONTENT_KINDS = [
  "image",
  "mask",
  "overlay",
  "pdf",
] as const;
export type ArtifactContentKind = (typeof ARTIFACT_CONTENT_KINDS)[number];

export const DEFAULT_ARTIFACT_CONTENT_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ARTIFACT_CONTENT_MAX_BYTES = 100 * 1024 * 1024;

export interface ArtifactContentEnv extends ArtifactReferenceEnv {
  MINIO_BUCKET_MASK?: string | undefined;
  MINIO_BUCKET_OVERLAY?: string | undefined;
  MINIO_BUCKET_PDF?: string | undefined;
  ARTIFACT_CONTENT_MAX_BYTES?: number | string | undefined;
}

export type ArtifactContentErrorCode =
  | "artifact_content_invalid_reference"
  | "artifact_content_invalid_config"
  | "artifact_content_invalid_content_type"
  | "artifact_content_missing"
  | "artifact_content_empty"
  | "artifact_content_too_large"
  | "artifact_content_read_failed";

/**
 * Safe seam failure. The message and enumerable fields never contain the raw
 * reference, bucket, key, storage path or SDK/network details.
 */
export class ArtifactContentError extends Error {
  readonly code: ArtifactContentErrorCode;

  constructor(code: ArtifactContentErrorCode) {
    super("Artifact content operation failed");
    this.name = "ArtifactContentError";
    this.code = code;
  }
}

function fail(code: ArtifactContentErrorCode): never {
  throw new ArtifactContentError(code);
}

/** Minimal storage port so 6.1/3.5 and unit tests share the same seam. */
export interface ArtifactContentStoragePort {
  getObjectStream(bucketOrContainer: string, key: string): Promise<Readable>;
}

export interface LoadArtifactBytesOptions {
  readonly env?: ArtifactContentEnv;
  readonly storage?: ArtifactContentStoragePort;
  readonly maxBytes?: number | string;
}

const defaultStorage: ArtifactContentStoragePort = {
  getObjectStream: (bucketOrContainer, key) =>
    StorageService.getObjectStream(bucketOrContainer, key),
};

export interface ArtifactBytesDescription {
  readonly size: number;
  readonly checksumSha256: string;
  readonly contentType: string;
}

function resolveMaxBytes(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_ARTIFACT_CONTENT_MAX_BYTES;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_ARTIFACT_CONTENT_MAX_BYTES
  ) {
    fail("artifact_content_invalid_config");
  }
  return parsed;
}

function resolveKindBucket(
  input: ArtifactContentEnv,
  kind: ArtifactContentKind,
): string {
  const bucket =
    kind === "image"
      ? input.MINIO_BUCKET_RAW
      : kind === "mask"
        ? input.MINIO_BUCKET_MASK
        : kind === "overlay"
          ? input.MINIO_BUCKET_OVERLAY
          : input.MINIO_BUCKET_PDF;
  if (typeof bucket !== "string" || bucket.trim().length === 0) {
    // Key-only legacy references need a configured default for their kind.
    fail("artifact_content_invalid_config");
  }
  return bucket;
}

function resolveContext(
  input: ArtifactContentEnv,
  kind: ArtifactContentKind,
): ReturnType<typeof resolveArtifactReferenceContextForBucket> {
  const bucket = resolveKindBucket(input, kind);
  try {
    return resolveArtifactReferenceContextForBucket(input, bucket);
  } catch {
    // Covers an invalid provider/storage id, an invalid bucket name and an
    // explicit allowlist that does not contain the kind bucket (fail closed).
    fail("artifact_content_invalid_config");
  }
}

function toChunkBuffer(chunk: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  return null;
}

async function readBounded(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = toChunkBuffer(chunk);
      if (buffer === null) {
        fail("artifact_content_read_failed");
      }
      total += buffer.length;
      if (total > maxBytes) {
        stream.destroy();
        fail("artifact_content_too_large");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ArtifactContentError) {
      throw error;
    }
    fail("artifact_content_read_failed");
  }
  if (total === 0) {
    fail("artifact_content_empty");
  }
  return Buffer.concat(chunks, total);
}

/**
 * Trusted location resolution only: no SDK, no network and no URL signing. The
 * returned fields are the exact metadata persisted in ArtifactRecord.
 */
export function resolveArtifactContentLocation(
  reference: ArtifactReferenceInput,
  kind: ArtifactContentKind,
  options: Pick<LoadArtifactBytesOptions, "env"> = {},
): ArtifactLocation {
  const input = options.env ?? env;
  const context = resolveContext(input, kind);
  try {
    return parseArtifactLocation(reference, context);
  } catch (error) {
    if (error instanceof ArtifactReferenceError) {
      fail("artifact_content_invalid_reference");
    }
    fail("artifact_content_invalid_reference");
  }
}

/**
 * Resolves a trusted location and loads bounded bytes. It never signs URLs,
 * performs DB writes or echoes the reference in errors/logs.
 */
export async function loadArtifactBytes(
  reference: ArtifactReferenceInput,
  kind: ArtifactContentKind,
  options: LoadArtifactBytesOptions = {},
): Promise<Buffer> {
  const input = options.env ?? env;
  const storage = options.storage ?? defaultStorage;
  const maxBytes = resolveMaxBytes(
    options.maxBytes ?? input.ARTIFACT_CONTENT_MAX_BYTES,
  );
  const location = resolveArtifactContentLocation(reference, kind, {
    env: input,
  });

  let stream: Readable;
  try {
    stream = await storage.getObjectStream(
      location.bucketOrContainer,
      location.key,
    );
  } catch (error) {
    if (
      error instanceof StorageProviderError &&
      error.code === "storage_object_missing"
    ) {
      fail("artifact_content_missing");
    }
    fail("artifact_content_read_failed");
  }

  return readBounded(stream, maxBytes);
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((value, index) => bytes[index] === value);
}

function sniffContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    // "%PDF-"
    return "application/pdf";
  }
  if (
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

/**
 * Pure descriptor for already-loaded bytes. `contentType` may be supplied by a
 * trusted caller; otherwise the media type is sniffed from the magic bytes.
 */
export function describeArtifactBytes(
  bytes: Uint8Array,
  contentType?: string,
): ArtifactBytesDescription {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail("artifact_content_empty");
  }

  let resolvedContentType: string;
  if (contentType === undefined) {
    resolvedContentType = sniffContentType(bytes);
  } else {
    try {
      const valid = assertValidContentType(contentType);
      resolvedContentType = normalizeContentType(valid) ?? sniffContentType(bytes);
    } catch {
      fail("artifact_content_invalid_content_type");
    }
  }

  return {
    size: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: resolvedContentType,
  };
}
