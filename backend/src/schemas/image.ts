import { z } from "zod";
import { EyeSide, Uuid } from "./common.js";

export const ImageCreate = z.object({
  consultationId: Uuid,
  eyeSide: EyeSide,
  storagePath: z.string().min(1),
  hashMd5: z
    .string()
    .regex(/^[0-9a-f]{32}$/i)
    .nullish(),
});
export type ImageCreate = z.input<typeof ImageCreate>;
