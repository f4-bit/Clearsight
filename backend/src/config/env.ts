import dotenv from "dotenv";
import { z } from "zod";
import {
  assertProductionJwtSecret,
  DEFAULT_JWT_ACCESS_TTL,
  KNOWN_DEV_JWT_SECRET,
  parseAccessTtl,
} from "../services/auth-policy.js";
import {
  DEFAULT_IP_RATE_LIMIT,
  DEFAULT_IP_RATE_WINDOW_SECONDS,
  MAX_IP_RATE_LIMIT,
  MAX_IP_RATE_WINDOW_SECONDS,
} from "../services/login-guard.js";
import { assertProductionExportHmacSecret } from "../services/export-policy.js";
import {
  assertPublicOriginForEnvironment,
  parseAuthPublicOrigin,
} from "../services/web-auth-policy.js";

dotenv.config();

const envSchema = z
  .object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default("0.0.0.0"),

  // PostgreSQL / Prisma
  DATABASE_URL: z
    .string()
    .default("postgresql://clearsight:clearsight@localhost:5432/clearsight"),

  // Redis / BullMQ
  REDIS_URL: z.string().default("redis://localhost:6379/0"),

  // MinIO / S3
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_SECURE: z
    .string()
    .transform((val) => val === "true")
    .default(false),
  MINIO_BUCKET_RAW: z.string().default("raw-retinas"),
  MINIO_BUCKET_GRADCAM: z.string().default("gradcam-overlays"),

  // Auth / JWT
  JWT_SECRET: z.string().default(KNOWN_DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default(DEFAULT_JWT_ACCESS_TTL),
  // Exact public web origin for login/refresh/logout. Empty/missing is allowed
  // at construction; the cookie endpoints then fail closed with 503. An invalid
  // value aborts startup instead of falling back to anything permissive.
  AUTH_PUBLIC_ORIGIN: z.string().optional(),
  // Complementary per-IP login quota. Positive integers only: zero/negative is
  // rejected in every environment instead of disabling production protection.
  IP_RATE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_IP_RATE_LIMIT)
    .default(DEFAULT_IP_RATE_LIMIT),
  IP_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_IP_RATE_WINDOW_SECONDS)
    .default(DEFAULT_IP_RATE_WINDOW_SECONDS),

  // ML Service
  ML_SERVICE_URL: z.string().default("http://localhost:8000"),
  // Bearer token for the ML inference service. If the ML service is configured with
  // ML_API_TOKEN, this must match; leave empty to talk to a development ML service that
  // does not enforce tokens.
  ML_API_TOKEN: z.string().optional(),
  // Host reachable FROM the ML service container (Docker network) used for presigned image URLs.
  ML_PUBLIC_HOST: z.string().optional(),

  // CORS (comma-separated origins; defaults per profile: dev=allow all, production=deny unless set)
  CORS_ORIGIN: z.string().optional(),

  // HMAC secret used to pseudonymize doctor ids in the gold-standard export.
  // Rotate = old exports become unlinkable by design; set explicitly in production.
  EXPORT_HMAC_SECRET: z.string().default("clearsight-dev-export-hmac-change-in-prod"),
  })
  .superRefine((data, ctx) => {
    try {
      assertProductionJwtSecret(data.JWT_SECRET, data.NODE_ENV);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: error instanceof Error ? error.message : "Invalid JWT secret",
      });
    }

    try {
      parseAccessTtl(data.JWT_EXPIRES_IN);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_EXPIRES_IN"],
        message: error instanceof Error ? error.message : "Invalid JWT lifetime",
      });
    }

    try {
      assertProductionExportHmacSecret(data.EXPORT_HMAC_SECRET, data.NODE_ENV);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["EXPORT_HMAC_SECRET"],
        message:
          error instanceof Error ? error.message : "Invalid export HMAC secret",
      });
    }

    try {
      const publicOrigin = parseAuthPublicOrigin(data.AUTH_PUBLIC_ORIGIN);
      if (publicOrigin !== null) {
        assertPublicOriginForEnvironment(publicOrigin, data.NODE_ENV);
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_PUBLIC_ORIGIN"],
        message:
          error instanceof Error ? error.message : "Invalid public auth origin",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.format());
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
