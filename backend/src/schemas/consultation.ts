import { z } from "zod";
import { JobStatus, Uuid } from "./common.js";

export const consultationStatusEnum = JobStatus;
export type ConsultationStatus = JobStatus;

export const ANALYSIS_STATES = [
  "OPEN",
  "IN_PROGRESS",
  "REVIEW_REQUIRED",
  "FAILED",
  "PARTIAL",
  "COMPLETED",
] as const;
export const AnalysisState = z.enum(ANALYSIS_STATES);
export type AnalysisState = z.infer<typeof AnalysisState>;

export const REPORT_STATES = [
  "NOT_REQUESTED",
  "REPORT_PENDING",
  "AVAILABLE",
  "FAILED",
] as const;
export const ReportState = z.enum(REPORT_STATES);
export type ReportState = z.infer<typeof ReportState>;

export const COMPLETION_STATES = ["INCOMPLETE", "COMPLETE"] as const;
export const CompletionState = z.enum(COMPLETION_STATES);
export type CompletionState = z.infer<typeof CompletionState>;

export const POLLING_STOPS = [
  "CONTINUE",
  "COMPLETE",
  "ACTION_REQUIRED",
  "FAILED",
] as const;
export const PollingStop = z.enum(POLLING_STOPS);
export type PollingStop = z.infer<typeof PollingStop>;

export const requiredExecutionsBodySchema = z
  .object({
    executionIds: z.array(Uuid).min(1).max(100),
  })
  .strict();

export type RequiredExecutionsBody = z.infer<
  typeof requiredExecutionsBodySchema
>;

export const requiredExecutionsResponseSchema = z
  .object({
    id: Uuid,
    requiredExecutionIds: z.array(Uuid),
    requiredSetVersion: z.string().min(1).max(128),
    requiredSetFrozenAt: z.date().or(z.iso.datetime()),
  })
  .strict();

export const consultationCreateSchema = z
  .object({
    patientId: Uuid,
    // Legacy hint: only allowed when it equals the authenticated doctor.
    doctorId: Uuid.optional(),
    status: consultationStatusEnum.default("QUEUED"),
    clinicalData: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type ConsultationCreate = z.infer<typeof consultationCreateSchema>;

export const consultationReadSchema = z.object({
  id: Uuid,
  patientId: Uuid,
  doctorId: Uuid,
  status: z.string(),
  clinicalData: z.record(z.string(), z.unknown()),
  createdAt: z.date().or(z.iso.datetime()),
});

export type ConsultationRead = z.infer<typeof consultationReadSchema>;
