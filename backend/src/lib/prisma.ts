import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type { PrismaClient } from "../generated/prisma/client.js";

/** Builds a PrismaClient on top of the `pg` driver adapter (Prisma 7). */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

let singleton: PrismaClient | undefined;

/** Process-wide client for the server; tests/scripts create their own. */
export function getPrisma(connectionString: string): PrismaClient {
  singleton ??= createPrismaClient(connectionString);
  return singleton;
}
