import type { Readable } from "node:stream";

export const STORAGE_PROVIDERS = ["minio", "azure"] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];
export type StorageSignEndpoint = "internal" | "ml";

export const STORAGE_TTL_MIN_SECONDS = 1;
export const STORAGE_TTL_MAX_SECONDS = 3600;
export const DEFAULT_STORAGE_TTL_SECONDS = 3600;
export const DEFAULT_MINIO_STORAGE_ID = "minio-local";
export const DEFAULT_AZURE_STORAGE_ID = "azure-blob-default";

export type StorageErrorCode =
  | "storage_invalid_provider"
  | "storage_invalid_config"
  | "storage_invalid_bucket"
  | "storage_invalid_key"
  | "storage_invalid_ttl"
  | "storage_invalid_body"
  | "storage_invalid_content_type"
  | "storage_object_missing"
  | "storage_container_missing"
  | "storage_permission_denied"
  | "storage_ensure_conflict"
  | "storage_upload_failed"
  | "storage_upload_verification_failed"
  | "storage_read_failed"
  | "storage_unavailable";

/**
 * Safe storage failure. The message and enumerable fields intentionally omit
 * SDK errors, URLs, credentials and causes so they can cross logs/API boundaries.
 */
export class StorageProviderError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode) {
    super("Storage operation failed");
    this.name = "StorageProviderError";
    this.code = code;
  }
}

export interface StorageProvider {
  readonly provider: StorageProviderName;
  readonly storageId: string;
  ensure(bucketOrContainer: string): Promise<void>;
  upload(
    bucketOrContainer: string,
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void>;
  sign(
    bucketOrContainer: string,
    key: string,
    expiresInSeconds: number,
    endpoint: StorageSignEndpoint,
  ): Promise<string>;
  read(bucketOrContainer: string, key: string): Promise<Readable>;
  exists(bucketOrContainer: string, key: string): Promise<boolean>;
}

export interface MinioStorageConfig {
  endpoint: string;
  port: number;
  secure: boolean;
  accessKey: string;
  secretKey: string;
  mlPublicHost: string | null;
}

export interface AzureStorageConfig {
  accountUrl: string;
  accountName: string;
  accountKey: string;
}

export interface StorageProviderConfig {
  provider: StorageProviderName;
  storageId: string;
  downloadTtlSeconds: number;
  minio: MinioStorageConfig;
  azure: AzureStorageConfig | null;
}

export interface StorageEnvInput {
  STORAGE_PROVIDER?: string | undefined;
  STORAGE_ID?: string | undefined;
  STORAGE_ALLOWED_BUCKETS?: string | undefined;
  STORAGE_DOWNLOAD_TTL_SECONDS?: number | undefined;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_SECURE?: boolean | string | undefined;
  ML_PUBLIC_HOST?: string | undefined;
  AZURE_STORAGE_ACCOUNT_URL?: string | undefined;
  AZURE_STORAGE_ACCOUNT_NAME?: string | undefined;
  AZURE_STORAGE_ACCOUNT_KEY?: string | undefined;
}

const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AZURE_ACCOUNT_NAME_PATTERN = /^[a-z0-9]{3,24}$/;
const MINIO_HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const AZURE_ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function isStorageProviderName(value: unknown): value is StorageProviderName {
  return value === "minio" || value === "azure";
}

/**
 * Resolves the logical storage id from trusted configuration without loading any
 * SDK or credentials. Reference parsing uses this before signing so an Azure
 * deployment can describe its identity even when account secrets are not
 * needed yet.
 */
export function resolveStorageLogicalId(
  provider: StorageProviderName,
  storageId: string | undefined,
): string {
  const defaultStorageId =
    provider === "azure" ? DEFAULT_AZURE_STORAGE_ID : DEFAULT_MINIO_STORAGE_ID;
  const resolved = storageId?.trim() || defaultStorageId;
  if (!STORAGE_ID_PATTERN.test(resolved)) {
    throw new StorageProviderError("storage_invalid_config");
  }
  return resolved;
}

export function resolveStorageTtlSeconds(
  requested: number | undefined,
  configured: number,
): number {
  const ttl = requested ?? configured;
  if (
    !Number.isInteger(ttl) ||
    ttl < STORAGE_TTL_MIN_SECONDS ||
    ttl > STORAGE_TTL_MAX_SECONDS
  ) {
    throw new StorageProviderError("storage_invalid_ttl");
  }
  return ttl;
}

/**
 * Strict boolean flag parser for security-sensitive env values. Absent means the
 * provided default; only real booleans or the exact lowercase strings "true" /
 * "false" are accepted. No silent coercion of "TRUE", "yes", "1" or empty.
 */
export function parseMinioSecure(
  value: unknown,
  defaultValue = false,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new StorageProviderError("storage_invalid_config");
}

const CONTENT_TYPE_MEDIA_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const CONTENT_TYPE_PARAMETER = /^[A-Za-z0-9!#$&^_.+-]+=[^\u0000-\u001F\u007F]+$/;

/**
 * Validates a caller-supplied Content-Type before any storage I/O. Returns the
 * trimmed value (content types are not object keys and may be normalized here).
 */
export function assertValidContentType(contentType: string): string {
  if (typeof contentType !== "string") {
    throw new StorageProviderError("storage_invalid_content_type");
  }
  const trimmed = contentType.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    /[\u0000-\u001F\u007F]/.test(trimmed)
  ) {
    throw new StorageProviderError("storage_invalid_content_type");
  }
  const [mediaType, ...parameters] = trimmed.split(";");
  if (mediaType === undefined || !CONTENT_TYPE_MEDIA_TYPE.test(mediaType)) {
    throw new StorageProviderError("storage_invalid_content_type");
  }
  for (const parameter of parameters) {
    const normalized = parameter.trim();
    if (!CONTENT_TYPE_PARAMETER.test(normalized)) {
      throw new StorageProviderError("storage_invalid_content_type");
    }
  }
  return trimmed;
}

export function assertValidStorageKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageProviderError("storage_invalid_key");
  }
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      throw new StorageProviderError("storage_invalid_key");
    }
  }
}

