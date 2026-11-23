import { z } from "zod";
import { env } from "../config/env.js";
import type { PrepareClinicalSnapshotRequest } from "../schemas/clinical-context.js";
import {
  jobStatusEnum,
  JobAccepted,
  JobResponse,
} from "../schemas/inference.js";

export interface MlClientOptions {
  baseUrl?: string;
  apiToken?: string | null;
  timeoutMs?: number;
}

export interface ClinicalContextPreparer {
  prepareClinicalSnapshot(payload: PrepareClinicalSnapshotRequest): Promise<unknown>;
}

export class MlClientHttpError extends Error {
  constructor(public readonly status: number) {
    super(`ML service request failed with status ${status}`);
    this.name = "MlClientHttpError";
  }
}

export class MlClientError extends Error {
  constructor(message = "ML service is unavailable") {
    super(message);
    this.name = "MlClientError";
  }
}

function defineRecordEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Zod `record()` silently drops an own `__proto__` key. The ML wire is JSON;
 * preserve every own key and validate each value before copying it.
 */
function protoSafeRecord<T>(
  valueSchema: z.ZodType<T>,
): z.ZodType<Record<string, T>> {
  return z.unknown().transform((value, ctx) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "Expected an object record" });
      return z.NEVER;
    }
    const parsed: Record<string, T> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = valueSchema.safeParse(item);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
        return z.NEVER;
      }
      defineRecordEntry(parsed, key, result.data);
    }
    return parsed;
  });
}

const WireModelPrediction = z.strictObject({
  probabilities: protoSafeRecord(z.number().finite()),
  predicted_class: z.string(),
  confidence: z.number().finite(),
});

const WireInferenceResult = z.strictObject({
  inference_id: z.string().uuid(),
  eye_side: z.enum(["OD", "OS"]),
  label: z.string().nullable(),
  confidence: z.number().finite().nullable(),
  probabilities: protoSafeRecord(z.number().finite()),
  model_predictions: protoSafeRecord(WireModelPrediction),
  cdr: z.number().finite().nullable(),
  cdr_vertical: z.number().finite().nullable(),
  quality: protoSafeRecord(z.unknown()),
  artifacts: protoSafeRecord(z.string()),
  model_versions: protoSafeRecord(z.string()),
  elapsed_seconds: z.number().finite(),
});

const WireJobAccepted = z.strictObject({
  inference_id: z.string().uuid(),
  job_id: z.string().min(1),
  status: jobStatusEnum,
});

const WireJobResponse = z.strictObject({
  inference_id: z.string().uuid(),
  job_id: z.string().min(1),
  status: jobStatusEnum,
  stage: z.string(),
  message: z.string().nullable().optional(),
  result: WireInferenceResult.nullable().optional(),
});

interface MlRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export class MlClient implements ClinicalContextPreparer {
  private baseUrl: string;
  private authHeaders: Record<string, string>;
  private timeoutMs: number;

  constructor(options: MlClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.ML_SERVICE_URL).replace(/\/$/, "");
    const token = options.apiToken === undefined ? env.ML_API_TOKEN : options.apiToken;
    this.authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private async request(path: string, init: MlRequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MlClientError();
    }
    if (!response.ok) {
      throw new MlClientHttpError(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new MlClientError("ML service returned invalid JSON");
    }
  }

  async prepareClinicalSnapshot(
    payload: PrepareClinicalSnapshotRequest,
  ): Promise<unknown> {
    return this.request("/v1/clinical-snapshots/prepare", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders,
      },
      body: JSON.stringify(payload),
    });
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
    expected_context?: {
      schema_version: string;
      fingerprint_sha256: string;
    } | null;
  }): Promise<JobAccepted> {
    const parsed = WireJobAccepted.safeParse(
      await this.request("/v1/inferences", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders,
        },
        body: JSON.stringify(payload),
      }),
    );
    if (!parsed.success) {
      throw new MlClientError("ML service returned an invalid payload");
    }
    return {
      inferenceId: parsed.data.inference_id,
      jobId: parsed.data.job_id,
      status: parsed.data.status,
    };
  }

  async getJobStatus(jobId: string): Promise<JobResponse> {
    const parsed = WireJobResponse.safeParse(
      await this.request(`/v1/inferences/${jobId}`, {
        method: "GET",
        headers: this.authHeaders,
      }),
    );
    if (!parsed.success) {
      throw new MlClientError("ML service returned an invalid payload");
    }
    const data = parsed.data;
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
            modelPredictions: Object.fromEntries(
              Object.entries(data.result.model_predictions).map(([name, value]) => [
                name,
                {
                  probabilities: value.probabilities,
                  predictedClass: value.predicted_class,
                  confidence: value.confidence,
                },
              ]),
            ),
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
      const response = await fetch(`${this.baseUrl}/health/live`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const mlClient = new MlClient();
