import { z } from "zod";
export declare const patientCreateSchema: z.ZodObject<{
    externalCode: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    age: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    gender: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    clinicalHistoryFlags: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodAny>>;
    clinicalData: z.ZodNullable<z.ZodOptional<z.ZodEffects<z.ZodObject<{
        Age: z.ZodNumber;
        Gender: z.ZodNumber;
        dioptre_1: z.ZodNumber;
        dioptre_2: z.ZodNumber;
        astigmatism: z.ZodNumber;
        "Phakic/Pseudophakic": z.ZodOptional<z.ZodNumber>;
        Phakic_Pseudophakic: z.ZodOptional<z.ZodNumber>;
        Pneumatic: z.ZodNumber;
        Perkins: z.ZodNumber;
        Pachymetry: z.ZodNumber;
        Axial_Length: z.ZodNumber;
        VF_DM: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
        "Phakic/Pseudophakic"?: number | undefined;
        Phakic_Pseudophakic?: number | undefined;
    }, {
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
        "Phakic/Pseudophakic"?: number | undefined;
        Phakic_Pseudophakic?: number | undefined;
    }>, {
        "Phakic/Pseudophakic": number;
        Phakic_Pseudophakic: number;
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
    }, {
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
        "Phakic/Pseudophakic"?: number | undefined;
        Phakic_Pseudophakic?: number | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    clinicalHistoryFlags: Record<string, any>;
    externalCode?: string | null | undefined;
    age?: number | null | undefined;
    gender?: string | null | undefined;
    clinicalData?: {
        "Phakic/Pseudophakic": number;
        Phakic_Pseudophakic: number;
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
    } | null | undefined;
}, {
    externalCode?: string | null | undefined;
    age?: number | null | undefined;
    gender?: string | null | undefined;
    clinicalHistoryFlags?: Record<string, any> | undefined;
    clinicalData?: {
        Age: number;
        Gender: number;
        dioptre_1: number;
        dioptre_2: number;
        astigmatism: number;
        Pneumatic: number;
        Perkins: number;
        Pachymetry: number;
        Axial_Length: number;
        VF_DM: number;
        "Phakic/Pseudophakic"?: number | undefined;
        Phakic_Pseudophakic?: number | undefined;
    } | null | undefined;
}>;
export type PatientCreate = z.infer<typeof patientCreateSchema>;
export declare const patientReadSchema: z.ZodObject<{
    id: z.ZodString;
    externalCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    age: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    gender: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    clinicalHistoryFlags: z.ZodRecord<z.ZodString, z.ZodAny>;
    clinicalData: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodAny>>>;
    createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string | Date;
    clinicalHistoryFlags: Record<string, any>;
    externalCode?: string | null | undefined;
    age?: number | null | undefined;
    gender?: string | null | undefined;
    clinicalData?: Record<string, any> | null | undefined;
}, {
    id: string;
    createdAt: string | Date;
    clinicalHistoryFlags: Record<string, any>;
    externalCode?: string | null | undefined;
    age?: number | null | undefined;
    gender?: string | null | undefined;
    clinicalData?: Record<string, any> | null | undefined;
}>;
export type PatientRead = z.infer<typeof patientReadSchema>;
