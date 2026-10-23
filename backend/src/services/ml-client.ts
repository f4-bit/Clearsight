import { env } from "../config/env.js";
import {
  InferenceCreate,
  JobAccepted,
  JobResponse,
} from "../schemas/inference.js";

export class MlClient {
  private baseUrl: string;

  constructor(baseUrl = env.ML_SERVICE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async submitInference(payload: {
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
  }): Promise<JobAccepted> {
    const res = await fetch(`${this.baseUrl}/v1/inferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`ML service error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      inferenceId: data.inference_id,
      jobId: data.job_id,
      status: data.status,
    };
  }

  async getJobStatus(jobId: string): Promise<JobResponse> {
    const res = await fetch(`${this.baseUrl}/v1/inferences/${jobId}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ML job ${jobId}: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
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

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health/live`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const mlClient = new MlClient();
