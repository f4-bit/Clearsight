import type { PatientCreate, PatientUpdate } from "../schemas/patient.js";
import type { Db, JsonObject } from "./types.js";

export function createPatientRepository(db: Db) {
  return {
    create: (input: PatientCreate) =>
      db.patient.create({
        data: {
          externalCode: input.externalCode ?? null,
          age: input.age ?? null,
          gender: input.gender ?? null,
          clinicalHistoryFlags: (input.clinicalHistoryFlags ?? {}) as JsonObject,
          clinicalData: (input.clinicalData ?? {}) as JsonObject,
        },
      }),

    findById: (id: string) => db.patient.findUnique({ where: { id } }),

    findByExternalCode: (externalCode: string) =>
      db.patient.findMany({ where: { externalCode }, orderBy: { createdAt: "asc" } }),

    list: (opts: { limit?: number; offset?: number } = {}) =>
      db.patient.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
      }),

    update: (id: string, input: PatientUpdate) =>
      db.patient.update({
        where: { id },
        data: {
          ...(input.externalCode !== undefined && { externalCode: input.externalCode }),
          ...(input.age !== undefined && { age: input.age }),
          ...(input.gender !== undefined && { gender: input.gender }),
          ...(input.clinicalHistoryFlags !== undefined && {
            clinicalHistoryFlags: input.clinicalHistoryFlags as JsonObject,
          }),
          ...(input.clinicalData !== undefined && {
            clinicalData: input.clinicalData as JsonObject,
          }),
        },
      }),

    /** Cascades to consultations, images, inferences and feedback. */
    delete: (id: string) => db.patient.delete({ where: { id } }),
  };
}
export type PatientRepository = ReturnType<typeof createPatientRepository>;
