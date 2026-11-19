import { z } from "zod";
import { canonicalEmailSchema } from "../lib/canonical-email.js";
import { UserRole } from "./common.js";

export const roleEnum = UserRole;
export type Role = UserRole;

const PASSWORD_MIN_CODEPOINTS_MESSAGE = "password must contain at least 12 Unicode code points";
const PASSWORD_MAX_UTF8_BYTES_MESSAGE = "password must be at most 72 UTF-8 bytes";

/**
 * JWT payload shared by the auth routes (issuer) and the middleware (verifier).
 * The four principal claims are mandatory; exp/iat are added by the signer and
 * validated separately from the raw verified payload.
 */
export const JwtPayload = z.object({
  sub: z.uuid(),
  role: UserRole,
  sessionId: z.uuid(),
  tokenVersion: z.number().int().min(0),
});
export type JwtPayload = z.infer<typeof JwtPayload>;

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().min(1).max(255).optional(),
  role: roleEnum.default("OFTALMOLOGO"),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  // Login normalizes email/trim/case before the case-insensitive lookup. The
  // shared canonical schema is the same contract used by bootstrap/admin create.
  email: canonicalEmailSchema,
  // Bounded before bcrypt so a huge body cannot force unbounded work.
  password: z.string().max(1024),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Strict administrative creation body. Actor identity, activity, hashes,
 * version counters and clinical grants are server-owned and rejected if a
 * caller tries to smuggle them in. The password rules mirror the shared
 * provisioning policy (12 Unicode code points, at most 72 UTF-8 bytes).
 */
export const adminCreateUserRequestSchema = z
  .object({
    email: canonicalEmailSchema,
    password: z
      .string()
      .refine((value) => [...value].length >= 12, PASSWORD_MIN_CODEPOINTS_MESSAGE)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 72,
        PASSWORD_MAX_UTF8_BYTES_MESSAGE,
      ),
    fullName: z.string().trim().min(1).max(255),
    role: roleEnum.default("OFTALMOLOGO"),
  })
  .strict();

export type AdminCreateUserRequest = z.infer<typeof adminCreateUserRequestSchema>;

/** Minimal safe projection returned by the administrative create endpoint. */
export const adminUserResponseSchema = z.object({
  id: z.uuid(),
  email: z.string().email().max(255),
  fullName: z.string().max(255),
  role: roleEnum,
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("bearer").default("bearer"),
  expiresIn: z.string(),
  user: z.object({
    id: z.uuid(),
    email: z.string().email(),
    role: roleEnum,
  }),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string().email(),
  role: roleEnum,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;
