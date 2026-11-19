import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/lib/prisma.js";
import type { UserRole } from "../../src/schemas/common.js";
import { makeSession } from "./db.js";

export const TEST_ENV = {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-test-jwt-secret-1234",
  JWT_EXPIRES_IN: "15m",
  EXPORT_HMAC_SECRET: "test-hmac-secret-test-hmac-secret-12",
} as const;

export async function buildTestApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const app = await buildApp({ env: TEST_ENV, prisma });
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
