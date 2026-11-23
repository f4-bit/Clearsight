import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "../src/generated/prisma/client.js";
import type { JobResponse } from "../src/schemas/inference.js";
import { createInferenceQueueRepository } from "../src/repositories/inference-queue.repo.js";
import {
  createInferenceRunRepository,
  type TerminalInferenceUpdate,
} from "../src/repositories/inference-run.repo.js";
import {
  MlClientHttpError,
  type MlClient,
} from "../src/services/ml-client.js";
import { enqueueInference } from "../src/workers/inference.queue.js";
import {
  createInferencePoller,
  type InferencePollerDeps,
} from "../src/workers/inference.worker.js";
import {
  createInferenceProcessor,
  InferenceRetryableError,
} from "../src/workers/inference.processor.js";
import { FEATURES } from "./fixtures/clinical.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "./helpers/ml.js";

const prisma = createTestPrisma();
const prepared = makePreparedSnapshot(FEATURES);

beforeEach(async () => {
  await resetDb(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createExecution(options: {
  status?: string;
  processAttempts?: number;
} = {}) {
  const doctor = await makeUser(prisma, "OFTALMOLOGO");
  const patient = await prisma.patient.create({
    data: { ownerDoctorId: doctor.id },
  });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      // Sentinel status the worker must never write (REG-003 class): a
      // regression that promotes the consultation to COMPLETED is observable.
      status: "DOWNLOADING",
      clinicalData: { ...FEATURES } as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: "OD",
      storagePath: "2026/11/queue-image.jpg",
    },
  });
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: consultation.id,
      rawPayload: {
        eyeSide: "OD",
        clinicalFeatures: FEATURES,
      } as Prisma.InputJsonValue,
      normalizedPayload: {
        ...prepared.normalizedPayload,
        eyeSide: "OD",
      } as Prisma.InputJsonValue,
      schemaVersion: "ml-zscore-f32-v1",
      modelVersions: prepared.modelVersions as Prisma.InputJsonValue,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide: "OD",
      snapshotId: snapshot.id,
      status: options.status ?? "QUEUED",
      modelVersion: FAKE_MANIFEST_VERSION,
    },
  });
  if (options.processAttempts !== undefined) {
    await prisma.$executeRawUnsafe(
      `UPDATE "public"."inferences" SET process_attempts = $2 WHERE id = $1::uuid`,
      inference.id,
      options.processAttempts,
    );
  }
  return { doctor, consultation, image, snapshot, inference };
}

function result(
  execution: { inference: { id: string } },
): NonNullable<JobResponse["result"]> {
  return {
    inferenceId: execution.inference.id,
    eyeSide: "OD",
    label: "Glaucoma",
    confidence: 0.8,
    probabilities: {
      Glaucoma: 0.8,
      Non_Glaucoma: 0.1,
      Suspicious_Glaucoma: 0.1,
    },
    modelPredictions: {
      efficientnet_b3: {
        probabilities: {
          Glaucoma: 0.8,
          Non_Glaucoma: 0.1,
          Suspicious_Glaucoma: 0.1,
        },
        predictedClass: "Glaucoma",
        confidence: 0.8,
      },
      resnet50: {
        probabilities: {
          Glaucoma: 0.1,
          Non_Glaucoma: 0.8,
          Suspicious_Glaucoma: 0.1,
        },
        predictedClass: "Non_Glaucoma",
        confidence: 0.8,
      },
    },
    cdr: 0.4,
    cdrVertical: 0.45,
    quality: { review_required: false },
    artifacts: {
      mask: "s3://masks/mask.png",
      overlay: "s3://overlays/overlay.png",
    },
    modelVersions: {
      segmentation: prepared.modelVersions.segmentation,
      efficientnet_b3: prepared.modelVersions.efficientnet_b3,
      resnet50: prepared.modelVersions.resnet50,
    },
    elapsedSeconds: 1.2,
  } as NonNullable<JobResponse["result"]>;
}

