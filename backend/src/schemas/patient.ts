import { z } from "zod";
import { Uuid } from "./common.js";

const JsonObject = z.record(z.string(), z.unknown());

export const PatientCreate = z.object({
  externalCode: z.string().max(64).nullish(),
  age: z.number().int().min(0).max(130).nullish(),
  gender: z.string().max(16).nullish(),
  clinicalHistoryFlags: JsonObject.default({}),
  clinicalData: JsonObject.default({}),
});
export type PatientCreate = z.input<typeof PatientCreate>;

export const PatientUpdate = PatientCreate.partial();
export type PatientUpdate = z.input<typeof PatientUpdate>;

export const PatientId = z.object({ id: Uuid });
