import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CLASS_LABEL_INDEX,
  CLASS_LABELS,
  canonicalClassIndex,
} from "../src/schemas/common.js";
import { CLINICAL_FEATURE_NAMES, ClinicalFeaturesSchema, ClinicalSnapshotCreateSchema, extractClinicalFeatures } from "../src/schemas/clinical.js";
import { FeedbackCreate } from "../src/schemas/feedback.js";
import {
  ARTIFACT_CATALOG_TYPES,
  ArtifactListQuerySchema,
  ArtifactListResponseSchema,
  ArtifactRefSchema,
  ArtifactUrlQuerySchema,
  ArtifactUrlSchema,
  InferenceResultUpdate,
  patientCreateSchema,
  registerRequestSchema,
} from "../src/schemas/index.js";
import { FEATURES } from "./fixtures/clinical.js";

const base = () => ({ consultation_id: randomUUID(), inference_id: randomUUID(), validated_class: 1 });

describe("class vocabulary", () => {
  it("follows the ML manifest order (0 = Glaucoma, not Normal)", () => {
    expect([...CLASS_LABELS]).toEqual(["Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma"]);
  });

  it("derives the canonical index from CLASS_LABELS", () => {
    expect(CLASS_LABEL_INDEX).toEqual({
      Glaucoma: 0,
      Non_Glaucoma: 1,
      Suspicious_Glaucoma: 2,
    });
  });

  it("maps only canonical labels and bounded legacy casing", () => {
    expect(canonicalClassIndex("Glaucoma")).toBe(0);
    expect(canonicalClassIndex("Non_Glaucoma")).toBe(1);
    expect(canonicalClassIndex("Suspicious_Glaucoma")).toBe(2);
    expect(canonicalClassIndex("glaucoma")).toBe(0);
    expect(canonicalClassIndex("NON_GLAUCOMA")).toBe(1);
    expect(canonicalClassIndex("suspicious_glaucoma")).toBe(2);
    expect(canonicalClassIndex("GlAuCoMa")).toBe(0);
  });

  it("returns null for unknown, non-string and prototype keys", () => {
    for (const value of [
      "unknown",
      "",
      " glaucoma",
      "glaucoma ",
      "__proto__",
      "constructor",
      "toString",
      null,
      undefined,
      {},
      [],
      Object.create({ Glaucoma: 0 }),
      0,
      false,
    ]) {
      expect(canonicalClassIndex(value)).toBeNull();
    }
  });
});

