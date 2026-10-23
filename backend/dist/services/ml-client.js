import { env } from "../config/env.js";
export class MlClient {
    baseUrl;
    constructor(baseUrl = env.ML_SERVICE_URL) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }
    async submitInference(payload) {
        const res = await fetch(`${this.baseUrl}/v1/inferences`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`ML service error ${res.status}: ${errorText}`);
        }
        const data = (await res.json());
        return {
            inferenceId: data.inference_id,
            jobId: data.job_id,
            status: data.status,
        };
    }
    async getJobStatus(jobId) {
        const res = await fetch(`${this.baseUrl}/v1/inferences/${jobId}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch ML job ${jobId}: ${res.statusText}`);
        }
        const data = (await res.json());
        return {
            inferenceId: data.inference_id,
            jobId: data.job_id,
            status: data.status,
            stage: data.stage,
            message: data.message,
            result: data.result
                ? {
                    inferenceId: data.result.inference_id,
                    eyeSide: data.result.eye_side,
                    label: data.result.label,
                    confidence: data.result.confidence,
                    probabilities: data.result.probabilities,
                    modelPredictions: data.result.model_predictions,
                    cdr: data.result.cdr,
                    cdrVertical: data.result.cdr_vertical,
                    quality: data.result.quality,
                    artifacts: data.result.artifacts,
                    modelVersions: data.result.model_versions,
                    elapsedSeconds: data.result.elapsed_seconds,
                }
                : null,
        };
    }
    async isHealthy() {
        try {
            const res = await fetch(`${this.baseUrl}/health/live`);
            return res.ok;
        }
        catch {
            return false;
        }
    }
}
export const mlClient = new MlClient();
//# sourceMappingURL=ml-client.js.map