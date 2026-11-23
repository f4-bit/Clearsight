import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "../src/generated/prisma/client.js";
import { FEATURES } from "./fixtures/clinical.js";
import { bearer, buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

type Role = "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN";
interface User {
  id: string;
  role: Role;
}

interface Execution {
  id: string;
  imageId: string;
}

interface Study {
  patient: { id: string };
  consultation: { id: string };
  image: { id: string };
  snapshot: { id: string };
  inference: Execution;
}

let doctorA: User;
let doctorB: User;
let researcher: User;
let headersA: { authorization: string };
let headersB: { authorization: string };
let headersResearcher: { authorization: string };

const CHECKSUM = "a".repeat(64);

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

beforeEach(async () => {
  await resetDb(prisma);
  doctorA = await makeUser(prisma, "OFTALMOLOGO");
  doctorB = await makeUser(prisma, "OFTALMOLOGO");
  researcher = await makeUser(prisma, "INVESTIGADOR");
  headersA = await bearer(app, prisma, doctorA);
  headersB = await bearer(app, prisma, doctorB);
  headersResearcher = await bearer(app, prisma, researcher);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function addArtifactsToInference(
  inferenceId: string,
  snapshotId: string,
  withArtifacts: "complete" | "no-pdf" | "none",
): Promise<void> {
  if (withArtifacts === "none") {
    return;
  }
  await prisma.artifactRecord.createMany({
    data: [
      {
        inferenceId,
        artifactType: "mask",
        version: 1,
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "mask-bucket",
        key: `mask/${inferenceId}.png`,
        contentType: "image/png",
        sizeBytes: 10n,
        checksumSha256: CHECKSUM,
        availableAt: new Date(),
      },
      {
        inferenceId,
        artifactType: "overlay",
        version: 1,
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "overlay-bucket",
        key: `overlay/${inferenceId}.png`,
        contentType: "image/png",
        sizeBytes: 10n,
        checksumSha256: CHECKSUM,
        availableAt: new Date(),
      },
    ],
  });
  if (withArtifacts === "complete") {
    const pdf = await prisma.artifactRecord.create({
      data: {
        inferenceId,
        artifactType: "pdf",
        version: 1,
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${inferenceId}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 20n,
        checksumSha256: CHECKSUM,
        availableAt: new Date(),
      },
    });
    await prisma.pdfReport.create({
      data: {
        inferenceId,
        version: 1,
        artifactId: pdf.id,
        sourceSnapshotId: snapshotId,
        status: "AVAILABLE",
        dataVersion: `pdfv1:${"b".repeat(64)}`,
        modelVersions: {},
        renderingInputs: {},
        availableAt: new Date(),
      },
    });
  }
}

async function addExecution(
  study: Study,
  status: string,
  eyeSide: "OD" | "OS",
  withArtifacts: "complete" | "no-pdf" | "none" = "none",
  reanalysisOfId?: string,
): Promise<Execution> {
  const image = await prisma.image.create({
    data: {
      consultationId: study.consultation.id,
      eyeSide,
      storagePath: `case/${eyeSide}-${Date.now()}.jpg`,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: study.consultation.id,
      eyeSide,
      snapshotId: study.snapshot.id,
      status,
      reanalysisOfId: reanalysisOfId ?? null,
      predictedClass: 2,
      confidence: 0.87,
      probabilities: {
        Glaucoma: 0.1,
        Non_Glaucoma: 0.03,
        Suspicious_Glaucoma: 0.87,
      } as Prisma.InputJsonValue,
      cdr: 0.42,
      cdrVertical: 0.38,
      quality: { segmentation: 0.91 } as Prisma.InputJsonValue,
      elapsedSeconds: 3.5,
      modelVersion: "v1",
      modelVersions: {} as Prisma.InputJsonValue,
      modelPredictions: {} as Prisma.InputJsonValue,
      artifacts: {} as Prisma.InputJsonValue,
    },
  });

  await addArtifactsToInference(
    inference.id,
    study.snapshot.id,
    withArtifacts,
  );
  return inference;
}

async function seedStudy(
  doctorId: string,
  status = "COMPLETED",
  withArtifacts: "complete" | "no-pdf" | "none" = "none",
  measures: Pick<Prisma.InferenceCreateInput, "cdr" | "cdrVertical" | "quality"> = {},
): Promise<Study> {
  const patient = await prisma.patient.create({
    data: { ownerDoctorId: doctorId },
  });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId,
      status: "COMPLETED",
      clinicalData: { ...FEATURES } as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: "OD",
      storagePath: `case/${consultation.id}.jpg`,
    },
  });
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: consultation.id,
      rawPayload: { ...FEATURES } as Prisma.InputJsonValue,
      normalizedPayload: { ...FEATURES } as Prisma.InputJsonValue,
      schemaVersion: "ml-zscore-f32-v1",
      modelVersions: {},
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide: "OD",
      snapshotId: snapshot.id,
      status,
      predictedClass: status === "QUEUED" ? null : 2,
      confidence: status === "QUEUED" ? null : 0.87,
      probabilities: {} as Prisma.InputJsonValue,
      cdr: status === "QUEUED" ? null : 0.42,
      cdrVertical: status === "QUEUED" ? null : 0.38,
      quality: {} as Prisma.InputJsonValue,
      elapsedSeconds: status === "QUEUED" ? null : 3.5,
      modelVersion: "v1",
      modelVersions: {} as Prisma.InputJsonValue,
      modelPredictions: {} as Prisma.InputJsonValue,
      artifacts: {} as Prisma.InputJsonValue,
      ...measures,
    },
  });
  const study = {
    patient,
    consultation,
    image,
    snapshot,
    inference: { id: inference.id, imageId: image.id },
  };
  await addArtifactsToInference(inference.id, snapshot.id, withArtifacts);
  if (withArtifacts !== "none") {
    // A second, unselected eye keeps the images count realistic without
    // changing the frozen set's evidence.
    await addExecution(study, status, "OS", "none");
  }
  return study;
}

