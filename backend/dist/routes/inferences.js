import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import { inferenceCreateSchema, jobAcceptedSchema, } from "../schemas/inference.js";
import { StorageService } from "../services/storage.js";
import { enqueueInference } from "../workers/inference.queue.js";
export async function inferenceRoutes(app) {
    const typedApp = app.withTypeProvider();
    // POST /inferences - Enqueue async inference job
    typedApp.post("/", {
        preHandler: [authenticate, authorize(["OPHTHALMOLOGIST", "ADMIN"])],
        schema: {
            tags: ["Inferences"],
            summary: "Dispatch asynchronous ML inference job via BullMQ",
            body: inferenceCreateSchema,
            response: {
                202: jobAcceptedSchema,
                400: errorResponseSchema,
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { imageId, eyeSide, clinicalFeatures, modelVersion } = request.body;
        const imageRecord = await prisma.image.findUnique({
            where: { id: imageId },
            include: { consultation: true },
        });
        if (!imageRecord) {
            return reply.status(404).send({
                error: "NotFound",
                message: "Image record not found",
                statusCode: 404,
            });
        }
        const inferenceId = request.body.inferenceId ?? randomUUID();
        // 1. Create DB inference record
        await prisma.inference.create({
            data: {
                id: inferenceId,
                imageId,
                probabilities: {},
            },
        });
        // Update consultation status to EN_PROCESO
        await prisma.consultation.update({
            where: { id: imageRecord.consultationId },
            data: { status: "EN_PROCESO" },
        });
        // 2. Generate presigned URL for image so ML worker can fetch it
        const [bucket, ...rest] = imageRecord.storagePath.split("/");
        const key = rest.join("/");
        const imageUrl = request.body.imageUrl ?? (await StorageService.getDownloadUrl(bucket, key));
        // 3. Enqueue job in BullMQ
        const job = await enqueueInference({
            inferenceId,
            imageId,
            imageUrl,
            eyeSide,
            clinicalFeatures,
            modelVersion,
        });
        return reply.status(202).send({
            inferenceId,
            jobId: job.id ?? inferenceId,
            status: "QUEUED",
        });
    });
    // GET /inferences/:id
    typedApp.get("/:id", {
        preHandler: [authenticate],
        schema: {
            tags: ["Inferences"],
            summary: "Get inference result and probabilities",
            params: z.object({ id: z.string().uuid() }),
            response: {
                200: z.object({
                    id: z.string().uuid(),
                    imageId: z.string().uuid(),
                    predictedClass: z.number().nullable(),
                    confidence: z.number().nullable(),
                    probabilities: z.record(z.any()),
                    gradcamPath: z.string().nullable(),
                    modelVersion: z.string().nullable(),
                    createdAt: z.date().or(z.string().datetime()),
                }),
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const inference = await prisma.inference.findUnique({
            where: { id },
        });
        if (!inference) {
            return reply.status(404).send({
                error: "NotFound",
                message: "Inference not found",
                statusCode: 404,
            });
        }
        return reply.send({
            id: inference.id,
            imageId: inference.imageId,
            predictedClass: inference.predictedClass,
            confidence: inference.confidence,
            probabilities: inference.probabilities,
            gradcamPath: inference.gradcamPath,
            modelVersion: inference.modelVersion,
            createdAt: inference.createdAt,
        });
    });
    // GET /inferences/:id/gradcam - Presigned URL for Grad-CAM overlay
    typedApp.get("/:id/gradcam", {
        preHandler: [authenticate],
        schema: {
            tags: ["Inferences"],
            summary: "Get presigned URL for the Grad-CAM heatmap visualization",
            params: z.object({ id: z.string().uuid() }),
            response: {
                200: z.object({
                    url: z.string().url(),
                    expiresIn: z.number(),
                }),
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const inference = await prisma.inference.findUnique({
            where: { id },
        });
        if (!inference || !inference.gradcamPath) {
            return reply.status(404).send({
                error: "NotFound",
                message: "Grad-CAM visualization not available yet",
                statusCode: 404,
            });
        }
        const [bucket, ...rest] = inference.gradcamPath.split("/");
        const key = rest.join("/");
        const url = await StorageService.getDownloadUrl(bucket, key, 3600);
        return reply.send({
            url,
            expiresIn: 3600,
        });
    });
}
//# sourceMappingURL=inferences.js.map