import { z } from "zod";
import { JobStatus, Uuid } from "./common.js";

export const consultationStatusEnum = JobStatus;
export type ConsultationStatus = JobStatus;

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
