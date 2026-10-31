import fastifyJwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Env } from "./config/env.js";
import { HttpError } from "./lib/http-error.js";
import type { PrismaClient } from "./lib/prisma.js";
import { createRepositories } from "./repositories/index.js";
import { feedbackRoutes } from "./routes/feedback.js";

export interface AppDeps {
  env: Pick<Env, "JWT_SECRET" | "EXPORT_HMAC_SECRET"> & Partial<Pick<Env, "NODE_ENV">>;
  prisma: PrismaClient;
  logger?: boolean;
}

export function buildApp({ env, prisma, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger });
  const repos = createRepositories(prisma);

  app.register(fastifyJwt, { secret: env.JWT_SECRET });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: "validation_error",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const prismaCode = (error as { code?: unknown }).code;
    if (prismaCode === "P2025") {
      return reply.code(404).send({ error: "not_found", message: "Record not found" });
    }
    if (prismaCode === "P2003") {
      return reply.code(409).send({ error: "conflict", message: "Referenced record does not exist" });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Routes owned by this module. auth / patients / consultations / inferences
  // are registered by their owners next to these.
  app.register(feedbackRoutes, { repos, exportHmacSecret: env.EXPORT_HMAC_SECRET });

  return app;
}
