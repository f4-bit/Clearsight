import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { env, type Env } from "./config/env.js";
import { HttpError } from "./lib/http-error.js";
import { prisma as defaultPrisma, type PrismaClient } from "./lib/prisma.js";
import { createRepositories } from "./repositories/index.js";
import { authRoutes } from "./routes/auth.js";
import { consultationRoutes } from "./routes/consultations.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { inferenceRoutes } from "./routes/inferences.js";
import { patientRoutes } from "./routes/patients.js";
import { healthResponseSchema } from "./schemas/common.js";
import {
  assertProductionJwtSecret,
  DEFAULT_JWT_ACCESS_TTL,
  parseAccessTtl,
} from "./services/auth-policy.js";
import { createAuthLoginProtection } from "./services/login-guard.js";
import {
  createAuthSessionService,
  DEFAULT_DATABASE_SCHEMA,
  type AuthSessionService,
} from "./services/session.js";

export interface AppDeps {
  env: Pick<Env, "JWT_SECRET" | "EXPORT_HMAC_SECRET"> &
    Partial<
      Pick<
        Env,
        | "NODE_ENV"
        | "CORS_ORIGIN"
        | "JWT_EXPIRES_IN"
        | "IP_RATE_LIMIT"
        | "IP_RATE_WINDOW_SECONDS"
      >
    >;
  prisma: PrismaClient;
  logger?: boolean;
  /** Explicit target schema shared by the auth service and the login guard. */
  databaseSchema?: string;
  /** Trusted clock seam shared by session issuance and login protection. */
  now?: () => Date;
  /** Trusted test seam; the default is always built from the injected prisma. */
  authService?: AuthSessionService;
}

/**
 * Builds the app. Two usage modes:
 *  - `buildApp()` — reads the env singleton and the process-wide Prisma client (server, smoke tests).
 *  - `buildApp({ env, prisma })` — dependency injection (integration tests with testcontainers).
 */
export async function buildApp(deps?: AppDeps): Promise<FastifyInstance> {
  const cfg = deps?.env ?? env;
  const nodeEnv = cfg.NODE_ENV ?? "test";
  const prisma = deps?.prisma ?? defaultPrisma;

  // Fail closed before plugins/routes if production uses a known/short secret
  // or the configured access lifetime violates the single TTL policy.
  assertProductionJwtSecret(cfg.JWT_SECRET, nodeEnv);
  const accessTtl = parseAccessTtl(cfg.JWT_EXPIRES_IN ?? DEFAULT_JWT_ACCESS_TTL);

  const app = Fastify({
    logger: deps?.logger ?? (nodeEnv === "development" && !deps),
    // request.ip is the actual socket peer; reverse-proxy XFF trust is a
    // deliberate future 8.x trusted-CIDR decision, never a global bypass.
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  // 1. Zod compiler setup
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 2. Global plugins
  // CORS is resolved per profile: development defaults to allow-all,
  // production defaults to deny (secure) unless CORS_ORIGIN is explicitly set.
  // CORS_ORIGIN may be "*", or a comma-separated list of allowed browser origins.
  const rawCors = cfg.CORS_ORIGIN ?? (nodeEnv === "production" ? false : "*");
  const corsOrigin =
    typeof rawCors === "string" && rawCors.includes(",")
      ? rawCors.split(",").map((s) => s.trim()).filter(Boolean)
      : rawCors;

  await app.register(fastifyCors, {
    origin: corsOrigin === "*" ? true : corsOrigin,
    credentials: true,
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB per retina image
    },
  });

  await app.register(fastifyJwt, {
    secret: cfg.JWT_SECRET,
    sign: { algorithm: "HS256", expiresIn: accessTtl.seconds },
    verify: { algorithms: ["HS256"], requiredClaims: ["exp", "iat"] },
  });

  // The login guard is mandatory and always built from the injected client and
  // server secret. Construction only derives an HMAC subkey; it never connects.
  const databaseSchema = deps?.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  const loginProtection = createAuthLoginProtection(prisma, {
    jwtSecret: cfg.JWT_SECRET,
    databaseSchema,
    now: deps?.now,
    ipRateLimit: cfg.IP_RATE_LIMIT,
    ipRateWindowSeconds: cfg.IP_RATE_WINDOW_SECONDS,
  });

  // The auth service is always built from the injected client; construction is
  // lazy and performs no connection or query.
  const authService =
    deps?.authService ??
    createAuthSessionService(prisma, {
      accessTtl,
      databaseSchema,
      now: deps?.now,
      loginProtection,
    });
  app.decorate("authService", authService);

  // 3. Swagger / OpenAPI documentation
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Clearsight Clinical API",
        description:
          "Ophthalmology platform for glaucoma detection from bilateral retinographies",
        version: "0.1.0",
      },
      servers: [
        {
          url: `http://${env.HOST}:${env.PORT}`,
          description: "Local development server",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // 4. Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(422).send({
        error: "validation_error",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
      });
      return;
    }

    const prismaCode = (error as { code?: unknown }).code;
    if (prismaCode === "P2025") {
      reply.status(404).send({
        error: "NotFound",
        message: "Record not found",
        statusCode: 404,
      });
      return;
    }
    if (prismaCode === "P2003") {
      reply.status(409).send({
        error: "Conflict",
        message: "Referenced record does not exist",
        statusCode: 409,
      });
      return;
    }

    const err = error as { statusCode?: number; name?: string; message?: string };
    if (err.statusCode) {
      reply.status(err.statusCode).send({
        error: err.name || "HttpError",
        message: err.message ?? "Error",
        statusCode: err.statusCode,
      });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: "InternalServerError",
      message: "An unexpected error occurred",
      statusCode: 500,
    });
  });

  // 5. Health Check Route
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "Service health check",
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async (_req, reply) => {
      return reply.send({
        status: "ok",
        service: "clearsight-backend",
        timestamp: new Date().toISOString(),
      });
    }
  );

  // 6. API Routers
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(patientRoutes, { prefix: "/patients" });
  await app.register(consultationRoutes, { prefix: "/consultations" });
  await app.register(inferenceRoutes, { prefix: "/inferences" });
  // Clinical feedback + gold-standard export (paths: /feedback, /export/gold-standard)
  await app.register(feedbackRoutes, {
    repos: createRepositories(prisma),
    exportHmacSecret: cfg.EXPORT_HMAC_SECRET,
  });

  return app;
}
