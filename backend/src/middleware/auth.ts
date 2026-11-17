import type { FastifyReply, FastifyRequest } from "fastify";
import { JwtPayload } from "../schemas/auth.js";
import { unauthorized } from "../lib/http-error.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/**
 * preHandler: verifies the Bearer JWT (HS256, JWT_SECRET) and exposes
 * `request.user = { sub, role }`. Stateless: it does not look the user up.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw unauthorized();
  }
  const parsed = JwtPayload.safeParse(request.user);
  if (!parsed.success) throw unauthorized("Token payload is not valid");
  request.user = parsed.data;
}
