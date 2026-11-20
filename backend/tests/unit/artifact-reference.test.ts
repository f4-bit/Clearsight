import { describe, expect, it } from "vitest";
import {
  ArtifactReferenceError,
  mapArtifactRecordToRef,
  parseArtifactLocation,
  resolveArtifactReferenceContext,
  resolveArtifactReferenceContextForBucket,
  type ArtifactReferenceContext,
} from "../../src/services/artifact-reference.js";

const MINIO_CONTEXT: ArtifactReferenceContext = {
  provider: "minio",
  storageId: "minio-local",
  allowedBuckets: ["raw-retinas", "gradcam-overlays"],
  defaultBucket: "raw-retinas",
};

const GRADCAM_CONTEXT: ArtifactReferenceContext = {
  ...MINIO_CONTEXT,
  defaultBucket: "gradcam-overlays",
};

const AZURE_CONTEXT: ArtifactReferenceContext = {
  provider: "azure",
  storageId: "azure-blob-default",
  allowedBuckets: ["raw-retinas", "gradcam-overlays"],
  defaultBucket: "raw-retinas",
};

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactReferenceError);
    return (error as ArtifactReferenceError).code;
  }
}

describe("parseArtifactLocation", () => {
  it("accepts s3/azure URIs with an exact key and no percent decoding", () => {
    expect(
      parseArtifactLocation(
        "s3://raw-retinas/carpeta/ünïcode %20 file?.png",
        MINIO_CONTEXT,
      ),
    ).toEqual({
      provider: "minio",
      storageId: "minio-local",
      bucketOrContainer: "raw-retinas",
      key: "carpeta/ünïcode %20 file?.png",
    });

    expect(
      parseArtifactLocation(
        "AZURE://gradcam-overlays/gradcam/x%2Fy.png",
        AZURE_CONTEXT,
      ),
    ).toEqual({
      provider: "azure",
      storageId: "azure-blob-default",
      bucketOrContainer: "gradcam-overlays",
      key: "gradcam/x%2Fy.png",
    });
  });

  it("preserves leading/double slashes and literal key characters", () => {
    const parsed = parseArtifactLocation(
      "s3://raw-retinas//folder/a b%20c#d?e|f&g.png",
      MINIO_CONTEXT,
    );
    expect(parsed.bucketOrContainer).toBe("raw-retinas");
    expect(parsed.key).toBe("/folder/a b%20c#d?e|f&g.png");
  });

  it("preserves embedded :// but rejects generic schemes at key start", () => {
    const embedded = "folder/http://literal.bin";
    expect(
      parseArtifactLocation(`s3://raw-retinas/${embedded}`, MINIO_CONTEXT).key,
    ).toBe(embedded);
    expect(
      parseArtifactLocation(
        {
          storageId: "minio-local",
          bucketOrContainer: "raw-retinas",
          key: embedded,
        },
        MINIO_CONTEXT,
      ).key,
    ).toBe(embedded);
    expect(parseArtifactLocation(embedded, MINIO_CONTEXT)).toMatchObject({
      bucketOrContainer: "raw-retinas",
      key: embedded,
    });
    expect(parseArtifactLocation("folder/blob:secret", MINIO_CONTEXT).key).toBe(
      "folder/blob:secret",
    );

    for (const key of [
      "blob:secret",
      "file:secret",
      "data:text/plain;base64,AA",
      "http:secret",
      "s3:secret",
    ]) {
      expect(errorCode(() => parseArtifactLocation(key, MINIO_CONTEXT))).toBe(
        "artifact_reference_invalid_key",
      );
      expect(
        errorCode(() =>
          parseArtifactLocation(
            {
              storageId: "minio-local",
              bucketOrContainer: "raw-retinas",
              key,
            },
            MINIO_CONTEXT,
          ),
        ),
      ).toBe("artifact_reference_invalid_key");
    }
  });

  it("accepts structured locations with a full key that starts like a bucket", () => {
    expect(
      parseArtifactLocation(
        {
          storageId: "minio-local",
          bucketOrContainer: "raw-retinas",
          key: "raw-retinas/entire-key.png",
        },
        MINIO_CONTEXT,
      ),
    ).toEqual({
      provider: "minio",
      storageId: "minio-local",
      bucketOrContainer: "raw-retinas",
      key: "raw-retinas/entire-key.png",
    });
  });

  it("interprets bare legacy strings deterministically without network", () => {
    expect(parseArtifactLocation("2026/10/x.jpg", MINIO_CONTEXT)).toMatchObject({
      bucketOrContainer: "raw-retinas",
      key: "2026/10/x.jpg",
    });
    expect(parseArtifactLocation("raw-retinas/foo", MINIO_CONTEXT)).toMatchObject({
      bucketOrContainer: "raw-retinas",
      key: "foo",
    });
    expect(
      parseArtifactLocation("gradcam-overlays/gradcam/x.png", GRADCAM_CONTEXT),
    ).toMatchObject({
      bucketOrContainer: "gradcam-overlays",
      key: "gradcam/x.png",
    });
    expect(parseArtifactLocation("gradcam/x.png", GRADCAM_CONTEXT)).toMatchObject({
      bucketOrContainer: "gradcam-overlays",
      key: "gradcam/x.png",
    });
    expect(errorCode(() => parseArtifactLocation("raw-retinas", MINIO_CONTEXT))).toBe(
      "artifact_reference_invalid",
    );
  });

  it("rejects external schemes, authority and SAS query signatures", () => {
    for (const [reference, code] of [
      ["http://bucket/key.png", "artifact_reference_invalid"],
      ["https://bucket/key.png", "artifact_reference_invalid"],
      ["file://bucket/key.png", "artifact_reference_invalid"],
      ["blob:https://bucket/key.png", "artifact_reference_invalid_key"],
      ["gcs://bucket/key.png", "artifact_reference_invalid"],
      ["s3://user@raw-retinas/key.png", "artifact_reference_invalid"],
      ["s3://raw-retinas:443/key.png", "artifact_reference_invalid"],
      ["s3://raw-retinas", "artifact_reference_invalid"],
      ["s3://raw-retinas/", "artifact_reference_invalid_key"],
      ["s3:///key.png", "artifact_reference_invalid"],
    ] as const) {
      expect(errorCode(() => parseArtifactLocation(reference, MINIO_CONTEXT))).toBe(
        code,
      );
    }

    for (const reference of [
      "s3://raw-retinas/folder/file.png?sv=1&sig=secret",
      "s3://raw-retinas/folder/file.png?X-Amz-Signature=secret",
      "s3://raw-retinas/folder/file.png?x-amz-credential=secret",
      "s3://raw-retinas/folder/file.png?x-amz-security-token=secret",
    ]) {
      expect(errorCode(() => parseArtifactLocation(reference, MINIO_CONTEXT))).toBe(
        "artifact_reference_invalid_key",
      );
    }

    expect(
      parseArtifactLocation(
        "s3://raw-retinas/folder/file.png?version=1&foo=bar",
        MINIO_CONTEXT,
      ).key,
    ).toBe("folder/file.png?version=1&foo=bar");
  });

  it("rejects a scheme/provider mismatch and unknown structured storage ids", () => {
    expect(
      errorCode(() => parseArtifactLocation("azure://raw-retinas/key.png", MINIO_CONTEXT)),
    ).toBe("artifact_reference_invalid");
    expect(
      errorCode(() => parseArtifactLocation("s3://raw-retinas/key.png", AZURE_CONTEXT)),
    ).toBe("artifact_reference_invalid");
    expect(
      errorCode(() =>
        parseArtifactLocation(
          {
            storageId: "azure-blob-default",
            bucketOrContainer: "raw-retinas",
            key: "key.png",
          },
          MINIO_CONTEXT,
        ),
      ),
    ).toBe("artifact_reference_storage_mismatch");
  });

  it("rejects forbidden/foreign buckets and invalid keys", () => {
    const forbidden: ArtifactReferenceContext = {
      ...MINIO_CONTEXT,
      allowedBuckets: ["raw-retinas"],
      defaultBucket: "raw-retinas",
    };
    expect(
      errorCode(() =>
        parseArtifactLocation("s3://gradcam-overlays/gradcam/x.png", forbidden),
      ),
    ).toBe("artifact_reference_invalid_bucket");
    expect(
      errorCode(() =>
        parseArtifactLocation(
          {
            storageId: "minio-local",
            bucketOrContainer: "other-bucket",
            key: "x.png",
          },
          MINIO_CONTEXT,
        ),
      ),
    ).toBe("artifact_reference_invalid_bucket");

    for (const key of ["   ", "a\u0000b.png", "folder/../x.png", "folder/./x.png"]) {
      expect(
        errorCode(() =>
          parseArtifactLocation(
            {
              storageId: "minio-local",
              bucketOrContainer: "raw-retinas",
              key,
            },
            MINIO_CONTEXT,
          ),
        ),
      ).toBe("artifact_reference_invalid_key");
    }

    expect(
      errorCode(() =>
        parseArtifactLocation(
          {
            storageId: "minio-local",
            bucketOrContainer: "raw-retinas",
            key: "https://evil.test/key.png",
          },
          MINIO_CONTEXT,
        ),
      ),
    ).toBe("artifact_reference_invalid_key");
  });

  it("rejects invalid trusted context without leaking source values", () => {
    const badDefault: ArtifactReferenceContext = {
      ...MINIO_CONTEXT,
      defaultBucket: "other-bucket",
    };
    expect(errorCode(() => parseArtifactLocation("x.png", badDefault))).toBe(
      "artifact_reference_invalid_config",
    );
    expect(
      errorCode(() =>
        parseArtifactLocation("x.png", {
          ...MINIO_CONTEXT,
          allowedBuckets: [],
        }),
      ),
    ).toBe("artifact_reference_invalid_config");
    expect(
      errorCode(() =>
        parseArtifactLocation("x.png", {
          ...MINIO_CONTEXT,
          storageId: "https://secret.example",
        }),
      ),
    ).toBe("artifact_reference_invalid_config");
    const rejection = (() => {
      try {
        parseArtifactLocation("https://secret.example/key.png", MINIO_CONTEXT);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(rejection).toBeInstanceOf(ArtifactReferenceError);
    expect((rejection as Error).message).not.toContain("secret.example");
    expect((rejection as Error).message).not.toContain("key.png");
  });

  it("rejects non-canonical trusted storage ids instead of trimming silently", () => {
    for (const storageId of ["minio-local ", " minio-local", "minio-local\t"]) {
      expect(
        errorCode(() => parseArtifactLocation("x.png", { ...MINIO_CONTEXT, storageId })),
      ).toBe("artifact_reference_invalid_config");
    }
  });
});

describe("resolveArtifactReferenceContext", () => {
  const base = {
    MINIO_BUCKET_RAW: "raw-retinas",
    MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  };

  it("defaults the allowlist to raw + Grad-CAM and works for Azure without credentials", () => {
    expect(resolveArtifactReferenceContext(base, "image")).toEqual({
      provider: "minio",
      storageId: "minio-local",
      allowedBuckets: ["raw-retinas", "gradcam-overlays"],
      defaultBucket: "raw-retinas",
    });
    expect(
      resolveArtifactReferenceContext(
        {
          ...base,
          STORAGE_PROVIDER: "azure",
          STORAGE_ID: "azure-blob-default",
        },
        "gradcam",
      ),
    ).toEqual({
      provider: "azure",
      storageId: "azure-blob-default",
      allowedBuckets: ["raw-retinas", "gradcam-overlays"],
      defaultBucket: "gradcam-overlays",
    });
  });

  it("trims and deduplicates explicit CSV entries", () => {
    expect(
      resolveArtifactReferenceContext(
        {
          ...base,
          STORAGE_ALLOWED_BUCKETS:
            " raw-retinas , gradcam-overlays , raw-retinas ",
        },
        "gradcam",
      ).allowedBuckets,
    ).toEqual(["raw-retinas", "gradcam-overlays"]);
  });

  it("fails closed on blank/empty lists and defaults outside the list", () => {
    for (const value of ["", "   ", ",", "raw-retinas,,gradcam-overlays"]) {
      expect(
        errorCode(() =>
          resolveArtifactReferenceContext(
            { ...base, STORAGE_ALLOWED_BUCKETS: value },
            "image",
          ),
        ),
      ).toBe("artifact_reference_invalid_config");
    }

    expect(
      errorCode(() =>
        resolveArtifactReferenceContext(
          { ...base, STORAGE_ALLOWED_BUCKETS: "raw-retinas" },
          "gradcam",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
    expect(
      errorCode(() =>
        resolveArtifactReferenceContext(
          { ...base, STORAGE_ALLOWED_BUCKETS: "gradcam-overlays" },
          "image",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
  });

  it("rejects unknown providers and invalid bucket names", () => {
    expect(
      errorCode(() =>
        resolveArtifactReferenceContext(
          { ...base, STORAGE_PROVIDER: "s3" },
          "image",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
    expect(
      errorCode(() =>
        resolveArtifactReferenceContext(
          { ...base, MINIO_BUCKET_RAW: "Raw_Retinas" },
          "image",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
  });
});

describe("resolveArtifactReferenceContextForBucket", () => {
  const base = {
    MINIO_BUCKET_RAW: "raw-retinas",
    MINIO_BUCKET_GRADCAM: "gradcam-overlays",
  };

  it("uses an explicit mask/overlay/pdf list without forcing raw defaults", () => {
    expect(
      resolveArtifactReferenceContextForBucket(
        {
          ...base,
          STORAGE_ALLOWED_BUCKETS: "mask-bucket, overlay-bucket, pdf-bucket",
        },
        "mask-bucket",
      ),
    ).toEqual({
      provider: "minio",
      storageId: "minio-local",
      allowedBuckets: ["mask-bucket", "overlay-bucket", "pdf-bucket"],
      defaultBucket: "mask-bucket",
    });

    // The old default-kind contexts remain strict: their default must be in the
    // explicit list, so this same configuration cannot silently serve images.
    expect(
      errorCode(() =>
        resolveArtifactReferenceContext(
          { ...base, STORAGE_ALLOWED_BUCKETS: "mask-bucket,overlay-bucket,pdf-bucket" },
          "image",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
  });

  it("defaults row context to raw/Grad-CAM only and never extends the allowlist", () => {
    expect(
      resolveArtifactReferenceContextForBucket(base, "raw-retinas"),
    ).toMatchObject({
      allowedBuckets: ["raw-retinas", "gradcam-overlays"],
      defaultBucket: "raw-retinas",
    });
    expect(
      errorCode(() =>
        resolveArtifactReferenceContextForBucket(base, "mask-bucket"),
      ),
    ).toBe("artifact_reference_invalid_bucket");
    expect(
      errorCode(() =>
        resolveArtifactReferenceContextForBucket(
          { ...base, STORAGE_ALLOWED_BUCKETS: "mask-bucket" },
          "other-bucket",
        ),
      ),
    ).toBe("artifact_reference_invalid_bucket");
  });

  it("fails closed for invalid row bucket names", () => {
    expect(
      errorCode(() =>
        resolveArtifactReferenceContextForBucket(
          { ...base, STORAGE_ALLOWED_BUCKETS: "mask-bucket" },
          "Mask_Bucket",
        ),
      ),
    ).toBe("artifact_reference_invalid_config");
  });
});

describe("mapArtifactRecordToRef", () => {
  const base = {
    artifactType: "mask",
    status: "AVAILABLE",
    storageId: "minio-local",
    bucketOrContainer: "raw-retinas",
    key: "folder/mask.png",
    contentType: "image/png",
    sizeBytes: 42n,
    checksumSha256: "a".repeat(64),
    failureCode: null,
    retryable: false,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("maps a DB row without inventing metadata", () => {
    expect(mapArtifactRecordToRef(base)).toEqual({
      artifactType: "mask",
      status: "AVAILABLE",
      storageId: "minio-local",
      bucketOrContainer: "raw-retinas",
      key: "folder/mask.png",
      contentType: "image/png",
      sizeBytes: 42,
      checksumSha256: "a".repeat(64),
      failureCode: null,
      retryable: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects unsafe bigints, invalid states and result as a binary artifact", () => {
    expect(
      errorCode(() =>
        mapArtifactRecordToRef({
          ...base,
          sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        }),
      ),
    ).toBe("artifact_record_invalid");
    expect(
      errorCode(() =>
        mapArtifactRecordToRef({
          ...base,
          artifactType: "result",
        }),
      ),
    ).toBe("artifact_record_invalid");
    expect(
      errorCode(() =>
        mapArtifactRecordToRef({
          ...base,
          status: "FAILED",
          failureCode: null,
        }),
      ),
    ).toBe("artifact_record_invalid");
  });

  it("does not expose source strings on invalid rows", () => {
    const rejection = (() => {
      try {
        mapArtifactRecordToRef({
          ...base,
          key: "https://secret.example/key.png",
        });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(rejection).toBeInstanceOf(ArtifactReferenceError);
    expect((rejection as Error).message).not.toContain("secret.example");
    expect((rejection as Error).message).not.toContain("key.png");
  });
});
