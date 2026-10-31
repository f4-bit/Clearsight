import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/lib/prisma.js";
import { createRepositories } from "../../src/repositories/index.js";
import type { UserRole } from "../../src/generated/prisma/enums.js";

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(inject("databaseUrl"));
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
  );
}

export const FEATURES = {
  Age: 63,
  Gender: 1,
  dioptre_1: -1.5,
  dioptre_2: 0.5,
  astigmatism: 90,
  "Phakic/Pseudophakic": 1,
  Pneumatic: 18,
  Perkins: 17,
  Pachymetry: 540,
  Axial_Length: 24.1,
  VF_DM: -3.2,
} as const;

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
