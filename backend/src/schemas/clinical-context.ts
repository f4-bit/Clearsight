import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CLINICAL_FEATURE_NAMES,
  ClinicalFeaturesSchema,
  type ClinicalFeatures,
} from "./clinical.js";

export const ML_NORMALIZATION_SCHEMA_VERSION = "ml-zscore-f32-v1" as const;
export const ML_NORMALIZATION_DTYPE = "float32" as const;
export const ML_MODEL_ARTIFACTS = [
  "segmentation",
  "efficientnet_b3",
  "resnet50",
] as const;
export const ML_REQUIRED_MODEL_VERSION_KEYS = [
  "manifest",
  "backend",
  ...ML_MODEL_ARTIFACTS,
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const NormalizationParameterSchema = z.strictObject({
  value: z.number().finite(),
  source: z.enum(["env", "manifest"]),
});

const ArtifactDescriptorSchema = z.strictObject({
  repository: z.string().min(1),
  revision: z.string().min(1),
  filename: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
});

const BinaryDescriptorSchema = z.strictObject({
  filename: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
});

const ModelDescriptorSchema = z.strictObject({
  manifest_version: z.string().min(1),
  backend: z.enum(["pytorch", "onnx"]),
  class_names: z.array(z.string().min(1)).length(3),
  ensemble: z.record(z.string(), z.number().finite()),
  artifacts: z.record(z.string(), ArtifactDescriptorSchema),
  binaries: z.record(z.string(), BinaryDescriptorSchema),
});

const PreprocessingDescriptorSchema = z.strictObject({
  localization: z.strictObject({
    gaussian_kernel_max: z.number().int().positive(),
  }),
  segmentation: z.strictObject({
    image_size: z.number().int().positive(),
    disc_threshold: z.number().finite(),
    cup_threshold: z.number().finite(),
    clahe_clip_limit: z.number().finite(),
    clahe_tile_grid: z.number().int().positive(),
  }),
  crop: z.strictObject({
    crop_margin: z.number().int().nonnegative(),
    classifier_crop_size: z.number().int().positive(),
    classifier_crop_min: z.number().int().positive(),
    classifier_crop_max: z.number().int().positive(),
  }),
  classifier: z.strictObject({
    five_channel: z.literal(true),
    clahe_clip_limit: z.number().finite(),
    clahe_tile_grid: z.number().int().positive(),
  }),
});

export const ContextDescriptorSchema = z.strictObject({
  schema_version: z.literal(ML_NORMALIZATION_SCHEMA_VERSION),
  model: ModelDescriptorSchema,
  normalization: z.strictObject({
    algorithm: z.literal("zscore"),
    dtype: z.literal(ML_NORMALIZATION_DTYPE),
    epsilon: z.number().finite(),
    ordered_feature_names: z.array(z.string().min(1)).length(11),
    mean: z.array(NormalizationParameterSchema).length(11),
    std: z.array(NormalizationParameterSchema).length(11),
  }),
  preprocessing: PreprocessingDescriptorSchema,
});

export const PreparedClinicalSnapshotResponseSchema = z.strictObject({
  rawCanonical: z.strictObject({
    clinicalFeatures: ClinicalFeaturesSchema,
  }),
  normalizedPayload: z.strictObject({
    orderedFeatureNames: z.array(z.string().min(1)).length(11),
    dtype: z.literal(ML_NORMALIZATION_DTYPE),
    values: z.array(z.number().finite()).length(11),
    descriptor: ContextDescriptorSchema,
    canonicalJson: z.string().min(1),
    contextFingerprintSha256: z.string().regex(SHA256_HEX),
  }),
  schemaVersion: z.literal(ML_NORMALIZATION_SCHEMA_VERSION),
  modelVersions: z.record(z.string(), z.string().min(1)),
  contextFingerprintSha256: z.string().regex(SHA256_HEX),
});
export type PreparedClinicalSnapshotResponse = z.infer<
  typeof PreparedClinicalSnapshotResponseSchema
>;

export const PrepareClinicalSnapshotRequestSchema = z.strictObject({
  clinical_features: ClinicalFeaturesSchema,
  requested_model_version: z.string().min(1).nullable().optional(),
});
export type PrepareClinicalSnapshotRequest = z.infer<
  typeof PrepareClinicalSnapshotRequestSchema
>;

export class PreparedSnapshotContractError extends Error {
  constructor() {
    super("prepared clinical snapshot is inconsistent");
    this.name = "PreparedSnapshotContractError";
  }
}

export function assertPreparedSnapshotConsistent(
  response: PreparedClinicalSnapshotResponse,
  requestedFeatures: ClinicalFeatures,
): void {
  const names = [...CLINICAL_FEATURE_NAMES];
  for (const name of names) {
    if (response.rawCanonical.clinicalFeatures[name] !== requestedFeatures[name]) {
      throw new PreparedSnapshotContractError();
    }
  }

  const normalizedNames = response.normalizedPayload.orderedFeatureNames;
  if (!sameStringOrder(normalizedNames, names)) {
    throw new PreparedSnapshotContractError();
  }
  const descriptor = response.normalizedPayload.descriptor;
  if (
    !sameStringOrder(descriptor.normalization.ordered_feature_names, names) ||
    descriptor.normalization.epsilon !== 1e-8
  ) {
    throw new PreparedSnapshotContractError();
  }
  if (
    descriptor.schema_version !== response.schemaVersion ||
    response.normalizedPayload.dtype !== ML_NORMALIZATION_DTYPE
  ) {
    throw new PreparedSnapshotContractError();
  }

  for (const key of ML_REQUIRED_MODEL_VERSION_KEYS) {
    if (typeof response.modelVersions[key] !== "string" || !response.modelVersions[key]) {
      throw new PreparedSnapshotContractError();
    }
  }
  if (
    response.modelVersions.manifest !== descriptor.model.manifest_version ||
    response.modelVersions.backend !== descriptor.model.backend
  ) {
    throw new PreparedSnapshotContractError();
  }
  for (const [name, artifact] of Object.entries(descriptor.model.artifacts)) {
    if (
      response.modelVersions[name] !==
      `${artifact.repository}@${artifact.revision}`
    ) {
      throw new PreparedSnapshotContractError();
    }
  }

  if (
    response.normalizedPayload.contextFingerprintSha256 !==
    response.contextFingerprintSha256
  ) {
    throw new PreparedSnapshotContractError();
  }
  const canonicalHash = createHash("sha256")
    .update(response.normalizedPayload.canonicalJson, "utf8")
    .digest("hex");
  if (canonicalHash !== response.contextFingerprintSha256) {
    throw new PreparedSnapshotContractError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.normalizedPayload.canonicalJson);
  } catch {
    throw new PreparedSnapshotContractError();
  }
  if (!deepEqualJson(parsed, descriptor)) {
    throw new PreparedSnapshotContractError();
  }
  assertDescriptorSafe(descriptor);
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ABSOLUTE_LOCAL_PATH =
  /^(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|app|workspace)(?:\/|$))/;
const FORBIDDEN_DESCRIPTOR_TEXT = /(?:token|secret|password|authorization|bearer)/i;

function assertDescriptorSafe(value: unknown): void {
  if (typeof value === "string") {
    if (ABSOLUTE_LOCAL_PATH.test(value) || FORBIDDEN_DESCRIPTOR_TEXT.test(value)) {
      throw new PreparedSnapshotContractError();
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PreparedSnapshotContractError();
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertDescriptorSafe(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_DESCRIPTOR_TEXT.test(key)) {
        throw new PreparedSnapshotContractError();
      }
      assertDescriptorSafe(nested);
    }
  }
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqualJson(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
}
