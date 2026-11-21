import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AzureStorageProvider,
  type AzureBlobLike,
  type AzureBlobServiceLike,
  type AzureBlockBlobLike,
  type AzureContainerLike,
} from "../../src/services/storage-azure.js";
import { createStorageProvider } from "../../src/services/storage-factory.js";
import {
  MinioStorageProvider,
  type S3CommandClient,
  type S3Presigner,
} from "../../src/services/storage-minio.js";
import {
  assertAzureContainerName,
  assertBody,
  assertMinioBucketName,
  assertValidContentType,
  assertValidStorageKey,
  normalizeContentType,
  parseMinioSecure,
  parseMlPublicHost,
  resolveStorageLogicalId,
  resolveStorageProviderConfig,
  resolveStorageTtlSeconds,
  StorageProviderError,
  type MinioStorageConfig,
  type StorageEnvInput,
} from "../../src/services/storage-provider.js";

const AZURE_KEY = Buffer.alloc(64, 7).toString("base64");
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

const MINIO_CONFIG: MinioStorageConfig = {
  endpoint: "localhost",
  port: 9000,
  secure: false,
  accessKey: "minio-test-key",
  secretKey: "minio-test-secret",
  mlPublicHost: "minio-ml:9001",
};

const MINIO_ENV: StorageEnvInput = {
  STORAGE_PROVIDER: "minio",
  MINIO_ENDPOINT: "localhost",
  MINIO_PORT: 9000,
  MINIO_ACCESS_KEY: "minio-test-key",
  MINIO_SECRET_KEY: "minio-test-secret",
  MINIO_SECURE: false,
  ML_PUBLIC_HOST: "minio-ml:9001",
};

const AZURE_ENV: StorageEnvInput = {
  ...MINIO_ENV,
  STORAGE_PROVIDER: "azure",
  AZURE_STORAGE_ACCOUNT_URL: "https://acct.blob.core.windows.net",
  AZURE_STORAGE_ACCOUNT_NAME: "acct",
  AZURE_STORAGE_ACCOUNT_KEY: AZURE_KEY,
};

function sdkError(
  status: number,
  code: string,
  message = "sdk failure",
): Error & { $metadata: { httpStatusCode: number }; code: string } {
  const error = new Error(message) as Error & {
    $metadata: { httpStatusCode: number };
    code: string;
  };
  error.name = code;
  error.code = code;
  error.$metadata = { httpStatusCode: status };
  return error;
}

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}

class FakeS3Client implements S3CommandClient {
  readonly calls: unknown[] = [];
  private readonly handler: (command: unknown) => Promise<unknown>;

  constructor(handler: (command: unknown) => Promise<unknown>) {
    this.handler = handler;
  }

  async send(command: unknown): Promise<unknown> {
    this.calls.push(command);
    return this.handler(command);
  }
}

function minioProvider(options: {
  handler: (command: unknown) => Promise<unknown>;
  signer?: S3Presigner;
  mlHandler?: (command: unknown) => Promise<unknown>;
}): {
  provider: MinioStorageProvider;
  client: FakeS3Client;
  mlClient: FakeS3Client;
} {
  const client = new FakeS3Client(options.handler);
  const mlClient = new FakeS3Client(
    options.mlHandler ?? options.handler,
  );
  return {
    provider: new MinioStorageProvider(MINIO_CONFIG, "minio-local", {
      client,
      mlClient,
      signer: options.signer,
    }),
    client,
    mlClient,
  };
}

function realPresigner(): {
  signer: S3Presigner;
  presignClient: S3Client;
  seenClients: S3CommandClient[];
} {
  const presignClient = new S3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    credentials: {
      accessKeyId: "minio-test-key",
      secretAccessKey: "minio-test-secret",
    },
    forcePathStyle: true,
  });
  const seenClients: S3CommandClient[] = [];
  const signer: S3Presigner = (client, command, options) => {
    seenClients.push(client);
    return getSignedUrl(presignClient, command, options);
  };
  return { signer, presignClient, seenClients };
}

function azureBlobUrl(container: string, key: string): string {
  const credential = new StorageSharedKeyCredential("acct", AZURE_KEY);
  return new BlobServiceClient(
    "https://acct.blob.core.windows.net",
    credential,
  )
    .getContainerClient(container)
    .getBlobClient(key).url;
}

