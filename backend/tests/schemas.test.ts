import { describe, expect, it } from "vitest";
import {
  clinicalFeaturesSchema,
  feedbackCreateSchema,
  loginRequestSchema,
  patientCreateSchema,
  registerRequestSchema,
} from "../src/schemas/index.js";

describe("Zod Schemas Validation", () => {
  it("validates clinical features and normalizes alias field", () => {
    const raw = {
      Age: 62.0,
      Gender: 1.0,
      dioptre_1: 1.25,
      dioptre_2: -0.5,
      astigmatism: 45.0,
      "Phakic/Pseudophakic": 1.0,
      Pneumatic: 18.0,
      Perkins: 17.5,
      Pachymetry: 535.0,
      Axial_Length: 24.1,
      VF_DM: -3.2,
    };

    const parsed = clinicalFeaturesSchema.parse(raw);
    expect(parsed.Age).toBe(62.0);
    expect(parsed["Phakic/Pseudophakic"]).toBe(1.0);
    expect(parsed.Phakic_Pseudophakic).toBe(1.0);
  });

  it("validates user registration payload", () => {
    const valid = {
      email: "ophthalmologist@clearsight.clinic",
      password: "securepassword123",
      role: "OPHTHALMOLOGIST",
    };
    const res = registerRequestSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  it("rejects weak password on registration", () => {
    const invalid = {
      email: "test@example.com",
      password: "short",
    };
    const res = registerRequestSchema.safeParse(invalid);
    expect(res.success).toBe(false);
  });

  it("validates patient creation", () => {
    const patient = {
      externalCode: "P-100",
      age: 55,
      gender: "M",
      clinicalHistoryFlags: { diabetes: true },
    };
    const res = patientCreateSchema.safeParse(patient);
    expect(res.success).toBe(true);
  });

  it("validates clinical feedback bounds", () => {
    const feedback = {
      consultationId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      inferenceId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e",
      validatedClass: 1, // 0, 1 or 2
      confidence: 0.88,
      agreement: true,
      isGoldStandard: true,
    };
    const res = feedbackCreateSchema.safeParse(feedback);
    expect(res.success).toBe(true);
  });

  it("rejects invalid validatedClass (> 2)", () => {
    const feedback = {
      consultationId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      inferenceId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e",
      validatedClass: 5,
    };
    const res = feedbackCreateSchema.safeParse(feedback);
    expect(res.success).toBe(false);
  });
});
