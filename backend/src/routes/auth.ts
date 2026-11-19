import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { unauthorized } from "../lib/http-error.js";
import { authenticate } from "../middleware/auth.js";
import {
  currentUserSchema,
  loginRequestSchema,
  tokenResponseSchema,
} from "../schemas/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
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
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await app.authService.login(
          request.body,
          (claims, expiresInSeconds) => app.jwt.sign(claims, { expiresIn: expiresInSeconds }),
          { clientIp: request.ip }
        );
        return reply.send(result);
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