function azureService(options: {
  key: string;
  exists?: boolean;
  properties?: { contentLength?: number; contentType?: string };
  propertiesError?: unknown;
  downloadBody?: unknown;
  downloadError?: unknown;
  uploadError?: unknown;
  uploadedProperties?: { contentLength?: number; contentType?: string };
}): {
  service: AzureBlobServiceLike;
  container: AzureContainerLike;
  blob: AzureBlobLike;
  blockBlob: AzureBlockBlobLike;
  uploadData: ReturnType<typeof vi.fn>;
  getProperties: ReturnType<typeof vi.fn>;
} {
  const url = azureBlobUrl("mask-bucket", options.key);
  const getProperties = vi.fn();
  if (options.propertiesError !== undefined) {
    getProperties.mockRejectedValue(options.propertiesError);
  } else {
    getProperties.mockResolvedValue(
      options.properties ?? { contentLength: 1, contentType: "image/png" },
    );
  }

  const uploadData = vi.fn();
  if (options.uploadError !== undefined) {
    uploadData.mockRejectedValue(options.uploadError);
  } else {
    uploadData.mockResolvedValue({});
  }

  const blockBlob: AzureBlockBlobLike = {
    url,
    uploadData,
    getProperties: vi.fn().mockResolvedValue(
      options.uploadedProperties ?? { contentLength: 1, contentType: "image/png" },
    ),
    download: vi.fn(),
  };
  const blob: AzureBlobLike = {
    url,
    getProperties,
    download: vi.fn().mockImplementation(async () => {
      if (options.downloadError !== undefined) {
        throw options.downloadError;
      }
      return { readableStreamBody: options.downloadBody };
    }),
  };
  const container: AzureContainerLike = {
    exists: vi.fn().mockResolvedValue(options.exists ?? true),
    getBlobClient: vi.fn(() => blob),
    getBlockBlobClient: vi.fn(() => blockBlob),
  };
  const service: AzureBlobServiceLike = {
    getContainerClient: vi.fn(() => container),
  };
  return { service, container, blob, blockBlob, uploadData, getProperties };
}

function azureProvider(options: Parameters<typeof azureService>[0]): {
  provider: AzureStorageProvider;
  fake: ReturnType<typeof azureService>;
} {
  const fake = azureService(options);
  return {
    provider: new AzureStorageProvider(
      {
        accountUrl: "https://acct.blob.core.windows.net/",
        accountName: "acct",
        accountKey: AZURE_KEY,
      },
      "azure-blob-default",
      {
        blobServiceClient: fake.service,
        now: () => FIXED_NOW,
      },
    ),
    fake,
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof StorageProviderError ? error.code : undefined;
  }
}

