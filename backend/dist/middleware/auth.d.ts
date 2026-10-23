import { FastifyReply, FastifyRequest } from "fastify";
import { Role } from "../schemas/auth.js";
declare module "@fastify/jwt" {
    interface FastifyJWT {
        payload: {
            id: string;
            email: string;
            role: Role;
        };
        user: {
            id: string;
            email: string;
            role: Role;
        };
    }
}
export declare function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function authorize(allowedRoles: Role[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
