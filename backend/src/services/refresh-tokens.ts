import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque refresh-token primitive. Only the SHA-256 hash is persisted; the raw
 * value exists solely in memory and in the browser cookie. Tokens are 32 bytes
 * (256 bits) of CSPRNG entropy encoded as base64url (43 characters).
 */
export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_LENGTH = 43;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Generates a fresh opaque refresh token. Callers must never log the result. */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/** Lowercase SHA-256 hex, matching the DB `refresh_tokens_hash_check` regex. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Strict shape gate applied before any hash lookup. */
export function isPlausibleRefreshToken(token: unknown): token is string {
  return typeof token === "string" && REFRESH_TOKEN_PATTERN.test(token);
}
