import { AzureStorageProvider, type AzureProviderDeps } from "./storage-azure.js";
import { MinioStorageProvider, type MinioProviderDeps } from "./storage-minio.js";
import {
  StorageProviderError,
  type StorageProvider,
  type StorageProviderConfig,
} from "./storage-provider.js";

export interface StorageFactoryDeps {
  minio?: MinioProviderDeps;
  azure?: AzureProviderDeps;
}

export function createStorageProvider(
  config: StorageProviderConfig,
  deps: StorageFactoryDeps = {},
): StorageProvider {
  if (config.provider === "minio") {
    return new MinioStorageProvider(config.minio, config.storageId, deps.minio);
  }
  if (config.provider === "azure") {
    if (config.azure === null) {
      throw new StorageProviderError("storage_invalid_config");
    }
    return new AzureStorageProvider(config.azure, config.storageId, deps.azure);
  }
  throw new StorageProviderError("storage_invalid_provider");
}
