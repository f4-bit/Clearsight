import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStorageProvider: vi.fn(),
}));

vi.mock("../../src/services/storage-minio.js", () => ({
  s3Client: {},
  mlS3Client: {},
}));

vi.mock("../../src/services/storage-factory.js", () => ({
  createStorageProvider: mocks.createStorageProvider,
}));

import { StorageService } from "../../src/services/storage.js";
import { StorageProviderError } from "../../src/services/storage-provider.js";

const provider = {
  provider: "minio" as const,
  storageId: "minio-local",
  ensure: vi.fn().mockResolvedValue(undefined),
  upload: vi.fn().mockResolvedValue(undefined),
  sign: vi.fn().mockResolvedValue("https://signed.example/object"),
  read: vi.fn().mockResolvedValue(Readable.from([Buffer.from("data")])),
  exists: vi.fn().mockResolvedValue(true),
};

mocks.createStorageProvider.mockReturnValue(provider);

describe("StorageService facade", () => {
  it("preserves the legacy public surface and upload bucket/key return", async () => {
    const body = Buffer.from("abc");
    await expect(
      StorageService.upload("raw-retinas", "carpeta/a b.png", body, "image/png"),
    ).resolves.toBe("raw-retinas/carpeta/a b.png");
    expect(provider.ensure).toHaveBeenCalledWith("raw-retinas");
    expect(provider.upload).toHaveBeenCalledWith(
      "raw-retinas",
      "carpeta/a b.png",
      body,
      "image/png",
    );

    await expect(StorageService.getDownloadUrl("raw-retinas", "a.png")).resolves.toBe(
      "https://signed.example/object",
    );
    expect(provider.sign).toHaveBeenLastCalledWith(
      "raw-retinas",
      "a.png",
      3600,
      "internal",
    );

    await expect(
      StorageService.getMlDownloadUrl("raw-retinas", "a.png", 120),
    ).resolves.toBe("https://signed.example/object");
    expect(provider.sign).toHaveBeenLastCalledWith(
      "raw-retinas",
      "a.png",
      120,
      "ml",
    );

    const stream = await StorageService.getObjectStream("raw-retinas", "a.png");
    expect(stream).toBeInstanceOf(Readable);
    expect(provider.read).toHaveBeenCalledWith("raw-retinas", "a.png");
    expect(StorageService.getStorageId()).toBe("minio-local");
  });

  it("resolves artifact reference context without constructing a provider", () => {
    mocks.createStorageProvider.mockClear();
    expect(StorageService.getArtifactReferenceContext("image")).toMatchObject({
      provider: "minio",
      storageId: "minio-local",
      defaultBucket: "raw-retinas",
    });
    expect(
      StorageService.getArtifactReferenceContext("gradcam"),
    ).toMatchObject({
      provider: "minio",
      defaultBucket: "gradcam-overlays",
    });
    expect(mocks.createStorageProvider).not.toHaveBeenCalled();
  });

  it("validates bodies and explicit TTL overrides before provider work", async () => {
    provider.ensure.mockClear();
    provider.upload.mockClear();
    provider.sign.mockClear();

    await expect(
      StorageService.upload("raw-retinas", "empty.png", Buffer.alloc(0), "image/png"),
    ).rejects.toMatchObject({ code: "storage_invalid_body" });
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();

    await expect(
      StorageService.upload("raw-retinas", "bad.png", Buffer.from("abc"), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_content_type" });
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();

    await expect(
      StorageService.getDownloadUrl("raw-retinas", "a.png", 0),
    ).rejects.toBeInstanceOf(StorageProviderError);
    await expect(
      StorageService.getDownloadUrl("raw-retinas", "a.png", 3601),
    ).rejects.toMatchObject({ code: "storage_invalid_ttl" });
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("reports upload validation errors in deterministic precedence order", async () => {
    provider.ensure.mockClear();
    provider.upload.mockClear();

    // key wins over body and content type
    await expect(
      StorageService.upload("raw-retinas", "a/../b.png", Buffer.alloc(0), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_key" });
    // body wins over content type
    await expect(
      StorageService.upload("raw-retinas", "ok.png", Buffer.alloc(0), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_body" });
    // content type is the last local check
    await expect(
      StorageService.upload("raw-retinas", "ok.png", Buffer.from("abc"), " "),
    ).rejects.toMatchObject({ code: "storage_invalid_content_type" });
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });
});