describe("InferenceResultUpdate model details", () => {
  const update = () => ({
    predictedClass: 0,
    confidence: 0.8,
    probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
    cdr: 0.4,
    cdrVertical: 0.45,
    elapsedSeconds: 1.2,
  });

  it("accepts and preserves the actual versions and camelCase predictions", () => {
    const parsed = InferenceResultUpdate.parse({
      ...update(),
      modelVersions: {
        manifest: "2026-09-24",
        efficientnet_b3: "repo/efficientnet_b3@revision",
      },
      modelPredictions: {
        efficientnet_b3: {
          probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
          predictedClass: "Glaucoma",
          confidence: 0.8,
        },
      },
    });

    expect(parsed.modelVersions).toEqual({
      manifest: "2026-09-24",
      efficientnet_b3: "repo/efficientnet_b3@revision",
    });
    expect(parsed.modelPredictions).toEqual({
      efficientnet_b3: {
        probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
        predictedClass: "Glaucoma",
        confidence: 0.8,
      },
    });
  });

  it("rejects malformed model predictions without coercing classifications", () => {
    const result = InferenceResultUpdate.safeParse({
      ...update(),
      modelPredictions: {
        efficientnet_b3: {
          probabilities: { Glaucoma: 0.8 },
          predictedClass: 0,
          confidence: 0.8,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("ArtifactRefSchema", () => {
  const available = () => ({
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

  it("accepts all-null location states and explicit failure metadata", () => {
    for (const status of ["NOT_SUPPORTED", "NOT_REQUESTED", "PENDING"]) {
      expect(
        ArtifactRefSchema.safeParse({
          ...available(),
          status,
          storageId: null,
          bucketOrContainer: null,
          key: null,
          contentType: null,
          sizeBytes: null,
          checksumSha256: null,
        }).success,
      ).toBe(true);
    }
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        status: "FAILED",
        storageId: null,
        bucketOrContainer: null,
        key: null,
        contentType: null,
        sizeBytes: null,
        checksumSha256: null,
        failureCode: "UPLOAD_FAILED",
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it("requires complete AVAILABLE metadata and a PDF content type", () => {
    expect(ArtifactRefSchema.safeParse(available()).success).toBe(true);
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        artifactType: "pdf",
        contentType: "application/pdf",
      }).success,
    ).toBe(true);
    for (const field of [
      "storageId",
      "bucketOrContainer",
      "key",
      "contentType",
      "sizeBytes",
      "checksumSha256",
    ]) {
      expect(
        ArtifactRefSchema.safeParse({ ...available(), [field]: null }).success,
      ).toBe(false);
    }
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        artifactType: "pdf",
        contentType: "image/png",
      }).success,
    ).toBe(false);
  });

  it("keeps result outside ArtifactRef and rejects invalid states/metadata", () => {
    expect(
      ArtifactRefSchema.safeParse({ ...available(), artifactType: "result" }).success,
    ).toBe(false);
    expect([...ARTIFACT_CATALOG_TYPES]).toContain("result");

    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        status: "PENDING",
      }).success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        status: "FAILED",
        failureCode: null,
      }).success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        failureCode: "UPLOAD_FAILED",
      }).success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        status: "PENDING",
        storageId: null,
        bucketOrContainer: null,
        key: null,
        contentType: null,
        sizeBytes: null,
        checksumSha256: null,
        retryable: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe sizes, bad checksums/dates and extra fields", () => {
    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ArtifactRefSchema.safeParse({ ...available(), sizeBytes }).success).toBe(
        false,
      );
    }
    for (const key of [
      "folder/http://literal.bin",
      "folder/blob:secret",
    ]) {
      expect(ArtifactRefSchema.safeParse({ ...available(), key }).success).toBe(
        true,
      );
    }
    for (const key of [
      "blob:secret",
      "file:secret",
      "data:text/plain;base64,AA",
      "folder/../mask.png",
      "folder/mask\u0000.png",
      "folder/mask.png?sv=1&sig=secret",
    ]) {
      expect(ArtifactRefSchema.safeParse({ ...available(), key }).success).toBe(
        false,
      );
    }
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        checksumSha256: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({
        ...available(),
        updatedAt: "not-a-date",
      }).success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({ ...available(), extra: "nope" }).success,
    ).toBe(false);
  });
});

