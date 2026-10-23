import { FeedbackCreate } from "../schemas/consultation.js";
export declare class FeedbackRepository {
    static create(data: FeedbackCreate & {
        doctorId: string;
    }): Promise<{
        id: string;
        createdAt: Date;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        predictedClass: number | null;
        validatedClass: number;
        confidence: number | null;
        agreement: boolean | null;
        doctorNotes: string | null;
        isGoldStandard: boolean;
    }>;
    static findGoldStandard(limit?: number, offset?: number): Promise<{
        id: string;
        createdAt: Date;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
        doctorId: string;
        consultationId: string;
        inferenceId: string;
        predictedClass: number | null;
        validatedClass: number;
        confidence: number | null;
        agreement: boolean | null;
        doctorNotes: string | null;
        isGoldStandard: boolean;
    }[]>;
}
