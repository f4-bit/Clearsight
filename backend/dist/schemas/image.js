import { z } from "zod";
export const eyeSideEnum = z.enum(["OD", "OS"]);
export const imageCreateSchema = z.object({
    consultationId: z.string().uuid(),
    eyeSide: eyeSideEnum,
    storagePath: z.string(),
    hashMd5: z.string().max(32).optional().nullable(),
});
export const imageReadSchema = z.object({
    id: z.string().uuid(),
    consultationId: z.string().uuid(),
    eyeSide: eyeSideEnum,
    storagePath: z.string(),
    hashMd5: z.string().nullable().optional(),
    createdAt: z.date().or(z.string().datetime()),
});
//# sourceMappingURL=image.js.map