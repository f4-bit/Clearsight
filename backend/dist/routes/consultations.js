import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import { consultationCreateSchema, consultationReadSchema, } from "../schemas/consultation.js";
import { imageReadSchema } from "../schemas/image.js";
import { sanitizeImage } from "../services/sanitizer.js";
import { StorageService } from "../services/storage.js";
export async function consultationRoutes(app) {
    const typedApp = app.withTypeProvider();
    // POST /consultations
    typedApp.post("/", {
        preHandler: [authenticate, authorize(["OPHTHALMOLOGIST", "ADMIN"])],
        schema: {
            tags: ["Consultations"],
            summary: "Open a new ophthalmology consultation",
            body: consultationCreateSchema,
            response: {
                201: consultationReadSchema,
                400: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { patientId, status, clinicalData } = request.body;
        const doctorId = request.body.doctorId ?? request.user.id;
        const consultation = await prisma.consultation.create({
            data: {
                patientId,
                doctorId,
                status,
                clinicalData: clinicalData,
            },
        });
        return reply.status(201).send({
            id: consultation.id,
            patientId: consultation.patientId,
            doctorId: consultation.doctorId,
            status: consultation.status,
            clinicalData: consultation.clinicalData,
            createdAt: consultation.createdAt,
        });
    });
    // POST /consultations/:id/images (Upload & sanitize retinography)
    app.post("/:id/images", {
        preHandler: [authenticate, authorize(["OPHTHALMOLOGIST", "ADMIN"])],
    }, async (request, reply) => {
        const { id: consultationId } = request.params;
        const consultation = await prisma.consultation.findUnique({
            where: { id: consultationId },
        });
        if (!consultation) {
            return reply.status(404).send({
                error: "NotFound",
                message: "Consultation not found",
                statusCode: 404,
            });
        }
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({
                error: "BadRequest",
                message: "No image file uploaded",
                statusCode: 400,
            });
        }
        // Parse eyeSide from fields or fallback to OD
        const eyeSideField = data.fields.eyeSide?.value;
        const eyeSide = eyeSideField === "OS" ? "OS" : "OD";
        const fileBuffer = await data.toBuffer();
        // 1. Sanitize image (remove EXIF/TIFF headers, orient, compute MD5)
        const sanitized = await sanitizeImage(fileBuffer);
        // 2. Upload to MinIO/S3
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const imageId = randomUUID();
        const key = `${year}/${month}/${imageId}.jpg`;
        await StorageService.upload(env.MINIO_BUCKET_RAW, key, sanitized.buffer, "image/jpeg");
        // 3. Persist Image metadata in PostgreSQL
        const imageRecord = await prisma.image.create({
            data: {
                id: imageId,
                consultationId,
                eyeSide,
                storagePath: `${env.MINIO_BUCKET_RAW}/${key}`,
                hashMd5: sanitized.hashMd5,
            },
        });
        return reply.status(201).send({
            id: imageRecord.id,
            consultationId: imageRecord.consultationId,
            eyeSide: imageRecord.eyeSide,
            storagePath: imageRecord.storagePath,
            hashMd5: imageRecord.hashMd5,
            createdAt: imageRecord.createdAt,
        });
    });
    // GET /consultations/:id
    typedApp.get("/:id", {
        preHandler: [authenticate],
        schema: {
            tags: ["Consultations"],
            summary: "Get consultation by ID including images and inferences",
            params: z.object({ id: z.string().uuid() }),
            response: {
                200: z.object({
                    id: z.string().uuid(),
                    patientId: z.string().uuid(),
                    doctorId: z.string().uuid(),
                    status: z.string(),
                    clinicalData: z.record(z.any()),
                    createdAt: z.date().or(z.string().datetime()),
                    images: z.array(imageReadSchema),
                }),
                404: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const consultation = await prisma.consultation.findUnique({
            where: { id },
            include: { images: true },
        });
        if (!consultation) {
            return reply.status(404).send({
                error: "NotFound",
                message: "Consultation not found",
                statusCode: 404,
            });
        }
        return reply.send({
            id: consultation.id,
            patientId: consultation.patientId,
            doctorId: consultation.doctorId,
            status: consultation.status,
            clinicalData: consultation.clinicalData,
            createdAt: consultation.createdAt,
            images: consultation.images.map((img) => ({
                id: img.id,
                consultationId: img.consultationId,
                eyeSide: img.eyeSide,
                storagePath: img.storagePath,
                hashMd5: img.hashMd5,
                createdAt: img.createdAt,
            })),
        });
    });
}
//# sourceMappingURL=consultations.js.map