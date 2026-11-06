import { z } from "zod";

const isProduction = (env: NodeJS.ProcessEnv) => env.NODE_ENV === "production";

const RawEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  DATABASE_URL: z.string().min(1).optional(),
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default("clearsight"),
  POSTGRES_USER: z.string().default("clearsight"),
  POSTGRES_PASSWORD: z.string().default("clearsight"),
  JWT_SECRET: z.string().min(1),
  EXPORT_HMAC_SECRET: z.string().min(1),
});

export interface Env {
  NODE_ENV: "development" | "test" | "production";
  HOST: string;
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  EXPORT_HMAC_SECRET: string;
}

/**
 * Validates the process environment. DATABASE_URL wins; otherwise it is built
 * from the POSTGRES_* variables that docker-compose already injects.
 * In production, placeholder/short secrets are rejected.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const raw = RawEnv.parse(source);

  const databaseUrl =
    raw.DATABASE_URL ??
    `postgresql://${encodeURIComponent(raw.POSTGRES_USER)}:${encodeURIComponent(
      raw.POSTGRES_PASSWORD,
    )}@${raw.POSTGRES_HOST}:${raw.POSTGRES_PORT}/${raw.POSTGRES_DB}`;

  if (isProduction(source)) {
    for (const key of ["JWT_SECRET", "EXPORT_HMAC_SECRET"] as const) {
      const value = raw[key];
      if (value.length < 32 || value.startsWith("replace-me")) {
        throw new Error(`${key} must be a random string of at least 32 characters in production`);
      }
    }
  }

  return {
    NODE_ENV: raw.NODE_ENV,
    HOST: raw.HOST,
    PORT: raw.PORT,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: raw.JWT_SECRET,
    EXPORT_HMAC_SECRET: raw.EXPORT_HMAC_SECRET,
  };
}
