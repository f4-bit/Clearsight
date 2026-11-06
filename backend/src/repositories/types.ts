import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/** A PrismaClient or an interactive-transaction client: repos work with both. */
export type Db = PrismaClient | Prisma.TransactionClient;

export type JsonObject = Prisma.InputJsonObject;
