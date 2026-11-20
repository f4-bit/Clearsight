import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  serviceUnavailable,
  unauthorized,
} from "../lib/http-error.js";
import type { PrismaClient } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import type { ArtifactReadRepository } from "../repositories/artifact.repo.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  ArtifactListQuerySchema,
  ArtifactListResponseSchema,
  ArtifactType,
  ArtifactUrlQuerySchema,
  ArtifactUrlSchema,
  type ArtifactRef,
} from "../schemas/inference.js";
import {
  mapArtifactRecordToRef,
  parseArtifactLocation,
  type ArtifactLocation,
} from "../services/artifact-reference.js";
import { withAuditedTransaction, writeAuditEvent } from "../services/audit.js";
import {
  subjectFromRequest,
  type ArtifactReadScope,
  type ClinicalAccessService,
  type ClinicalSubject,
} from "../services/clinical-access.js";
import { AuthSessionError, type AuthSessionService } from "../services/session.js";
import { StorageProviderError } from "../services/storage-provider.js";
import { StorageService, type ArtifactStoragePort } from "../services/storage.js";

const ARTIFACT_URL_AUDIT_ACTION = "ARTIFACT_URL_ISSUED";
const ARTIFACT_OBJECT_MISSING_ACTION = "ARTIFACT_OBJECT_MISSING";
const REPORT_NOT_AVAILABLE_ACTION = "REPORT_NOT_AVAILABLE";
const ARTIFACT_URL_REASON = "AUTHORIZED_READ";
const STORAGE_OBJECT_MISSING_REASON = "STORAGE_OBJECT_MISSING";
const REPORT_NOT_AVAILABLE_REASON = "REPORT_NOT_AVAILABLE";
const NO_STORE = "no-store";

export interface ArtifactRoutesOptions {
  prisma: PrismaClient;
  access: ClinicalAccessService;
  authService: Pick<AuthSessionService, "verifySession">;
  artifactReadRepository: ArtifactReadRepository;
  /** Trusted storage seam; defaults to the backward-compatible facade. */
  storage?: ArtifactStoragePort;
}

async function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply.header("Cache-Control", NO_STORE);
}

function parseListQuery(raw: unknown) {
  const parsed = ArtifactListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid artifact list query");
  }
  return parsed.data;
}

function parseUrlQuery(raw: unknown) {
  const parsed = ArtifactUrlQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("A positive artifact version is required");
  }
  return parsed.data;
}

function parseArtifactType(raw: unknown): ArtifactType {
  const parsed = ArtifactType.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Unsupported artifact type");
  }
  return parsed.data;
}

function toReference(
  row: Parameters<typeof mapArtifactRecordToRef>[0],
): ArtifactRef {
  try {
    return mapArtifactRecordToRef(row);
  } catch {
    throw serviceUnavailable("Artifact metadata is unavailable");
  }
}

/** Metadata DTO + structured 3.3 location, always before any SDK call. */
function resolveRowLocation(
  reference: ArtifactRef,
  storage: ArtifactStoragePort,
): ArtifactLocation {
  if (
    reference.status !== "AVAILABLE" ||
    reference.storageId === null ||
    reference.bucketOrContainer === null ||
    reference.key === null
  ) {
    throw serviceUnavailable("Artifact metadata is unavailable");
  }

  let context;
  try {
    context = storage.getArtifactRecordContext(reference.bucketOrContainer);
  } catch {
    throw serviceUnavailable("Artifact metadata is unavailable");
  }

  try {
    return parseArtifactLocation(
      {
        storageId: reference.storageId,
        bucketOrContainer: reference.bucketOrContainer,
        key: reference.key,
      },
      context,
    );
  } catch {
    throw serviceUnavailable("Artifact metadata is unavailable");
  }
}

/**
 * Fresh session/capability check after external I/O. A revoked session is a
 * 401 and a lost grant is a uniform 404, both before any URL/audit is returned.
 */
async function recheckFreshAccess(
  request: FastifyRequest,
  subject: ClinicalSubject,
  access: ClinicalAccessService,
  authService: Pick<AuthSessionService, "verifySession">,
  inferenceId: string,
  artifactType: ArtifactType,
): Promise<void> {
  let principal;
  try {
    principal = await authService.verifySession(request.user);
  } catch (error) {
    if (
      error instanceof AuthSessionError &&
      error.code === "AUTH_SESSION_INVALID"
    ) {
      throw unauthorized();
    }
    throw serviceUnavailable("Authentication is temporarily unavailable");
  }

  if (principal.id !== subject.id) {
    throw unauthorized();
  }

  const freshScope: ArtifactReadScope = await access.getArtifactReadScope(
    { id: principal.id, role: principal.role },
    inferenceId,
  );
  if (!freshScope.allowedTypes.includes(artifactType)) {
    throw notFound("Artifact");
  }
}

async function writeArtifactAudit(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    artifactId: string;
    action: string;
    outcome: "SUCCESS" | "FAILURE";
    reasonCode: string;
  },
): Promise<void> {
  await withAuditedTransaction(
    prisma,
    async (context) => {
      await writeAuditEvent(context, {
        actorKind: "USER",
        actorUserId: input.actorUserId,
        targetType: "ARTIFACT",
        targetId: input.artifactId,
        action: input.action,
        outcome: input.outcome,
        metadata: { reasonCode: input.reasonCode },
      });
    },
    { isolationLevel: "ReadCommitted" },
  );
}

