import "dotenv/config";
import { buildApp } from "./app.js";
import { parseEnv } from "./config/env.js";
import { createPrismaClient } from "./lib/prisma.js";

const env = parseEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = buildApp({ env, prisma, logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
