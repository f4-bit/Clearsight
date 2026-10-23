import { z } from "zod";
export declare const consultationStatusEnum: z.ZodEnum<["PENDIENTE", "EN_PROCESO", "COMPLETADA", "FALLIDA"]>;
export type ConsultationStatus = z.infer<typeof consultationStatusEnum>;
export declare const consultationCreateSchema: z.ZodObject<{
    patientId: z.ZodString;
    doctorId: z.ZodOptional<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<["PENDIENTE", "EN_PROCESO", "COMPLETADA", "FALLIDA"]>>;
    clinicalData: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, "strip", z.ZodTypeAny, {
    status: "PENDIENTE" | "EN_PROCESO" | "COMPLETADA" | "FALLIDA";
    clinicalData: Record<string, any>;
    patientId: string;
    doctorId?: string | undefined;
}, {
    patientId: string;
    status?: "PENDIENTE" | "EN_PROCESO" | "COMPLETADA" | "FALLIDA" | undefined;
    clinicalData?: Record<string, any> | undefined;
    doctorId?: string | undefined;
}>;
export type ConsultationCreate = z.infer<typeof consultationCreateSchema>;
export declare const consultationReadSchema: z.ZodObject<{
    id: z.ZodString;
    patientId: z.ZodString;
    doctorId: z.ZodString;
    status: z.ZodString;
    clinicalData: z.ZodRecord<z.ZodString, z.ZodAny>;
    createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
}, "strip", z.ZodTypeAny, {
    status: string;
    id: string;
    createdAt: string | Date;
    clinicalData: Record<string, any>;
    patientId: string;
    doctorId: string;
}, {
    status: string;
    id: string;
    createdAt: string | Date;
    clinicalData: Record<string, any>;
    patientId: string;
    doctorId: string;
}>;
export type ConsultationRead = z.infer<typeof consultationReadSchema>;
export declare const feedbackCreateSchema: z.ZodObject<{
    consultationId: z.ZodString;
    inferenceId: z.ZodString;
    doctorId: z.ZodOptional<z.ZodString>;
    validatedClass: z.ZodNumber;
    predictedClass: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    confidence: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    agreement: z.ZodNullable<z.ZodOptional<z.ZodBoolean>>;
    doctorNotes: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    isGoldStandard: z.ZodDefault<z.ZodBoolean>;
    clinicalData: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, "strip", z.ZodTypeAny, {
    clinicalData: Record<string, any>;
    consultationId: string;
    inferenceId: string;
    validatedClass: number;
    isGoldStandard: boolean;
    doctorId?: string | undefined;
    predictedClass?: number | null | undefined;
    confidence?: number | null | undefined;
    agreement?: boolean | null | undefined;
    doctorNotes?: string | null | undefined;
}, {
    consultationId: string;
    inferenceId: string;
    validatedClass: number;
    clinicalData?: Record<string, any> | undefined;
    doctorId?: string | undefined;
    predictedClass?: number | null | undefined;
    confidence?: number | null | undefined;
    agreement?: boolean | null | undefined;
    doctorNotes?: string | null | undefined;
    isGoldStandard?: boolean | undefined;
}>;
export type FeedbackCreate = z.infer<typeof feedbackCreateSchema>;
export declare const feedbackReadSchema: z.ZodObject<{
    id: z.ZodString;
    consultationId: z.ZodString;
    inferenceId: z.ZodString;
    doctorId: z.ZodString;
    validatedClass: z.ZodNumber;
    predictedClass: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    agreement: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    doctorNotes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isGoldStandard: z.ZodBoolean;
    clinicalData: z.ZodRecord<z.ZodString, z.ZodAny>;
    createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string | Date;
    clinicalData: Record<string, any>;
    doctorId: string;
    consultationId: string;
    inferenceId: string;
    validatedClass: number;
    isGoldStandard: boolean;
    predictedClass?: number | null | undefined;
    confidence?: number | null | undefined;
    agreement?: boolean | null | undefined;
    doctorNotes?: string | null | undefined;
}, {
    id: string;
    createdAt: string | Date;
    clinicalData: Record<string, any>;
    doctorId: string;
    consultationId: string;
    inferenceId: string;
    validatedClass: number;
    isGoldStandard: boolean;
    predictedClass?: number | null | undefined;
    confidence?: number | null | undefined;
    agreement?: boolean | null | undefined;
    doctorNotes?: string | null | undefined;
}>;
export type FeedbackRead = z.infer<typeof feedbackReadSchema>;
export declare const goldStandardBatchSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        consultationId: z.ZodString;
        inferenceId: z.ZodString;
        doctorId: z.ZodString;
        validatedClass: z.ZodNumber;
        predictedClass: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        agreement: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        doctorNotes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isGoldStandard: z.ZodBoolean;
        clinicalData: z.ZodRecord<z.ZodString, z.ZodAny>;
        createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        createdAt: string | Date;
        clinicalData: Record<string, any>;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        validatedClass: number;
        isGoldStandard: boolean;
        predictedClass?: number | null | undefined;
        confidence?: number | null | undefined;
        agreement?: boolean | null | undefined;
        doctorNotes?: string | null | undefined;
    }, {
        id: string;
        createdAt: string | Date;
        clinicalData: Record<string, any>;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        validatedClass: number;
        isGoldStandard: boolean;
        predictedClass?: number | null | undefined;
        confidence?: number | null | undefined;
        agreement?: boolean | null | undefined;
        doctorNotes?: string | null | undefined;
    }>, "many">;
    count: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    items: {
        id: string;
        createdAt: string | Date;
        clinicalData: Record<string, any>;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        validatedClass: number;
        isGoldStandard: boolean;
        predictedClass?: number | null | undefined;
        confidence?: number | null | undefined;
        agreement?: boolean | null | undefined;
        doctorNotes?: string | null | undefined;
    }[];
    count: number;
}, {
    items: {
        id: string;
        createdAt: string | Date;
        clinicalData: Record<string, any>;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        validatedClass: number;
        isGoldStandard: boolean;
        predictedClass?: number | null | undefined;
        confidence?: number | null | undefined;
        agreement?: boolean | null | undefined;
        doctorNotes?: string | null | undefined;
    }[];
    count: number;
}>;
export type GoldStandardBatch = z.infer<typeof goldStandardBatchSchema>;
