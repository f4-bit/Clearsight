import bcrypt from "bcryptjs";
import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import {
  currentUserSchema,
  loginRequestSchema,
  tokenResponseSchema,
} from "../schemas/auth.js";
import { errorResponseSchema } from "../schemas/common.js";

/** Public self-registration is retired for security (REG-005). */
const PUBLIC_REGISTRATION_GONE = {
  error: "Gone",
  message: "Public registration has been retired",
  statusCode: 410,
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
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid credentials",
          statusCode: 401,
        });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid credentials",
          statusCode: 401,
        });
      }

      const accessToken = app.jwt.sign(
        { sub: user.id, role: user.role },
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      return reply.send({
        accessToken,
        tokenType: "bearer",
        expiresIn: env.JWT_EXPIRES_IN,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      });
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
        },
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user.sub },
      });

      if (!user) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "User no longer exists",
          statusCode: 401,
        });
      }

      return reply.send({
        id: user.id,
        email: user.email,
        role: user.role,
      });
    }
  );
}
