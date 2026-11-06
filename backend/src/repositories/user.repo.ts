import type { UserRole } from "../generated/prisma/enums.js";
import type { Db } from "./types.js";

export interface UserCreateInput {
  email: string;
  passwordHash: string;
  fullName: string;
  role?: UserRole;
  isActive?: boolean;
}

export function createUserRepository(db: Db) {
  return {
    create: (data: UserCreateInput) =>
      db.user.create({ data: { ...data, email: data.email.trim().toLowerCase() } }),

    findById: (id: string) => db.user.findUnique({ where: { id } }),

    findByEmail: (email: string) =>
      db.user.findUnique({ where: { email: email.trim().toLowerCase() } }),

    list: (opts: { limit?: number; offset?: number; role?: UserRole } = {}) =>
      db.user.findMany({
        where: opts.role ? { role: opts.role } : undefined,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
      }),

    update: (
      id: string,
      data: Partial<Pick<UserCreateInput, "fullName" | "role" | "isActive" | "passwordHash">>,
    ) => db.user.update({ where: { id }, data }),

    /** Fails (FK RESTRICT) while the user still owns consultations or feedback: deactivate instead. */
    delete: (id: string) => db.user.delete({ where: { id } }),
  };
}
export type UserRepository = ReturnType<typeof createUserRepository>;
