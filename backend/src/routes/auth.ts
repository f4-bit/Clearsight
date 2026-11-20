import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { unauthorized } from "../lib/http-error.js";
import { authenticate } from "../middleware/auth.js";
import {
  currentUserSchema,
  forgotPasswordAcceptedSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  refreshResponseSchema,
  resetPasswordRequestSchema,
  tokenResponseSchema,
} from "../schemas/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
import {
  readRefreshCookie,
  serializeRefreshCookie,
  serializeRefreshCookieClear,
} from "../services/auth-cookies.js";
import { PasswordResetError } from "../services/password-reset.js";
import { AuthSessionError } from "../services/session.js";

/** Public self-registration is retired for security (REG-005). */
const PUBLIC_REGISTRATION_GONE = {
  error: "Gone",
  message: "Public registration has been retired",
  statusCode: 410,
} as const;

const INVALID_CREDENTIALS = {
  error: "Unauthorized",
  message: "Invalid credentials",
  statusCode: 401,
} as const;

const INVALID_SESSION = {
  error: "Unauthorized",
  message: "Invalid or expired session",
  statusCode: 401,
} as const;

/** One generic body for identifier lockout and the complementary IP quota. */
const LOGIN_THROTTLED = {
  error: "Too Many Requests",
  message: "Too many login attempts",
  statusCode: 429,
} as const;

const AUTHENTICATION_UNAVAILABLE = {
  error: "service_unavailable",
  message: "Authentication is temporarily unavailable",
  statusCode: 503,
} as const;

const PASSWORD_RECOVERY_THROTTLED = {
  error: "Too Many Requests",
  message: "Too many password recovery attempts",
  statusCode: 429,
} as const;

const PASSWORD_RECOVERY_INVALID = {
  error: "Bad Request",
  message: "Invalid password recovery request",
  statusCode: 400,
} as const;

const INVALID_RESET_TOKEN = {
  error: "Unauthorized",
  message: "Invalid or expired reset token",
  statusCode: 401,
} as const;

const PASSWORD_RECOVERY_UNAVAILABLE = {
  error: "service_unavailable",
  message: "Password recovery is temporarily unavailable",
  statusCode: 503,
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header("Cache-Control", "no-store");
}

async function requireWebOrigin(request: FastifyRequest): Promise<void> {
  request.server.webAuthPolicy.assertRequiredOrigin(request.headers);
}

async function optionalWebOrigin(request: FastifyRequest): Promise<void> {
  request.server.webAuthPolicy.assertOptionalOrigin(request.headers);
}

