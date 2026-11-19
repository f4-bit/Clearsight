import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { unauthorized } from "../lib/http-error.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  adminCreateUserRequestSchema,
  adminUserResponseSchema,
  type AdminUserResponse,
} from "../schemas/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  AdminUsersError,
  type AdminActor,
  type AdminUserRecord,
} from "../services/admin-users.js";

const INPUT_INVALID = {
  error: "validation_error",
  message: "Request validation failed",
  statusCode: 400,
} as const;

const ACCESS_DENIED = {
  error: "forbidden",
  message: "Forbidden",
  statusCode: 403,
} as const;

const EMAIL_CONFLICT = {
  error: "Conflict",
  message: "A user with this email already exists",
  statusCode: 409,
} as const;

const ADMINISTRATION_UNAVAILABLE = {
  error: "service_unavailable",
  message: "User administration is temporarily unavailable",
  statusCode: 503,
} as const;

/** Trusted principal from the authenticated middleware only, never the body. */
function actorFromRequest(request: FastifyRequest): AdminActor | null {
  const principal = request.authenticatedUser;
  if (principal) {
    return {
      userId: principal.id,
      role: principal.role,
      sessionId: principal.sessionId,
      tokenVersion: principal.tokenVersion,
    };
  }

  const claims = request.user;
  if (!claims) {
    return null;
  }
  return {
    userId: claims.sub,
    role: claims.role,
    sessionId: claims.sessionId,
    tokenVersion: claims.tokenVersion,
  };
}

function toResponse(user: AdminUserRecord): AdminUserResponse {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function adminRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/users",
    {
      preHandler: [authenticate, requireRole("ADMIN")],
      // Keep schema validation errors from becoming a generic Fastify body:
      // authenticated ADMIN callers get the same constant safe 400 as the
      // service, while unauthenticated/non-admin callers still fail in the
      // preHandlers first.
      attachValidation: true,
      schema: {
        tags: ["Admin"],
        summary: "Create a user account (administrator only)",
        body: adminCreateUserRequestSchema,
        response: {
          201: adminUserResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(INPUT_INVALID);
      }

      const actor = actorFromRequest(request);
      if (actor === null) {
        throw unauthorized();
      }

      try {
        const created = await app.adminUsersService.createUser(request.body, actor);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        if (error instanceof AdminUsersError) {
          switch (error.code) {
            case "ADMIN_INPUT_INVALID":
              return reply.status(400).send(INPUT_INVALID);
            case "ADMIN_ACCESS_DENIED":
              return reply.status(403).send(ACCESS_DENIED);
            case "ADMIN_EMAIL_CONFLICT":
              return reply.status(409).send(EMAIL_CONFLICT);
            case "ADMIN_STORE_UNAVAILABLE":
            case "ADMIN_AUDIT_FAILED":
              return reply.status(503).send(ADMINISTRATION_UNAVAILABLE);
          }
        }
        throw error;
      }
    },
  );
}
