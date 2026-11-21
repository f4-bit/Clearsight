import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock external services so RBAC smoke tests run without S3/Redis.
vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn().mockResolvedValue("bucket/key.jpg"),
    getDownloadUrl: vi.fn().mockResolvedValue("http://localhost:9000/test.jpg"),
    getMlDownloadUrl: vi.fn().mockResolvedValue("http://minio:9000/test.jpg"),
    getObjectStream: vi.fn(),
    getArtifactReferenceContext: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { bearer, buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeStudy, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;
let doctorHeaders: { authorization: string };
let adminHeaders: { authorization: string };
let researcherHeaders: { authorization: string };

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

beforeEach(async () => {
  await resetDb(prisma);
  const doctor = await makeUser(prisma, "OFTALMOLOGO");
  const admin = await makeUser(prisma, "ADMIN");
  const researcher = await makeUser(prisma, "INVESTIGADOR");
  doctorHeaders = await bearer(app, prisma, doctor);
  adminHeaders = await bearer(app, prisma, admin);
  researcherHeaders = await bearer(app, prisma, researcher);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("RBAC smoke tests", () => {
  it("GET /patients returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/patients" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /patients returns only the doctor's own resources; other roles are denied", async () => {
    expect((await app.inject({ method: "GET", url: "/patients", headers: doctorHeaders })).statusCode).toBe(200);
    for (const headers of [adminHeaders, researcherHeaders]) {
      expect((await app.inject({ method: "GET", url: "/patients", headers })).statusCode).toBe(403);
    }
  });

  it("POST /patients allows OFTALMOLOGO with valid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/patients",
      headers: {
        ...doctorHeaders,
        "content-type": "application/json",
      },
      payload: { externalCode: "P-001", age: 55, gender: "M" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST /patients returns 403 for INVESTIGADOR and ADMIN", async () => {
    for (const headers of [researcherHeaders, adminHeaders]) {
      const res = await app.inject({
        method: "POST",
        url: "/patients",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        payload: { age: 50 },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("POST /inferences returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inferences",
      headers: {
        ...researcherHeaders,
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
        ...researcherHeaders,
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
      headers: doctorHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /export/gold-standard returns 403 for INVESTIGADOR without an active export grant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/export/gold-standard?limit=10",
      headers: researcherHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /export/gold-standard returns 200 for INVESTIGADOR with an active export grant", async () => {
    const researcher = await prisma.user.findFirstOrThrow({
      where: { email: { contains: "investigador" } },
      select: { id: true },
    });
    const doctor = await prisma.user.findFirstOrThrow({
      where: { role: "OFTALMOLOGO" },
      select: { id: true },
    });
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    await prisma.inferenceAccessGrant.create({
      data: {
        inferenceId: study.inference.id,
        consultationId: study.consultation.id,
        recipientUserId: researcher.id,
        approvalReference: `RBAC-${randomUUID()}`,
        canExportGoldStandard: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/export/gold-standard?limit=10",
      headers: researcherHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });

  it("POST /consultations returns 403 for INVESTIGADOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: {
        ...researcherHeaders,
        "content-type": "application/json",
      },
      payload: { patientId: "88888888-8888-4888-8888-888888888888" },
    });
    expect(res.statusCode).toBe(403);
  });
});
