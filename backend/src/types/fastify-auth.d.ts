import type { AuthSessionService, SafePrincipal } from "../services/session.js";
import type { AuthWebSessionService } from "../services/auth-web-session.js";
import type { AdminUsersService } from "../services/admin-users.js";
import type { PasswordResetService } from "../services/password-reset.js";
import type { WebAuthPolicy } from "../services/web-auth-policy.js";

declare module "fastify" {
  interface FastifyInstance {
    authService: AuthSessionService;
    authWebSessionService: AuthWebSessionService;
    webAuthPolicy: WebAuthPolicy;
    adminUsersService: AdminUsersService;
    passwordResetService: PasswordResetService;
  }

  interface FastifyRequest {
    authenticatedUser?: SafePrincipal;
  }
}