describe("artifact list and URL DTOs", () => {
  const availableRef = {
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
  } as const;

  it("accepts a strict paginated envelope and keeps result out of ArtifactRef", () => {
    const item = {
      artifactId: randomUUID(),
      version: 2,
      reference: availableRef,
    };
    const envelope = {
      items: [item],
      total: 1,
      limit: 20,
      offset: 0,
    };
    expect(ArtifactListResponseSchema.safeParse(envelope).success).toBe(true);
    expect(
      ArtifactListResponseSchema.safeParse({
        ...envelope,
        items: [
          {
            ...item,
            reference: { ...availableRef, artifactType: "result" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ArtifactListResponseSchema.safeParse({ ...envelope, limit: 101 }).success,
    ).toBe(false);
    expect(
      ArtifactListResponseSchema.safeParse({ ...envelope, total: -1 }).success,
    ).toBe(false);
    expect(
      ArtifactListResponseSchema.safeParse({ ...envelope, extra: true }).success,
    ).toBe(false);
  });

  it("accepts nulls for non-AVAILABLE and requires URL fields only for AVAILABLE", () => {
    const unavailable = {
      artifactType: "mask" as const,
      status: "PENDING" as const,
      url: null,
      expiresInSeconds: null,
      contentType: null,
      reportVersion: null,
    };
    expect(ArtifactUrlSchema.safeParse(unavailable).success).toBe(true);

    const available = {
      artifactType: "pdf" as const,
      status: "AVAILABLE" as const,
      url: "https://signed.example/object",
      expiresInSeconds: 3600,
      contentType: "application/pdf",
      reportVersion: 3,
    };
    expect(ArtifactUrlSchema.safeParse(available).success).toBe(true);

    for (const field of ["url", "expiresInSeconds", "contentType"] as const) {
      expect(
        ArtifactUrlSchema.safeParse({ ...available, [field]: null }).success,
      ).toBe(false);
    }
    for (const field of ["url", "expiresInSeconds", "contentType"] as const) {
      expect(
        ArtifactUrlSchema.safeParse({
          ...unavailable,
          [field]: field === "url" ? "https://secret.example" : 1,
        }).success,
      ).toBe(false);
    }
    expect(
      ArtifactUrlSchema.safeParse({ ...available, reportVersion: 0 }).success,
    ).toBe(false);
    expect(
      ArtifactUrlSchema.safeParse({ ...available, extra: true }).success,
    ).toBe(false);
  });

  it("parses strict list/version queries with safe defaults and int32 bounds", () => {
    expect(ArtifactListQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(
      ArtifactListQuerySchema.parse({ limit: "100", offset: "2147483647", type: "mask" }),
    ).toEqual({ limit: 100, offset: 2147483647, type: "mask" });
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 2147483648 },
      { type: "result" },
      { type: "unknown" },
      { extra: "1" },
    ]) {
      expect(ArtifactListQuerySchema.safeParse(query).success).toBe(false);
    }

    expect(ArtifactUrlQuerySchema.parse({ version: "3" })).toEqual({ version: 3 });
    for (const query of [
      {},
      { version: 0 },
      { version: -1 },
      { version: 1.5 },
      { version: 2147483648 },
      { version: "abc" },
      { version: 1, extra: "1" },
    ]) {
      expect(ArtifactUrlQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe("FeedbackCreate", () => {
  it("accepts classes 0..2 and null (no concluyente)", () => {
    for (const validated_class of [0, 1, 2, null]) {
      expect(FeedbackCreate.safeParse({ ...base(), validated_class }).success).toBe(true);
    }
  });

  it.each([3, -1, 1.5, "1"])("rejects validated_class %j", (validated_class) => {
    expect(FeedbackCreate.safeParse({ ...base(), validated_class }).success).toBe(false);
  });

  it("rejects gold standard on a no-concluyente verdict", () => {
    const result = FeedbackCreate.safeParse({ ...base(), validated_class: null, is_gold_standard: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["is_gold_standard"]);
  });

  it("defaults is_gold_standard to false and tolerates the legacy frontend fields", () => {
    const parsed = FeedbackCreate.parse({ ...base(), doctor_id: randomUUID(), predicted_class: 2, confidence: 0.4, agreement: false });
    expect(parsed.is_gold_standard).toBe(false);
  });

  it("rejects non-uuid ids", () => {
    expect(FeedbackCreate.safeParse({ ...base(), inference_id: "nope" }).success).toBe(false);
  });
});

describe("clinical features", () => {
  it("is strict like the ML contract (no extras, none missing)", () => {
    expect(ClinicalFeaturesSchema.safeParse(FEATURES).success).toBe(true);
    expect(ClinicalFeaturesSchema.safeParse({ ...FEATURES, extra: 1 }).success).toBe(false);
    const { Age: _age, ...missing } = FEATURES;
    expect(ClinicalFeaturesSchema.safeParse(missing).success).toBe(false);
  });

  it("extracts in manifest order, accepts the Phakic_Pseudophakic alias and nulls junk", () => {
    const { ["Phakic/Pseudophakic"]: _p, ...rest } = FEATURES;
    const out = extractClinicalFeatures({ ...rest, Phakic_Pseudophakic: 0, Age: "70", VF_DM: "n/a", ignored: 5 });
    expect(Object.keys(out)).toEqual([...CLINICAL_FEATURE_NAMES]);
    expect(out["Phakic/Pseudophakic"]).toBe(0);
    expect(out.Age).toBe(70);
    expect(out.VF_DM).toBeNull();
  });

  it("never throws on non-object JSONB", () => {
    for (const raw of [null, undefined, [], "x", 3]) {
      expect(Object.values(extractClinicalFeatures(raw)).every((v) => v === null)).toBe(true);
    }
  });
});

describe("auth and patient schemas", () => {
  it("validates user registration payload (Spanish role vocabulary)", () => {
    const valid = {
      email: "ophthalmologist@clearsight.clinic",
      password: "securepassword123",
      role: "OFTALMOLOGO",
    };
    const res = registerRequestSchema.safeParse(valid);
    expect(res.success).toBe(true);
    expect(res.success && res.data.role).toBe("OFTALMOLOGO");
  });

  it("defaults role to OFTALMOLOGO on registration", () => {
    const res = registerRequestSchema.safeParse({
      email: "test@example.com",
      password: "securepassword123",
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.role).toBe("OFTALMOLOGO");
  });

  it("rejects weak password on registration", () => {
    const res = registerRequestSchema.safeParse({
      email: "test@example.com",
      password: "short",
    });
    expect(res.success).toBe(false);
  });

  it("validates patient creation", () => {
    const res = patientCreateSchema.safeParse({
      externalCode: "P-100",
      age: 55,
      gender: "M",
      clinicalHistoryFlags: { diabetes: true },
    });
    expect(res.success).toBe(true);
  });
});

describe("clinical snapshot schema", () => {
  const base = () => ({
    consultationId: randomUUID(),
    rawPayload: { age: 63, laterality: "OD", nested: { values: [1, "x", null, true] } },
    normalizedPayload: { age: 63, features: { cdr: 0.4 } },
    schemaVersion: "clinical-v1",
    modelVersions: {
      classifier: { name: "efficientnet", version: "2026-09-24" },
      segmenter: { versions: ["v1", "v2"] },
    },
  });

  it("accepts independent raw/normalized objects and preserves nested model versions", () => {
    const input = base();
    const result = ClinicalSnapshotCreateSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.success && result.data.rawPayload).toEqual(input.rawPayload);
    expect(result.success && result.data.normalizedPayload).toEqual(input.normalizedPayload);
    expect(result.success && result.data.modelVersions).toEqual(input.modelVersions);
  });

  it("defaults modelVersions to an empty object without inventing revisions", () => {
    const { modelVersions: _modelVersions, ...input } = base();
    const parsed = ClinicalSnapshotCreateSchema.parse(input);
    expect(parsed.modelVersions).toEqual({});
  });

  it("requires raw and normalized payloads independently", () => {
    const input = base();
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...input, rawPayload: undefined }).success).toBe(false);
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...input, normalizedPayload: undefined }).success).toBe(false);
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...input, rawPayload: [] }).success).toBe(false);
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...input, normalizedPayload: [] }).success).toBe(false);
  });

  it("requires a UUID consultation id", () => {
    for (const consultationId of ["not-a-uuid", "", 42, null, undefined]) {
      expect(
        ClinicalSnapshotCreateSchema.safeParse({ ...base(), consultationId }).success,
      ).toBe(false);
    }
  });

  it("accepts empty JSON objects as raw, normalized and model versions", () => {
    const parsed = ClinicalSnapshotCreateSchema.parse({
      ...base(),
      rawPayload: {},
      normalizedPayload: {},
      modelVersions: {},
    });
    expect(parsed.rawPayload).toEqual({});
    expect(parsed.normalizedPayload).toEqual({});
    expect(parsed.modelVersions).toEqual({});
  });

  it("requires an explicit non-blank schemaVersion within the DB width", () => {
    const { schemaVersion: _schemaVersion, ...withoutVersion } = base();
    expect(ClinicalSnapshotCreateSchema.safeParse(withoutVersion).success).toBe(false);
    for (const schemaVersion of ["", "   ", "x".repeat(129)]) {
      expect(ClinicalSnapshotCreateSchema.safeParse({ ...base(), schemaVersion }).success).toBe(false);
    }
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...base(), schemaVersion: "x".repeat(128) }).success).toBe(true);
  });

  it("rejects non-object roots and non-JSON values at any depth without coercion", () => {
    for (const rawPayload of [[], null, "x", 3]) {
      expect(ClinicalSnapshotCreateSchema.safeParse({ ...base(), rawPayload }).success).toBe(false);
    }

    const invalidValues = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      () => "x",
      new Date(),
      new Map(),
      new Set(),
    ];
    for (const value of invalidValues) {
      expect(
        ClinicalSnapshotCreateSchema.safeParse({
          ...base(),
          rawPayload: { nested: { value } },
        }).success,
      ).toBe(false);
      expect(
        ClinicalSnapshotCreateSchema.safeParse({
          ...base(),
          normalizedPayload: { value },
        }).success,
      ).toBe(false);
      expect(
        ClinicalSnapshotCreateSchema.safeParse({
          ...base(),
          modelVersions: { classifier: { value } },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects cyclic payloads instead of recursing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(ClinicalSnapshotCreateSchema.safeParse({ ...base(), rawPayload: cyclic }).success).toBe(false);
  });

  it("rejects unknown snapshot fields", () => {
    expect(
      ClinicalSnapshotCreateSchema.safeParse({ ...base(), sources: ["x"] }).success,
    ).toBe(false);
  });
});
