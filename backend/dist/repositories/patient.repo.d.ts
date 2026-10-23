import { PatientCreate } from "../schemas/patient.js";
export declare class PatientRepository {
    static create(data: PatientCreate): Promise<{
        id: string;
        createdAt: Date;
        externalCode: string | null;
        age: number | null;
        gender: string | null;
        clinicalHistoryFlags: import("@prisma/client/runtime/library").JsonValue;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
    }>;
    static findById(id: string): Promise<({
        consultations: ({
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
        })[];
    } & {
        id: string;
        createdAt: Date;
        externalCode: string | null;
        age: number | null;
        gender: string | null;
        clinicalHistoryFlags: import("@prisma/client/runtime/library").JsonValue;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
    }) | null>;
    static list(limit?: number, offset?: number): Promise<{
        id: string;
        createdAt: Date;
        externalCode: string | null;
        age: number | null;
        gender: string | null;
        clinicalHistoryFlags: import("@prisma/client/runtime/library").JsonValue;
        clinicalData: import("@prisma/client/runtime/library").JsonValue;
    }[]>;
}
