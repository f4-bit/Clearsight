import { z } from "zod";
export declare const eyeSideEnum: z.ZodEnum<["OD", "OS"]>;
export type EyeSide = z.infer<typeof eyeSideEnum>;
export declare const imageCreateSchema: z.ZodObject<{
    consultationId: z.ZodString;
    eyeSide: z.ZodEnum<["OD", "OS"]>;
    storagePath: z.ZodString;
    hashMd5: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    consultationId: string;
    eyeSide: "OD" | "OS";
    storagePath: string;
    hashMd5?: string | null | undefined;
}, {
    consultationId: string;
    eyeSide: "OD" | "OS";
    storagePath: string;
    hashMd5?: string | null | undefined;
}>;
export type ImageCreate = z.infer<typeof imageCreateSchema>;
export declare const imageReadSchema: z.ZodObject<{
    id: z.ZodString;
    consultationId: z.ZodString;
    eyeSide: z.ZodEnum<["OD", "OS"]>;
    storagePath: z.ZodString;
    hashMd5: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string | Date;
    consultationId: string;
    eyeSide: "OD" | "OS";
    storagePath: string;
    hashMd5?: string | null | undefined;
}, {
    id: string;
    createdAt: string | Date;
    consultationId: string;
    eyeSide: "OD" | "OS";
    storagePath: string;
    hashMd5?: string | null | undefined;
}>;
export type ImageRead = z.infer<typeof imageReadSchema>;
