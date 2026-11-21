import type { FastifyReply, FastifyRequest } from "fastify";
import { serviceUnavailable, unauthorized } from "../lib/http-error.js";
import { JwtPayload } from "../schemas/auth.js";
import { parseVerifiedAccessTokenClaims } from "../services/auth-policy.js";
import { AuthSessionError } from "../services/session.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/**
 * preHandler: verifies the Bearer JWT cryptographically first (HS256, exp/iat
 * required), then validates the temporal policy and the durable session.
 *
 * Only a valid signature with the four principal claims reaches the store.
 * An invalid session is always a generic 401; an unavailable store is a safe
 * 503. The handler never writes lastUsedAt or revokes anything implicitly.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  let raw: unknown;
  try {
    raw = await request.jwtVerify();
  } catch {
    throw unauthorized();
  }

  const service = request.server.authService;
  if (!service) {
    throw serviceUnavailable("Authentication is temporarily unavailable");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = parseVerifiedAccessTokenClaims(
    raw,
    nowSeconds,
    service.accessTtlSeconds,
  );
  // Malformed claims share the same generic 401 as an invalid signature; no
  // account or claim detail is exposed on protected paths.
  if (claims === null) {
    throw unauthorized();
  }

  let principal;
  try {
    principal = await service.verifySession(claims);
  } catch (error) {
    if (error instanceof AuthSessionError && error.code === "AUTH_SESSION_INVALID") {
      throw unauthorized();
    }
    throw serviceUnavailable("Authentication is temporarily unavailable");
  }

  request.user = claims;
  request.authenticatedUser = principal;
}
