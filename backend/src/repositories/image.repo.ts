import type { ImageCreate } from "../schemas/image.js";
import type { Db } from "./types.js";

export function createImageRepository(db: Db) {
  return {
    create: (input: ImageCreate) =>
      db.image.create({
        data: {
          consultationId: input.consultationId,
          eyeSide: input.eyeSide,
          storagePath: input.storagePath,
          hashMd5: input.hashMd5?.toLowerCase() ?? null,
        },
      }),

    findById: (id: string) => db.image.findUnique({ where: { id } }),

    listByConsultation: (consultationId: string) =>
      db.image.findMany({ where: { consultationId }, orderBy: { eyeSide: "asc" } }),

    /** Duplicate-upload detection. */
    findByHash: (hashMd5: string) =>
      db.image.findMany({ where: { hashMd5: hashMd5.toLowerCase() }, orderBy: { createdAt: "asc" } }),

    delete: (id: string) => db.image.delete({ where: { id } }),
  };
}
export type ImageRepository = ReturnType<typeof createImageRepository>;
