import { z } from "zod";

export const roleEnum = z.enum(["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]);
export type Role = z.infer<typeof roleEnum>;

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: roleEnum.default("OPHTHALMOLOGIST"),
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
    id: z.string().uuid(),
    email: z.string().email(),
    role: roleEnum,
  }),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const currentUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: roleEnum,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;
