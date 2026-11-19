import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { notFound, unprocessable } from "../lib/http-error.js";
import type { PrismaClient } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  inferenceCreateSchema,
  jobAcceptedSchema,
} from "../schemas/inference.js";
import type { ClinicalAccessService } from "../services/clinical-access.js";
import { subjectFromRequest } from "../services/clinical-access.js";
import { StorageService } from "../services/storage.js";
import { enqueueInference } from "../workers/inference.queue.js";

export interface InferenceRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
}

export const inferenceRoutes: FastifyPluginAsync<InferenceRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, access } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /inferences - Enqueue async inference job
  typedApp.post(
    "/",
    {
      preHandler: [authenticate, requireRole("OFTALMOLOGO")],
      schema: {
        tags: ["Inferences"],
        summary: "Dispatch asynchronous ML inference job via BullMQ",
        body: inferenceCreateSchema,
        response: {
          202: jobAcceptedSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const { imageId, eyeSide, clinicalFeatures, modelVersion } = request.body;

      // Ownership and laterality are checked before any DB write, signed URL or
      // queue dispatch. A foreign/missing image is a uniform 404.
      const { image: imageRecord } = await access.getOwnedImageContext(
        subject,
        imageId,
      );

      if (eyeSide !== imageRecord.eyeSide) {
        // The stored image lateral side is authoritative; never trust the body.
        throw unprocessable("eyeSide does not match the stored image laterality");
      }

      // The execution id is always server-generated. There is no client PK
      // idempotency in the current contract, so a supplied id can never probe
      // whether an execution exists in this or another case.
      const inferenceId = randomUUID();

      // 1. Create DB inference record
      await prisma.inference.create({
        data: {
          id: inferenceId,
          imageId,
          probabilities: {},
        },
      });

      // Update consultation status to QUEUED (ML job dispatched)
      await prisma.consultation.update({
        where: { id: imageRecord.consultationId },
        data: { status: "QUEUED" },
      });

      // 2. Generate presigned URL for the stored image (server-side only).
      const [bucket = "", ...rest] = imageRecord.storagePath.split("/");
      const key = rest.join("/");
      const imageUrl = await StorageService.getMlDownloadUrl(bucket, key);

      // 3. Enqueue job in BullMQ
      const job = await enqueueInference({
        inferenceId,
        imageId,
        imageUrl,
        eyeSide: imageRecord.eyeSide as "OD" | "OS",
        clinicalFeatures,
        modelVersion,
      });

      return reply.status(202).send({
        inferenceId,
        jobId: job.id ?? inferenceId,
        status: "QUEUED",
      });
    }
  );

  // GET /inferences/:id
  typedApp.get(
    "/:id",
    {
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
            probabilities: z.record(z.string(), z.unknown()),
            gradcamPath: z.string().nullable(),
            modelVersion: z.string().nullable(),
            createdAt: z.date().or(z.iso.datetime()),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      const { inference, redactGradcamPath } = await access.getInferenceForRead(
        subject,
        request.params.id,
        "readResult",
      );

      return reply.send({
        id: inference.id,
        imageId: inference.imageId,
        predictedClass: inference.predictedClass,
        confidence: inference.confidence,
        probabilities: inference.probabilities as Record<string, unknown>,
        gradcamPath: redactGradcamPath ? null : inference.gradcamPath,
        modelVersion: inference.modelVersion,
        createdAt: inference.createdAt,
      });
    }
  );

  // GET /inferences/:id/gradcam - Presigned URL for Grad-CAM overlay
  typedApp.get(
    "/:id/gradcam",
    {
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
    },
    async (request, reply) => {
      const subject = subjectFromRequest(request);
      // Non-doctors need the explicit artifact capability; a doctor that owns
      // the execution reads it directly.
      const { inference } = await access.getInferenceForRead(
        subject,
        request.params.id,
        "readArtifacts",
      );

      if (!inference.gradcamPath) {
        throw notFound("Grad-CAM visualization");
      }

      const [bucket = "", ...rest] = inference.gradcamPath.split("/");
      const key = rest.join("/");
      const url = await StorageService.getDownloadUrl(bucket, key, 3600);

      return reply.send({
        url,
        expiresIn: 3600,
      });
    }
  );
};
