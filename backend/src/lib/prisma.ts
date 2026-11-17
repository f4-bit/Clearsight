import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";

export type { PrismaClient } from "../generated/prisma/client.js";
import { PrismaClient } from "../generated/prisma/client.js";

/** Builds a PrismaClient on top of the `pg` driver adapter (Prisma 7). */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Process-wide client for the server; tests/scripts create their own. */
export function getPrisma(connectionString: string): PrismaClient {
  return createPrismaClient(connectionString);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