async function auditIncident(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    artifactId: string;
    action: string;
    reasonCode: string;
  },
): Promise<void> {
  try {
    await writeArtifactAudit(prisma, { ...input, outcome: "FAILURE" });
  } catch {
    throw serviceUnavailable("Artifact incident could not be recorded");
  }
}

export const artifactRoutes: FastifyPluginAsync<ArtifactRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, access, artifactReadRepository } = opts;
  const storage = opts.storage ?? StorageService;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/:id/artifacts",
    {
      onRequest: [noStore, authenticate],
      schema: {
        tags: ["Artifacts"],
        summary: "List artifact references for an inference",
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: ArtifactListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = parseListQuery(request.query);
      const subject = subjectFromRequest(request);

      try {
        const scope = await access.getArtifactReadScope(
          subject,
          request.params.id,
        );
        let effectiveTypes: readonly ArtifactType[];
        if (query.type === undefined) {
          effectiveTypes = scope.allowedTypes;
        } else if (scope.allowedTypes.includes(query.type)) {
          effectiveTypes = [query.type];
        } else {
          effectiveTypes = [];
        }

        const result =
          effectiveTypes.length === 0
            ? { rows: [], total: 0 }
            : await artifactReadRepository.list(
                request.params.id,
                effectiveTypes,
                { limit: query.limit, offset: query.offset },
              );

        const items = result.rows.map((row) => ({
          artifactId: row.id,
          version: row.version,
          reference: toReference(row),
        }));

        return reply.send({
          items,
          total: result.total,
          limit: query.limit,
          offset: query.offset,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        throw serviceUnavailable("Artifact list is temporarily unavailable");
      }
    },
  );

  typedApp.get(
    "/:id/artifacts/:type/url",
    {
      onRequest: [noStore, authenticate],
      schema: {
        tags: ["Artifacts"],
        summary: "Get a fresh signed URL for an exact artifact version",
        params: z.object({ id: z.string().uuid(), type: z.string() }),
        response: {
          200: ArtifactUrlSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const artifactType = parseArtifactType(request.params.type);
      const query = parseUrlQuery(request.query);
      const subject = subjectFromRequest(request);

      try {
        const scope = await access.getArtifactReadScope(
          subject,
          request.params.id,
        );
        if (!scope.allowedTypes.includes(artifactType)) {
          throw notFound("Artifact");
        }

        const row = await artifactReadRepository.findExact(
          request.params.id,
          artifactType,
          query.version,
        );
        if (row === null) {
          throw notFound("Artifact");
        }
        const reference = toReference(row);

        let reportVersion: number | null = null;
        if (artifactType === "pdf") {
          const report = await artifactReadRepository.findPublishedPdfReport(
            request.params.id,
            row.version,
            row.id,
            scope.inference.snapshotId,
          );
          reportVersion = report?.version ?? null;
          if (reference.status === "AVAILABLE" && report === null) {
            await recheckFreshAccess(
              request,
              subject,
              access,
              opts.authService,
              request.params.id,
              artifactType,
            );
            await auditIncident(prisma, {
              actorUserId: subject.id,
              artifactId: row.id,
              action: REPORT_NOT_AVAILABLE_ACTION,
              reasonCode: REPORT_NOT_AVAILABLE_REASON,
            });
            throw conflict("Published PDF report is unavailable");
          }
        }

        if (reference.status !== "AVAILABLE") {
          return reply.send({
            artifactType: reference.artifactType,
            status: reference.status,
            url: null,
            expiresInSeconds: null,
            contentType: null,
            reportVersion,
          });
        }

        // DTO and the structured 3.3 location are validated before the SDK.
        const location = resolveRowLocation(reference, storage);
        const ttl = storage.getDownloadTtlSeconds();
        let url: string;
        try {
          url = await storage.getDownloadUrl(
            location.bucketOrContainer,
            location.key,
            ttl,
          );
        } catch (error) {
          if (
            error instanceof StorageProviderError &&
            error.code === "storage_object_missing"
          ) {
            await recheckFreshAccess(
              request,
              subject,
              access,
              opts.authService,
              request.params.id,
              artifactType,
            );
            await auditIncident(prisma, {
              actorUserId: subject.id,
              artifactId: row.id,
              action: ARTIFACT_OBJECT_MISSING_ACTION,
              reasonCode: STORAGE_OBJECT_MISSING_REASON,
            });
            throw conflict("Artifact object is unavailable");
          }
          throw serviceUnavailable(
            "Artifact download is temporarily unavailable",
          );
        }

        await recheckFreshAccess(
          request,
          subject,
          access,
          opts.authService,
          request.params.id,
          artifactType,
        );

        try {
          await writeArtifactAudit(prisma, {
            actorUserId: subject.id,
            artifactId: row.id,
            action: ARTIFACT_URL_AUDIT_ACTION,
            outcome: "SUCCESS",
            reasonCode: ARTIFACT_URL_REASON,
          });
        } catch {
          throw serviceUnavailable("Artifact audit is unavailable");
        }

        return reply.send({
          artifactType: reference.artifactType,
          status: reference.status,
          url,
          expiresInSeconds: ttl,
          contentType: reference.contentType,
          reportVersion,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        throw serviceUnavailable("Artifact download is temporarily unavailable");
      }
    },
  );
};
