import type { Writable } from "node:stream";
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
import { buildLoggerOptions } from "./lib/log-redaction.js";
import { registerGenericNotFoundHandler } from "./lib/not-found-handler.js";
import { prisma as defaultPrisma, type PrismaClient } from "./lib/prisma.js";
import { createRepositories } from "./repositories/index.js";
import type { ArtifactReadRepository } from "./repositories/artifact.repo.js";
import { createArtifactPublicationRepository } from "./repositories/artifact-publication.repo.js";
import { adminRoutes } from "./routes/admin.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { authRoutes } from "./routes/auth.js";
import { consultationRoutes } from "./routes/consultations.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { inferenceRoutes } from "./routes/inferences.js";
import { patientRoutes } from "./routes/patients.js";
import { healthResponseSchema } from "./schemas/common.js";
import { createAdminUsersService, type AdminUsersService } from "./services/admin-users.js";
import {
  assertProductionJwtSecret,
  DEFAULT_JWT_ACCESS_TTL,
  parseAccessTtl,
} from "./services/auth-policy.js";
import { createAuthWebSessionService } from "./services/auth-web-session.js";
import { createClinicalAccessService } from "./services/clinical-access.js";
import { assertProductionExportHmacSecret } from "./services/export-policy.js";
import { createAuthLoginProtection } from "./services/login-guard.js";
import {
  MlClient,
  type ClinicalContextPreparer,
} from "./services/ml-client.js";
import {
  createPasswordResetService,
  type PasswordResetService,
} from "./services/password-reset.js";
import type { PasswordResetDelivery } from "./services/password-reset-delivery.js";
import { smtpPasswordResetDelivery } from "./services/password-reset-smtp.js";
import type { PasswordRecoveryQuotaGuard } from "./services/password-recovery-quota.js";
import {
  createAuthSessionService,
  DEFAULT_DATABASE_SCHEMA,
  type AuthSessionService,
} from "./services/session.js";
import type { ArtifactStoragePort } from "./services/storage.js";
import { createWebAuthPolicy, type WebAuthPolicy } from "./services/web-auth-policy.js";

export interface AppDeps {
  env: Pick<Env, "JWT_SECRET" | "EXPORT_HMAC_SECRET"> &
    Partial<
      Pick<
        Env,
        | "NODE_ENV"
        | "AUTH_PUBLIC_ORIGIN"
        | "CORS_ORIGIN"
        | "JWT_EXPIRES_IN"
        | "IP_RATE_LIMIT"
        | "IP_RATE_WINDOW_SECONDS"
        | "ML_SERVICE_URL"
        | "ML_API_TOKEN"
      >
    >;
  prisma: PrismaClient;
  /** Trusted test seam; the real client is built from the injected env. */
  mlClient?: ClinicalContextPreparer;
  logger?: boolean;
  /**
   * Trusted test seam for capturing real Pino output. Redaction paths are
   * always applied; only the destination changes.
   */
  logDestination?: Writable;
  /** Explicit target schema shared by the auth service and the login guard. */
  databaseSchema?: string;
  /** Trusted clock seam shared by session issuance and login protection. */
  now?: () => Date;
  /** Trusted test seam; the default is always built from the injected prisma. */
  authService?: AuthSessionService;
  /** Trusted test seam for administrative provisioning; defaults from prisma. */
  adminUsersService?: AdminUsersService;
  /** Trusted test seam for password recovery; defaults from the injected prisma. */
  passwordResetService?: PasswordResetService;
  /** Explicit delivery port for isolated app instances. */
  passwordResetDelivery?: PasswordResetDelivery;
  /** Trusted test seam; defaults to the R1 durable recovery quota guard. */
  passwordRecoveryQuotaGuard?: PasswordRecoveryQuotaGuard;
  /**
   * Trusted storage seam. Reference metadata and signing must use the same
   * instance so provider/storageId cannot silently diverge.
   */
  storage?: ArtifactStoragePort;
  /** Trusted test seam; defaults to the same injected client + repository factory. */
  artifactReadRepository?: ArtifactReadRepository;
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
  // App DI never falls back to the process-wide env for ML credentials; an
  // injected test client is used directly and missing config fails closed 503.
  const mlClient =
    deps?.mlClient ??
    new MlClient({
      baseUrl: cfg.ML_SERVICE_URL ?? (deps ? "" : env.ML_SERVICE_URL),
      apiToken: cfg.ML_API_TOKEN ?? (deps ? null : env.ML_API_TOKEN),
    });