function completedClient(
  execution: { inference: { id: string } },
): Pick<MlClient, "submitInference" | "getJobStatus"> {
  return {
    submitInference: vi.fn(async () => ({
      inferenceId: execution.inference.id,
      jobId: execution.inference.id,
      status: "QUEUED" as const,
    })),
    getJobStatus: vi.fn(async () => ({
      inferenceId: execution.inference.id,
      jobId: execution.inference.id,
      status: "COMPLETED" as const,
      stage: "COMPLETED",
      message: null,
      result: result(execution),
    })),
  };
}

function retryableClient(): Pick<MlClient, "submitInference" | "getJobStatus"> {
  return {
    submitInference: vi.fn(async () => {
      throw new MlClientHttpError(429);
    }),
    getJobStatus: vi.fn(async () => {
      throw new Error("getJobStatus must not be called after a retryable submit");
    }),
  };
}

function processorFor(
  ml: Pick<MlClient, "submitInference" | "getJobStatus">,
  signMlDownloadUrl = vi.fn(async () => "https://signed.test/fresh.png"),
) {
  return {
    processor: createInferenceProcessor({
      db: createInferenceRunRepository(prisma),
      mlClient: ml,
      signMlDownloadUrl,
      sleep: async () => {},
      now: () => new Date("2026-11-20T00:00:00.000Z"),
      pollIntervalMs: 1,
      maxPolls: 1,
    }),
    signMlDownloadUrl,
  };
}

function makePoller(
  processor: InferencePollerDeps["processor"],
  repository: InferencePollerDeps["repository"] = createInferenceRunRepository(
    prisma,
  ),
) {
  return createInferencePoller({
    repository,
    queue: createInferenceQueueRepository(prisma),
    processor,
    intervalMs: 0,
    logger: vi.fn(),
  });
}

async function queueRow(inferenceId: string) {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      status: string | null;
      process_attempts: number;
      next_process_at: Date;
      process_lease_until: Date | null;
    }>
  >(
    `SELECT status, process_attempts, next_process_at, process_lease_until
       FROM "public"."inferences"
      WHERE id = $1::uuid`,
    inferenceId,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("inference row is missing");
  }
  return row;
}

