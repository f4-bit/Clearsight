import { z } from "zod";
export declare const roleEnum: z.ZodEnum<["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]>;
export type Role = z.infer<typeof roleEnum>;
export declare const registerRequestSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
    role: z.ZodDefault<z.ZodEnum<["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]>>;
}, "strip", z.ZodTypeAny, {
    email: string;
    role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
    password: string;
}, {
    email: string;
    password: string;
    role?: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN" | undefined;
}>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export declare const loginRequestSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
}, {
    email: string;
    password: string;
}>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export declare const tokenResponseSchema: z.ZodObject<{
    accessToken: z.ZodString;
    tokenType: z.ZodDefault<z.ZodLiteral<"bearer">>;
    expiresIn: z.ZodString;
    user: z.ZodObject<{
        id: z.ZodString;
        email: z.ZodString;
        role: z.ZodEnum<["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        email: string;
        role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
    }, {
        id: string;
        email: string;
        role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
    }>;
}, "strip", z.ZodTypeAny, {
    user: {
        id: string;
        email: string;
        role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
    };
    accessToken: string;
    tokenType: "bearer";
    expiresIn: string;
}, {
    user: {
        id: string;
        email: string;
        role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
    };
    accessToken: string;
    expiresIn: string;
    tokenType?: "bearer" | undefined;
}>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export declare const currentUserSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodString;
    role: z.ZodEnum<["OPHTHALMOLOGIST", "RESEARCHER", "ADMIN"]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    email: string;
    role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
}, {
    id: string;
    email: string;
    role: "OPHTHALMOLOGIST" | "RESEARCHER" | "ADMIN";
}>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
