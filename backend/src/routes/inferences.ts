import type { FastifyPluginAsync } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound, serviceUnavailable } from "../lib/http-error.js";
import type { PrismaClient } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { createConsultationRepository } from "../repositories/consultation.repo.js";
import { errorResponseSchema } from "../schemas/common.js";
import { PollingStop } from "../schemas/consultation.js";
import {
  DeliveryStateSchema,
  inferenceCreateSchema,
  jobAcceptedSchema,
} from "../schemas/inference.js";
import { parseArtifactLocation } from "../services/artifact-reference.js";
import type { ClinicalAccessService } from "../services/clinical-access.js";
import { subjectFromRequest } from "../services/clinical-access.js";
import {
  computeConsultationStates,
  computeExecutionDelivery,
  computeRetryAfterSeconds,
} from "../services/consultation-completion.js";
import { createInferenceCreationService } from "../services/inference-creation.js";
import { parseIdempotencyKey } from "../services/idempotency.js";
import type { ClinicalContextPreparer } from "../services/ml-client.js";
import type { AuthSessionService } from "../services/session.js";
import { StorageService, type ArtifactStoragePort } from "../services/storage.js";
import { enqueueInference } from "../workers/inference.queue.js";

export interface InferenceRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
  authService: Pick<AuthSessionService, "verifySession">;
  mlClient: ClinicalContextPreparer;
  databaseSchema?: string;
  /** Trusted storage seam; defaults to the backward-compatible facade. */
  storage?: ArtifactStoragePort;
}

export const inferenceRoutes: FastifyPluginAsync<InferenceRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, access } = opts;
  const storage = opts.storage ?? StorageService;
  const consultationRepository = createConsultationRepository(prisma);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  const resolveLocation = (
    reference: string,
    kind: "image" | "gradcam",
  ) => {
    try {
      return parseArtifactLocation(
        reference,
        storage.getArtifactReferenceContext(kind),
      );
    } catch {
      throw serviceUnavailable("Artifact reference is unavailable");
    }
  };

  const creation = createInferenceCreationService({
    prisma,
    access,
    authService: opts.authService,
    mlClient: opts.mlClient,
    databaseSchema: opts.databaseSchema,
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
      // Header validation runs after authenticate + requireRole preHandlers,
      // so 401/403 keep priority over the header's 400.
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const result = await creation.create({
        subject: subjectFromRequest(request),
        claims: request.user,
        idempotencyKey,
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
            status: z.string(),
            stage: z.string().nullable(),
            delivery: DeliveryStateSchema,
            pollingStop: PollingStop,
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

      const legacyConsultationId = inference.consultationId
        ? null
        : (
            await prisma.image.findUnique({
              where: { id: inference.imageId },
              select: { consultationId: true },
            })
          )?.consultationId ?? null;
      const consultationId = inference.consultationId ?? legacyConsultationId;
      const completion =
        consultationId === null
          ? null
          : await consultationRepository.findCompletionInput(consultationId);
      const execution =
        completion?.input.executions.find(
          (row) => row.inferenceId === inference.id,
        ) ??
        (await consultationRepository.findExecutionState(inference.id));
      if (execution === null) {
        throw serviceUnavailable("Inference delivery state is unavailable");
      }

      const delivery = computeExecutionDelivery(execution);
      const pollingStop =
        completion === null
          ? computeConsultationStates({
              requiredExecutionIds: [inference.id],
              executions: [execution],
            }).pollingStop
          : computeConsultationStates(completion.input).pollingStop;
      const status = inference.status ?? "QUEUED";
      const retryAfter = computeRetryAfterSeconds(status, pollingStop);
      if (retryAfter !== null) {
        reply.header("Retry-After", String(retryAfter));
      }

      return reply.send({
        id: inference.id,
        imageId: inference.imageId,
        predictedClass: inference.predictedClass,
        confidence: inference.confidence,
        probabilities: inference.probabilities as Record<string, unknown>,
        gradcamPath: redactGradcamPath ? null : inference.gradcamPath,
        modelVersion: inference.modelVersion,
        createdAt: inference.createdAt,
        status,
        stage: inference.status,
        delivery,
        pollingStop,
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

      const location = resolveLocation(inference.gradcamPath, "gradcam");
      const url = await storage.getDownloadUrl(
        location.bucketOrContainer,
        location.key,
        3600,
      );

      return reply.send({
        url,
        expiresIn: 3600,
      });
    }
  );
};