describe("storage config and validation", () => {
  it("resolves MinIO as the backward-compatible default with TTL 3600", () => {
    const config = resolveStorageProviderConfig({
      ...MINIO_ENV,
      STORAGE_PROVIDER: undefined,
      STORAGE_DOWNLOAD_TTL_SECONDS: undefined,
    });
    expect(config.provider).toBe("minio");
    expect(config.storageId).toBe("minio-local");
    expect(config.downloadTtlSeconds).toBe(3600);
    expect(config.azure).toBeNull();
  });

  it("resolves Azure defaults and keeps Azure config explicit", () => {
    const config = resolveStorageProviderConfig(AZURE_ENV);
    expect(config.provider).toBe("azure");
    expect(config.storageId).toBe("azure-blob-default");
    expect(config.azure).toEqual({
      accountUrl: "https://acct.blob.core.windows.net/",
      accountName: "acct",
      accountKey: AZURE_KEY,
    });
  });

  it("accepts an explicit logical storage id and TTL", () => {
    const config = resolveStorageProviderConfig({
      ...MINIO_ENV,
      STORAGE_ID: "local-lab",
      STORAGE_DOWNLOAD_TTL_SECONDS: 120,
    });
    expect(config.storageId).toBe("local-lab");
    expect(config.downloadTtlSeconds).toBe(120);
  });

  it("resolves logical ids without requiring provider credentials", () => {
    expect(resolveStorageLogicalId("minio", undefined)).toBe("minio-local");
    expect(resolveStorageLogicalId("azure", undefined)).toBe("azure-blob-default");
    expect(resolveStorageLogicalId("minio", " local-lab ")).toBe("local-lab");
    expect(errorCode(() => resolveStorageLogicalId("minio", "bad id!"))).toBe(
      "storage_invalid_config",
    );
  });

  it("rejects unknown providers and invalid Azure config without MinIO fallback", () => {
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          STORAGE_PROVIDER: "gcs",
        }),
      ),
    ).toBe("storage_invalid_provider");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL: undefined,
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL: "https://evil.example.com",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL: "http://acct.blob.core.windows.net",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL:
            "https://acct.blob.core.windows.net/container",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL:
            "https://acct.blob.core.windows.net?sv=1",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL:
            "https://user:pass@acct.blob.core.windows.net",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_URL: "https://*.blob.core.windows.net",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_NAME: "other",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_KEY: "not-base64",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_NAME: "ab",
          AZURE_STORAGE_ACCOUNT_URL: "https://ab.blob.core.windows.net",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...AZURE_ENV,
          AZURE_STORAGE_ACCOUNT_NAME: "Acct",
          AZURE_STORAGE_ACCOUNT_URL: "https://Acct.blob.core.windows.net",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({ ...MINIO_ENV, MINIO_PORT: 0 }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({ ...MINIO_ENV, MINIO_PORT: 70_000 }),
      ),
    ).toBe("storage_invalid_config");
  });

  it("rejects malformed storage ids instead of permissive defaults", () => {
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({ ...MINIO_ENV, STORAGE_ID: "bad id!" }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({ ...MINIO_ENV, STORAGE_ID: "-leading-dash" }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          STORAGE_ID: "x".repeat(129),
        }),
      ),
    ).toBe("storage_invalid_config");
  });

  it("rejects invalid MinIO hosts, ML hosts and ports", () => {
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          MINIO_ENDPOINT: "http://localhost",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          MINIO_ENDPOINT: "local host",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          ML_PUBLIC_HOST: "minio:9000/path",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          ML_PUBLIC_HOST: "user@minio:9000",
        }),
      ),
    ).toBe("storage_invalid_config");
    expect(parseMlPublicHost("minio:9000")).toBe("minio:9000");
    expect(parseMlPublicHost(undefined)).toBeNull();
    expect(errorCode(() => parseMlPublicHost("minio:0"))).toBe(
      "storage_invalid_config",
    );
    expect(errorCode(() => parseMlPublicHost("minio:70000"))).toBe(
      "storage_invalid_config",
    );
  });

  it("clamps TTL to 1..3600 and validates explicit overrides", () => {
    expect(resolveStorageTtlSeconds(undefined, 3600)).toBe(3600);
    expect(resolveStorageTtlSeconds(120, 3600)).toBe(120);
    expect(resolveStorageTtlSeconds(1, 3600)).toBe(1);
    expect(resolveStorageTtlSeconds(3600, 3600)).toBe(3600);
    expect(() => resolveStorageTtlSeconds(0, 3600)).toThrowError(
      StorageProviderError,
    );
    expect(() => resolveStorageTtlSeconds(3601, 3600)).toThrowError(
      StorageProviderError,
    );
    expect(() => resolveStorageTtlSeconds(1.5, 3600)).toThrowError(
      StorageProviderError,
    );
  });

  it("parses MINIO_SECURE strictly without reading the real env or SDKs", () => {
    expect(parseMinioSecure(undefined)).toBe(false);
    expect(parseMinioSecure(undefined, true)).toBe(true);
    expect(parseMinioSecure(true)).toBe(true);
    expect(parseMinioSecure(false)).toBe(false);
    expect(parseMinioSecure("true")).toBe(true);
    expect(parseMinioSecure("false")).toBe(false);
    for (const invalid of ["TRUE", "False", "yes", "1", "0", "", " true "]) {
      expect(errorCode(() => parseMinioSecure(invalid))).toBe(
        "storage_invalid_config",
      );
    }

    expect(
      resolveStorageProviderConfig({
        ...MINIO_ENV,
        MINIO_SECURE: "true",
      }).minio.secure,
    ).toBe(true);
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          MINIO_SECURE: "TRUE",
        }),
      ),
    ).toBe("storage_invalid_config");
  });

  it("validates content types before storage I/O", () => {
    expect(assertValidContentType("image/jpeg")).toBe("image/jpeg");
    expect(assertValidContentType("application/pdf;charset=utf-8")).toBe(
      "application/pdf;charset=utf-8",
    );
    expect(assertValidContentType("image/png; charset=\"utf-8\"")).toBe(
      "image/png; charset=\"utf-8\"",
    );
    for (const invalid of [
      "",
      "   ",
      "image",
      "image/",
      " / ",
      "image/jpeg\r\nX-Evil: 1",
      "image/jpeg\u0000",
      "image/jpeg;",
      "image/jpeg; charset=",
    ]) {
      expect(errorCode(() => assertValidContentType(invalid))).toBe(
        "storage_invalid_content_type",
      );
    }
  });

  it("validates buckets, containers, keys and bodies locally", () => {
    expect(() => assertMinioBucketName("raw-retinas")).not.toThrow();
    expect(() => assertMinioBucketName("gradcam-overlays")).not.toThrow();
    expect(() => assertMinioBucketName("bad--bucket")).not.toThrow();
    expect(() => assertMinioBucketName("Bad-Bucket")).toThrowError(
      StorageProviderError,
    );
    expect(() => assertMinioBucketName("ab")).toThrowError(StorageProviderError);
    expect(() => assertMinioBucketName("bad..bucket")).toThrowError(
      StorageProviderError,
    );

    expect(() => assertAzureContainerName("raw-retinas")).not.toThrow();
    expect(() => assertAzureContainerName("gradcam-overlays")).not.toThrow();
    expect(() => assertAzureContainerName("bad--container")).toThrowError(
      StorageProviderError,
    );

    expect(() => assertValidStorageKey("carpeta 1/100% real/ñandú-🩺.png")).not.toThrow();
    expect(() => assertValidStorageKey("a/./b")).toThrowError(StorageProviderError);
    expect(() => assertValidStorageKey("a/../b")).toThrowError(StorageProviderError);
    expect(() => assertValidStorageKey("a/.../b")).not.toThrow();
    expect(() => assertBody(Buffer.alloc(0))).toThrowError(StorageProviderError);
    expect(normalizeContentType("IMAGE/JPEG; charset=utf-8")).toBe("image/jpeg");
  });
});

