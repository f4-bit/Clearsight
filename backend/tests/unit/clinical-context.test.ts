import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FEATURES } from "../fixtures/clinical.js";
import {
  assertPreparedSnapshotConsistent,
  PreparedClinicalSnapshotResponseSchema,
  PreparedSnapshotContractError,
} from "../../src/schemas/clinical-context.js";
import { makePreparedSnapshot } from "../helpers/ml.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("backend clinical context wire contract", () => {
  it("accepts the Python-generated shape and verifies the exact canonical hash", () => {
    const response = makePreparedSnapshot(FEATURES);

    expect(PreparedClinicalSnapshotResponseSchema.parse(response)).toEqual(response);
    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).not.toThrow();
    expect(
      createHash("sha256")
        .update(response.normalizedPayload.canonicalJson, "utf8")
        .digest("hex"),
    ).toBe(response.contextFingerprintSha256);
  });

  it("rejects altered raw canonical features", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    response.rawCanonical.clinicalFeatures = {
      ...response.rawCanonical.clinicalFeatures,
      Age: FEATURES.Age + 1,
    };

    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects changed feature order", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    const names = response.normalizedPayload.orderedFeatureNames;
    [names[0], names[1]] = [names[1]!, names[0]!];

    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects a canonicalJson whose bytes no longer match the fingerprint", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    response.normalizedPayload.canonicalJson = "{}";

    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects a descriptor that is not the parsed canonicalJson", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    response.normalizedPayload.descriptor.normalization.epsilon = 1e-7;

    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects missing or invented model version keys", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    delete response.modelVersions.resnet50;

    expect(() => assertPreparedSnapshotConsistent(response, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects local paths or secrets in the descriptor", () => {
    const withPath = clone(makePreparedSnapshot(FEATURES));
    withPath.normalizedPayload.descriptor.model.binaries.resnet50!.filename =
      "C:\\models\\resnet50.onnx";

    expect(() => assertPreparedSnapshotConsistent(withPath, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );

    const withToken = clone(makePreparedSnapshot(FEATURES));
    withToken.normalizedPayload.descriptor.model.artifacts.resnet50!.filename =
      "service-token.bin";

    expect(() => assertPreparedSnapshotConsistent(withToken, FEATURES)).toThrow(
      PreparedSnapshotContractError,
    );
  });

  it("rejects non-finite values before persistence", () => {
    const response = clone(makePreparedSnapshot(FEATURES));
    response.normalizedPayload.values[0] = Number.NaN;

    expect(() => PreparedClinicalSnapshotResponseSchema.parse(response)).toThrow();
  });
});