async function makeDue(inferenceId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "public"."inferences"
        SET next_process_at = pg_catalog.statement_timestamp()
      WHERE id = $1::uuid`,
    inferenceId,
  );
}

describe("PostgreSQL inference poller integration", () => {
  it("claims a due row once across two pollers and re-signs the image JIT", async () => {
    const execution = await createExecution();
    const ml = completedClient(execution);
    const { processor, signMlDownloadUrl } = processorFor(ml);

    await Promise.all([
      makePoller(processor).runOnce(),
      makePoller(processor).runOnce(),
    ]);

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.status).toBe("COMPLETED");
    expect(ml.submitInference).toHaveBeenCalledTimes(1);
    expect((await queueRow(execution.inference.id)).process_lease_until).toBeNull();
    expect(signMlDownloadUrl).toHaveBeenCalledWith(execution.image.storagePath);
    expect(ml.submitInference).toHaveBeenCalledWith(
      expect.objectContaining({
        image_url: "https://signed.test/fresh.png",
      }),
    );
    expect(ml.submitInference).not.toHaveBeenCalledWith(
      expect.objectContaining({
        image_url: "2026/11/queue-image.jpg",
      }),
    );
  });

  it("retries a 429 with backoff and keeps the execution QUEUED", async () => {
    const execution = await createExecution();
    const ml = retryableClient();
    const { processor } = processorFor(ml);
    const poller = makePoller(processor);

    const before = Date.now();
    await poller.runOnce();

    const queued = await queueRow(execution.inference.id);
    expect(queued.status).toBe("QUEUED");
    expect(queued.process_attempts).toBe(1);
    expect(queued.process_lease_until).toBeNull();
    expect(new Date(queued.next_process_at).getTime()).toBeGreaterThan(before);

    // Not due yet: a second tick must not submit again.
    await poller.runOnce();
    expect(ml.submitInference).toHaveBeenCalledTimes(1);

    await makeDue(execution.inference.id);
    const success = completedClient(execution);
    await makePoller(processorFor(success).processor).runOnce();

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.status).toBe("COMPLETED");
    expect(success.submitInference).toHaveBeenCalledTimes(1);
    expect((await queueRow(execution.inference.id)).process_lease_until).toBeNull();
  });

  it("persists FAILED once after three retryable attempts and never touches the consultation", async () => {
    const execution = await createExecution();
    const ml = retryableClient();
    const repository = createInferenceRunRepository(prisma);
    const saveTerminalResult = vi.fn(
      async (inferenceId: string, update: TerminalInferenceUpdate) =>
        repository.saveTerminalResult(inferenceId, update),
    );
    const poller = makePoller(processorFor(ml).processor, {
      findExecution: repository.findExecution,
      saveTerminalResult,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await makeDue(execution.inference.id);
      await poller.runOnce();
    }

    const failed = await queueRow(execution.inference.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.process_attempts).toBe(3);
    expect(failed.process_lease_until).toBeNull();
    expect(ml.submitInference).toHaveBeenCalledTimes(3);
    expect(
      saveTerminalResult.mock.calls.filter(
        (call) => call[1].status === "FAILED",
      ),
    ).toHaveLength(1);

    // A FAILED row is no longer claimable: no extra ML call or FAILED write.
    await makeDue(execution.inference.id);
    await poller.runOnce();
    expect(ml.submitInference).toHaveBeenCalledTimes(3);
    expect(
      saveTerminalResult.mock.calls.filter(
        (call) => call[1].status === "FAILED",
      ),
    ).toHaveLength(1);

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: execution.consultation.id },
    });
    // REG-003 class: no code path in the queue/worker may write
    // consultation.status, least of all promote it to COMPLETED.
    expect(consultation.status).toBe("DOWNLOADING");
  });

  it.each(["COMPLETED", "REVIEW_REQUIRED"] as const)(
    "never downgrades a racing terminal %s through the FAILED CAS",
    async (terminalStatus) => {
      const execution = await createExecution({ processAttempts: 2 });
      const repository = createInferenceRunRepository(prisma);
      const processor = vi.fn(async () => {
        await repository.saveTerminalResult(execution.inference.id, {
          status: terminalStatus,
        });
        throw new InferenceRetryableError();
      });

      await makePoller(processor, repository).runOnce();

      const stored = await prisma.inference.findUniqueOrThrow({
        where: { id: execution.inference.id },
      });
      expect(stored.status).toBe(terminalStatus);
      expect((await queueRow(execution.inference.id)).process_lease_until).toBeNull();
    },
  );

  it("clears the lease after a terminal ML error without consuming a retry", async () => {
    const execution = await createExecution();
    const ml: Pick<MlClient, "submitInference" | "getJobStatus"> = {
      submitInference: vi.fn(async () => {
        throw new MlClientHttpError(400);
      }),
      getJobStatus: vi.fn(async () => {
        throw new Error("getJobStatus must not be called after a terminal submit");
      }),
    };

    await makePoller(processorFor(ml).processor).runOnce();

    const failed = await queueRow(execution.inference.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.process_attempts).toBe(0);
    expect(failed.process_lease_until).toBeNull();
  });

  it("does not re-arm a row while its process lease is live", async () => {
    const execution = await createExecution();
    const baseline = new Date("2026-01-01T00:00:00.000Z");
    await prisma.$executeRawUnsafe(
      `UPDATE "public"."inferences" SET next_process_at = $2 WHERE id = $1::uuid`,
      execution.inference.id,
      baseline,
    );

    const claimed = await createInferenceQueueRepository(prisma).claimProcessBatch(1);
    expect(claimed.map((item) => item.id)).toContain(execution.inference.id);
    const leased = await queueRow(execution.inference.id);
    expect(leased.process_lease_until).not.toBeNull();
    expect(new Date(leased.next_process_at).getTime()).toBe(baseline.getTime());

    const job = {
      inferenceId: execution.inference.id,
      imageId: execution.image.id,
      eyeSide: "OD" as const,
      clinicalFeatures: FEATURES,
    };
    await enqueueInference(job);
    const notRearmed = await queueRow(execution.inference.id);
    expect(new Date(notRearmed.next_process_at).getTime()).toBe(
      baseline.getTime(),
    );

    // An expired lease no longer fences markReady.
    await prisma.$executeRawUnsafe(
      `UPDATE "public"."inferences"
          SET process_lease_until = pg_catalog.statement_timestamp() - interval '1 second'
        WHERE id = $1::uuid`,
      execution.inference.id,
    );
    await enqueueInference(job);
    const rearmed = await queueRow(execution.inference.id);
    expect(new Date(rearmed.next_process_at).getTime()).toBeGreaterThan(
      baseline.getTime(),
    );
  });

  it("allows re-claiming a QUEUED row whose lease expired", async () => {
    const execution = await createExecution();
    await prisma.$executeRawUnsafe(
      `UPDATE "public"."inferences"
          SET next_process_at = pg_catalog.statement_timestamp() - interval '1 second',
              process_lease_until = pg_catalog.statement_timestamp() - interval '1 second'
        WHERE id = $1::uuid`,
      execution.inference.id,
    );

    const claimed = await createInferenceQueueRepository(prisma).claimProcessBatch(1);
    expect(claimed.map((item) => item.id)).toContain(execution.inference.id);
    const reclaimed = await queueRow(execution.inference.id);
    expect(reclaimed.process_lease_until).not.toBeNull();
    // Contract: claim lease is exactly 300s (INFERENCE_PROCESS_CLAIM_LEASE_SECONDS).
    const leaseMs = new Date(reclaimed.process_lease_until!).getTime();
    expect(leaseMs).toBeGreaterThanOrEqual(Date.now() + 295_000);
    expect(leaseMs).toBeLessThanOrEqual(Date.now() + 305_000);
  });

  it("wakes a deferred execution through enqueueInference", async () => {
    const execution = await createExecution();
    await prisma.$executeRawUnsafe(
      `UPDATE "public"."inferences"
          SET next_process_at = pg_catalog.statement_timestamp() + interval '1 hour'
        WHERE id = $1::uuid`,
      execution.inference.id,
    );

    await enqueueInference({
      inferenceId: execution.inference.id,
      imageId: execution.image.id,
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });
    await makePoller(processorFor(completedClient(execution)).processor).runOnce();

    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: execution.inference.id },
    });
    expect(stored.status).toBe("COMPLETED");
  });

  it("adds the process queue columns, constraint and partial index", async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{ column_name: string; is_nullable: string }>
    >(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inferences'
          AND column_name IN ('process_attempts', 'next_process_at', 'process_lease_until')
        ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: "next_process_at", is_nullable: "NO" },
      { column_name: "process_attempts", is_nullable: "NO" },
      { column_name: "process_lease_until", is_nullable: "YES" },
    ]);

    const indexes = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_inferences_process_queue'`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("next_process_at");
    expect(indexes[0]!.indexdef).toContain("'QUEUED'::text");

    const constraints = await prisma.$queryRawUnsafe<
      Array<{ conname: string }>
    >(
      `SELECT conname
         FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.inferences'::regclass
          AND conname = 'inferences_process_attempts_nonnegative'`,
    );
    expect(constraints).toHaveLength(1);
  });

  it("applies 2s*2^attempts retry backoff capped at exactly 120 seconds", async () => {
    const execution = await createExecution();
    const queue = createInferenceQueueRepository(prisma);
    const id = execution.inference.id;

    const measure = async (priorAttempts: number, expectedMs: number) => {
      await prisma.$executeRawUnsafe(
        `UPDATE "public"."inferences"
            SET process_attempts = $2,
                next_process_at = pg_catalog.statement_timestamp(),
                process_lease_until = NULL
          WHERE id = $1::uuid`,
        id,
        priorAttempts,
      );
      const before = (
        await prisma.$queryRawUnsafe<Array<{ t: Date }>>(
          "SELECT pg_catalog.statement_timestamp() AS t",
        )
      )[0]!.t;
      const attempt = await queue.markProcessRetry(id);
      const after = (
        await prisma.$queryRawUnsafe<Array<{ t: Date }>>(
          "SELECT pg_catalog.statement_timestamp() AS t",
        )
      )[0]!.t;
      const row = await queueRow(id);
      expect(attempt).toBe(priorAttempts + 1);
      expect(row.process_attempts).toBe(priorAttempts + 1);
      expect(row.process_lease_until).toBeNull();
      const next = new Date(row.next_process_at).getTime();
      expect(next).toBeGreaterThanOrEqual(new Date(before).getTime() + expectedMs);
      expect(next).toBeLessThanOrEqual(new Date(after).getTime() + expectedMs);
    };

    // First failure: process_attempts=0 -> 2s * 2^0 = 2s.
    await measure(0, 2_000);
    // Second failure: process_attempts=1 -> 2s * 2^1 = 4s.
    await measure(1, 4_000);
    // Third failure: process_attempts=2 -> 2s * 2^2 = 8s.
    await measure(2, 8_000);
    // A deeply failed row is capped at exactly 120s, never 2s*2^attempts.
    await measure(20, 120_000);
  });

  it("markReady never re-arms a row that is no longer QUEUED", async () => {
    const execution = await createExecution({ status: "FAILED" });
    const before = await queueRow(execution.inference.id);

    await enqueueInference({
      inferenceId: execution.inference.id,
      imageId: execution.image.id,
      eyeSide: "OD",
      clinicalFeatures: FEATURES,
    });

    const after = await queueRow(execution.inference.id);
    expect(new Date(after.next_process_at).getTime()).toBe(
      new Date(before.next_process_at).getTime(),
    );
  });

  it("persists FAILED invalid_job_context for a legacy row without snapshot", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const patient = await prisma.patient.create({
      data: { ownerDoctorId: doctor.id },
    });
    const consultation = await prisma.consultation.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        status: "DOWNLOADING",
        clinicalData: { ...FEATURES } as Prisma.InputJsonValue,
      },
    });
    const image = await prisma.image.create({
      data: {
        consultationId: consultation.id,
        eyeSide: "OD",
        storagePath: "2026/11/legacy-image.jpg",
      },
    });
    const inference = await prisma.inference.create({
      data: {
        imageId: image.id,
        consultationId: consultation.id,
        eyeSide: "OD",
        status: "QUEUED",
        modelVersion: FAKE_MANIFEST_VERSION,
      },
    });

    const processor = vi.fn(async () => {
      throw new Error("processor must not run without a pinned snapshot");
    });
    const logger = vi.fn();
    const poller = createInferencePoller({
      repository: createInferenceRunRepository(prisma),
      queue: createInferenceQueueRepository(prisma),
      processor,
      intervalMs: 0,
      logger,
    });
    await poller.runOnce();

    const failed = await queueRow(inference.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.process_attempts).toBe(0);
    expect(failed.process_lease_until).toBeNull();
    expect(processor).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "failed",
        inferenceId: inference.id,
        errorCode: "invalid_job_context",
      }),
    );
    const untouched = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultation.id },
    });
    expect(untouched.status).toBe("DOWNLOADING");
  });
});
