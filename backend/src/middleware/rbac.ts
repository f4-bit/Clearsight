import type { FastifyReply, FastifyRequest } from "fastify";
import { forbidden } from "../lib/http-error.js";
import type { UserRole } from "../schemas/common.js";

/** preHandler factory: use after `authenticate`. */
export function requireRole(...allowed: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!allowed.includes(request.user.role)) {
      throw forbidden(`Role ${request.user.role} is not allowed to perform this action`);
    }
  };
}
