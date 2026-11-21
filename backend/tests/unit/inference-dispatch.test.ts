import { describe, expect, it, vi } from "vitest";
import type { IdempotencyRecord } from "../../src/generated/prisma/client.js";
import type { PrismaClient } from "../../src/lib/prisma.js";
import type { IdempotencyRepository } from "../../src/repositories/idempotency.repo.js";
import { createInferenceDispatchService } from "../../src/services/inference-dispatch.js";
import { FEATURES } from "../fixtures/clinical.js";
import {
  FAKE_MANIFEST_VERSION,
  makePreparedSnapshot,
} from "../helpers/ml.js";

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
const DOCTOR_ID = "33333333-3333-4333-8333-333333333333";
const CONSULTATION_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555";
const prepared = makePreparedSnapshot(FEATURES);

function record(): IdempotencyRecord {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    actorUserId: DOCTOR_ID,
    scope: "inferences:create:v1",
    key: "key",
    payloadHash: "a".repeat(64),
    inferenceId: INFERENCE_ID,
    resolvedModelVersions: prepared.modelVersions,
    state: "PENDING",
    responseStatus: null,
    responseBody: null,
    acceptedAt: null,
    createdAt: new Date("2026-11-20T00:00:00.000Z"),
    dispatchAttempts: 0,
    nextDispatchAt: new Date("2026-11-20T00:00:00.000Z"),
    leaseUntil: null,
    lastErrorCode: null,
  } as IdempotencyRecord;
}

function execution(status = "QUEUED") {
  return {
    id: INFERENCE_ID,
    imageId: IMAGE_ID,
    consultationId: CONSULTATION_ID,
    eyeSide: "OD",
    snapshotId: SNAPSHOT_ID,
    status,
    modelVersion: FAKE_MANIFEST_VERSION,
    image: {
      id: IMAGE_ID,
      consultationId: CONSULTATION_ID,
      eyeSide: "OD",
      storagePath: "2026/11/retina.jpg",
      consultation: { id: CONSULTATION_ID, doctorId: DOCTOR_ID },
    },
    snapshot: {
      id: SNAPSHOT_ID,
      consultationId: CONSULTATION_ID,
      schemaVersion: "ml-zscore-f32-v1",
      rawPayload: { eyeSide: "OD", clinicalFeatures: FEATURES },
      normalizedPayload: {
        ...prepared.normalizedPayload,
        eyeSide: "OD",
      },
      modelVersions: prepared.modelVersions,
    },
    consultation: { id: CONSULTATION_ID, doctorId: DOCTOR_ID },
  };
}

function fakePrisma(value: unknown) {
  return {
    inference: { findUnique: vi.fn(async () => value) },
  } as unknown as PrismaClient;
}

function fakeRepository() {
  const markAccepted = vi.fn(async () => 1);
  const findById = vi.fn(
    async (): Promise<IdempotencyRecord | null> => null,
  );
  return {
    repository: { markAccepted, findById } as unknown as Pick<
      IdempotencyRepository,
      "markAccepted" | "findById"
    >,
    markAccepted,
    findById,
  };
}

function service(value: unknown) {
  const signMlDownloadUrl = vi.fn(async () => "https://signed.test/fresh.png");
  const enqueue = vi.fn(async () => ({ id: INFERENCE_ID }));
  const repo = fakeRepository();
  const dispatch = createInferenceDispatchService({
    prisma: fakePrisma(value),
    repository: repo.repository,
    signMlDownloadUrl,
    enqueue,
  });
  return { dispatch, signMlDownloadUrl, enqueue, ...repo };
}

describe("session-less pending dispatch", () => {
  it("signs, enqueues with the stable inference id and marks accepted", async () => {
    const harness = service(execution());

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({
      ok: true,
      inferenceId: INFERENCE_ID,
      alreadyTerminal: false,
    });
    expect(harness.signMlDownloadUrl).toHaveBeenCalledWith("2026/11/retina.jpg");
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceId: INFERENCE_ID,
        imageId: IMAGE_ID,
        eyeSide: "OD",
      }),
    );
    expect(harness.markAccepted).toHaveBeenCalledWith(record().id, {
      inferenceId: INFERENCE_ID,
      jobId: INFERENCE_ID,
      status: "QUEUED",
    });
  });

  it("marks a terminal execution accepted without signing or enqueueing", async () => {
    const harness = service(execution("COMPLETED"));

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({
      ok: true,
      inferenceId: INFERENCE_ID,
      alreadyTerminal: true,
    });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).toHaveBeenCalledTimes(1);
  });

  it("returns sign_failed without enqueueing or accepting", async () => {
    const harness = service(execution());
    harness.signMlDownloadUrl.mockRejectedValueOnce(new Error("sign down"));

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "sign_failed" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("returns enqueue_failed while leaving the record pending", async () => {
    const harness = service(execution());
    harness.enqueue.mockRejectedValueOnce(new Error("queue down"));

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "enqueue_failed" });
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("fails safely on an inconsistent snapshot/model record without side effects", async () => {
    const inconsistent = execution();
    inconsistent.snapshot.modelVersions = { collection: "other" };
    const harness = service(inconsistent);

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "inconsistent_record" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("rejects a missing execution as inconsistent", async () => {
    const harness = service(null);

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "inconsistent_record" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
  });

  it("treats a record with an invalid scope as inconsistent without side effects", async () => {
    const harness = service(execution());
    const bad = {
      ...record(),
      scope: "inferences:create:v2",
    } as IdempotencyRecord;

    const outcome = await harness.dispatch.dispatchPendingExecution(bad);

    expect(outcome).toEqual({ ok: false, code: "inconsistent_record" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("treats a record whose actor does not own the case as inconsistent", async () => {
    const harness = service(execution());
    const bad = {
      ...record(),
      actorUserId: "99999999-9999-4999-8999-999999999999",
    } as IdempotencyRecord;

    const outcome = await harness.dispatch.dispatchPendingExecution(bad);

    expect(outcome).toEqual({ ok: false, code: "inconsistent_record" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose stored eye side contradicts the image", async () => {
    const inconsistent = execution();
    inconsistent.snapshot.rawPayload = {
      eyeSide: "OS",
      clinicalFeatures: FEATURES,
    };
    const harness = service(inconsistent);

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "inconsistent_record" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to dispatch a record that is no longer pending", async () => {
    const harness = service(execution());
    const accepted = { ...record(), state: "ACCEPTED" } as IdempotencyRecord;

    const outcome = await harness.dispatch.dispatchPendingExecution(accepted);

    expect(outcome).toEqual({ ok: false, code: "not_pending" });
    expect(harness.signMlDownloadUrl).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.markAccepted).not.toHaveBeenCalled();
  });

  it("returns mark_failed when the acceptance CAS affects no row and stays pending", async () => {
    const harness = service(execution());
    harness.markAccepted.mockResolvedValueOnce(0);
    harness.findById.mockResolvedValueOnce(record());

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({ ok: false, code: "mark_failed" });
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("accepts when the CAS loses to a concurrent acceptance", async () => {
    const harness = service(execution());
    harness.markAccepted.mockResolvedValueOnce(0);
    harness.findById.mockResolvedValueOnce({
      ...record(),
      state: "ACCEPTED",
    } as IdempotencyRecord);

    const outcome = await harness.dispatch.dispatchPendingExecution(record());

    expect(outcome).toEqual({
      ok: true,
      inferenceId: INFERENCE_ID,
      alreadyTerminal: false,
    });
  });
});
