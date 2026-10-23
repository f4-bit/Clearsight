import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, } from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { authRoutes } from "./routes/auth.js";
import { consultationRoutes } from "./routes/consultations.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { inferenceRoutes } from "./routes/inferences.js";
import { patientRoutes } from "./routes/patients.js";
import { healthResponseSchema } from "./schemas/common.js";
export async function buildApp() {
    const app = Fastify({
        logger: env.NODE_ENV === "development",
    }).withTypeProvider();
    // 1. Zod compiler setup
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // 2. Global plugins
    await app.register(fastifyCors, {
        origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN,
        credentials: true,
    });
    await app.register(fastifyMultipart, {
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB per retina image
        },
    });
    await app.register(fastifyJwt, {
        secret: env.JWT_SECRET,
    });
    // 3. Swagger / OpenAPI documentation
    await app.register(fastifySwagger, {
        openapi: {
            info: {
                title: "Clearsight Clinical API",
                description: "Ophthalmology platform for glaucoma detection from bilateral retinographies",
                version: "0.1.0",
            },
            servers: [
                {
                    url: `http://${env.HOST}:${env.PORT}`,
                    description: "Local development server",
                },
            ],
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: "http",
                        scheme: "bearer",
                        bearerFormat: "JWT",
                    },
                },
            },
        },
        transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, {
        routePrefix: "/docs",
        uiConfig: {
            docExpansion: "list",
            deepLinking: true,
        },
    });
    // 4. Global Error Handler
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError) {
            reply.status(400).send({
                error: "ValidationFailed",
                message: "Invalid request payload",
                statusCode: 400,
                issues: error.issues,
            });
            return;
        }
        const err = error;
        if (err.statusCode) {
            reply.status(err.statusCode).send({
                error: err.name || "HttpError",
                message: err.message ?? "Error",
                statusCode: err.statusCode,
            });
            return;
        }
        request.log.error(error);
        reply.status(500).send({
            error: "InternalServerError",
            message: "An unexpected error occurred",
            statusCode: 500,
        });
    });
    // 5. Health Check Route
    app.withTypeProvider().get("/health", {
        schema: {
            tags: ["System"],
            summary: "Service health check",
            response: {
                200: healthResponseSchema,
            },
        },
    }, async (_req, reply) => {
        return reply.send({
            status: "ok",
            service: "clearsight-backend",
            timestamp: new Date().toISOString(),
        });
    });
    // 6. API Routers
    await app.register(authRoutes, { prefix: "/auth" });
    await app.register(patientRoutes, { prefix: "/patients" });
    await app.register(consultationRoutes, { prefix: "/consultations" });
    await app.register(inferenceRoutes, { prefix: "/inferences" });
    await app.register(feedbackRoutes, { prefix: "/feedback" });
    return app;
}
//# sourceMappingURL=app.js.map