describe("MinIO provider", () => {
  it("creates only on 404 and accepts AlreadyOwnedByYou races", async () => {
    const { provider, client } = minioProvider({
      handler: async (command) => {
        if (command instanceof HeadBucketCommand) {
          throw sdkError(404, "NotFound");
        }
        if (command instanceof CreateBucketCommand) {
          throw sdkError(409, "AlreadyOwnedByYou");
        }
        throw new Error("unexpected command");
      },
    });
    await expect(provider.ensure("raw-retinas")).resolves.toBeUndefined();
    expect(client.calls.map(commandName)).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
    ]);
  });

  it("does not create on permission errors and does not absorb a foreign bucket", async () => {
    const permission = minioProvider({
      handler: async (command) => {
        if (command instanceof HeadBucketCommand) {
          throw sdkError(403, "AccessDenied");
        }
        throw new Error("unexpected command");
      },
    });
    await expect(permission.provider.ensure("raw-retinas")).rejects.toMatchObject({
      code: "storage_permission_denied",
    });
    expect(permission.client.calls.map(commandName)).toEqual(["HeadBucketCommand"]);

    const foreign = minioProvider({
      handler: async (command) => {
        if (command instanceof HeadBucketCommand) {
          throw sdkError(404, "NotFound");
        }
        if (command instanceof CreateBucketCommand) {
          throw sdkError(409, "BucketAlreadyExists");
        }
        throw new Error("unexpected command");
      },
    });
    await expect(foreign.provider.ensure("raw-retinas")).rejects.toMatchObject({
      code: "storage_ensure_conflict",
    });
  });

  it("uploads with the exact key and verifies HeadObject length/type", async () => {
    const key = "carpeta 1/100% real/ñandú-🩺.png";
    const { provider, client } = minioProvider({
      handler: async (command) => {
        if (command instanceof PutObjectCommand) {
          return {};
        }
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 3, ContentType: "image/jpeg" };
        }
        throw new Error("unexpected command");
      },
    });
    const body = Buffer.from("abc");
    await expect(provider.upload("raw-retinas", key, body, "image/jpeg")).resolves.toBeUndefined();
    const put = client.calls[0] as PutObjectCommand;
    const head = client.calls[1] as HeadObjectCommand;
    expect(put.input.Key).toBe(key);
    expect(head.input.Key).toBe(key);
  });

  it("fails empty bodies and metadata mismatches without declaring success", async () => {
    const empty = minioProvider({
      handler: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(
      empty.provider.upload("raw-retinas", "a.png", Buffer.alloc(0), "image/png"),
    ).rejects.toMatchObject({ code: "storage_invalid_body" });
    expect(empty.client.calls).toHaveLength(0);

    const badType = minioProvider({
      handler: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(
      badType.provider.upload("raw-retinas", "a.png", Buffer.from("abc"), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_content_type" });
    expect(badType.client.calls).toHaveLength(0);

    const mismatch = minioProvider({
      handler: async (command) => {
        if (command instanceof PutObjectCommand) {
          return {};
        }
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 99, ContentType: "image/png" };
        }
        throw new Error("unexpected command");
      },
    });
    await expect(
      mismatch.provider.upload("raw-retinas", "a.png", Buffer.from("abc"), "image/png"),
    ).rejects.toMatchObject({ code: "storage_upload_verification_failed" });
    // No cleanup/delete is attempted; 3.5 owns reconciliation of the orphan.
    expect(mismatch.client.calls.map(commandName)).toEqual([
      "PutObjectCommand",
      "HeadObjectCommand",
    ]);
  });

  it("maps generic upload failures to storage_upload_failed and keeps 403 safe", async () => {
    const secret = "put-secret-material";
    const generic = minioProvider({
      handler: async (command) => {
        if (command instanceof PutObjectCommand) {
          throw sdkError(500, "InternalError", `put failed with ${secret}`);
        }
        throw new Error("unexpected command");
      },
    });
    await expect(
      generic.provider.upload("raw-retinas", "a.png", Buffer.from("abc"), "image/png"),
    ).rejects.toMatchObject({ code: "storage_upload_failed" });

    const permission = minioProvider({
      handler: async (command) => {
        if (command instanceof PutObjectCommand) {
          throw sdkError(403, "AccessDenied", `put failed with ${secret}`);
        }
        throw new Error("unexpected command");
      },
    });
    let caught: unknown;
    try {
      await permission.provider.upload("raw-retinas", "a.png", Buffer.from("abc"), "image/png");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageProviderError);
    expect((caught as StorageProviderError).code).toBe("storage_permission_denied");
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it("fails when HeadObject reports a different content type", async () => {
    const mismatch = minioProvider({
      handler: async (command) => {
        if (command instanceof PutObjectCommand) {
          return {};
        }
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 3, ContentType: "image/png" };
        }
        throw new Error("unexpected command");
      },
    });
    await expect(
      mismatch.provider.upload("raw-retinas", "a.png", Buffer.from("abc"), "image/jpeg"),
    ).rejects.toMatchObject({ code: "storage_upload_verification_failed" });
  });

  it("builds distinct internal and ML endpoints including their ports", async () => {
    const provider = new MinioStorageProvider(MINIO_CONFIG, "minio-local");
    type Endpoint = { protocol: string; hostname: string; port?: string | number };
    const internals = provider as unknown as {
      client: { config: { endpoint(): Promise<Endpoint> } };
      mlClient: { config: { endpoint(): Promise<Endpoint> } };
    };
    const internal = await internals.client.config.endpoint();
    const ml = await internals.mlClient.config.endpoint();
    expect(internal.protocol).toBe("http:");
    expect(internal.hostname).toBe("localhost");
    expect(Number(internal.port)).toBe(9000);
    expect(ml.protocol).toBe("http:");
    expect(ml.hostname).toBe("minio-ml");
    expect(Number(ml.port)).toBe(9001);
  });

  it("signs with the real S3 presigner offline and preserves the exact key", async () => {
    const { signer, presignClient, seenClients } = realPresigner();
    const key = "carpeta 1/100% real/ñandú-🩺.png";
    const { provider, client, mlClient } = minioProvider({
      handler: async (command) => {
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 3, ContentType: "image/png" };
        }
        throw new Error("unexpected command");
      },
      signer,
    });

    const url = await provider.sign("raw-retinas", key, 120, "internal");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(decodeURIComponent(parsed.pathname)).toBe(`/raw-retinas/${key}`);
    expect(seenClients[0]).toBe(client);
    expect(mlClient.calls).toHaveLength(0);

    const trickyKey = "a b%20c#d?e|f";
    const trickyUrl = await provider.sign("raw-retinas", trickyKey, 120, "internal");
    const tricky = new URL(trickyUrl);
    expect(decodeURIComponent(tricky.pathname)).toBe(`/raw-retinas/${trickyKey}`);
    expect(tricky.pathname).not.toContain("?");
    expect(tricky.pathname).not.toContain("#");
    expect(tricky.pathname).toContain("%23");
    expect(tricky.pathname).toContain("%3F");
    expect(tricky.searchParams.get("X-Amz-Expires")).toBe("120");
    presignClient.destroy();
  });

  it("uses the ML endpoint client for getMlDownloadUrl sign and checks existence first", async () => {
    const { signer, seenClients, presignClient } = realPresigner();
    const { provider, client, mlClient } = minioProvider({
      handler: async (command) => {
        if (command instanceof HeadObjectCommand) {
          return { ContentLength: 3, ContentType: "image/png" };
        }
        throw new Error("unexpected command");
      },
      signer,
    });
    await provider.sign("raw-retinas", "a.png", 60, "ml");
    expect(seenClients[0]).toBe(mlClient);
    expect(client.calls.map(commandName)).toEqual(["HeadObjectCommand"]);
    expect(mlClient.calls).toHaveLength(0);
    presignClient.destroy();
  });

  it("returns object_missing before signing and distinguishes permission errors", async () => {
    const missingSigner = vi.fn<S3Presigner>();
    const missing = minioProvider({
      handler: async () => {
        throw sdkError(404, "NoSuchKey");
      },
      signer: missingSigner,
    });
    await expect(
      missing.provider.sign("raw-retinas", "missing.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_object_missing" });
    expect(missingSigner).not.toHaveBeenCalled();

    const permission = minioProvider({
      handler: async () => {
        throw sdkError(403, "AccessDenied");
      },
    });
    await expect(
      permission.provider.sign("raw-retinas", "a.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_permission_denied" });
  });

  it("does not turn a network failure during existence check into object_missing", async () => {
    const signer = vi.fn<S3Presigner>();
    const unreachable = minioProvider({
      handler: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9000");
      },
      signer,
    });
    await expect(
      unreachable.provider.sign("raw-retinas", "a.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(signer).not.toHaveBeenCalled();
  });

  it("reads a Node Readable and maps missing/undefined streams safely", async () => {
    const stream = Readable.from([Buffer.from("data")]);
    const ok = minioProvider({
      handler: async (command) => {
        if (command instanceof GetObjectCommand) {
          return { Body: stream };
        }
        throw new Error("unexpected command");
      },
    });
    await expect(ok.provider.read("raw-retinas", "a.png")).resolves.toBe(stream);

    const undefinedBody = minioProvider({
      handler: async () => ({ Body: undefined }),
    });
    await expect(
      undefinedBody.provider.read("raw-retinas", "a.png"),
    ).rejects.toMatchObject({ code: "storage_read_failed" });

    const missing = minioProvider({
      handler: async () => {
        throw sdkError(404, "NoSuchKey");
      },
    });
    await expect(missing.provider.read("raw-retinas", "a.png")).rejects.toMatchObject({
      code: "storage_object_missing",
    });
  });

  it("rejects traversal keys and invalid buckets before any SDK call", async () => {
    const { provider, client } = minioProvider({
      handler: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(
      provider.upload("raw-retinas", "a/../b.png", Buffer.from("abc"), "image/png"),
    ).rejects.toMatchObject({ code: "storage_invalid_key" });
    await expect(
      provider.ensure("Bad_Bucket"),
    ).rejects.toMatchObject({ code: "storage_invalid_bucket" });
    expect(client.calls).toHaveLength(0);
  });

  it("wraps SDK failures without leaking secrets or raw details", async () => {
    const secret = "super-secret-minio-material";
    const { provider } = minioProvider({
      handler: async () => {
        throw new Error(`sdk failed with ${secret}`);
      },
    });
    let caught: unknown;
    try {
      await provider.exists("raw-retinas", "a.png");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageProviderError);
    expect((caught as StorageProviderError).code).toBe("storage_unavailable");
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(secret);
  });
});

describe("Azure provider", () => {
  it("checks container existence only and never creates", async () => {
    const missing = azureProvider({ key: "a.png", exists: false });
    await expect(missing.provider.ensure("mask-bucket")).rejects.toMatchObject({
      code: "storage_container_missing",
    });
    expect(missing.fake.container.exists).toHaveBeenCalledTimes(1);

    const present = azureProvider({ key: "a.png", exists: true });
    await expect(present.provider.ensure("mask-bucket")).resolves.toBeUndefined();
  });

  it("uploads data and verifies getProperties length/type", async () => {
    const ok = azureProvider({
      key: "a.png",
      uploadedProperties: { contentLength: 3, contentType: "IMAGE/PNG; charset=utf-8" },
    });
    await expect(
      ok.provider.upload("mask-bucket", "a.png", Buffer.from("abc"), "image/png"),
    ).resolves.toBeUndefined();
    expect(ok.fake.uploadData).toHaveBeenCalledWith(Buffer.from("abc"), {
      blobHTTPHeaders: { blobContentType: "image/png" },
    });

    const wrongLength = azureProvider({
      key: "a.png",
      uploadedProperties: { contentLength: 99, contentType: "image/png" },
    });
    await expect(
      wrongLength.provider.upload("mask-bucket", "a.png", Buffer.from("abc"), "image/png"),
    ).rejects.toMatchObject({ code: "storage_upload_verification_failed" });

    const wrongType = azureProvider({
      key: "a.png",
      uploadedProperties: { contentLength: 3, contentType: "image/jpeg" },
    });
    await expect(
      wrongType.provider.upload("mask-bucket", "a.png", Buffer.from("abc"), "image/png"),
    ).rejects.toMatchObject({ code: "storage_upload_verification_failed" });
    // The post-upload mismatch is not deleted; 3.5 owns orphan reconciliation.
    expect(wrongType.fake.uploadData).toHaveBeenCalledTimes(1);
    expect(wrongType.fake.blockBlob.getProperties).toHaveBeenCalledTimes(1);

    const empty = azureProvider({ key: "a.png" });
    await expect(
      empty.provider.upload("mask-bucket", "a.png", Buffer.alloc(0), "image/png"),
    ).rejects.toMatchObject({ code: "storage_invalid_body" });
    expect(empty.fake.uploadData).not.toHaveBeenCalled();

    const badType = azureProvider({ key: "a.png" });
    await expect(
      badType.provider.upload("mask-bucket", "a.png", Buffer.from("abc"), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_content_type" });
    expect(badType.fake.uploadData).not.toHaveBeenCalled();
  });

  it("generates a real per-object HTTPS SAS with bounded TTL using the injected clock", async () => {
    const key = "carpeta 1/100% real/ñandú-🩺.png";
    const { provider } = azureProvider({
      key,
      properties: { contentLength: 3, contentType: "image/png" },
    });
    const url = await provider.sign("mask-bucket", key, 120, "internal");
    const parsed = new URL(url);
    // Wire format must be the official SDK's `sp`; `p` is only D22 shorthand,
    // so a homemade signer emitting `p` must not pass this test.
    expect(parsed.searchParams.get("sp")).toBe("r");
    expect(parsed.searchParams.get("p")).toBeNull();
    expect(parsed.searchParams.get("sr")).toBe("b");
    expect(parsed.searchParams.get("spr")).toBe("https");
    expect(parsed.searchParams.get("st")).toBe("2026-01-01T00:00:00Z");
    expect(parsed.searchParams.get("se")).toBe("2026-01-01T00:02:00Z");
    expect(parsed.searchParams.get("sig")).toBeTruthy();
    expect(parsed.searchParams.get("ss")).toBeNull();
    expect(parsed.searchParams.get("srt")).toBeNull();
    expect(parsed.searchParams.get("skoid")).toBeNull();
    expect(decodeURIComponent(parsed.pathname)).toBe(`/mask-bucket/${key}`);
    expect(url).not.toContain(AZURE_KEY);

    const trickyKey = "a b%20c#d?e|f";
    const tricky = azureProvider({
      key: trickyKey,
      properties: { contentLength: 3, contentType: "image/png" },
    });
    const trickyUrl = await tricky.provider.sign(
      "mask-bucket",
      trickyKey,
      120,
      "internal",
    );
    const trickyParsed = new URL(trickyUrl);
    expect(decodeURIComponent(trickyParsed.pathname)).toBe(
      `/mask-bucket/${trickyKey}`,
    );
    expect(trickyParsed.pathname).not.toContain("?");
    expect(trickyParsed.pathname).not.toContain("#");
    expect(trickyParsed.pathname).toContain("%23");
    expect(trickyParsed.pathname).toContain("%3F");
    expect(trickyParsed.searchParams.get("sp")).toBe("r");
    expect(trickyParsed.searchParams.get("sr")).toBe("b");
    expect(trickyParsed.searchParams.get("spr")).toBe("https");
  });

  it("checks existence before SAS and never turns permission errors into 404", async () => {
    const missing = azureProvider({
      key: "a.png",
      propertiesError: sdkError(404, "BlobNotFound"),
    });
    await expect(
      missing.provider.sign("mask-bucket", "a.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_object_missing" });

    const permission = azureProvider({
      key: "a.png",
      propertiesError: sdkError(403, "AuthorizationFailure"),
    });
    await expect(
      permission.provider.sign("mask-bucket", "a.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_permission_denied" });

    const unreachable = azureProvider({
      key: "a.png",
      propertiesError: new Error("connect ECONNREFUSED"),
    });
    await expect(
      unreachable.provider.sign("mask-bucket", "a.png", 60, "internal"),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("reads the download stream and maps undefined/404 safely", async () => {
    const stream = Readable.from([Buffer.from("data")]);
    const ok = azureProvider({ key: "a.png", downloadBody: stream });
    await expect(ok.provider.read("mask-bucket", "a.png")).resolves.toBe(stream);

    const undefinedBody = azureProvider({ key: "a.png" });
    await expect(
      undefinedBody.provider.read("mask-bucket", "a.png"),
    ).rejects.toMatchObject({ code: "storage_read_failed" });

    const missing = azureProvider({
      key: "a.png",
      downloadError: sdkError(404, "BlobNotFound"),
    });
    await expect(
      missing.provider.read("mask-bucket", "a.png"),
    ).rejects.toMatchObject({ code: "storage_object_missing" });
  });

  it("wraps Azure failures without leaking secrets or raw details", async () => {
    const secret = "super-secret-azure-material";
    const { provider } = azureProvider({
      key: "a.png",
      propertiesError: new Error(`azure sdk failed with ${secret}`),
    });
    let caught: unknown;
    try {
      await provider.exists("mask-bucket", "a.png");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageProviderError);
    expect((caught as StorageProviderError).code).toBe("storage_unavailable");
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(secret);
  });
});

describe("storage factory", () => {
  it("builds MinIO and Azure providers without network I/O", () => {
    const minio = createStorageProvider(resolveStorageProviderConfig(MINIO_ENV), {
      minio: {
        client: new FakeS3Client(async () => ({})),
        mlClient: new FakeS3Client(async () => ({})),
      },
    });
    expect(minio.provider).toBe("minio");
    expect(minio.storageId).toBe("minio-local");

    const azure = createStorageProvider(resolveStorageProviderConfig(AZURE_ENV));
    expect(azure.provider).toBe("azure");
    expect(azure.storageId).toBe("azure-blob-default");
  });

  it("rejects unknown providers without falling back", () => {
    expect(
      errorCode(() =>
        resolveStorageProviderConfig({
          ...MINIO_ENV,
          STORAGE_PROVIDER: "unknown",
        }),
      ),
    ).toBe("storage_invalid_provider");
  });

  it("rejects impossible factory configs without falling back to MinIO", () => {
    const base = resolveStorageProviderConfig(MINIO_ENV);
    expect(
      errorCode(() =>
        createStorageProvider({ ...base, provider: "gcs" as never }),
      ),
    ).toBe("storage_invalid_provider");
    expect(
      errorCode(() =>
        createStorageProvider({
          ...resolveStorageProviderConfig(AZURE_ENV),
          azure: null,
        }),
      ),
    ).toBe("storage_invalid_config");
  });
});
