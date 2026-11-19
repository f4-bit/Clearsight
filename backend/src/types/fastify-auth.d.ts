import type { AuthSessionService, SafePrincipal } from "../services/session.js";

declare module "fastify" {
  interface FastifyInstance {
    authService: AuthSessionService;
  }

  interface FastifyRequest {
    authenticatedUser?: SafePrincipal;
  }
}
