export async function authenticate(request, reply) {
    try {
        await request.jwtVerify();
    }
    catch (err) {
        reply.status(401).send({
            error: "Unauthorized",
            message: "Invalid or missing bearer token",
            statusCode: 401,
        });
    }
}
export function authorize(allowedRoles) {
    return async (request, reply) => {
        if (!request.user) {
            reply.status(401).send({
                error: "Unauthorized",
                message: "Authentication required",
                statusCode: 401,
            });
            return;
        }
        if (!allowedRoles.includes(request.user.role)) {
            reply.status(403).send({
                error: "Forbidden",
                message: `Role ${request.user.role} does not have access to this resource`,
                statusCode: 403,
            });
        }
    };
}
//# sourceMappingURL=auth.js.map