import { z } from "zod";
export const roleEnum = z.enum(["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]);
export const registerRequestSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters"),
    role: roleEnum.default("OPHTHALMOLOGIST"),
});
export const loginRequestSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});
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
export const currentUserSchema = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: roleEnum,
});
//# sourceMappingURL=auth.js.map