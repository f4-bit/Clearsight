import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import { feedbackCreateSchema, feedbackReadSchema, goldStandardBatchSchema, } from "../schemas/consultation.js";
export async function feedbackRoutes(app) {
    const typedApp = app.withTypeProvider();
    // POST /feedback - Clinical feedback submission (Human-in-the-loop)
    typedApp.post("/", {
        preHandler: [authenticate, authorize(["OPHTHALMOLOGIST", "ADMIN"])],
        schema: {
            tags: ["Clinical Feedback"],
            summary: "Submit physician diagnostic feedback (Human-in-the-loop)",
            body: feedbackCreateSchema,
            response: {
                201: feedbackReadSchema,
                400: errorResponseSchema,
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { consultationId, inferenceId, validatedClass, predictedClass, confidence, agreement, doctorNotes, isGoldStandard, clinicalData, } = request.body;
        const doctorId = request.body.doctorId ?? request.user.id;
        const feedback = await prisma.clinicalFeedback.create({
            data: {
                consultationId,
                inferenceId,
                doctorId,
                validatedClass,
                predictedClass,
                confidence,
                agreement,
                doctorNotes,
                isGoldStandard,
                clinicalData: clinicalData,
            },
        });
        return reply.status(201).send({
            id: feedback.id,
            consultationId: feedback.consultationId,
            inferenceId: feedback.inferenceId,
            doctorId: feedback.doctorId,
            validatedClass: feedback.validatedClass,
            predictedClass: feedback.predictedClass,
            confidence: feedback.confidence,
            agreement: feedback.agreement,
            doctorNotes: feedback.doctorNotes,
            isGoldStandard: feedback.isGoldStandard,
            clinicalData: feedback.clinicalData,
            createdAt: feedback.createdAt,
        });
    });
    // GET /feedback/gold-standard - Export validated gold-standard records for MLOps retraining
    typedApp.get("/gold-standard", {
        preHandler: [authenticate, authorize(["RESEARCHER", "ADMIN"])],
        schema: {
            tags: ["Clinical Feedback"],
            summary: "Export verified gold-standard records for model retraining cycle",
            querystring: z.object({
                limit: z.coerce.number().min(1).max(500).default(100),
                offset: z.coerce.number().min(0).default(0),
            }),
            response: {
                200: goldStandardBatchSchema,
            },
        },
    }, async (request, reply) => {
        const { limit, offset } = request.query;
        const items = await prisma.clinicalFeedback.findMany({
            where: { isGoldStandard: true },
            take: limit,
            skip: offset,
            orderBy: { createdAt: "desc" },
        });
        return reply.send({
            items: items.map((f) => ({
                id: f.id,
                consultationId: f.consultationId,
                inferenceId: f.inferenceId,
                doctorId: f.doctorId,
                validatedClass: f.validatedClass,
                predictedClass: f.predictedClass,
                confidence: f.confidence,
                agreement: f.agreement,
                doctorNotes: f.doctorNotes,
                isGoldStandard: f.isGoldStandard,
                clinicalData: f.clinicalData,
                createdAt: f.createdAt,
            })),
            count: items.length,
        });
    });
}
//# sourceMappingURL=feedback.js.map