import { describe, expect, it, vi, beforeAll } from "vitest";

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

vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn(),
    getDownloadUrl: vi.fn(),
    getMlDownloadUrl: vi.fn(),
    getObjectStream: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "job" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const PATIENT_LOAD = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "op@clearsight.clinic",
  role: "OPHTHALMOLOGIST" as const,
};

beforeAll(async () => {
  app = await buildApp();
});

describe("JWT expiry verification", () => {
  it("accepts a valid token with default lifetime", async () => {
    const token = app.jwt.sign(PATIENT_LOAD);
    const res = await app.inject({
      method: "GET",
      url: "/patients",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a malformed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/patients",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects token with obviously invalid signature", async () => {
    const token = app.jwt.sign(PATIENT_LOAD);
    const res = await app.inject({
      method: "GET",
      url: "/patients",
      headers: {
        authorization: `Bearer ${token.slice(0, -10)}AAAAAAAAAA`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = app.jwt.sign(PATIENT_LOAD, { expiresIn: "1s" });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await app.inject({
      method: "GET",
      url: "/patients",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests without an authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/patients" });
    expect(res.statusCode).toBe(401);
  });
});
