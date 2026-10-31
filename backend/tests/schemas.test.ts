import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CLASS_LABELS } from "../src/schemas/common.js";
import { CLINICAL_FEATURE_NAMES, ClinicalFeaturesSchema, extractClinicalFeatures } from "../src/schemas/clinical.js";
import { FeedbackCreate } from "../src/schemas/feedback.js";
import { FEATURES } from "./helpers/db.js";

const base = () => ({ consultation_id: randomUUID(), inference_id: randomUUID(), validated_class: 1 });

describe("class vocabulary", () => {
  it("follows the ML manifest order (0 = Glaucoma, not Normal)", () => {
    expect([...CLASS_LABELS]).toEqual(["Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma"]);
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
