import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { unauthorized } from "../lib/http-error.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  adminCreateUserRequestSchema,
  adminUpdateUserRequestSchema,
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
  adminUserListResponseSchema,
  adminUserResponseSchema,
  type AdminUserListResponse,
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

const TARGET_NOT_FOUND = {
  error: "NotFound",
  message: "User not found",
  statusCode: 404,
} as const;

const EMAIL_CONFLICT = {
  error: "Conflict",
  message: "A user with this email already exists",
  statusCode: 409,
} as const;

const LAST_ACTIVE_ADMIN = {
  error: "Conflict",
  message: "At least one active administrator is required",
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

function toListResponse(result: {
  items: AdminUserRecord[];
  total: number;
  limit: number;
  offset: number;
}): AdminUserListResponse {
  return {
    items: result.items.map(toResponse),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

function adminErrorMapping(error: unknown): {
  statusCode: number;
  body: typeof INPUT_INVALID | typeof ACCESS_DENIED | typeof TARGET_NOT_FOUND | typeof EMAIL_CONFLICT | typeof LAST_ACTIVE_ADMIN | typeof ADMINISTRATION_UNAVAILABLE;
} | null {
  if (!(error instanceof AdminUsersError)) {
    return null;
  }
  switch (error.code) {
    case "ADMIN_INPUT_INVALID":
      return { statusCode: 400, body: INPUT_INVALID };
    case "ADMIN_ACCESS_DENIED":
      return { statusCode: 403, body: ACCESS_DENIED };
    case "ADMIN_TARGET_NOT_FOUND":
      return { statusCode: 404, body: TARGET_NOT_FOUND };
    case "ADMIN_EMAIL_CONFLICT":
      return { statusCode: 409, body: EMAIL_CONFLICT };
    case "ADMIN_LAST_ACTIVE_ADMIN":
      return { statusCode: 409, body: LAST_ACTIVE_ADMIN };
    case "ADMIN_STORE_UNAVAILABLE":
    case "ADMIN_AUDIT_FAILED":
      return { statusCode: 503, body: ADMINISTRATION_UNAVAILABLE };
  }
}

function sendAdminError(reply: FastifyReply, error: unknown): FastifyReply {
  const mapped = adminErrorMapping(error);
  if (mapped === null) {
    throw error;
  }
  return reply.status(mapped.statusCode).send(mapped.body);
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
        return sendAdminError(reply, error);
      }
    },
  );

  typedApp.get(
    "/users",
    {
      preHandler: [authenticate, requireRole("ADMIN")],
      attachValidation: true,
      schema: {
        tags: ["Admin"],
        summary: "List user accounts (administrator only)",
        querystring: adminUserListQuerySchema,
        response: {
          200: adminUserListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
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
        const result = await app.adminUsersService.listUsers(request.query, actor);
        return reply.send(toListResponse(result));
      } catch (error) {
        return sendAdminError(reply, error);
      }
    },
  );

  typedApp.get(
    "/users/:id",
    {
      preHandler: [authenticate, requireRole("ADMIN")],
      attachValidation: true,
      schema: {
        tags: ["Admin"],
        summary: "Read a user account (administrator only)",
        params: adminUserIdParamsSchema,
        response: {
          200: adminUserResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
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
        const user = await app.adminUsersService.getUser(request.params.id, actor);
        return reply.send(toResponse(user));
      } catch (error) {
        return sendAdminError(reply, error);
      }
    },
  );

  typedApp.patch(
    "/users/:id",
    {
      preHandler: [authenticate, requireRole("ADMIN")],
      attachValidation: true,
      schema: {
        tags: ["Admin"],
        summary: "Update a user account state (administrator only)",
        params: adminUserIdParamsSchema,
        body: adminUpdateUserRequestSchema,
        response: {
          200: adminUserResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
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
        const updated = await app.adminUsersService.updateUser(
          request.params.id,
          request.body,
          actor,
        );
        return reply.send(toResponse(updated));
      } catch (error) {
        return sendAdminError(reply, error);
      }
    },
  );
}
