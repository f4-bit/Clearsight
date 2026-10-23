import { describe, expect, it, vi } from "vitest";

// Mock external services so unit tests run isolated without AWS/Redis
vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn().mockResolvedValue("test-bucket/test-key.jpg"),
    getDownloadUrl: vi.fn().mockResolvedValue("http://localhost:9000/test.jpg"),
    getObjectStream: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

import { buildApp } from "../src/app.js";

describe("Health Route", () => {
  it("returns 200 ok on /health", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("clearsight-backend");
    expect(body.timestamp).toBeDefined();
    await app.close();
  });
});
