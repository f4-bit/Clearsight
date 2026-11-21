import type { FastifyInstance } from "fastify";

/**
 * Fastify's default 404 handler logs `Route <method>:<raw url> not found` as a
 * message string, which Pino path redaction cannot scrub. Install this generic
 * handler on the root instance before plugins/routes so unmatched paths and
 * unsupported methods keep the 404 status without echoing the URL/query.
 */
export const NOT_FOUND_BODY = {
  message: "Route not found",
  error: "Not Found",
  statusCode: 404,
} as const;

export function registerGenericNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ ...NOT_FOUND_BODY });
  });
}
