import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/lib/prisma.js";
import type { ArtifactReadRepository } from "../../src/repositories/artifact.repo.js";
import type { UserRole } from "../../src/schemas/common.js";
import type { ClinicalContextPreparer } from "../../src/services/ml-client.js";
import type { ArtifactStoragePort } from "../../src/services/storage.js";
import { makeSession } from "./db.js";
import { createFakeMlClient } from "./ml.js";

export const TEST_ENV = {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-test-jwt-secret-1234",
  JWT_EXPIRES_IN: "15m",
  EXPORT_HMAC_SECRET: "test-hmac-secret-test-hmac-secret-12",
  AUTH_PUBLIC_ORIGIN: "https://app.clearsight.test",
} as const;

export const TEST_AUTH_ORIGIN = TEST_ENV.AUTH_PUBLIC_ORIGIN;

/** Merges the legitimate test Origin unless a guard test overrides it. */
export function withAuthOrigin(
  headers: Record<string, string> = {},
): Record<string, string> {
  return { origin: TEST_AUTH_ORIGIN, ...headers };
}

export async function buildTestApp(
  prisma: PrismaClient,
  options: {
    now?: () => Date;
    mlClient?: ClinicalContextPreparer;
    storage?: ArtifactStoragePort;
    artifactReadRepository?: ArtifactReadRepository;
    logger?: boolean;
    publicOrigin?: string;
    logDestination?: Writable;
  } = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    env: { ...TEST_ENV, AUTH_PUBLIC_ORIGIN: options.publicOrigin ?? TEST_AUTH_ORIGIN },
    prisma,
    now: options.now,
    // Default fake: existing ACL/RBAC tests must never reach a real ML service.
    mlClient: options.mlClient ?? createFakeMlClient(),
    storage: options.storage,
    artifactReadRepository: options.artifactReadRepository,
    logger: options.logger,
    logDestination: options.logDestination,
  });
  await app.ready();
  return app;
}

/**
 * Creates a real durable session for the user and signs a complete access
 * token. Tests that need authenticated routes must use this instead of signing
 * a bare { sub, role } payload, which is now rejected by the reader.
 */
export async function bearer(
  app: FastifyInstance,
  prisma: PrismaClient,
  user: { id: string; role: UserRole; tokenVersion?: number },
): Promise<{ authorization: string }> {
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { role: true, tokenVersion: true },
  });
  const session = await makeSession(prisma, {
    id: user.id,
    tokenVersion: current.tokenVersion,
  });
  return {
    authorization: `Bearer ${app.jwt.sign({
      sub: user.id,
      role: current.role,
      sessionId: session.id,
      tokenVersion: current.tokenVersion,
    })}`,
  };
}
