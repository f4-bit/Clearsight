import { ApiError, api, apiResponse, jsonBody, retryAfterSeconds, uploadImage } from "@/lib/api";
import type {
  ArtifactItem, ArtifactUrl, Consultation, ConsultationImage, CreatedConsultation,
  EvidenceType, EyeExecution, Inference, Page, Patient, ReportVersion,
} from "@/types/api";
import { CAPTURE_EYE_ORDER, type CaptureEyeAsset } from "@/types/capture";
import type { ClinicalFeatures, EyeSide } from "@/types/clinical";

export interface Submission {
  patientId: string | null;
  consultation: CreatedConsultation | null;
  eyes: Partial<Record<EyeSide, {
    asset: CaptureEyeAsset;
    key: string;
    imageId?: string;
    inferenceId?: string;
  }>>;
  clinical: ClinicalFeatures;
  externalCode: string | null;
  creationUnconfirmed?: "paciente" | "consulta";
}

export type SubmissionEvent =
  | { stage: "patient" | "consultation" | "freeze" }
  | { stage: "upload"; side: EyeSide; percent: number | null }
  | { stage: "inference"; side: EyeSide };

export type StudySnapshot = {
  consultation: Consultation;
  executions: EyeExecution[];
  retryAfter: number;
};

function unconfirmedWrite(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

export async function submitStudy(attempt: Submission, notify: (event: SubmissionEvent) => void) {
  if (attempt.creationUnconfirmed) throw new Error("Creation already attempted");
  if (!attempt.patientId) {
    notify({ stage: "patient" });
    try {
      const patient = await api<Patient>("/patients", {
        method: "POST",
        ...jsonBody({ externalCode: attempt.externalCode }),
      });
      attempt.patientId = patient.id;
    } catch (error) {
      if (unconfirmedWrite(error)) attempt.creationUnconfirmed = "paciente";
      throw error;
    }
  }
  if (!attempt.consultation) {
    notify({ stage: "consultation" });
    try {
      attempt.consultation = await api<CreatedConsultation>("/consultations", {
        method: "POST",
        ...jsonBody({ patientId: attempt.patientId, clinicalData: attempt.clinical }),
      });
    } catch (error) {
      if (unconfirmedWrite(error)) attempt.creationUnconfirmed = "consulta";
      throw error;
    }
  }
  const consultationId = attempt.consultation.id;
  const executionIds: string[] = [];
  for (const side of CAPTURE_EYE_ORDER) {
    const eye = attempt.eyes[side];
    if (!eye) continue;
    if (!eye.imageId) {
      try {
        const image = await uploadRetinography(consultationId, side, eye.asset.file, (percent) => {
          notify({ stage: "upload", side, percent });
        });
        eye.imageId = image.id;
      } catch (error) {
        if (!unconfirmedWrite(error)) throw error;
        const consultation = await api<Consultation>(`/consultations/${consultationId}`);
        const matches = consultation.images.filter((image) => image.eyeSide === side);
        if (matches.length !== 1) throw error;
        eye.imageId = matches[0].id;
      }
    }
    if (!eye.inferenceId) {
      notify({ stage: "inference", side });
      eye.inferenceId = await createInference(eye.key, eye.imageId, side, attempt.clinical);
    }
    executionIds.push(eye.inferenceId);
  }
  notify({ stage: "freeze" });
  try {
    await apiResponse(`/consultations/${consultationId}/required-executions`, {
      method: "POST",
      ...jsonBody({ executionIds }),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const current = await api<Consultation>(`/consultations/${consultationId}`);
    if (current.requiredExecutionIds.length !== executionIds.length ||
        !executionIds.every((id) => current.requiredExecutionIds.includes(id))) throw error;
  }
  return attempt.consultation;
}

export function uploadRetinography(
  consultationId: string, side: EyeSide, file: File, onProgress: (percent: number | null) => void,
) {
  const form = new FormData();
  form.set("eyeSide", side);
  form.set("file", file);
  return uploadImage<ConsultationImage>(consultationId, form, onProgress);
}

export async function createInference(
  key: string, imageId: string, eyeSide: EyeSide, clinicalFeatures: ClinicalFeatures,
  reanalysisOf?: string,
): Promise<string> {
  const request = jsonBody({ imageId, eyeSide, clinicalFeatures, reanalysisOf });
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", key);
  const accepted = await api<{ inferenceId: string }>("/inferences", {
    ...request,
    method: "POST",
    headers,
  });
  return accepted.inferenceId;
}

export async function getInference(id: string, signal?: AbortSignal) {
  const response = await apiResponse(`/inferences/${id}`, { signal });
  return {
    result: await response.json() as Inference,
    retryAfter: retryAfterSeconds(response.headers.get("Retry-After")),
  };
}

export async function getStudy(id: string, signal: AbortSignal): Promise<StudySnapshot> {
  const consultation = await api<Consultation>(`/consultations/${id}`, { signal });
  const results = await Promise.all(consultation.requiredExecutionIds.map((id) => getInference(id, signal)));
  const sides = new Map(consultation.images.map((image) => [image.id, image.eyeSide]));
  const executions = results.map(({ result }) => {
    const side = sides.get(result.imageId);
    if (!side) throw new Error("Execution image is missing from consultation");
    return { side, result };
  });
  const intervals = results.flatMap(({ retryAfter }) => retryAfter === null ? [] : [retryAfter]);
  return {
    consultation,
    executions,
    retryAfter: Math.min(10, Math.max(2, ...intervals)),
  };
}

export function studyNeedsPolling({ consultation, executions }: StudySnapshot) {
  return executions.length > 0 && (consultation.pollingStop === "CONTINUE" ||
    executions.some(({ result }) => !result.delivery.deliveryTerminal));
}

export async function evidenceUrl(id: string, type: EvidenceType, signal: AbortSignal) {
  const page = await api<Page<ArtifactItem>>(`/inferences/${id}/artifacts?type=${type}&limit=1`, { signal });
  const artifact = page.items[0];
  if (!artifact || artifact.reference.status !== "AVAILABLE") return null;
  const signed = await api<ArtifactUrl>(
    `/inferences/${id}/artifacts/${type}/url?version=${artifact.version}`, { signal },
  );
  return signed.status === "AVAILABLE" ? signed.url : null;
}

export async function reportUrls(id: string, signal?: AbortSignal) {
  return api<ReportVersion[]>(`/inferences/${id}/reports`, { signal });
}

export async function reportUrl(id: string, version: number) {
  const signed = await api<ArtifactUrl>(`/inferences/${id}/reports/${version}/url`);
  return signed.status === "AVAILABLE" ? signed.url : null;
}
