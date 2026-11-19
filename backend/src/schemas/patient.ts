import { z } from "zod";
import { Uuid } from "./common.js";

const JsonObject = z.record(z.string(), z.unknown());

export const PatientCreate = z
  .object({
    externalCode: z.string().max(64).nullish(),
    age: z.number().int().min(0).max(130).nullish(),
    gender: z.string().max(16).nullish(),
    clinicalHistoryFlags: JsonObject.default({}),
    clinicalData: JsonObject.default({}),
  })
  // Owner/actor are server-owned: an unknown body field is rejected before any
  // database work (no client-supplied `ownerDoctorId`).
  .strict();
export type PatientCreate = z.input<typeof PatientCreate>;

export const PatientUpdate = PatientCreate.partial();
export type PatientUpdate = z.input<typeof PatientUpdate>;

export const PatientId = z.object({ id: Uuid });

// camelCase alias kept for the API routes and tests.
export const patientCreateSchema = PatientCreate;

export const patientReadSchema = z.object({
  id: z.string().uuid(),
  externalCode: z.string().nullable().optional(),
  age: z.number().nullable().optional(),
  gender: z.string().nullable().optional(),
  clinicalHistoryFlags: z.record(z.string(), z.unknown()),
  clinicalData: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.date().or(z.iso.datetime()),
});

export type PatientRead = z.infer<typeof patientReadSchema>;
