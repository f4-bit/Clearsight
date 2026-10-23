import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { currentUserSchema, loginRequestSchema, registerRequestSchema, tokenResponseSchema, } from "../schemas/auth.js";
import { errorResponseSchema } from "../schemas/common.js";
export async function authRoutes(app) {
    const typedApp = app.withTypeProvider();
    // POST /auth/register
    typedApp.post("/register", {
        schema: {
            tags: ["Auth"],
            summary: "Register a new clinical user",
            body: registerRequestSchema,
            response: {
                201: tokenResponseSchema,
                400: errorResponseSchema,
                409: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { email, password, role } = request.body;
        const existing = await prisma.user.findUnique({
            where: { email },
        });
        if (existing) {
            return reply.status(409).send({
                error: "Conflict",
                message: "User with this email already exists",
                statusCode: 409,
            });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                role,
            },
        });
        const accessToken = app.jwt.sign({ id: user.id, email: user.email, role: user.role }, { expiresIn: env.JWT_EXPIRES_IN });
        return reply.status(201).send({
            accessToken,
            tokenType: "bearer",
            expiresIn: env.JWT_EXPIRES_IN,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
            },
        });
    });
    // POST /auth/login
    typedApp.post("/login", {
        schema: {
            tags: ["Auth"],
            summary: "Log in with email and password",
            body: loginRequestSchema,
            response: {
                200: tokenResponseSchema,
                401: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
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
        const accessToken = app.jwt.sign({ id: user.id, email: user.email, role: user.role }, { expiresIn: env.JWT_EXPIRES_IN });
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
    });
    // GET /auth/me
    typedApp.get("/me", {
        preHandler: [authenticate],
        schema: {
            tags: ["Auth"],
            summary: "Get current logged-in user profile",
            response: {
                200: currentUserSchema,
                401: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        return reply.send(request.user);
    });
}
//# sourceMappingURL=auth.js.map