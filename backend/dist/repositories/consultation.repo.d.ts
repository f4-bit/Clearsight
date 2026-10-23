import { ConsultationCreate } from "../schemas/consultation.js";
export declare class ConsultationRepository {
    static create(data: ConsultationCreate & {
        doctorId: string;
    }): Promise<{
        status: string;
        id: string;
        createdAt: Date;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
        patientId: string;
        doctorId: string;
    }>;
    static findById(id: string): Promise<({
        patient: {
            id: string;
            createdAt: Date;
            externalCode: string | null;
            age: number | null;
            gender: string | null;
            clinicalHistoryFlags: import("@prisma/client/runtime/library").JsonValue;
            clinicalData: import("@prisma/client/runtime/library").JsonValue;
        };
        clinicalFeedback: {
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
        }[];
        images: ({
            inferences: {
                id: string;
                createdAt: Date;
                predictedClass: number | null;
                confidence: number | null;
                imageId: string;
                probabilities: import("@prisma/client/runtime/library").JsonValue;
                gradcamPath: string | null;
                modelVersion: string | null;
            }[];
        } & {
            id: string;
            createdAt: Date;
            consultationId: string;
            eyeSide: import("@prisma/client").$Enums.EyeSide;
            storagePath: string;
            hashMd5: string | null;
        })[];
    } & {
        status: string;
        id: string;
        createdAt: Date;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
        patientId: string;
        doctorId: string;
    }) | null>;
    static updateStatus(id: string, status: string): Promise<{
        status: string;
        id: string;
        createdAt: Date;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
        patientId: string;
        doctorId: string;
    }>;
}
