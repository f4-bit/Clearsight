import { FastifyReply, FastifyRequest } from "fastify";
import { Role } from "../schemas/auth.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: string;
      email: string;
      role: Role;
    };
    user: {
      id: string;
      email: string;
      role: Role;
    };
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or missing bearer token",
      statusCode: 401,
    });
  }
}

export function authorize(allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "Authentication required",
        statusCode: 401,
      });
      return;
    }

    if (!allowedRoles.includes(request.user.role)) {
      reply.status(403).send({
        error: "Forbidden",
        message: `Role ${request.user.role} does not have access to this resource`,
        statusCode: 403,
      });
    }
  };
}
