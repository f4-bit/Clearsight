import { z } from "zod";
import { UserRole } from "./common.js";

export const roleEnum = UserRole;
export type Role = UserRole;

/** JWT payload shared by the auth routes (issuer) and the middleware (verifier). */
export const JwtPayload = z.object({
  sub: z.uuid(),
  role: UserRole,
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
  email: z.string().email(),
  password: z.string(),
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
