import type { AuthSessionService, SafePrincipal } from "../services/session.js";
import type { AdminUsersService } from "../services/admin-users.js";

declare module "fastify" {
  interface FastifyInstance {
    authService: AuthSessionService;
    adminUsersService: AdminUsersService;
  }

  interface FastifyRequest {
    authenticatedUser?: SafePrincipal;
  }
}
