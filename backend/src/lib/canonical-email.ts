import { z } from "zod";

/**
 * Single canonical email contract shared by the login DTO, the controlled
 * bootstrap validator and the administrative user-creation DTO.
 *
 * The format is intentionally the same one the public login endpoint has always
 * accepted: ASCII only, trimmed, lowercased and bounded to 255 characters. A
 * first administrator whose email the login DTO rejects would be unusable, so
 * bootstrap must reject it before opening a database connection.
 */
export const CANONICAL_EMAIL_MAX_LENGTH = 255;

export const canonicalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.string().email().max(CANONICAL_EMAIL_MAX_LENGTH),
);

/** Normalizes and validates in one pure step; `null` means "not usable". */
export function canonicalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > CANONICAL_EMAIL_MAX_LENGTH) {
    return null;
  }
  const parsed = canonicalEmailSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

/**
 * Prisma/PostgreSQL `equals` with `mode: "insensitive"` is implemented with
 * ILIKE on the current engine, so `_` and `%` in the caller value act as
 * wildcards. Escaping keeps the comparison literal without dropping the ORM
 * parameterization. Confirmed against the owned PostgreSQL 16 test container;
 * the same helper is applied to bootstrap, login, the login guard and the
 * administrative create path so all four identify exactly the same address.
 */
export function escapeLiteralLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
