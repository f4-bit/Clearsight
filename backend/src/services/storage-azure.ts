import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  type BlobSASSignatureValues,
} from "@azure/storage-blob";
import { Readable } from "node:stream";
import {
  assertAzureContainerName,
  assertBody,
  assertValidContentType,
  assertValidStorageKey,
  normalizeContentType,
  resolveStorageTtlSeconds,
  StorageProviderError,
  type AzureStorageConfig,
  type StorageProvider,
  type StorageSignEndpoint,
} from "./storage-provider.js";

export interface AzureBlobLike {
  readonly url: string;
  getProperties(): Promise<{ contentLength?: number; contentType?: string }>;
  download(): Promise<{ readableStreamBody?: unknown }>;
}

export interface AzureBlockBlobLike extends AzureBlobLike {
  uploadData(
    data: Buffer | Uint8Array,
    options: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<unknown>;
}

export interface AzureContainerLike {
  exists(): Promise<boolean>;
  getBlobClient(blobName: string): AzureBlobLike;
  getBlockBlobClient(blobName: string): AzureBlockBlobLike;
}

export interface AzureBlobServiceLike {
  getContainerClient(containerName: string): AzureContainerLike;
}

export type AzureSasGenerator = (
  values: BlobSASSignatureValues,
  credential: StorageSharedKeyCredential,
) => { toString(): string };

export interface AzureProviderDeps {
  blobServiceClient?: AzureBlobServiceLike;
  credential?: StorageSharedKeyCredential;
  now?: () => Date;
  generateSas?: AzureSasGenerator;
}

function azureErrorFields(error: unknown): {
  status: number | undefined;
  code: string | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { status: undefined, code: undefined };
  }
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return {
    status: typeof candidate.statusCode === "number" ? candidate.statusCode : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
  };
}

function isAzureNotFound(error: unknown): boolean {
  const { status, code } = azureErrorFields(error);
  return (
    status === 404 ||
    code === "BlobNotFound" ||
    code === "ContainerNotFound" ||
    code === "ResourceNotFound"
  );
}

function isAzurePermissionDenied(error: unknown): boolean {
  const { status, code } = azureErrorFields(error);
  return (
    status === 401 ||
    status === 403 ||
    code === "AuthorizationFailure" ||
    code === "AuthenticationFailed" ||
    code === "InsufficientAccountPermissions"
  );
}

function safeAzureError(
  error: unknown,
  fallback:
    | "storage_unavailable"
    | "storage_read_failed"
    | "storage_upload_failed",
): StorageProviderError {
  if (error instanceof StorageProviderError) {
    return error;
  }
  if (isAzurePermissionDenied(error)) {
    return new StorageProviderError("storage_permission_denied");
  }
  return new StorageProviderError(fallback);
}

export class AzureStorageProvider implements StorageProvider {
  readonly provider = "azure" as const;
  readonly storageId: string;
  private readonly service: AzureBlobServiceLike;
  private readonly credential: StorageSharedKeyCredential;
  private readonly now: () => Date;
  private readonly generateSas: AzureSasGenerator;

  constructor(
    config: AzureStorageConfig,
    storageId: string,
    deps: AzureProviderDeps = {},
  ) {
    this.storageId = storageId;
    try {
      this.credential =
        deps.credential ??
        new StorageSharedKeyCredential(config.accountName, config.accountKey);
    } catch {
      throw new StorageProviderError("storage_invalid_config");
    }
    this.service =
      deps.blobServiceClient ??
      new BlobServiceClient(config.accountUrl, this.credential);
    this.now = deps.now ?? (() => new Date());
    this.generateSas = deps.generateSas ?? generateBlobSASQueryParameters;
  }

  async ensure(containerName: string): Promise<void> {
    const container = this.container(containerName);
    try {
      if (!(await container.exists())) {
        throw new StorageProviderError("storage_container_missing");
      }
    } catch (error) {
      throw safeAzureError(error, "storage_unavailable");
    }
  }

  async upload(
    containerName: string,
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertAzureContainerName(containerName);
    assertValidStorageKey(key);
    const byteLength = assertBody(body);
    const safeContentType = assertValidContentType(contentType);
    const container = this.container(containerName);
    const blob = container.getBlockBlobClient(key);

    try {
      await blob.uploadData(body, {
        blobHTTPHeaders: { blobContentType: safeContentType },
      });
    } catch (error) {
      throw safeAzureError(error, "storage_upload_failed");
    }

    try {
      const properties = await blob.getProperties();
      const expectedType = normalizeContentType(safeContentType);
      const actualType = normalizeContentType(properties.contentType);
      if (
        properties.contentLength !== byteLength ||
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
    containerName: string,
    key: string,
    expiresInSeconds: number,
    _endpoint: StorageSignEndpoint,
  ): Promise<string> {
    assertAzureContainerName(containerName);
    assertValidStorageKey(key);
    const ttl = resolveStorageTtlSeconds(expiresInSeconds, expiresInSeconds);
    const blob = this.container(containerName).getBlobClient(key);

    if (!(await this.existsBlob(blob))) {
      throw new StorageProviderError("storage_object_missing");
    }

    const startsOn = this.now();
    let sas: string;
    try {
      // Azure service SAS wire format uses `sp` for signed permissions. D22's
      // `p=r` shorthand means read-only; the official SDK owns the exact query
      // parameter names (`sp=r`, `sr=b`, `spr=https`).
      sas = this.generateSas(
        {
          containerName,
          blobName: key,
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
          startsOn,
          expiresOn: new Date(startsOn.getTime() + ttl * 1000),
        },
        this.credential,
      ).toString();
    } catch {
      throw new StorageProviderError("storage_unavailable");
    }

    const separator = blob.url.includes("?") ? "&" : "?";
    return `${blob.url}${separator}${sas}`;
  }

  async read(containerName: string, key: string): Promise<Readable> {
    assertAzureContainerName(containerName);
    assertValidStorageKey(key);
    const blob = this.container(containerName).getBlobClient(key);

    let response: { readableStreamBody?: unknown };
    try {
      response = await blob.download();
    } catch (error) {
      if (isAzureNotFound(error)) {
        throw new StorageProviderError("storage_object_missing");
      }
      throw safeAzureError(error, "storage_read_failed");
    }

    const body = response?.readableStreamBody;
    if (body instanceof Readable) {
      return body;
    }
    if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
      return Readable.from(body as AsyncIterable<Uint8Array>);
    }
    throw new StorageProviderError("storage_read_failed");
  }

  async exists(containerName: string, key: string): Promise<boolean> {
    assertAzureContainerName(containerName);
    assertValidStorageKey(key);
    return this.existsBlob(this.container(containerName).getBlobClient(key));
  }

  private container(containerName: string): AzureContainerLike {
    assertAzureContainerName(containerName);
    return this.service.getContainerClient(containerName);
  }

  private async existsBlob(blob: AzureBlobLike): Promise<boolean> {
    try {
      await blob.getProperties();
      return true;
    } catch (error) {
      if (isAzureNotFound(error)) {
        return false;
      }
      throw safeAzureError(error, "storage_unavailable");
    }
  }
}

export function createAzureStorageProvider(
  config: AzureStorageConfig,
  storageId: string,
  deps: AzureProviderDeps = {},
): AzureStorageProvider {
  return new AzureStorageProvider(config, storageId, deps);
}
