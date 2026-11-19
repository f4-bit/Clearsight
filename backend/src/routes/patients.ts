import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import type { PrismaClient } from "../lib/prisma.js";
import { errorResponseSchema } from "../schemas/common.js";
import { patientCreateSchema, patientReadSchema } from "../schemas/patient.js";
import type { ClinicalAccessService } from "../services/clinical-access.js";
import { subjectFromRequest } from "../services/clinical-access.js";

export interface ClinicalRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
}

function toPatientRead(patient: {
  id: string;
  externalCode: string | null;
  age: number | null;
  gender: string | null;
  clinicalHistoryFlags: unknown;
  clinicalData: unknown;
  createdAt: Date;
}) {
  return {
    id: patient.id,
    externalCode: patient.externalCode,
    age: patient.age,
    gender: patient.gender,
    clinicalHistoryFlags: patient.clinicalHistoryFlags as Record<string, unknown>,
    clinicalData: patient.clinicalData as Record<string, unknown>,
    createdAt: patient.createdAt,
  };
}

/**
 * Patients are an ophthalmologist-owned clinical resource. ADMIN/INVESTIGADOR
 * can never create, list or read a patient profile, even with a grant; a grant
 * is scoped to a specific inference result/artifact/pdf/export only.
 */
export const patientRoutes: FastifyPluginAsync<ClinicalRoutesOptions> = async (app, opts) => {
  const { prisma, access } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /patients
  typedApp.post(
    "/",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Patients"],
        summary: "Register a pseudonymized clinical patient",
        body: patientCreateSchema,
        response: {
          201: patientReadSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      access.assertDoctor(subject);
      const data = request.body;

      const patient = await prisma.patient.create({
        data: {
          externalCode: data.externalCode ?? null,
          age: data.age ?? null,
          gender: data.gender ?? null,
          clinicalHistoryFlags: (data.clinicalHistoryFlags ?? {}) as Prisma.InputJsonValue,
          clinicalData: (data.clinicalData ?? {}) as Prisma.InputJsonValue,
          // Server-owned access owner: never from the body.
          ownerDoctorId: subject.id,
        },
      });

      return reply.status(201).send(toPatientRead(patient));
    }
  );

  // GET /patients
  typedApp.get(
    "/",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Patients"],
        summary: "List the authenticated doctor's patients",
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.array(patientReadSchema),
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const { limit, offset } = request.query;
      const patients = await access.listOwnedPatients(subject, { limit, offset });
      return reply.send(patients.map(toPatientRead));
    }
  );

  // GET /patients/:id
  typedApp.get(
    "/:id",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Patients"],
        summary: "Get an owned patient by UUID",
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: patientReadSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const patient = await access.getOwnedPatient(subject, request.params.id);
      return reply.send(toPatientRead(patient));
    }
  );
};
