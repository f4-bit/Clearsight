import { JobAccepted, JobResponse } from "../schemas/inference.js";
export declare class MlClient {
    private baseUrl;
    constructor(baseUrl?: string);
    submitInference(payload: {
        inference_id: string;
        image_url: string;
        eye_side: "OD" | "OS";
        clinical_features: {
            Age: number;
            Gender: number;
            dioptre_1: number;
            dioptre_2: number;
            astigmatism: number;
            "Phakic/Pseudophakic": number;
            Pneumatic: number;
            Perkins: number;
            Pachymetry: number;
            Axial_Length: number;
            VF_DM: number;
        };
        model_version?: string | null;
    }): Promise<JobAccepted>;
    getJobStatus(jobId: string): Promise<JobResponse>;
    isHealthy(): Promise<boolean>;
}
export declare const mlClient: MlClient;
