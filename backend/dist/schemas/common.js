import { z } from "zod";
export const errorResponseSchema = z.object({
    error: z.string(),
    message: z.string(),
    statusCode: z.number().int(),
});
export const healthResponseSchema = z.object({
    status: z.string(),
    service: z.string(),
    timestamp: z.string().datetime(),
});
//# sourceMappingURL=common.js.map