export function assertMinioBucketName(bucket: string): void {
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new StorageProviderError("storage_invalid_bucket");
  }
}

export function assertAzureContainerName(container: string): void {
  if (
    container.length < 3 ||
    container.length > 63 ||
    !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(container) ||
    container.includes("--")
  ) {
    throw new StorageProviderError("storage_invalid_bucket");
  }
}

export function assertMinioHost(host: string): string {
  const normalized = host.trim();
  if (normalized.length === 0 || normalized !== host) {
    throw new StorageProviderError("storage_invalid_config");
  }
  const labels = normalized.split(".");
  if (
    labels.length === 0 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !MINIO_HOST_LABEL_PATTERN.test(label),
    )
  ) {
    throw new StorageProviderError("storage_invalid_config");
  }
  return normalized;
}

export function parseMlPublicHost(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.includes("://") ||
    /[/?#@*\\]/.test(normalized)
  ) {
    throw new StorageProviderError("storage_invalid_config");
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(normalized);
  if (match === null) {
    throw new StorageProviderError("storage_invalid_config");
  }
  const host = assertMinioHost(match[1] ?? "");
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new StorageProviderError("storage_invalid_config");
    }
    return `${host}:${port}`;
  }
  return host;
}

export function assertAzureAccountName(accountName: string): void {
  if (!AZURE_ACCOUNT_NAME_PATTERN.test(accountName)) {
    throw new StorageProviderError("storage_invalid_config");
  }
}

export function assertAzureAccountKey(accountKey: string): void {
  if (
    accountKey.length === 0 ||
    !AZURE_ACCOUNT_KEY_PATTERN.test(accountKey) ||
    accountKey.length % 4 !== 0
  ) {
    throw new StorageProviderError("storage_invalid_config");
  }
  const decoded = Buffer.from(accountKey, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== accountKey) {
    throw new StorageProviderError("storage_invalid_config");
  }
}

export function assertAzureAccountUrl(
  accountUrl: string,
  accountName: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(accountUrl);
  } catch {
    throw new StorageProviderError("storage_invalid_config");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.hostname !== `${accountName}.blob.core.windows.net`
  ) {
    throw new StorageProviderError("storage_invalid_config");
  }
  return parsed.toString();
}

export function normalizeContentType(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType.length > 0 ? mediaType : null;
}

export function assertBody(body: Buffer | Uint8Array): number {
  if (!(body instanceof Uint8Array) || body.byteLength === 0) {
    throw new StorageProviderError("storage_invalid_body");
  }
  return body.byteLength;
}

export function resolveStorageProviderConfig(
  input: StorageEnvInput,
): StorageProviderConfig {
  const rawProvider = input.STORAGE_PROVIDER ?? "minio";
  if (!isStorageProviderName(rawProvider)) {
    throw new StorageProviderError("storage_invalid_provider");
  }

  const provider = rawProvider;
  const configuredTtl = input.STORAGE_DOWNLOAD_TTL_SECONDS ?? DEFAULT_STORAGE_TTL_SECONDS;
  const downloadTtlSeconds = resolveStorageTtlSeconds(undefined, configuredTtl);
  const storageId = resolveStorageLogicalId(provider, input.STORAGE_ID);

  const minio: MinioStorageConfig = {
    endpoint: assertMinioHost(input.MINIO_ENDPOINT),
    port: input.MINIO_PORT,
    secure: parseMinioSecure(input.MINIO_SECURE, false),
    accessKey: input.MINIO_ACCESS_KEY,
    secretKey: input.MINIO_SECRET_KEY,
    mlPublicHost: parseMlPublicHost(input.ML_PUBLIC_HOST),
  };
  if (
    !Number.isInteger(minio.port) ||
    minio.port < 1 ||
    minio.port > 65_535 ||
    minio.accessKey.length === 0 ||
    minio.secretKey.length === 0
  ) {
    throw new StorageProviderError("storage_invalid_config");
  }

  if (provider === "azure") {
    const accountName = input.AZURE_STORAGE_ACCOUNT_NAME?.trim() ?? "";
    const accountUrl = input.AZURE_STORAGE_ACCOUNT_URL?.trim() ?? "";
    const accountKey = input.AZURE_STORAGE_ACCOUNT_KEY?.trim() ?? "";
    if (accountName.length === 0 || accountUrl.length === 0 || accountKey.length === 0) {
      throw new StorageProviderError("storage_invalid_config");
    }
    assertAzureAccountName(accountName);
    assertAzureAccountKey(accountKey);
    const normalizedAccountUrl = assertAzureAccountUrl(accountUrl, accountName);
    return {
      provider,
      storageId,
      downloadTtlSeconds,
      minio,
      azure: {
        accountUrl: normalizedAccountUrl,
        accountName,
        accountKey,
      },
    };
  }

  return {
    provider,
    storageId,
    downloadTtlSeconds,
    minio,
    azure: null,
  };
}
