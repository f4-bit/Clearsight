import { z } from "zod";
import { clinicalFeaturesSchema } from "./clinical.js";

export const patientCreateSchema = z.object({
  externalCode: z.string().max(64).optional().nullable(),
  age: z.number().int().min(0).max(130).optional().nullable(),
  gender: z.string().max(16).optional().nullable(),
  clinicalHistoryFlags: z.record(z.any()).default({}),
  clinicalData: clinicalFeaturesSchema.optional().nullable(),
});

export type PatientCreate = z.infer<typeof patientCreateSchema>;

export const patientReadSchema = z.object({
  id: z.string().uuid(),
  externalCode: z.string().nullable().optional(),
  age: z.number().nullable().optional(),
  gender: z.string().nullable().optional(),
  clinicalHistoryFlags: z.record(z.any()),
  clinicalData: z.record(z.any()).nullable().optional(),
  createdAt: z.date().or(z.string().datetime()),
});

export type PatientRead = z.infer<typeof patientReadSchema>;
