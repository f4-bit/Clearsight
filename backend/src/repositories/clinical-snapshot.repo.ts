import {
  ClinicalSnapshotCreateSchema,
  type ClinicalSnapshotCreate,
} from "../schemas/clinical.js";
import { Uuid } from "../schemas/common.js";
import type { Db, JsonObject } from "./types.js";

/**
 * Immutable clinical snapshots. The repository is internal (no HTTP ownership
 * checks) and accepts any `Db`, so the same instance works with the global
 * client or an interactive transaction. Normalization and model-version
 * resolution are deliberately out of scope here (task 2.2).
 */
export function createClinicalSnapshotRepository(db: Db) {
  return {
    /**
     * Validates before touching the database: structural shape plus deep JSON
     * values are checked, without normalizing or coercing either payload.
     * Returns the persisted Prisma row, not the caller's input object.
     */
    create: async (input: ClinicalSnapshotCreate) => {
      const snapshot = ClinicalSnapshotCreateSchema.parse(input);
      return db.clinicalSnapshot.create({
        data: {
          consultationId: snapshot.consultationId,
          rawPayload: snapshot.rawPayload as JsonObject,
          normalizedPayload: snapshot.normalizedPayload as JsonObject,
          schemaVersion: snapshot.schemaVersion,
          modelVersions: snapshot.modelVersions as JsonObject,
        },
      });
    },

    /** Invalid UUIDs and missing rows both resolve to `null`. */
    findById: (id: string) => {
      const parsed = Uuid.safeParse(id);
      return parsed.success
        ? db.clinicalSnapshot.findUnique({ where: { id: parsed.data } })
        : Promise.resolve(null);
    },
  };
}
export type ClinicalSnapshotRepository = ReturnType<typeof createClinicalSnapshotRepository>;
