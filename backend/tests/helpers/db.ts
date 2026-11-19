import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "../../src/lib/prisma.js";
import { createRepositories } from "../../src/repositories/index.js";
import type { UserRole } from "../../src/generated/prisma/enums.js";
import { SESSION_TTL_MS } from "../../src/services/session.js";
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

/** Owned ephemeral URL for tests that must create an isolated schema/client. */
export function testDatabaseUrl(): string {
  return injectedDatabaseUrl();
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
  // auth_login_buckets has no FK to users, so CASCADE cannot reach it; it must
  // be truncated explicitly under the same ownership gate.
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE inference_access_grants, auth_login_buckets, clinical_feedback, inferences, images, consultations, patients, users RESTART IDENTITY CASCADE",
  );
}

export interface MakeUserOverrides {
  email?: string;
  passwordHash?: string;
  fullName?: string;
  isActive?: boolean;
  tokenVersion?: number;
  lockedUntil?: Date | null;
}

export async function makeUser(
  prisma: PrismaClient,
  role: UserRole = "OFTALMOLOGO",
  overrides: MakeUserOverrides = {},
) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `${role.toLowerCase()}-${randomUUID()}@clearsight.test`,
      passwordHash: overrides.passwordHash ?? "x",
      fullName: overrides.fullName ?? `Test ${role}`,
      role,
      ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
      ...(overrides.tokenVersion !== undefined ? { tokenVersion: overrides.tokenVersion } : {}),
      ...(overrides.lockedUntil !== undefined ? { lockedUntil: overrides.lockedUntil } : {}),
    },
  });
}

export interface MakeSessionOverrides {
  issuedTokenVersion?: number;
  expiresAt?: Date;
  revokedAt?: Date | null;
  reasonCode?: string | null;
}

/** Creates a durable session paired to the user's current token version. */
export async function makeSession(
  prisma: PrismaClient,
  user: { id: string; tokenVersion?: number },
  createdAt: Date = new Date(),
  overrides: MakeSessionOverrides = {},
) {
  const revokedAt = overrides.revokedAt ?? null;
  return prisma.userSession.create({
    data: {
      userId: user.id,
      issuedTokenVersion: overrides.issuedTokenVersion ?? user.tokenVersion ?? 0,
      createdAt,
      expiresAt: overrides.expiresAt ?? new Date(createdAt.getTime() + SESSION_TTL_MS),
      revokedAt,
      reasonCode: overrides.reasonCode ?? (revokedAt === null ? null : "TEST_REVOKED"),
    },
  });
}

/**
 * Synthetic fixture cost only. It is intentionally cheaper than the
 * provisioning policy (`PASSWORD_BCRYPT_COST`); these hashes never represent a
 * real provisioned account.
 */
export const TEST_BCRYPT_ROUNDS = 4;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, TEST_BCRYPT_ROUNDS);
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
  const patient = await repos.patients.create({
    age: 63,
    gender: "M",
    ownerDoctorId: opts.doctorId,
  });
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
