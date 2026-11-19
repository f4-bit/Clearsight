import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Prisma } from "../generated/prisma/client.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { forbidden, notFound } from "../lib/http-error.js";
import type { PrismaClient } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  consultationCreateSchema,
  consultationReadSchema,
} from "../schemas/consultation.js";
import { imageReadSchema } from "../schemas/image.js";
import type { ClinicalAccessService } from "../services/clinical-access.js";
import { subjectFromRequest } from "../services/clinical-access.js";
import { sanitizeImage } from "../services/sanitizer.js";
import { StorageService } from "../services/storage.js";

export interface ConsultationRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
}

function toImageRead(image: {
  id: string;
  consultationId: string;
  eyeSide: string;
  storagePath: string;
  hashMd5: string | null;
  createdAt: Date;
}) {
  return {
    id: image.id,
    consultationId: image.consultationId,
    eyeSide: image.eyeSide as "OD" | "OS",
    storagePath: image.storagePath,
    hashMd5: image.hashMd5,
    createdAt: image.createdAt,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const consultationRoutes: FastifyPluginAsync<ConsultationRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, access } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /consultations
  typedApp.post(
    "/",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Consultations"],
        summary: "Open a new ophthalmology consultation",
        body: consultationCreateSchema,
        response: {
          201: consultationReadSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const { patientId, status, clinicalData, doctorId } = request.body;

      // A legacy doctor hint is only accepted when it matches the authenticated
      // doctor; the stored value is always the server principal.
      if (doctorId !== undefined && doctorId !== subject.id) {
        throw forbidden("doctorId does not match the authenticated user");
      }

      // The new API may only attach a consultation to a patient the caller
      // already owns; an orphan profile cannot be claimed by creating a case.
      const patient = await prisma.patient.findFirst({
        where: { id: patientId, ownerDoctorId: subject.id },
        select: { id: true },
      });
      if (patient === null) {
        throw notFound("Patient");
      }

      const consultation = await prisma.consultation.create({
        data: {
          patientId,
          doctorId: subject.id,
          status,
          clinicalData: clinicalData as Prisma.InputJsonValue,
        },
      });

      return reply.status(201).send({
        id: consultation.id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
        status: consultation.status,
        clinicalData: consultation.clinicalData as Record<string, unknown>,
        createdAt: consultation.createdAt,
      });
    }
  );

  // POST /consultations/:id/images
  app.post(
    "/:id/images",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const { id: consultationId } = request.params as { id: string };

      if (!UUID_PATTERN.test(consultationId)) {
        return reply.status(400).send({
          error: "BadRequest",
          message: "Consultation id must be a UUID",
          statusCode: 400,
        });
      }

      // Ownership is decided before any multipart buffering or storage write.
      await access.getOwnedConsultation(subject, consultationId, false);

      let fileBuffer: Buffer | null = null;
      let eyeSideValue: string | null = null;
      let eyeSideSeen = false;
      let eyeSideInvalid = false;

      try {
        for await (const part of request.parts()) {
          if (part.type === "field") {
            if (part.fieldname !== "eyeSide") continue;
            const value = String(part.value ?? "").trim().toUpperCase();
            if (eyeSideSeen) {
              // Duplicate lateralities are ambiguous: never guess.
              eyeSideInvalid = true;
              continue;
            }
            eyeSideSeen = true;
            if (value === "OD" || value === "OS") {
              eyeSideValue = value;
            } else {
              eyeSideInvalid = true;
            }
          } else if (part.type === "file" && !fileBuffer) {
            fileBuffer = await part.toBuffer();
          }
        }
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode === 413 ? 413 : 400;
        return reply.status(statusCode).send({
          error: statusCode === 413 ? "PayloadTooLarge" : "BadRequest",
          message: "Image file exceeds the size limit or is unreadable",
          statusCode,
        });
      }

      // Eye side must be explicit and unambiguous; there is no OD default.
      if (!eyeSideSeen || eyeSideInvalid || eyeSideValue === null) {
        return reply.status(422).send({
          error: "validation_error",
          message: "eyeSide must be exactly one of OD or OS",
          statusCode: 422,
        });
      }

      if (!fileBuffer) {
        return reply.status(400).send({
          error: "BadRequest",
          message: "No image file uploaded",
          statusCode: 400,
        });
      }

      let sanitized;
      try {
        sanitized = await sanitizeImage(fileBuffer);
      } catch {
        return reply.status(400).send({
          error: "BadRequest",
          message: "Invalid or unsupported image file",
          statusCode: 400,
        });
      }

      // Upload to object storage, then persist the metadata.
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const imageId = randomUUID();
      const key = `${year}/${month}/${imageId}.jpg`;

      await StorageService.upload(env.MINIO_BUCKET_RAW, key, sanitized.buffer, "image/jpeg");

      const imageRecord = await prisma.image.create({
        data: {
          id: imageId,
          consultationId,
          eyeSide: eyeSideValue,
          storagePath: `${env.MINIO_BUCKET_RAW}/${key}`,
          hashMd5: sanitized.hashMd5,
        },
      });

      return reply.status(201).send(toImageRead(imageRecord));
    }
  );

  // GET /consultations/:id
  typedApp.get(
    "/:id",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Consultations"],
        summary: "Get an owned consultation by ID including images",
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string().uuid(),
            patientId: z.string().uuid(),
            doctorId: z.string().uuid(),
            status: z.string(),
            clinicalData: z.record(z.string(), z.unknown()),
            createdAt: z.date().or(z.iso.datetime()),
            images: z.array(imageReadSchema),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const consultation = await access.getOwnedConsultation(
        subject,
        request.params.id,
        true,
      );

      return reply.send({
        id: consultation.id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
        status: consultation.status,
        clinicalData: consultation.clinicalData as Record<string, unknown>,
        createdAt: consultation.createdAt,
        images: (consultation.images as Array<Parameters<typeof toImageRead>[0]>).map(
          toImageRead,
        ),
      });
    }
  );
};
