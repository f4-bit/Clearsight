import { createHash } from "node:crypto";
import {
  CLINICAL_FEATURE_NAMES,
  type ClinicalFeatures,
} from "../../src/schemas/clinical.js";
import type {
  PreparedClinicalSnapshotResponse,
  PrepareClinicalSnapshotRequest,
} from "../../src/schemas/clinical-context.js";
import {
  MlClientHttpError,
  type ClinicalContextPreparer,
} from "../../src/services/ml-client.js";

export const FAKE_MANIFEST_VERSION = "2026-09-24";
const SHA = "a".repeat(64);
const BINARY_SHA = "b".repeat(64);

const ARTIFACTS = ["segmentation", "efficientnet_b3", "resnet50"] as const;

export const FAKE_DESCRIPTOR: PreparedClinicalSnapshotResponse["normalizedPayload"]["descriptor"] = {
  schema_version: "ml-zscore-f32-v1",
  model: {
    manifest_version: FAKE_MANIFEST_VERSION,
    backend: "pytorch",
    class_names: ["Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma"],
    ensemble: { efficientnet_b3: 0.5, resnet50: 0.5 },
    artifacts: Object.fromEntries(
      ARTIFACTS.map((name) => [
        name,
        {
          repository: `repo/${name}`,
          revision: `revision-${name}`,
          filename: `${name}.bin`,
          sha256: SHA,
        },
      ]),
    ),
    binaries: Object.fromEntries(
      ARTIFACTS.map((name) => [
        name,
        { filename: `${name}.bin`, sha256: BINARY_SHA },
      ]),
    ),
  },
  normalization: {
    algorithm: "zscore",
    dtype: "float32",
    epsilon: 1e-8,
    ordered_feature_names: [...CLINICAL_FEATURE_NAMES],
    mean: CLINICAL_FEATURE_NAMES.map(() => ({ value: 0, source: "manifest" })),
    std: CLINICAL_FEATURE_NAMES.map(() => ({ value: 1, source: "manifest" })),
  },
  preprocessing: {
    localization: { gaussian_kernel_max: 151 },
    segmentation: {
      image_size: 512,
      disc_threshold: 0.4,
      cup_threshold: 0.33,
      clahe_clip_limit: 2,
      clahe_tile_grid: 8,
    },
    crop: {
      crop_margin: 100,
      classifier_crop_size: 384,
      classifier_crop_min: 600,
      classifier_crop_max: 1000,
    },
    classifier: {
      five_channel: true,
      clahe_clip_limit: 2,
      clahe_tile_grid: 8,
    },
  },
};

const FAKE_CANONICAL_JSON = JSON.stringify(FAKE_DESCRIPTOR);
const FAKE_FINGERPRINT = createHash("sha256")
  .update(FAKE_CANONICAL_JSON, "utf8")
  .digest("hex");

export function makePreparedSnapshot(
  features: ClinicalFeatures,
): PreparedClinicalSnapshotResponse {
  return {
    rawCanonical: { clinicalFeatures: features },
    normalizedPayload: {
      orderedFeatureNames: [...CLINICAL_FEATURE_NAMES],
      dtype: "float32",
      values: CLINICAL_FEATURE_NAMES.map(() => 0),
      descriptor: FAKE_DESCRIPTOR,
      canonicalJson: FAKE_CANONICAL_JSON,
      contextFingerprintSha256: FAKE_FINGERPRINT,
    },
    schemaVersion: "ml-zscore-f32-v1",
    modelVersions: {
      manifest: FAKE_MANIFEST_VERSION,
      backend: "pytorch",
      segmentation: "repo/segmentation@revision-segmentation",
      efficientnet_b3: "repo/efficientnet_b3@revision-efficientnet_b3",
      resnet50: "repo/resnet50@revision-resnet50",
    },
    contextFingerprintSha256: FAKE_FINGERPRINT,
  };
}

export function createFakeMlClient(
  handler?: (payload: PrepareClinicalSnapshotRequest) => Promise<unknown>,
): ClinicalContextPreparer {
  return {
    prepareClinicalSnapshot:
      handler ??
      (async (payload) => {
        if (
          payload.requested_model_version != null &&
          payload.requested_model_version !== FAKE_MANIFEST_VERSION
        ) {
          throw new MlClientHttpError(422);
        }
        return makePreparedSnapshot(payload.clinical_features);
      }),
  };
}
