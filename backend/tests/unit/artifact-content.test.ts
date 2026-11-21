import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ArtifactContentError,
  describeArtifactBytes,
  loadArtifactBytes,
  type ArtifactContentEnv,
  type ArtifactContentStoragePort,
} from "../../src/services/artifact-content.js";
import { StorageProviderError } from "../../src/services/storage-provider.js";

const BASE_ENV: ArtifactContentEnv = {
  STORAGE_PROVIDER: "minio",
  MINIO_BUCKET_RAW: "raw-retinas",
  MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  MINIO_BUCKET_MASK: "retina-masks",
  MINIO_BUCKET_OVERLAY: "retina-overlays",
  MINIO_BUCKET_PDF: "clinical-reports",
};

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const PDF = Buffer.from("%PDF-1.7\nmock\n", "ascii");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function storageReturning(
  bytes: Uint8Array,
): { readonly port: ArtifactContentStoragePort; readonly calls: Array<{ bucket: string; key: string }> } {
  const calls: Array<{ bucket: string; key: string }> = [];
  return {
    calls,
    port: {
      async getObjectStream(bucket, key) {
        calls.push({ bucket, key });
        return Readable.from([Buffer.from(bytes)]);
      },
    },
  };
}

async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactContentError);
    return (error as ArtifactContentError).code;
  }
}

