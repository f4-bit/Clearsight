import type { DiagnosticClass, EyeSide, JobStatus } from "@/types/clinical";

export const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type UserRole = "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN";
export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface AdminUser extends SessionUser {
  fullName: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Patient {
  id: string;
  externalCode?: string | null;
}

export interface ConsultationImage {
  id: string;
  eyeSide: EyeSide;
}

export interface CreatedConsultation {
  id: string;
  patientId: string;
  createdAt: string;
}

export type PollingStop = "CONTINUE" | "COMPLETE" | "ACTION_REQUIRED" | "FAILED";
export type AnalysisState =
  | "OPEN" | "IN_PROGRESS" | "REVIEW_REQUIRED" | "FAILED" | "PARTIAL" | "COMPLETED";

export interface Consultation extends CreatedConsultation {
  clinicalData: Record<string, unknown>;
  images: ConsultationImage[];
  requiredExecutionIds: string[];
  analysisState: AnalysisState;
  reportState: "NOT_REQUESTED" | "REPORT_PENDING" | "AVAILABLE" | "FAILED";
  completionState: "INCOMPLETE" | "COMPLETE";
  pollingStop: PollingStop;
}

export type ArtifactStatus = "PENDING" | "AVAILABLE" | "FAILED" | "NOT_SUPPORTED" | "NOT_REQUESTED";
export type EvidenceType = "mask" | "overlay";

export interface Inference {
  id: string;
  imageId: string;
  predictedClass: DiagnosticClass | null;
  confidence: number | null;
  probabilities: Record<string, unknown>;
  cdr?: number | null;
  cdrVertical?: number | null;
  modelVersion: string | null;
  createdAt: string;
  status: JobStatus;
  stage: JobStatus | null;
  pollingStop: PollingStop;
  delivery: {
    resultStatus: ArtifactStatus;
    evidenceStatus: ArtifactStatus;
    pdfStatus: ArtifactStatus;
    complete: boolean;
    reviewRequired: boolean;
    failed: boolean;
    deliveryTerminal: boolean;
  };
}

export interface EyeExecution {
  side: EyeSide;
  result: Inference;
}

export interface ArtifactItem {
  artifactId: string;
  version: number;
  reference: {
    artifactType: EvidenceType | "pdf" | "gradcam" | "shap";
    status: ArtifactStatus;
  };
}

export interface ReportVersion {
  reportId: string;
  version: number;
  status: ArtifactStatus;
}

export interface ArtifactUrl {
  status: ArtifactStatus;
  url: string | null;
  expiresInSeconds: number | null;
}
