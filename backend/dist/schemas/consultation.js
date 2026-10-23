import { z } from "zod";
export const consultationStatusEnum = z.enum(["PENDIENTE", "EN_PROCESO", "COMPLETADA", "FALLIDA"]);
export const consultationCreateSchema = z.object({
    patientId: z.string().uuid(),
    doctorId: z.string().uuid().optional(),
    status: consultationStatusEnum.default("PENDIENTE"),
    clinicalData: z.record(z.any()).default({}),
});
export const consultationReadSchema = z.object({
    id: z.string().uuid(),
    patientId: z.string().uuid(),
    doctorId: z.string().uuid(),
    status: z.string(),
    clinicalData: z.record(z.any()),
    createdAt: z.date().or(z.string().datetime()),
});
export const feedbackCreateSchema = z.object({
    consultationId: z.string().uuid(),
    inferenceId: z.string().uuid(),
    doctorId: z.string().uuid().optional(),
    validatedClass: z.number().int().min(0).max(2),
    predictedClass: z.number().int().min(0).max(2).optional().nullable(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    agreement: z.boolean().optional().nullable(),
    doctorNotes: z.string().optional().nullable(),
    isGoldStandard: z.boolean().default(false),
    clinicalData: z.record(z.any()).default({}),
});
export const feedbackReadSchema = z.object({
    id: z.string().uuid(),
    consultationId: z.string().uuid(),
    inferenceId: z.string().uuid(),
    doctorId: z.string().uuid(),
    validatedClass: z.number().int(),
    predictedClass: z.number().int().nullable().optional(),
    confidence: z.number().nullable().optional(),
    agreement: z.boolean().nullable().optional(),
    doctorNotes: z.string().nullable().optional(),
    isGoldStandard: z.boolean(),
    clinicalData: z.record(z.any()),
    createdAt: z.date().or(z.string().datetime()),
});
export const goldStandardBatchSchema = z.object({
    items: z.array(feedbackReadSchema),
    count: z.number().int(),
});
//# sourceMappingURL=consultation.js.map