describe("artifact-content seam", () => {
  it("loads an s3 URI through the 3.3 parser and the storage port", async () => {
    const { port, calls } = storageReturning(PNG);
    await expect(
      loadArtifactBytes("s3://retina-masks/case/mask.png", "mask", {
        env: BASE_ENV,
        storage: port,
      }),
    ).resolves.toEqual(PNG);
    expect(calls).toEqual([{ bucket: "retina-masks", key: "case/mask.png" }]);
  });

  it("loads an azure URI with the active azure provider", async () => {
    const { port, calls } = storageReturning(PDF);
    const azureEnv: ArtifactContentEnv = {
      ...BASE_ENV,
      STORAGE_PROVIDER: "azure",
    };
    await expect(
      loadArtifactBytes("azure://clinical-reports/case/report.pdf", "pdf", {
        env: azureEnv,
        storage: port,
      }),
    ).resolves.toEqual(PDF);
    expect(calls).toEqual([
      { bucket: "clinical-reports", key: "case/report.pdf" },
    ]);
  });

  it("supports bucket/key legacy and key-only with the kind default", async () => {
    const bucketFirst = storageReturning(PNG);
    await expect(
      loadArtifactBytes("retina-masks/case/mask.png", "mask", {
        env: BASE_ENV,
        storage: bucketFirst.port,
      }),
    ).resolves.toEqual(PNG);
    expect(bucketFirst.calls).toEqual([
      { bucket: "retina-masks", key: "case/mask.png" },
    ]);

    const keyOnly = storageReturning(PNG);
    await expect(
      loadArtifactBytes("case/mask.png", "mask", {
        env: BASE_ENV,
        storage: keyOnly.port,
      }),
    ).resolves.toEqual(PNG);
    expect(keyOnly.calls).toEqual([
      { bucket: "retina-masks", key: "case/mask.png" },
    ]);
  });

  it("loads the original image with the raw default bucket", async () => {
    const { port, calls } = storageReturning(JPEG);
    await expect(
      loadArtifactBytes("case/original.jpg", "image", {
        env: BASE_ENV,
        storage: port,
      }),
    ).resolves.toEqual(JPEG);
    expect(calls).toEqual([{ bucket: "raw-retinas", key: "case/original.jpg" }]);
  });

  it("describes size, lowercase SHA-256 and sniffed content type", () => {
    const expected = createHash("sha256").update(PNG).digest("hex");
    expect(describeArtifactBytes(PNG)).toEqual({
      size: PNG.byteLength,
      checksumSha256: expected,
      contentType: "image/png",
    });
    expect(describeArtifactBytes(PDF).contentType).toBe("application/pdf");
    expect(describeArtifactBytes(JPEG).contentType).toBe("image/jpeg");
    expect(describeArtifactBytes(Buffer.from("plain")).contentType).toBe(
      "application/octet-stream",
    );
  });

  it("accepts a trusted content type and rejects an invalid one", () => {
    expect(
      describeArtifactBytes(PNG, "image/png; charset=binary"),
    ).toMatchObject({ contentType: "image/png" });
    expect(() => describeArtifactBytes(PNG, "not-a-media-type")).toThrow(
      expect.objectContaining({ code: "artifact_content_invalid_content_type" }),
    );
  });

  it("fails an empty buffer instead of returning a descriptor", () => {
    expect(() => describeArtifactBytes(Buffer.alloc(0))).toThrow(
      expect.objectContaining({ code: "artifact_content_empty" }),
    );
  });

  it("rejects uploads over the configured byte limit", async () => {
    const { port } = storageReturning(Buffer.alloc(8));
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
          maxBytes: 4,
        }),
      ),
    ).resolves.toBe("artifact_content_too_large");
  });

  it("fails closed when the kind bucket is not configured", async () => {
    const { port, calls } = storageReturning(PNG);
    const missingMask: ArtifactContentEnv = {
      ...BASE_ENV,
      MINIO_BUCKET_MASK: undefined,
    };
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: missingMask,
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_invalid_config");
    expect(calls).toEqual([]);
  });

  it("fails closed when an explicit allowlist excludes the kind bucket", async () => {
    const { port } = storageReturning(PNG);
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: {
            ...BASE_ENV,
            STORAGE_ALLOWED_BUCKETS: "raw-retinas,gradcam-overlays",
          },
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_invalid_config");
  });

  it("maps a missing storage object to a typed safe error", async () => {
    const port: ArtifactContentStoragePort = {
      async getObjectStream() {
        throw new StorageProviderError("storage_object_missing");
      },
    };
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_missing");
  });

  it("does not echo a rejected reference or SDK details", async () => {
    const { port } = storageReturning(PNG);
    const reference = "s3://private-bucket/secret/sig=abc";
    const error = await loadArtifactBytes(reference, "mask", {
      env: BASE_ENV,
      storage: port,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArtifactContentError);
    expect((error as Error).message).not.toContain("private-bucket");
    expect((error as Error).message).not.toContain("sig=abc");
    expect(JSON.stringify(error)).not.toContain("private-bucket");
    expect(JSON.stringify(error)).not.toContain("sig=abc");
  });

  it("rejects a reference whose scheme does not match the active provider", async () => {
    const { port } = storageReturning(PNG);
    await expect(
      errorCode(
        loadArtifactBytes("azure://retina-masks/case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_invalid_reference");
  });

  it("enforces ARTIFACT_CONTENT_MAX_BYTES from the env without a per-call override", async () => {
    const { port } = storageReturning(Buffer.alloc(8));
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: { ...BASE_ENV, ARTIFACT_CONTENT_MAX_BYTES: "4" },
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_too_large");
  });

  it("accepts content that exactly matches the byte limit", async () => {
    const exact = Buffer.alloc(8, 7);
    const { port } = storageReturning(exact);
    await expect(
      loadArtifactBytes("case/mask.png", "mask", {
        env: BASE_ENV,
        storage: port,
        maxBytes: 8,
      }),
    ).resolves.toEqual(exact);
  });

  it("accumulates chunked content before enforcing the byte limit", async () => {
    const calls: Array<{ bucket: string; key: string }> = [];
    const port: ArtifactContentStoragePort = {
      async getObjectStream(bucket, key) {
        calls.push({ bucket, key });
        return Readable.from([
          Buffer.alloc(3, 1),
          Buffer.alloc(3, 2),
          Buffer.alloc(3, 3),
        ]);
      },
    };
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
          maxBytes: 8,
        }),
      ),
    ).resolves.toBe("artifact_content_too_large");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["above the hard maximum", 100 * 1024 * 1024 + 1],
    ["non-numeric string", "abc"],
  ])("rejects an invalid max byte configuration (%s)", async (_label, value) => {
    const { port } = storageReturning(PNG);
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
          maxBytes: value,
        }),
      ),
    ).resolves.toBe("artifact_content_invalid_config");
  });

  it("fails an empty stream instead of returning zero bytes", async () => {
    const port: ArtifactContentStoragePort = {
      async getObjectStream() {
        return Readable.from([]);
      },
    };
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_empty");
  });

  it("fails on non-binary stream chunks instead of coercing them", async () => {
    const port: ArtifactContentStoragePort = {
      async getObjectStream() {
        return Readable.from([123456]);
      },
    };
    await expect(
      errorCode(
        loadArtifactBytes("case/mask.png", "mask", {
          env: BASE_ENV,
          storage: port,
        }),
      ),
    ).resolves.toBe("artifact_content_read_failed");
  });

  it("maps a mid-stream read failure to a safe error without echoing secrets", async () => {
    const port: ArtifactContentStoragePort = {
      async getObjectStream() {
        return new Readable({
          read() {
            this.push(Buffer.from("abc"));
            this.destroy(new Error("boom-secret-detail"));
          },
        });
      },
    };
    const error = await loadArtifactBytes("case/secret-key.png", "mask", {
      env: BASE_ENV,
      storage: port,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArtifactContentError);
    expect((error as ArtifactContentError).code).toBe(
      "artifact_content_read_failed",
    );
    expect((error as Error).message).not.toContain("boom-secret-detail");
    expect((error as Error).message).not.toContain("secret-key");
  });

  it.each([
    ["a generic SDK failure", new Error("connect ECONNREFUSED 10.0.0.5:9000")],
    ["a non-missing provider failure", new StorageProviderError("storage_unavailable")],
  ])("maps %s to artifact_content_read_failed", async (_label, thrown) => {
    const port: ArtifactContentStoragePort = {
      async getObjectStream() {
        throw thrown;
      },
    };
    const error = await loadArtifactBytes("case/mask.png", "mask", {
      env: BASE_ENV,
      storage: port,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArtifactContentError);
    expect((error as ArtifactContentError).code).toBe(
      "artifact_content_read_failed",
    );
    expect((error as Error).message).not.toContain("ECONNREFUSED");
  });

  it("resolves overlay and pdf key-only references to their own default buckets", async () => {
    const overlay = storageReturning(PNG);
    await expect(
      loadArtifactBytes("case/overlay.png", "overlay", {
        env: BASE_ENV,
        storage: overlay.port,
      }),
    ).resolves.toEqual(PNG);
    expect(overlay.calls).toEqual([
      { bucket: "retina-overlays", key: "case/overlay.png" },
    ]);

    const pdf = storageReturning(PDF);
    await expect(
      loadArtifactBytes("case/report.pdf", "pdf", {
        env: BASE_ENV,
        storage: pdf.port,
      }),
    ).resolves.toEqual(PDF);
    expect(pdf.calls).toEqual([
      { bucket: "clinical-reports", key: "case/report.pdf" },
    ]);
  });

  it("keeps working with an explicit allowlist that contains the kind bucket", async () => {
    const { port, calls } = storageReturning(PNG);
    await expect(
      loadArtifactBytes("case/mask.png", "mask", {
        env: {
          ...BASE_ENV,
          STORAGE_ALLOWED_BUCKETS: "raw-retinas,gradcam-overlays,retina-masks",
        },
        storage: port,
      }),
    ).resolves.toEqual(PNG);
    expect(calls).toEqual([{ bucket: "retina-masks", key: "case/mask.png" }]);
  });
});
