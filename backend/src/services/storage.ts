import type { Readable } from "node:stream";
import { env } from "../config/env.js";
import {
  resolveArtifactReferenceContext,
  resolveArtifactReferenceContextForBucket,
  type ArtifactDefaultKind,
  type ArtifactReferenceContext,
} from "./artifact-reference.js";
import { createStorageProvider } from "./storage-factory.js";
import { mlS3Client, s3Client } from "./storage-minio.js";
import {
  assertBody,
  assertValidContentType,
  assertValidStorageKey,
  resolveStorageProviderConfig,
  resolveStorageTtlSeconds,
  type StorageProvider,
} from "./storage-provider.js";

export { s3Client };

export interface ArtifactStoragePort {
  getArtifactReferenceContext(kind: ArtifactDefaultKind): ArtifactReferenceContext;
  /** Trusted context for an already-persisted row bucket; never extends the allowlist. */
  getArtifactRecordContext(bucketOrContainer: string): ArtifactReferenceContext;
  /** Effective configured download TTL (1..3600); the default is 3600 today. */
  getDownloadTtlSeconds(): number;
  getDownloadUrl(bucket: string, key: string, expiresIn?: number): Promise<string>;
  getMlDownloadUrl(bucket: string, key: string, expiresIn?: number): Promise<string>;
}

let defaultProvider: StorageProvider | null = null;

function getDefaultProvider(): StorageProvider {
  if (defaultProvider === null) {
    const config = resolveStorageProviderConfig(env);
    defaultProvider = createStorageProvider(config, {
      minio:
        config.provider === "minio"
          ? { client: s3Client, mlClient: mlS3Client }
          : undefined,
    });
  }
  return defaultProvider;
}

/**
 * Backward-compatible facade. Public signatures and `s3Client` stay stable;
 * provider resolution is lazy and performs no network I/O at construction.
 */
export class StorageService {
  static async ensureBucket(bucketName: string): Promise<void> {
    await getDefaultProvider().ensure(bucketName);
  }

  static async upload(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array,
    contentType = "image/jpeg",
  ): Promise<string> {
    assertValidStorageKey(key);
    assertBody(body);
    const safeContentType = assertValidContentType(contentType);
    const provider = getDefaultProvider();
    await provider.ensure(bucket);
    await provider.upload(bucket, key, body, safeContentType);
    return `${bucket}/${key}`;
  }

  static async getDownloadUrl(
    bucket: string,
    key: string,
    expiresIn?: number,
  ): Promise<string> {
    const ttl = resolveStorageTtlSeconds(expiresIn, env.STORAGE_DOWNLOAD_TTL_SECONDS);
    return getDefaultProvider().sign(bucket, key, ttl, "internal");
  }

  static async getMlDownloadUrl(
    bucket: string,
    key: string,
    expiresIn?: number,
  ): Promise<string> {
    const ttl = resolveStorageTtlSeconds(expiresIn, env.STORAGE_DOWNLOAD_TTL_SECONDS);
    return getDefaultProvider().sign(bucket, key, ttl, "ml");
  }

  static async getObjectStream(bucket: string, key: string): Promise<Readable> {
    return getDefaultProvider().read(bucket, key);
  }

  /**
   * Additive trusted metadata for artifact references. It deliberately avoids
   * provider construction, credentials and network I/O.
   */
  static getArtifactReferenceContext(
    kind: ArtifactDefaultKind,
  ): ArtifactReferenceContext {
    return resolveArtifactReferenceContext(env, kind);
  }

  /** Trusted row context: the bucket must already be allowlisted (no extension). */
  static getArtifactRecordContext(
    bucketOrContainer: string,
  ): ArtifactReferenceContext {
    return resolveArtifactReferenceContextForBucket(env, bucketOrContainer);
  }

  /** Effective configured TTL; 300 s remains a 4.8 change, not a 3.4 default. */
  static getDownloadTtlSeconds(): number {
    return resolveStorageTtlSeconds(undefined, env.STORAGE_DOWNLOAD_TTL_SECONDS);
  }

  static getStorageId(): string {
    return getDefaultProvider().storageId;
  }
}
