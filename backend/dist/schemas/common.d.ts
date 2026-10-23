import { z } from "zod";
export declare const errorResponseSchema: z.ZodObject<{
    error: z.ZodString;
    message: z.ZodString;
    statusCode: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    message: string;
    error: string;
    statusCode: number;
}, {
    message: string;
    error: string;
    statusCode: number;
}>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export declare const healthResponseSchema: z.ZodObject<{
    status: z.ZodString;
    service: z.ZodString;
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: string;
    service: string;
    timestamp: string;
}, {
    status: string;
    service: string;
    timestamp: string;
}>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
