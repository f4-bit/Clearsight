import { z } from "zod";
import { UserRole } from "./common.js";

export const roleEnum = UserRole;
export type Role = UserRole;

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
  // Login normalizes email/trim/case before the case-insensitive lookup.
  email: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.string().email().max(255),
  ),
  // Bounded before bcrypt so a huge body cannot force unbounded work.
  password: z.string().max(1024),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

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
