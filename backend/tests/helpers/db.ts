import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/lib/prisma.js";
import { createRepositories } from "../../src/repositories/index.js";
import type { UserRole } from "../../src/generated/prisma/enums.js";
import { FEATURES } from "../fixtures/clinical.js";
import { assertOwnershipRunId, TEST_OWNERSHIP_TABLE } from "./ownership.js";

export { FEATURES };

function injectedDatabaseUrl(): string {
  const url = inject("databaseUrl");
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Integration test context is missing the ephemeral database URL");
  }
  return url;
}

function injectedOwnershipRunId(): string {
  const runId = inject("databaseOwnership");
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Integration test context is missing the ownership run id");
  }
  return runId;
}

export function createTestPrisma(): PrismaClient {
  const url = injectedDatabaseUrl();
  injectedOwnershipRunId();
  return createPrismaClient(url);
}

export async function assertTestDatabaseOwnership(prisma: PrismaClient): Promise<void> {
  const runId = injectedOwnershipRunId();
  const rows = await prisma.$queryRawUnsafe<Array<{ run_id: string }>>(
    `SELECT run_id FROM ${TEST_OWNERSHIP_TABLE}`,
  );
  assertOwnershipRunId(rows, runId);
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await assertTestDatabaseOwnership(prisma);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
  );
}

export async function makeUser(prisma: PrismaClient, role: UserRole = "OFTALMOLOGO") {
  return prisma.user.create({
    data: { email: `${role.toLowerCase()}-${randomUUID()}@clearsight.test`, passwordHash: "x", fullName: `Test ${role}`, role },
  });
}

/** patient -> consultation -> image -> inference, all owned by `doctorId`. */
export async function makeStudy(
  prisma: PrismaClient,
  opts: {
    doctorId: string;
    predictedClass?: number | null;
    confidence?: number | null;
    clinicalData?: Record<string, unknown>;
    eyeSide?: "OD" | "OS";
    modelVersion?: string;
  },
) {
  const repos = createRepositories(prisma);
  const patient = await repos.patients.create({ age: 63, gender: "M" });
  const consultation = await repos.consultations.create({
    patientId: patient.id,
    doctorId: opts.doctorId,
    status: "QUEUED",
    clinicalData: opts.clinicalData ?? { ...FEATURES },
  });
  const image = await repos.images.create({
    consultationId: consultation.id,
    eyeSide: opts.eyeSide ?? "OD",
    storagePath: `2026/10/${randomUUID()}.jpg`,
  });
  const inference = await repos.inferences.create({ imageId: image.id, modelVersion: opts.modelVersion ?? "2026-09-24" });
  const solved = await prisma.inference.update({
    where: { id: inference.id },
    data: {
      predictedClass: opts.predictedClass === undefined ? 1 : opts.predictedClass,
      confidence: opts.confidence === undefined ? 0.91 : opts.confidence,
    },
  });
  return { patient, consultation, image, inference: solved };
}
