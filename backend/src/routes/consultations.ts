import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Prisma } from "../generated/prisma/client.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
  unprocessable,
} from "../lib/http-error.js";
import type { PrismaClient } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { createConsultationRepository } from "../repositories/consultation.repo.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  AnalysisState,
  CompletionState,
  PollingStop,
  ReportState,
  consultationCreateSchema,
  consultationReadSchema,
  requiredExecutionsBodySchema,
  requiredExecutionsResponseSchema,
} from "../schemas/consultation.js";
import { imageReadSchema } from "../schemas/image.js";
import { FeedbackRead } from "../schemas/feedback.js";
import { toFeedbackRead } from "./feedback.js";
import type { ClinicalAccessService } from "../services/clinical-access.js";
import { subjectFromRequest } from "../services/clinical-access.js";
import { computeConsultationStates } from "../services/consultation-completion.js";
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
  const consultationRepository = createConsultationRepository(prisma);
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

  // POST /consultations/:id/required-executions
  typedApp.post(
    "/:id/required-executions",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Consultations"],
        summary: "Freeze the required execution set for a consultation",
        params: z.object({ id: z.string().uuid() }),
        body: requiredExecutionsBodySchema,
        response: {
          200: requiredExecutionsResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const consultationId = request.params.id;
      const consultation = await access.getOwnedConsultation(
        subject,
        consultationId,
        false,
      );
      if (consultation.requiredSetFrozenAt !== null) {
        throw conflict("Required selection is already frozen");
      }

      const executionIds = request.body.executionIds.map((id) =>
        id.toLowerCase(),
      );
      if (new Set(executionIds).size !== executionIds.length) {
        throw unprocessable("executionIds must not contain duplicates");
      }

      const existing = await prisma.inference.findMany({
        where: {
          OR: [
            { consultationId },
            { consultationId: null, image: { consultationId } },
          ],
        },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((row) => row.id));
      if (executionIds.some((id) => !existingIds.has(id))) {
        throw unprocessable(
          "executionIds must be executions of this consultation",
        );
      }

      const requiredExecutionIds = [...executionIds].sort();
      const requiredSetVersion = `rsv1:${createHash("sha256")
        .update(requiredExecutionIds.join("\n"))
        .digest("hex")}`;
      const requiredSetFrozenAt = new Date();

      let updated;
      try {
        updated = await prisma.$transaction(async (tx) => {
          const repository = createConsultationRepository(tx);
          return repository.setRequiredSelection(consultationId, {
            requiredExecutionIds,
            requiredSetVersion,
            requiredSetFrozenAt,
          });
        });
      } catch (error) {
        // PostgreSQL raises restrict_violation (SQLSTATE 23001) when the
        // selection is already frozen. Prisma may surface it as P2003 (FK) or
        // P2010 (raw query), depending on the driver path. Both are a safe 409;
        // never forward the Prisma message or cause.
        const code = (error as { code?: unknown }).code;
        if (code === "P2003" || code === "P2010") {
          throw conflict("Required selection could not be frozen");
        }
        throw error;
      }

      if (
        updated.requiredSetVersion === null ||
        updated.requiredSetFrozenAt === null
      ) {
        throw serviceUnavailable("Required selection is unavailable");
      }
      return reply.send({
        id: updated.id,
        requiredExecutionIds: updated.requiredExecutionIds,
        requiredSetVersion: updated.requiredSetVersion,
        requiredSetFrozenAt: updated.requiredSetFrozenAt,
      });
    },
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
            feedback: z.array(FeedbackRead),
            reanalyses: z.array(z.object({
              id: z.uuid(), imageId: z.uuid(), reanalysisOfId: z.uuid().nullable(), createdAt: z.date(),
            })),
            requiredExecutionIds: z.array(z.string().uuid()),
            requiredSetVersion: z.string().nullable(),
            analysisState: AnalysisState,
            reportState: ReportState,
            completionState: CompletionState,
            pollingStop: PollingStop,
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
      const completion = await consultationRepository.findCompletionInput(
        request.params.id,
      );
      if (completion === null) {
        throw notFound("Consultation");
      }
      const states = computeConsultationStates(completion.input);
      const [feedback, reanalyses] = await Promise.all([
        prisma.clinicalFeedback.findMany({
          where: { consultationId: consultation.id, doctorId: subject.id },
        }),
        prisma.inference.findMany({
          where: { reanalysisOfId: { not: null }, image: { consultationId: consultation.id, consultation: { doctorId: subject.id } } },
          select: { id: true, imageId: true, reanalysisOfId: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        }),
      ]);

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
        requiredExecutionIds: [...completion.requiredExecutionIds],
        feedback: feedback.map(toFeedbackRead),
        reanalyses,
        requiredSetVersion: completion.requiredSetVersion,
        analysisState: states.analysisState,
        reportState: states.reportState,
        completionState: states.completionState,
        pollingStop: states.pollingStop,
      });
    }
  );
};
