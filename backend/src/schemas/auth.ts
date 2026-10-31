import { z } from "zod";
import { UserRole } from "./common.js";

/** JWT payload shared by the auth routes (issuer) and the middleware (verifier). */
export const JwtPayload = z.object({
  sub: z.uuid(),
  role: UserRole,
});
export type JwtPayload = z.infer<typeof JwtPayload>;
