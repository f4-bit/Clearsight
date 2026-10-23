import dotenv from "dotenv";
import { z } from "zod";
dotenv.config();
const envSchema = z.object({
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
        .default("false"),
    MINIO_BUCKET_RAW: z.string().default("raw-retinas"),
    MINIO_BUCKET_GRADCAM: z.string().default("gradcam-overlays"),
    // Auth / JWT
    JWT_SECRET: z.string().default("clearsight-dev-secret-change-in-prod-32chars!"),
    JWT_EXPIRES_IN: z.string().default("8h"),
    // ML Service
    ML_SERVICE_URL: z.string().default("http://localhost:8001"),
    // CORS
    CORS_ORIGIN: z.string().default("*"),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.format());
    throw new Error("Invalid environment configuration");
}
export const env = parsed.data;
//# sourceMappingURL=env.js.map