import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import { patientCreateSchema, patientReadSchema } from "../schemas/patient.js";
export async function patientRoutes(app) {
    const typedApp = app.withTypeProvider();
    // POST /patients
    typedApp.post("/", {
        preHandler: [authenticate, authorize(["OPHTHALMOLOGIST", "ADMIN"])],
        schema: {
            tags: ["Patients"],
            summary: "Register a pseudonymized clinical patient",
            body: patientCreateSchema,
            response: {
                201: patientReadSchema,
                400: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const data = request.body;
        const patient = await prisma.patient.create({
            data: {
                externalCode: data.externalCode,
                age: data.age,
                gender: data.gender,
                clinicalHistoryFlags: data.clinicalHistoryFlags ?? {},
                clinicalData: data.clinicalData ? data.clinicalData : {},
            },
        });
        return reply.status(201).send({
            id: patient.id,
            externalCode: patient.externalCode,
            age: patient.age,
            gender: patient.gender,
            clinicalHistoryFlags: patient.clinicalHistoryFlags,
            clinicalData: patient.clinicalData,
            createdAt: patient.createdAt,
        });
    });
    // GET /patients
    typedApp.get("/", {
        preHandler: [authenticate],
        schema: {
            tags: ["Patients"],
            summary: "List patients",
            querystring: z.object({
                limit: z.coerce.number().min(1).max(100).default(20),
                offset: z.coerce.number().min(0).default(0),
            }),
            response: {
                200: z.array(patientReadSchema),
            },
        },
    }, async (request, reply) => {
        const { limit, offset } = request.query;
        const patients = await prisma.patient.findMany({
            take: limit,
            skip: offset,
            orderBy: { createdAt: "desc" },
        });
        return reply.send(patients.map((p) => ({
            id: p.id,
            externalCode: p.externalCode,
            age: p.age,
            gender: p.gender,
            clinicalHistoryFlags: p.clinicalHistoryFlags,
            clinicalData: p.clinicalData,
            createdAt: p.createdAt,
        })));
    });
    // GET /patients/:id
    typedApp.get("/:id", {
        preHandler: [authenticate],
        schema: {
            tags: ["Patients"],
            summary: "Get patient by UUID",
            params: z.object({ id: z.string().uuid() }),
            response: {
                200: patientReadSchema,
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const patient = await prisma.patient.findUnique({
            where: { id },
        });
        if (!patient) {
            return reply.status(404).send({
                error: "NotFound",
                message: `Patient ${id} not found`,
                statusCode: 404,
            });
        }
        return reply.send({
            id: patient.id,
            externalCode: patient.externalCode,
            age: patient.age,
            gender: patient.gender,
            clinicalHistoryFlags: patient.clinicalHistoryFlags,
            clinicalData: patient.clinicalData,
            createdAt: patient.createdAt,
        });
    });
}
//# sourceMappingURL=patients.js.map