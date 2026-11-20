import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../lib/http-error.js";
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
import { createInferenceCreationService } from "../services/inference-creation.js";
import type { ClinicalContextPreparer } from "../services/ml-client.js";
import type { AuthSessionService } from "../services/session.js";
import { StorageService } from "../services/storage.js";
import { enqueueInference } from "../workers/inference.queue.js";

export interface InferenceRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
  authService: Pick<AuthSessionService, "verifySession">;
  mlClient: ClinicalContextPreparer;
  databaseSchema?: string;
}

export const inferenceRoutes: FastifyPluginAsync<InferenceRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, access } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const creation = createInferenceCreationService({
    prisma,
    access,
    authService: opts.authService,
    mlClient: opts.mlClient,
    databaseSchema: opts.databaseSchema,
    signMlDownloadUrl: async (storagePath) => {
      const [bucket = "", ...rest] = storagePath.split("/");
      return StorageService.getMlDownloadUrl(bucket, rest.join("/"));
    },
    enqueue: enqueueInference,
  });

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
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await creation.create({
        subject: subjectFromRequest(request),
        claims: request.user,
        imageId: request.body.imageId,
        eyeSide: request.body.eyeSide,
        clinicalFeatures: request.body.clinicalFeatures,
        modelVersion: request.body.modelVersion ?? null,
        reanalysisOf: request.body.reanalysisOf ?? null,
      });
      return reply.status(202).send(result);
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
