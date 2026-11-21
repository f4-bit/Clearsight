import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn(),
    getDownloadUrl: vi.fn(),
    getMlDownloadUrl: vi.fn(),
    getObjectStream: vi.fn(),
    getArtifactReferenceContext: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "job" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import type { FastifyInstance } from "fastify";
import type { UserRole } from "../src/schemas/common.js";
import { buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeSession, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

beforeEach(() => resetDb(prisma));

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function authenticatedToken(role: UserRole = "OFTALMOLOGO") {
  const user = await makeUser(prisma, role);
  const session = await makeSession(prisma, user);
  const token = app.jwt.sign({
    sub: user.id,
    role: user.role,
    sessionId: session.id,
    tokenVersion: user.tokenVersion,
  });
  return { user, session, token };
}

describe("JWT expiry verification", () => {
  it("accepts a valid token with default lifetime", async () => {
    const { token } = await authenticatedToken();
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
    const { token } = await authenticatedToken();
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
    const user = await makeUser(prisma, "OFTALMOLOGO");
    const session = await makeSession(prisma, user);
    const token = app.jwt.sign(
      {
        sub: user.id,
        role: user.role,
        sessionId: session.id,
        tokenVersion: user.tokenVersion,
      },
      { expiresIn: "1s" },
    );
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
