import { Queue } from "bullmq";
export declare const INFERENCE_QUEUE_NAME = "inference-jobs";
export interface InferenceJobData {
    inferenceId: string;
    imageId: string;
    imageUrl: string;
    eyeSide: "OD" | "OS";
    clinicalFeatures: any;
    modelVersion?: string | null;
}
export declare const inferenceQueue: Queue<InferenceJobData, any, string, InferenceJobData, any, string>;
export declare function enqueueInference(data: InferenceJobData): Promise<import("bullmq").Job<InferenceJobData, any, string>>;
