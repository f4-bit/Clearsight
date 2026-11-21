import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { env } from "../config/env.js";
import {
  assertBody,
  assertMinioBucketName,
  assertValidContentType,
  assertValidStorageKey,
  normalizeContentType,
  resolveStorageTtlSeconds,
  StorageProviderError,
  type MinioStorageConfig,
  type StorageProvider,
  type StorageSignEndpoint,
} from "./storage-provider.js";

export interface S3CommandClient {
  send(command: any): Promise<any>;
}

export type S3Presigner = (
  client: S3CommandClient,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface MinioProviderDeps {
  client?: S3CommandClient;
  mlClient?: S3CommandClient;
  signer?: S3Presigner;
}

function endpointFor(config: MinioStorageConfig, mlEndpoint: boolean): string {
  const protocol = config.secure ? "https" : "http";
  if (mlEndpoint && config.mlPublicHost !== null) {
    return `${protocol}://${config.mlPublicHost}`;
  }
  return `${protocol}://${config.endpoint}:${config.port}`;
}

function createS3Client(config: MinioStorageConfig, mlEndpoint: boolean): S3Client {
  return new S3Client({
    endpoint: endpointFor(config, mlEndpoint),
    region: "us-east-1",
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
}

const legacyMinioConfig: MinioStorageConfig = {
  endpoint: env.MINIO_ENDPOINT.trim(),
  port: env.MINIO_PORT,
  secure: env.MINIO_SECURE,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  mlPublicHost:
    env.ML_PUBLIC_HOST !== undefined && env.ML_PUBLIC_HOST.trim() !== ""
      ? env.ML_PUBLIC_HOST.trim()
      : null,
};

/** Legacy named export kept for callers/tests that imported it directly. */
export const s3Client = createS3Client(legacyMinioConfig, false);
export const mlS3Client = createS3Client(legacyMinioConfig, true);

const defaultSigner: S3Presigner = (client, command, options) =>
  getSignedUrl(client as unknown as S3Client, command, options);

function s3ErrorFields(error: unknown): {
  status: number | undefined;
  code: string | undefined;
  name: string | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { status: undefined, code: undefined, name: undefined };
  }
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status = candidate.$metadata?.httpStatusCode ?? candidate.statusCode;
  return {
    status: typeof status === "number" ? status : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
  };
}

function isS3NotFound(error: unknown): boolean {
  const { status, code, name } = s3ErrorFields(error);
  return (
    status === 404 ||
    code === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NoSuchBucket" ||
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NoSuchBucket"
  );
}

function isS3PermissionDenied(error: unknown): boolean {
  const { status, code, name } = s3ErrorFields(error);
  return (
    status === 401 ||
    status === 403 ||
    code === "AccessDenied" ||
    code === "Forbidden" ||
    code === "InvalidAccessKeyId" ||
    code === "SignatureDoesNotMatch" ||
    name === "AccessDenied" ||
    name === "Forbidden"
  );
}

function isS3AlreadyOwned(error: unknown): boolean {
  const { code, name } = s3ErrorFields(error);
  return (
    code === "AlreadyOwnedByYou" ||
    code === "BucketAlreadyOwnedByYou" ||
    name === "AlreadyOwnedByYou" ||
    name === "BucketAlreadyOwnedByYou"
  );
}

function isS3BucketAlreadyExists(error: unknown): boolean {
  const { code, name } = s3ErrorFields(error);
  return code === "BucketAlreadyExists" || name === "BucketAlreadyExists";
}

function safeS3Error(
  error: unknown,
  fallback:
    | "storage_unavailable"
    | "storage_read_failed"
    | "storage_upload_failed",
): StorageProviderError {
  if (error instanceof StorageProviderError) {
    return error;
  }
  if (isS3PermissionDenied(error)) {
    return new StorageProviderError("storage_permission_denied");
  }
  return new StorageProviderError(fallback);
}

export class MinioStorageProvider implements StorageProvider {
  readonly provider = "minio" as const;
  readonly storageId: string;
  private readonly client: S3CommandClient;
  private readonly mlClient: S3CommandClient;
  private readonly signer: S3Presigner;

  constructor(
    config: MinioStorageConfig,
    storageId: string,
    deps: MinioProviderDeps = {},
  ) {
    this.storageId = storageId;
    this.client = deps.client ?? createS3Client(config, false);
    this.mlClient = deps.mlClient ?? createS3Client(config, true);
    this.signer = deps.signer ?? defaultSigner;
  }

  async ensure(bucket: string): Promise<void> {
    assertMinioBucketName(bucket);
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (!isS3NotFound(error)) {
        throw safeS3Error(error, "storage_unavailable");
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (isS3AlreadyOwned(error)) {
        return;
      }
      if (isS3BucketAlreadyExists(error)) {
        throw new StorageProviderError("storage_ensure_conflict");
      }
      throw safeS3Error(error, "storage_unavailable");
    }
  }

  async upload(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertMinioBucketName(bucket);
    assertValidStorageKey(key);
    const byteLength = assertBody(body);
    const safeContentType = assertValidContentType(contentType);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: safeContentType,
        }),
      );
    } catch (error) {
      throw safeS3Error(error, "storage_upload_failed");
    }

    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      const actualLength = Number(head?.ContentLength);
      const expectedType = normalizeContentType(safeContentType);
      const actualType = normalizeContentType(
        typeof head?.ContentType === "string" ? head.ContentType : undefined,
      );
      if (
        !Number.isFinite(actualLength) ||
        actualLength !== byteLength ||
        expectedType === null ||
        actualType !== expectedType
      ) {
        throw new StorageProviderError("storage_upload_verification_failed");
      }
    } catch (error) {
      if (error instanceof StorageProviderError) {
        throw error;
      }
      throw new StorageProviderError("storage_upload_verification_failed");
    }
  }

  async sign(
    bucket: string,
    key: string,
    expiresInSeconds: number,
    endpoint: StorageSignEndpoint,
  ): Promise<string> {
    assertMinioBucketName(bucket);
    assertValidStorageKey(key);
    const ttl = resolveStorageTtlSeconds(expiresInSeconds, expiresInSeconds);
    const client = endpoint === "ml" ? this.mlClient : this.client;

    // Existence is checked against the internal endpoint; only the presigned URL
    // is generated for the ML-reachable host.
    if (!(await this.existsWith(this.client, bucket, key))) {
      throw new StorageProviderError("storage_object_missing");
    }

    try {
      return await this.signer(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttl },
      );
    } catch (error) {
      throw safeS3Error(error, "storage_unavailable");
    }
  }

  async read(bucket: string, key: string): Promise<Readable> {
    assertMinioBucketName(bucket);
    assertValidStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const body = response?.Body;
      if (body instanceof Readable) {
        return body;
      }
      if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
        return Readable.from(body as AsyncIterable<Uint8Array>);
      }
      throw new StorageProviderError("storage_read_failed");
    } catch (error) {
      if (isS3NotFound(error)) {
        throw new StorageProviderError("storage_object_missing");
      }
      throw safeS3Error(error, "storage_read_failed");
    }
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    assertMinioBucketName(bucket);
    assertValidStorageKey(key);
    return this.existsWith(this.client, bucket, key);
  }

  private async existsWith(
    client: S3CommandClient,
    bucket: string,
    key: string,
  ): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) {
        return false;
      }
      throw safeS3Error(error, "storage_unavailable");
    }
  }
}
