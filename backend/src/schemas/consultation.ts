import { z } from "zod";
import { JobStatus, Uuid } from "./common.js";

export const ConsultationCreate = z.object({
  patientId: Uuid,
  doctorId: Uuid,
  status: JobStatus.default("QUEUED"),
  clinicalData: z.record(z.string(), z.unknown()).default({}),
});
export type ConsultationCreate = z.input<typeof ConsultationCreate>;
