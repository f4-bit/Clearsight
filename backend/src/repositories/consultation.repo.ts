import type { ConsultationCreate } from "../schemas/consultation.js";
import type { JobStatus } from "../schemas/common.js";
import type { Db, JsonObject } from "./types.js";

export function createConsultationRepository(db: Db) {
  return {
    create: (input: ConsultationCreate) =>
      db.consultation.create({
        data: {
          patientId: input.patientId,
          doctorId: input.doctorId,
          status: input.status ?? "QUEUED",
          clinicalData: (input.clinicalData ?? {}) as JsonObject,
        },
      }),

    findById: (id: string) => db.consultation.findUnique({ where: { id } }),

    findWithImages: (id: string) =>
      db.consultation.findUnique({
        where: { id },
        include: { images: { orderBy: { eyeSide: "asc" }, include: { inferences: true } } },
      }),

    listByDoctor: (doctorId: string, opts: { limit?: number; offset?: number; status?: JobStatus } = {}) =>
      db.consultation.findMany({
        where: { doctorId, ...(opts.status && { status: opts.status }) },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
      }),

    listByPatient: (patientId: string) =>
      db.consultation.findMany({ where: { patientId }, orderBy: { createdAt: "desc" } }),

    updateStatus: (id: string, status: JobStatus) =>
      db.consultation.update({ where: { id }, data: { status } }),

    updateClinicalData: (id: string, clinicalData: Record<string, unknown>) =>
      db.consultation.update({ where: { id }, data: { clinicalData: clinicalData as JsonObject } }),

    delete: (id: string) => db.consultation.delete({ where: { id } }),
  };
}
export type ConsultationRepository = ReturnType<typeof createConsultationRepository>;