async function freeze(
  consultationId: string,
  executionIds: string[],
  headers = headersA,
) {
  return app.inject({
    method: "POST",
    url: `/consultations/${consultationId}/required-executions`,
    headers,
    payload: { executionIds },
  });
}

async function grantReadResult(study: Study): Promise<void> {
  await prisma.inferenceAccessGrant.create({
    data: {
      inferenceId: study.inference.id,
      consultationId: study.consultation.id,
      recipientUserId: researcher.id,
      approvalReference: `APP-${study.inference.id}`,
      readResult: true,
      readArtifacts: false,
      readPdf: false,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe("consultation completion and freeze (real PostgreSQL)", () => {
  it("freezes the owned selection once and rejects foreign/duplicate changes", async () => {
    const study = await seedStudy(doctorA.id);
    const second = await addExecution(study, "COMPLETED", "OS");
    const foreign = await seedStudy(doctorA.id);

    expect(
      (
        await freeze(study.consultation.id, [
          study.inference.id,
          study.inference.id,
        ])
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await freeze(study.consultation.id, [
          study.inference.id,
          foreign.inference.id,
        ])
      ).statusCode,
    ).toBe(422);
    expect((await freeze(study.consultation.id, [])).statusCode).toBe(400);
    expect(
      (await freeze(study.consultation.id, [study.inference.id], headersB))
        .statusCode,
    ).toBe(404);

    const owned = await freeze(study.consultation.id, [
      study.inference.id,
      second.id,
    ]);
    expect(owned.statusCode).toBe(200);
    const body = owned.json() as {
      id: string;
      requiredExecutionIds: string[];
      requiredSetVersion: string;
      requiredSetFrozenAt: string;
    };
    expect(body.requiredExecutionIds).toEqual(
      [study.inference.id, second.id].sort(),
    );
    expect(body.requiredSetVersion).toMatch(/^rsv1:[0-9a-f]{64}$/);
    expect(body.requiredSetFrozenAt).toBeTruthy();

    const persisted = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(persisted?.requiredExecutionIds).toEqual(
      [study.inference.id, second.id].sort(),
    );
    expect(persisted?.requiredSetVersion).toBe(body.requiredSetVersion);
    expect(persisted?.requiredSetFrozenAt).not.toBeNull();

    const secondFreeze = await freeze(study.consultation.id, [
      study.inference.id,
    ]);
    expect(secondFreeze.statusCode).toBe(409);
    expect(secondFreeze.body).not.toMatch(
      /Prisma|constraint|trigger|restrict_violation|23001|P2003|P2010|foreign key/i,
    );

    const intact = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(intact?.requiredExecutionIds).toEqual(
      [study.inference.id, second.id].sort(),
    );
    expect(intact?.requiredSetVersion).toBe(body.requiredSetVersion);
  });

  it("maps a concurrent freeze loser to a safe 409 without Prisma details", async () => {
    const study = await seedStudy(doctorA.id);
    const second = await addExecution(study, "COMPLETED", "OS");

    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedGate = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const locker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consultations WHERE id = ${study.consultation.id}::uuid FOR UPDATE`;
      locked();
      await releaseGate;
    });
    await lockedGate;

    // Both requests pass the frozenAt pre-check before the row lock is
    // released; only the first update can win, the second hits the trigger.
    const first = freeze(study.consultation.id, [study.inference.id]);
    const secondRequest = freeze(study.consultation.id, [
      study.inference.id,
      second.id,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const [firstResponse, secondResponse] = await Promise.all([
      first,
      secondRequest,
    ]);
    await locker;

    const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort(
      (left, right) => left - right,
    );
    expect(statuses).toEqual([200, 409]);
    const loser =
      firstResponse.statusCode === 409 ? firstResponse : secondResponse;
    expect(loser.statusCode).toBe(409);
    expect(loser.body).not.toMatch(
      /Prisma|constraint|trigger|restrict_violation|23001|P2003|P2010|foreign key/i,
    );

    const persisted = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(persisted?.requiredSetFrozenAt).not.toBeNull();
  });

  it("exposes frozen selection and deterministic aggregates without persisting them", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    const selected = study.inference.id;
    const freezeResponse = await freeze(study.consultation.id, [selected]);
    expect(freezeResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: study.consultation.id,
      requiredExecutionIds: [selected],
      requiredSetVersion: (freezeResponse.json() as { requiredSetVersion: string })
        .requiredSetVersion,
      analysisState: "COMPLETED",
      reportState: "AVAILABLE",
      completionState: "COMPLETE",
      pollingStop: "COMPLETE",
    });
    expect(body.images).toHaveLength(2);

    const persisted = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(persisted).not.toHaveProperty("analysisState");
    expect(persisted).not.toHaveProperty("reportState");
    expect(persisted).not.toHaveProperty("completionState");
    expect(persisted).not.toHaveProperty("pollingStop");
  });

  it("ignores later reanalyses outside the frozen set", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    await freeze(study.consultation.id, [study.inference.id]);

    await addExecution(
      study,
      "COMPLETED",
      "OD",
      "complete",
      study.inference.id,
    );

    const response = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { requiredExecutionIds: string[] }).requiredExecutionIds).toEqual(
      [study.inference.id],
    );
  });

  it("returns delivery, consultation pollingStop and Retry-After after publication", async () => {
    const complete = await seedStudy(doctorA.id, "COMPLETED", "complete");
    await freeze(complete.consultation.id, [complete.inference.id]);
    const completeResponse = await app.inject({
      method: "GET",
      url: `/inferences/${complete.inference.id}`,
      headers: headersA,
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json()).toMatchObject({
      status: "COMPLETED",
      delivery: {
        resultStatus: "AVAILABLE",
        evidenceStatus: "AVAILABLE",
        pdfStatus: "AVAILABLE",
        complete: true,
        deliveryTerminal: true,
      },
      pollingStop: "COMPLETE",
    });
    expect(completeResponse.headers["retry-after"]).toBeUndefined();

    const pending = await seedStudy(doctorA.id, "COMPLETED", "no-pdf");
    await freeze(pending.consultation.id, [pending.inference.id]);
    const pendingResponse = await app.inject({
      method: "GET",
      url: `/inferences/${pending.inference.id}`,
      headers: headersA,
    });
    expect(pendingResponse.statusCode).toBe(200);
    expect(pendingResponse.json()).toMatchObject({
      status: "COMPLETED",
      cdr: 0.42,
      cdrVertical: 0.38,
      delivery: {
        resultStatus: "AVAILABLE",
        evidenceStatus: "AVAILABLE",
        pdfStatus: "PENDING",
        complete: false,
        deliveryTerminal: false,
      },
      pollingStop: "CONTINUE",
    });
    const retryAfter = Number(pendingResponse.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(2);
    expect(retryAfter).toBeLessThanOrEqual(10);

    const queued = await seedStudy(doctorA.id, "QUEUED", "none");
    await freeze(queued.consultation.id, [queued.inference.id]);
    const queuedResponse = await app.inject({
      method: "GET",
      url: `/inferences/${queued.inference.id}`,
      headers: headersA,
    });
    expect(queuedResponse.statusCode).toBe(200);
    expect(queuedResponse.json()).toMatchObject({
      status: "QUEUED",
      cdr: null,
      cdrVertical: null,
      pollingStop: "CONTINUE",
    });
    expect(Number(queuedResponse.headers["retry-after"])).toBe(2);
  });

  it("allows readResult grant delivery without exposing artifact locators", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    await freeze(study.consultation.id, [study.inference.id]);
    await grantReadResult(study);

    const response = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}`,
      headers: headersResearcher,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.delivery).toMatchObject({ complete: true });
    expect(body).toMatchObject({ cdr: 0.42, cdrVertical: 0.38 });
    expect(body).not.toHaveProperty("artifacts");
    expect(body).not.toHaveProperty("storageId");
    expect(body).not.toHaveProperty("key");
  });

  it("recomputes aggregates on every read from persisted rows without storing enums", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "no-pdf");
    await freeze(study.consultation.id, [study.inference.id]);

    const first = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });

    // Publication lands later (3.5); no endpoint mutates the aggregates.
    const pdf = await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "pdf",
        version: 1,
        status: "AVAILABLE",
        storageId: "minio-local",
        bucketOrContainer: "pdf-bucket",
        key: `${study.inference.id}/v1.pdf`,
        contentType: "application/pdf",
        sizeBytes: 20n,
        checksumSha256: CHECKSUM,
        availableAt: new Date(),
      },
    });
    await prisma.pdfReport.create({
      data: {
        inferenceId: study.inference.id,
        version: 1,
        artifactId: pdf.id,
        sourceSnapshotId: study.snapshot.id,
        status: "AVAILABLE",
        dataVersion: `pdfv1:${"b".repeat(64)}`,
        modelVersions: {},
        renderingInputs: {},
        availableAt: new Date(),
      },
    });

    const second = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "AVAILABLE",
      completionState: "COMPLETE",
      pollingStop: "COMPLETE",
    });
  });

  it("keeps frozen-set aggregates intact when out-of-set reanalyses complete or fail", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "no-pdf");
    await freeze(study.consultation.id, [study.inference.id]);

    // A reanalysis outside the frozen set finishes complete with PDF...
    const good = await addExecution(
      study,
      "COMPLETED",
      "OD",
      "complete",
      study.inference.id,
    );
    // ...and another one fails outright. Neither may touch the frozen set.
    await addExecution(study, "FAILED", "OD", "none", good.id);

    const response = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requiredExecutionIds: [study.inference.id],
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
  });

  it("never reports AVAILABLE when only some required executions have a PDF", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    const second = await addExecution(study, "COMPLETED", "OS", "no-pdf");
    await freeze(study.consultation.id, [study.inference.id, second.id]);

    const response = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersA,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { reportState: string };
    expect(body).toMatchObject({
      analysisState: "COMPLETED",
      reportState: "REPORT_PENDING",
      completionState: "INCOMPLETE",
      pollingStop: "CONTINUE",
    });
    expect(body.reportState).not.toBe("AVAILABLE");
  });

  it("freezes a case-insensitive deterministic rsv1 manifest without touching consultation status", async () => {
    const open = await seedStudy(doctorA.id, "QUEUED", "none");
    await prisma.consultation.update({
      where: { id: open.consultation.id },
      data: { status: "QUEUED" },
    });
    const second = await addExecution(open, "QUEUED", "OS");
    const sorted = [open.inference.id, second.id]
      .map((id) => id.toLowerCase())
      .sort();
    const digest = createHash("sha256").update(sorted.join("\n")).digest("hex");

    const response = await freeze(
      open.consultation.id,
      [second.id, open.inference.id].map((id) => id.toUpperCase()),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      requiredExecutionIds: string[];
      requiredSetVersion: string;
    };
    expect(body.requiredExecutionIds).toEqual(sorted);
    expect(body.requiredSetVersion).toBe(`rsv1:${digest}`);

    const openAfter = await prisma.consultation.findUnique({
      where: { id: open.consultation.id },
    });
    expect(openAfter?.status).toBe("QUEUED");
    expect(openAfter?.requiredExecutionIds).toEqual(sorted);
    expect(openAfter?.requiredSetVersion).toBe(`rsv1:${digest}`);
    expect(openAfter?.requiredSetFrozenAt).not.toBeNull();

    // A closed consultation freezes without reopening: status stays COMPLETED.
    const closed = await seedStudy(doctorA.id, "COMPLETED", "none");
    const closedFreeze = await freeze(closed.consultation.id, [
      closed.inference.id,
    ]);
    expect(closedFreeze.statusCode).toBe(200);
    const closedAfter = await prisma.consultation.findUnique({
      where: { id: closed.consultation.id },
    });
    expect(closedAfter?.status).toBe("COMPLETED");
    expect(closedAfter?.requiredSetFrozenAt).not.toBeNull();
  });

  it("rejects case-folded duplicates and keeps manifest and status intact after rejected changes", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "none");
    const id = study.inference.id;

    const duplicate = await freeze(study.consultation.id, [
      id,
      id.toUpperCase(),
    ]);
    expect(duplicate.statusCode).toBe(422);

    const owned = await freeze(study.consultation.id, [id]);
    expect(owned.statusCode).toBe(200);
    const version = (owned.json() as { requiredSetVersion: string })
      .requiredSetVersion;

    const second = await freeze(study.consultation.id, [id]);
    expect(second.statusCode).toBe(409);

    const intact = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(intact?.requiredExecutionIds).toEqual([id]);
    expect(intact?.requiredSetVersion).toBe(version);
    expect(intact?.status).toBe("COMPLETED");
    expect(intact?.requiredSetFrozenAt).not.toBeNull();
  });

  it("caps Retry-After at 10s by stage and drops it on every polling stop", async () => {
    const classifying = await seedStudy(doctorA.id, "CLASSIFYING", "none");
    await freeze(classifying.consultation.id, [classifying.inference.id]);
    const classifyingResponse = await app.inject({
      method: "GET",
      url: `/inferences/${classifying.inference.id}`,
      headers: headersA,
    });
    expect(classifyingResponse.statusCode).toBe(200);
    expect(classifyingResponse.headers["retry-after"]).toBe("10");
    expect(
      (classifyingResponse.json() as { pollingStop: string }).pollingStop,
    ).toBe("CONTINUE");

    const segmenting = await seedStudy(doctorA.id, "SEGMENTING", "none");
    await freeze(segmenting.consultation.id, [segmenting.inference.id]);
    const segmentingResponse = await app.inject({
      method: "GET",
      url: `/inferences/${segmenting.inference.id}`,
      headers: headersA,
    });
    expect(segmentingResponse.headers["retry-after"]).toBe("8");

    const review = await seedStudy(doctorA.id, "REVIEW_REQUIRED", "none");
    await freeze(review.consultation.id, [review.inference.id]);
    const reviewResponse = await app.inject({
      method: "GET",
      url: `/inferences/${review.inference.id}`,
      headers: headersA,
    });
    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.headers["retry-after"]).toBeUndefined();
    expect(reviewResponse.json()).toMatchObject({
      pollingStop: "ACTION_REQUIRED",
      cdr: null,
      cdrVertical: null,
      delivery: { reviewRequired: true, complete: false },
    });

    const failed = await seedStudy(doctorA.id, "FAILED", "none");
    await freeze(failed.consultation.id, [failed.inference.id]);
    const failedResponse = await app.inject({
      method: "GET",
      url: `/inferences/${failed.inference.id}`,
      headers: headersA,
    });
    expect(failedResponse.headers["retry-after"]).toBeUndefined();
    expect(failedResponse.json()).toMatchObject({
      pollingStop: "FAILED",
      delivery: { failed: true, complete: false },
    });
  });

  it("keeps consultation reads and freeze owner-only even with an active readResult grant", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    await grantReadResult(study);

    const freezeAsGrantee = await freeze(
      study.consultation.id,
      [study.inference.id],
      headersResearcher,
    );
    expect(freezeAsGrantee.statusCode).toBe(403);

    await freeze(study.consultation.id, [study.inference.id]);

    const executionAsGrantee = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}`,
      headers: headersResearcher,
    });
    expect(executionAsGrantee.statusCode).toBe(200);

    const consultationAsGrantee = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersResearcher,
    });
    expect(consultationAsGrantee.statusCode).toBe(403);

    const consultationAsOtherDoctor = await app.inject({
      method: "GET",
      url: `/consultations/${study.consultation.id}`,
      headers: headersB,
    });
    expect(consultationAsOtherDoctor.statusCode).toBe(404);
  });

  it("returns exactly the contracted inference fields and never leaks artifact locators", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "complete");
    await freeze(study.consultation.id, [study.inference.id]);
    const response = await app.inject({
      method: "GET",
      url: `/inferences/${study.inference.id}`,
      headers: headersA,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "cdr",
      "cdrVertical",
      "confidence",
      "createdAt",
      "delivery",
      "gradcamPath",
      "hasClahe",
      "id",
      "imageId",
      "modelVersion",
      "pollingStop",
      "predictedClass",
      "probabilities",
      "stage",
      "status",
    ]);
    expect(Object.keys((body as { delivery: object }).delivery).sort()).toEqual([
      "complete",
      "deliveryTerminal",
      "evidenceStatus",
      "failed",
      "pdfStatus",
      "resultStatus",
      "reviewRequired",
    ]);
    for (const leak of [
      "storageId",
      "bucketOrContainer",
      "checksumSha256",
      "s3://",
      "minio",
      "presigned",
    ]) {
      expect(response.body).not.toContain(leak);
    }
  });

  it("preserves valid zeroes and suppresses invalid or flagged CDR independently of delivery", async () => {
    async function readMeasures(
      measures: Pick<Prisma.InferenceCreateInput, "cdr" | "cdrVertical" | "quality">,
    ) {
      const study = await seedStudy(doctorA.id, "COMPLETED", "none", measures);
      const response = await app.inject({
        method: "GET",
        url: `/inferences/${study.inference.id}`,
        headers: headersA,
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    }

    expect(await readMeasures({ cdr: -0.01, cdrVertical: 1.01 })).toMatchObject({
      cdr: null,
      cdrVertical: null,
    });
    expect(await readMeasures({ cdr: null, cdrVertical: 0 })).toMatchObject({
      cdr: null,
      cdrVertical: 0,
    });
    expect(await readMeasures({ quality: { review_required: true } })).toMatchObject({
      cdr: null,
      cdrVertical: null,
    });
  });

  it("rejects malformed freeze payloads before any write", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "none");
    const url = `/consultations/${study.consultation.id}/required-executions`;

    const tooMany = await app.inject({
      method: "POST",
      url,
      headers: headersA,
      payload: { executionIds: Array.from({ length: 101 }, () => randomUUID()) },
    });
    expect(tooMany.statusCode).toBe(400);

    const notUuid = await app.inject({
      method: "POST",
      url,
      headers: headersA,
      payload: { executionIds: ["not-a-uuid"] },
    });
    expect(notUuid.statusCode).toBe(400);

    const extraKey = await app.inject({
      method: "POST",
      url,
      headers: headersA,
      payload: { executionIds: [study.inference.id], unexpected: true },
    });
    expect(extraKey.statusCode).toBe(400);

    const missingField = await app.inject({
      method: "POST",
      url,
      headers: headersA,
      payload: {},
    });
    expect(missingField.statusCode).toBe(400);

    const persisted = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(persisted?.requiredExecutionIds).toEqual([]);
    expect(persisted?.requiredSetVersion).toBeNull();
    expect(persisted?.requiredSetFrozenAt).toBeNull();
  });

  it("rejects post-freeze manifest writes at the SQL guard even bypassing the route", async () => {
    const study = await seedStudy(doctorA.id, "COMPLETED", "none");
    const id = study.inference.id;
    const owned = await freeze(study.consultation.id, [id]);
    expect(owned.statusCode).toBe(200);
    const version = (owned.json() as { requiredSetVersion: string })
      .requiredSetVersion;

    await expect(
      prisma.consultation.update({
        where: { id: study.consultation.id },
        data: {
          requiredExecutionIds: [],
          requiredSetVersion: null,
          requiredSetFrozenAt: null,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    const intact = await prisma.consultation.findUnique({
      where: { id: study.consultation.id },
    });
    expect(intact?.requiredExecutionIds).toEqual([id]);
    expect(intact?.requiredSetVersion).toBe(version);
    expect(intact?.requiredSetFrozenAt).not.toBeNull();
    expect(intact?.status).toBe("COMPLETED");
  });
});
