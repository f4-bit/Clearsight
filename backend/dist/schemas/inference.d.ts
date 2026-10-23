import { z } from "zod";
export declare const jobStatusEnum: z.ZodEnum<["QUEUED", "DOWNLOADING", "LOCALIZING", "SEGMENTING", "CLASSIFYING", "COMPLETED", "REVIEW_REQUIRED", "FAILED"]>;
export type JobStatus = z.infer<typeof jobStatusEnum>;
export declare const inferenceCreateSchema: z.ZodObject<{
    inferenceId: z.ZodOptional<z.ZodString>;
    imageId: z.ZodString;
    imageUrl: z.ZodOptional<z.ZodString>;
    eyeSide: z.ZodEnum<["OD", "OS"]>;
    clinicalFeatures: z.ZodEffects<z.ZodObject<{
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
    }>;
    modelVersion: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    eyeSide: "OD" | "OS";
    imageId: string;
    clinicalFeatures: {
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
    };
    inferenceId?: string | undefined;
    modelVersion?: string | null | undefined;
    imageUrl?: string | undefined;
}, {
    eyeSide: "OD" | "OS";
    imageId: string;
    clinicalFeatures: {
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
    };
    inferenceId?: string | undefined;
    modelVersion?: string | null | undefined;
    imageUrl?: string | undefined;
}>;
export type InferenceCreate = z.infer<typeof inferenceCreateSchema>;
export declare const modelPredictionSchema: z.ZodObject<{
    probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
    predictedClass: z.ZodString;
    confidence: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    predictedClass: string;
    confidence: number;
    probabilities: Record<string, number>;
}, {
    predictedClass: string;
    confidence: number;
    probabilities: Record<string, number>;
}>;
export type ModelPrediction = z.infer<typeof modelPredictionSchema>;
export declare const inferenceResultSchema: z.ZodObject<{
    inferenceId: z.ZodString;
    eyeSide: z.ZodEnum<["OD", "OS"]>;
    label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
    modelPredictions: z.ZodRecord<z.ZodString, z.ZodObject<{
        probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
        predictedClass: z.ZodString;
        confidence: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        predictedClass: string;
        confidence: number;
        probabilities: Record<string, number>;
    }, {
        predictedClass: string;
        confidence: number;
        probabilities: Record<string, number>;
    }>>;
    cdr: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    cdrVertical: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    quality: z.ZodRecord<z.ZodString, z.ZodAny>;
    artifacts: z.ZodRecord<z.ZodString, z.ZodString>;
    modelVersions: z.ZodRecord<z.ZodString, z.ZodString>;
    elapsedSeconds: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    eyeSide: "OD" | "OS";
    inferenceId: string;
    probabilities: Record<string, number>;
    quality: Record<string, any>;
    modelPredictions: Record<string, {
        predictedClass: string;
        confidence: number;
        probabilities: Record<string, number>;
    }>;
    artifacts: Record<string, string>;
    modelVersions: Record<string, string>;
    elapsedSeconds: number;
    confidence?: number | null | undefined;
    label?: string | null | undefined;
    cdr?: number | null | undefined;
    cdrVertical?: number | null | undefined;
}, {
    eyeSide: "OD" | "OS";
    inferenceId: string;
    probabilities: Record<string, number>;
    quality: Record<string, any>;
    modelPredictions: Record<string, {
        predictedClass: string;
        confidence: number;
        probabilities: Record<string, number>;
    }>;
    artifacts: Record<string, string>;
    modelVersions: Record<string, string>;
    elapsedSeconds: number;
    confidence?: number | null | undefined;
    label?: string | null | undefined;
    cdr?: number | null | undefined;
    cdrVertical?: number | null | undefined;
}>;
export type InferenceResult = z.infer<typeof inferenceResultSchema>;
export declare const jobAcceptedSchema: z.ZodObject<{
    inferenceId: z.ZodString;
    jobId: z.ZodString;
    status: z.ZodEnum<["QUEUED", "DOWNLOADING", "LOCALIZING", "SEGMENTING", "CLASSIFYING", "COMPLETED", "REVIEW_REQUIRED", "FAILED"]>;
}, "strip", z.ZodTypeAny, {
    status: "COMPLETED" | "FAILED" | "QUEUED" | "DOWNLOADING" | "LOCALIZING" | "SEGMENTING" | "CLASSIFYING" | "REVIEW_REQUIRED";
    inferenceId: string;
    jobId: string;
}, {
    status: "COMPLETED" | "FAILED" | "QUEUED" | "DOWNLOADING" | "LOCALIZING" | "SEGMENTING" | "CLASSIFYING" | "REVIEW_REQUIRED";
    inferenceId: string;
    jobId: string;
}>;
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;
export declare const jobResponseSchema: z.ZodObject<{
    inferenceId: z.ZodString;
    jobId: z.ZodString;
    status: z.ZodEnum<["QUEUED", "DOWNLOADING", "LOCALIZING", "SEGMENTING", "CLASSIFYING", "COMPLETED", "REVIEW_REQUIRED", "FAILED"]>;
    stage: z.ZodString;
    message: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    result: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        inferenceId: z.ZodString;
        eyeSide: z.ZodEnum<["OD", "OS"]>;
        label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
        modelPredictions: z.ZodRecord<z.ZodString, z.ZodObject<{
            probabilities: z.ZodRecord<z.ZodString, z.ZodNumber>;
            predictedClass: z.ZodString;
            confidence: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }>>;
        cdr: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        cdrVertical: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        quality: z.ZodRecord<z.ZodString, z.ZodAny>;
        artifacts: z.ZodRecord<z.ZodString, z.ZodString>;
        modelVersions: z.ZodRecord<z.ZodString, z.ZodString>;
        elapsedSeconds: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        eyeSide: "OD" | "OS";
        inferenceId: string;
        probabilities: Record<string, number>;
        quality: Record<string, any>;
        modelPredictions: Record<string, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }>;
        artifacts: Record<string, string>;
        modelVersions: Record<string, string>;
        elapsedSeconds: number;
        confidence?: number | null | undefined;
        label?: string | null | undefined;
        cdr?: number | null | undefined;
        cdrVertical?: number | null | undefined;
    }, {
        eyeSide: "OD" | "OS";
        inferenceId: string;
        probabilities: Record<string, number>;
        quality: Record<string, any>;
        modelPredictions: Record<string, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }>;
        artifacts: Record<string, string>;
        modelVersions: Record<string, string>;
        elapsedSeconds: number;
        confidence?: number | null | undefined;
        label?: string | null | undefined;
        cdr?: number | null | undefined;
        cdrVertical?: number | null | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    status: "COMPLETED" | "FAILED" | "QUEUED" | "DOWNLOADING" | "LOCALIZING" | "SEGMENTING" | "CLASSIFYING" | "REVIEW_REQUIRED";
    inferenceId: string;
    jobId: string;
    stage: string;
    message?: string | null | undefined;
    result?: {
        eyeSide: "OD" | "OS";
        inferenceId: string;
        probabilities: Record<string, number>;
        quality: Record<string, any>;
        modelPredictions: Record<string, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }>;
        artifacts: Record<string, string>;
        modelVersions: Record<string, string>;
        elapsedSeconds: number;
        confidence?: number | null | undefined;
        label?: string | null | undefined;
        cdr?: number | null | undefined;
        cdrVertical?: number | null | undefined;
    } | null | undefined;
}, {
    status: "COMPLETED" | "FAILED" | "QUEUED" | "DOWNLOADING" | "LOCALIZING" | "SEGMENTING" | "CLASSIFYING" | "REVIEW_REQUIRED";
    inferenceId: string;
    jobId: string;
    stage: string;
    message?: string | null | undefined;
    result?: {
        eyeSide: "OD" | "OS";
        inferenceId: string;
        probabilities: Record<string, number>;
        quality: Record<string, any>;
        modelPredictions: Record<string, {
            predictedClass: string;
            confidence: number;
            probabilities: Record<string, number>;
        }>;
        artifacts: Record<string, string>;
        modelVersions: Record<string, string>;
        elapsedSeconds: number;
        confidence?: number | null | undefined;
        label?: string | null | undefined;
        cdr?: number | null | undefined;
        cdrVertical?: number | null | undefined;
    } | null | undefined;
}>;
export type JobResponse = z.infer<typeof jobResponseSchema>;
