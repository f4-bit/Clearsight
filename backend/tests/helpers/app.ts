import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/lib/prisma.js";
import type { UserRole } from "../../src/schemas/common.js";

export const TEST_ENV = {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-test-jwt-secret-1234",
  EXPORT_HMAC_SECRET: "test-hmac-secret-test-hmac-secret-12",
} as const;

export function buildTestApp(prisma: PrismaClient): FastifyInstance {
  return buildApp({ env: TEST_ENV, prisma });
}

export function bearer(app: FastifyInstance, user: { id: string; role: UserRole }): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ sub: user.id, role: user.role })}` };
}