export async function authRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /auth/register — unconditionally retired. No body schema is installed
  // on purpose: any valid JSON shape gets the same 410 and malformed JSON is
  // rejected by the transport parser before any account logic could run.
  typedApp.post(
    "/register",
    {
      schema: {
        tags: ["Auth"],
        summary: "Public registration (retired)",
        response: {
          410: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      return reply.status(410).send(PUBLIC_REGISTRATION_GONE);
    }
  );

  // POST /auth/login
  typedApp.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Log in with email and password",
        body: loginRequestSchema,
        response: {
          200: tokenResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: [noStore, requireWebOrigin],
    },
    async (request, reply) => {
      try {
        const result = await app.authService.login(
          request.body,
          (claims, expiresInSeconds) => app.jwt.sign(claims, { expiresIn: expiresInSeconds }),
          { clientIp: request.ip }
        );

        // Explicit split: the JSON body never contains the opaque refresh
        // secret. Only the cookie carries it.
        reply.header(
          "Set-Cookie",
          serializeRefreshCookie(result.refreshToken, result.refreshMaxAgeSeconds),
        );
        return reply.send({
          accessToken: result.accessToken,
          tokenType: result.tokenType,
          expiresIn: result.expiresIn,
          user: result.user,
        });
      } catch (error) {
        if (error instanceof AuthSessionError) {
          if (error.code === "AUTH_INVALID_CREDENTIALS") {
            return reply.status(401).send(INVALID_CREDENTIALS);
          }
          if (error.code === "AUTH_LOGIN_THROTTLED") {
            // Retry-After is the stable remaining lock/window in whole seconds;
            // the body never carries account state, identifier or counter data.
            return reply
              .header("Retry-After", String(error.retryAfterSeconds ?? 1))
              .status(429)
              .send(LOGIN_THROTTLED);
          }
          // Store/sign/audit failures are safe and never expose driver output.
          return reply.status(503).send(AUTHENTICATION_UNAVAILABLE);
        }
        throw error;
      }
    }
  );

  // POST /auth/password/forgot — public, no session/cookie, uniform 202 after
  // the quota stage. The delivery port is DISABLED by default.
  typedApp.post(
    "/password/forgot",
    {
      schema: {
        tags: ["Auth"],
        summary: "Request a password-reset token",
        body: forgotPasswordRequestSchema,
        response: {
          202: forgotPasswordAcceptedSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: [noStore, optionalWebOrigin],
    },
    async (request, reply) => {
      try {
        await app.passwordResetService.forgot({
          email: request.body.email,
          clientIp: request.socket.remoteAddress ?? null,
        });
        return reply.status(202).send({ accepted: true });
      } catch (error) {
        if (error instanceof PasswordResetError) {
          if (error.code === "PASSWORD_RESET_THROTTLED") {
            return reply
              .header("Retry-After", String(error.retryAfterSeconds ?? 1))
              .status(429)
              .send(PASSWORD_RECOVERY_THROTTLED);
          }
          if (error.code === "PASSWORD_RESET_INVALID_INPUT") {
            return reply.status(400).send(PASSWORD_RECOVERY_INVALID);
          }
          return reply.status(503).send(PASSWORD_RECOVERY_UNAVAILABLE);
        }
        throw error;
      }
    },
  );

  // POST /auth/password/reset — token-only public endpoint, no session/cookie.
  // Invalid/expired/used/revoked/inactive all share one generic 401.
  typedApp.post(
    "/password/reset",
    {
      schema: {
        tags: ["Auth"],
        summary: "Reset a password with a single-use token",
        body: resetPasswordRequestSchema,
        response: {
          204: z.void(),
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: [noStore, optionalWebOrigin],
    },
    async (request, reply) => {
      try {
        await app.passwordResetService.reset({
          token: request.body.token,
          newPassword: request.body.newPassword,
          clientIp: request.socket.remoteAddress ?? null,
        });
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof PasswordResetError) {
          if (error.code === "PASSWORD_RESET_INVALID_INPUT") {
            return reply.status(400).send(PASSWORD_RECOVERY_INVALID);
          }
          if (error.code === "PASSWORD_RESET_INVALID_TOKEN") {
            return reply.status(401).send(INVALID_RESET_TOKEN);
          }
          if (error.code === "PASSWORD_RESET_THROTTLED") {
            return reply
              .header("Retry-After", String(error.retryAfterSeconds ?? 1))
              .status(429)
              .send(PASSWORD_RECOVERY_THROTTLED);
          }
          return reply.status(503).send(PASSWORD_RECOVERY_UNAVAILABLE);
        }
        throw error;
      }
    },
  );

  // POST /auth/refresh — cookie-only, no body and no Bearer.
  typedApp.post(
    "/refresh",
    {
      schema: {
        tags: ["Auth"],
        summary: "Rotate the opaque refresh cookie",
        response: {
          200: refreshResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: [noStore, requireWebOrigin],
    },
    async (request, reply) => {
      const rawRefreshToken = readRefreshCookie(request.headers);
      if (rawRefreshToken === null) {
        return reply.status(401).send(INVALID_SESSION);
      }

      try {
        const result = await app.authWebSessionService.refresh(
          rawRefreshToken,
          (claims, expiresInSeconds) =>
            app.jwt.sign(claims, { expiresIn: expiresInSeconds }),
        );
        reply.header(
          "Set-Cookie",
          serializeRefreshCookie(result.refreshToken, result.refreshMaxAgeSeconds),
        );
        return reply.send({
          accessToken: result.accessToken,
          tokenType: result.tokenType,
          expiresIn: result.expiresIn,
        });
      } catch (error) {
        if (error instanceof AuthSessionError) {
          if (error.code === "AUTH_SESSION_INVALID") {
            return reply.status(401).send(INVALID_SESSION);
          }
          return reply.status(503).send(AUTHENTICATION_UNAVAILABLE);
        }
        throw error;
      }
    }
  );

  // POST /auth/logout — Bearer authorization is mandatory; the cookie alone is
  // never sufficient. An Origin header, when present, passes the same guard.
  typedApp.post(
    "/logout",
    {
      schema: {
        tags: ["Auth"],
        summary: "Revoke the current session and clear the refresh cookie",
        response: {
          204: z.void(),
          401: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: [noStore, optionalWebOrigin],
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const principal = request.authenticatedUser;
      if (!principal) {
        throw unauthorized();
      }

      try {
        await app.authWebSessionService.logout(principal);
        reply.header("Set-Cookie", serializeRefreshCookieClear());
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof AuthSessionError) {
          if (error.code === "AUTH_SESSION_INVALID") {
            return reply.status(401).send(INVALID_SESSION);
          }
          return reply.status(503).send(AUTHENTICATION_UNAVAILABLE);
        }
        throw error;
      }
    }
  );

  // GET /auth/me
  typedApp.get(
    "/me",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Auth"],
        summary: "Get current logged-in user profile",
        response: {
          200: currentUserSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.authenticatedUser;
      if (!principal) {
        throw unauthorized();
      }

      return reply.send({
        id: principal.id,
        email: principal.email,
        role: principal.role,
      });
    }
  );
}