  // Fail closed before plugins/routes if production uses a known/short secret
  // or the configured access lifetime violates the single TTL policy.
  assertProductionJwtSecret(cfg.JWT_SECRET, nodeEnv);
  assertProductionExportHmacSecret(cfg.EXPORT_HMAC_SECRET, nodeEnv);
  const accessTtl = parseAccessTtl(cfg.JWT_EXPIRES_IN ?? DEFAULT_JWT_ACCESS_TTL);

  const loggerEnabled = deps?.logger ?? (nodeEnv === "development" && !deps);
  const app = Fastify({
    logger: loggerEnabled ? buildLoggerOptions(deps?.logDestination) : false,
    // request.ip is the actual socket peer; reverse-proxy XFF trust is a
    // deliberate future 8.x trusted-CIDR decision, never a global bypass.
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  // Install the generic 404 before plugins/routes. Fastify's default handler
  // logs the raw URL as a message string, which Pino path redaction cannot
  // scrub; unmatched paths/methods must not echo or log the request URL.
  registerGenericNotFoundHandler(app);

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

  // Opaque refresh rotation/logout shares the same client, schema and clock.
  // Construction is lazy and performs no connection.
  const authWebSessionService = createAuthWebSessionService(prisma, {
    accessTtl,
    databaseSchema,
    now: deps?.now,
  });
  app.decorate("authWebSessionService", authWebSessionService);

  // Only the normal server bootstrap picks up the configured mail relay.
  const passwordResetService =
    deps?.passwordResetService ??
    createPasswordResetService(prisma, {
      jwtSecret: cfg.JWT_SECRET,
      databaseSchema,
      now: deps?.now,
      delivery: deps ? deps.passwordResetDelivery : smtpPasswordResetDelivery(process.env),
      quotaGuard: deps?.passwordRecoveryQuotaGuard,
      onOperationalFailure: (code) => {
        app.log.error(
          { code, channel: "password-reset" },
          "password reset operation failed",
        );
      },
    });
  app.decorate("passwordResetService", passwordResetService);

  // Public-origin policy for the credential endpoints. Missing config is
  // allowed at construction (cookie endpoints fail closed per request), while
  // an invalid configured origin aborts startup without any permissive fallback.
  const webAuthPolicy: WebAuthPolicy = createWebAuthPolicy({
    publicOrigin: cfg.AUTH_PUBLIC_ORIGIN,
    nodeEnv,
  });
  app.decorate("webAuthPolicy", webAuthPolicy);

  // Administrative provisioning is also always built from the injected client
  // and the same explicit schema; construction never connects.
  const adminUsersService =
    deps?.adminUsersService ??
    createAdminUsersService(prisma, {
      databaseSchema,
      now: deps?.now,
    });
  app.decorate("adminUsersService", adminUsersService);

  // Clinical ownership/grants service. Built from the same injected client and
  // explicit schema; construction performs no connection or query.
  const clinicalAccess = createClinicalAccessService(prisma, {
    databaseSchema,
    now: deps?.now,
  });
  const repositories = createRepositories(prisma);
  const artifactPublicationRepository =
    createArtifactPublicationRepository(prisma);

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
    if (prismaCode === "P2002") {
      // Generic duplicate unique key (e.g. a worker/job unique collision). The
      // concrete conflicting field is intentionally not disclosed.
      reply.status(409).send({
        error: "Conflict",
        message: "A record with the same unique key already exists",
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
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(patientRoutes, {
    prefix: "/patients",
    prisma,
    access: clinicalAccess,
  });
  await app.register(consultationRoutes, {
    prefix: "/consultations",
    prisma,
    access: clinicalAccess,
  });
  await app.register(inferenceRoutes, {
    prefix: "/inferences",
    prisma,
    access: clinicalAccess,
    authService,
    mlClient,
    databaseSchema,
    storage: deps?.storage,
  });
  await app.register(artifactRoutes, {
    prefix: "/inferences",
    prisma,
    access: clinicalAccess,
    authService,
    artifactReadRepository:
      deps?.artifactReadRepository ?? repositories.artifacts,
    artifactPublicationRepository,
    storage: deps?.storage,
  });
  // Clinical feedback + gold-standard export (paths: /feedback, /export/gold-standard)
  await app.register(feedbackRoutes, {
    repos: repositories,
    access: clinicalAccess,
    exportHmacSecret: cfg.EXPORT_HMAC_SECRET,
  });

  return app;
}
