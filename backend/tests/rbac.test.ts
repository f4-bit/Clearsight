import { describe, expect, it, vi, beforeAll } from "vitest";

// Mock external services so RBAC smoke tests run isolated
vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn().mockResolvedValue("bucket/key.jpg"),
    getDownloadUrl: vi.fn().mockResolvedValue("http://localhost:9000/test.jpg"),
    getMlDownloadUrl: vi.fn().mockResolvedValue("http://minio:9000/test.jpg"),
    getObjectStream: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    patient: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    consultation: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    image: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    inference: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    clinicalFeedback: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../src/repositories/index.js", () => ({
  createRepositories: () => ({
    feedback: {
      listGoldStandard: vi.fn().mockResolvedValue([]),
    },
  }),
}));

import { buildTestApp } from "./helpers/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { FastifyInstance } from "fastify";
import type { UserRole } from "../src/schemas/common.js";

let app: FastifyInstance;
const DOCTOR = { sub: "11111111-1111-4111-8111-111111111111", email: "doc@clearsight.clinic", role: "OFTALMOLOGO" as const };
const ADMIN = { sub: "22222222-2222-4222-8222-222222222222", email: "admin@clearsight.clinic", role: "ADMIN" as const };
const RESEARCHER = { sub: "33333333-3333-4333-8333-333333333333", email: "lab@clearsight.clinic", role: "INVESTIGADOR" as const };

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

const signToken = (payload: { sub: string; role: UserRole }) =>
  app.jwt.sign(payload);

describe("RBAC smoke tests", () => {
  it("GET /patients returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/patients" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /patients returns 200 with any authenticated role", async () => {
    for (const user of [DOCTOR, ADMIN, RESEARCHER]) {
      const res = await app.inject({
        method: "GET",
        url: "/patients",
        headers: { authorization: `Bearer ${signToken(user)}` },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("POST /patients allows OFTALMOLOGO with valid body", async () => {
    const mockPatient = {
      id: "44444444-4444-4444-8444-444444444444",
      externalCode: "P-001",
      age: 55,
      gender: "M",
      clinicalHistoryFlags: {},
      clinicalData: {},
      createdAt: new Date(),
    };
    vi.mocked(prisma.patient.create).mockResolvedValueOnce(mockPatient as any);

    const res = await app.inject({
      method: "POST",
      url: "/patients",
      headers: {
        authorization: `Bearer ${signToken(DOCTOR)}`,
        "content-type": "application/json",
      },
      payload: { externalCode: "P-001", age: 55, gender: "M" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST /patients returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/patients",
      headers: {
        authorization: `Bearer ${signToken(RESEARCHER)}`,
        "content-type": "application/json",
      },
      payload: { age: 50 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /inferences returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inferences",
      headers: {
        authorization: `Bearer ${signToken(RESEARCHER)}`,
        "content-type": "application/json",
      },
      payload: {
        imageId: "55555555-5555-4555-8555-555555555555",
        eyeSide: "OD",
        clinicalFeatures: {
          Age: 62,
          Gender: 1,
          dioptre_1: 1.25,
          dioptre_2: -0.5,
          astigmatism: 45,
          "Phakic/Pseudophakic": 1,
          Pneumatic: 18,
          Perkins: 17.5,
          Pachymetry: 535,
          Axial_Length: 24.1,
          VF_DM: -3.2,
        },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /inferences/:id returns 401 without token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inferences/55555555-5555-4555-8555-555555555555",
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /feedback returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: {
        authorization: `Bearer ${signToken(RESEARCHER)}`,
        "content-type": "application/json",
      },
      payload: {
        consultation_id: "66666666-6666-4666-8666-666666666666",
        inference_id: "77777777-7777-4777-8777-777777777777",
        validated_class: 1,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /export/gold-standard returns 403 for OFTALMOLOGO", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/export/gold-standard?limit=10",
      headers: { authorization: `Bearer ${signToken(DOCTOR)}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /export/gold-standard returns 200 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/export/gold-standard?limit=10",
      headers: { authorization: `Bearer ${signToken(RESEARCHER)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.count).toBe(0);
  });

  it("POST /consultations returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: {
        authorization: `Bearer ${signToken(RESEARCHER)}`,
        "content-type": "application/json",
      },
      payload: { patientId: "88888888-8888-4888-8888-888888888888" },
    });
    expect(res.statusCode).toBe(403);
  });
});
