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

  // Optional legacy setting. The inference queue is PostgreSQL-backed and the
  // backend never connects to Redis; an absent value must not break startup.
  REDIS_URL: z.string().optional(),

  // MinIO / S3
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_BROWSER_ORIGIN: z.string().optional(),
  MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9000),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_SECURE: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => (typeof value === "boolean" ? value : value === "true"))
    .default(false),
  MINIO_BUCKET_RAW: z.string().default("raw-retinas"),
  MINIO_BUCKET_GRADCAM: z.string().default("gradcam-overlays"),
  // Artifact-content defaults for key-only legacy references (6.1/3.5). They
  // are optional on purpose: a missing kind bucket fails closed instead of
  // inventing a location. An explicit STORAGE_ALLOWED_BUCKETS must include it.
  MINIO_BUCKET_MASK: z.string().optional(),
  MINIO_BUCKET_OVERLAY: z.string().optional(),
  MINIO_BUCKET_PDF: z.string().optional(),
  // Bounded read for the shared artifact-content seam. Integer bytes.
  ARTIFACT_CONTENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),

  // Storage provider selection. `minio` is the backward-compatible default;
  // `azure` is explicit and validated lazily by the provider factory.
  STORAGE_PROVIDER: z.enum(["minio", "azure"]).default("minio"),
  // Optional logical id; defaults to `minio-local` or `azure-blob-default`.
  STORAGE_ID: z.string().max(128).optional(),
  // Optional CSV allowlist for the active provider. Absent defaults to the raw
  // and Grad-CAM buckets below; an explicit empty value fails closed.
  STORAGE_ALLOWED_BUCKETS: z.string().optional(),
  // Signed URL lifetime. Integer seconds, 1..3600; legacy callers keep 3600.
  STORAGE_DOWNLOAD_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(3600),
  // Azure Blob account configuration. Empty/absent is valid for MinIO and is
  // validated fail-closed only when STORAGE_PROVIDER=azure.
  AZURE_STORAGE_ACCOUNT_URL: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_NAME: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_KEY: z.string().optional(),

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
