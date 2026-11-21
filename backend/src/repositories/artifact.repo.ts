import type { Prisma } from "../generated/prisma/client.js";
import type { ArtifactType } from "../schemas/inference.js";
import type { Db } from "./types.js";

/**
 * Read-only artifact/PDF access. The list applies the authorized type filter in
 * the SQL WHERE before ordering, pagination and count; `result` never reaches
 * this table because it remains the inline `Inference` projection.
 */
const ARTIFACT_READ_SELECT = {
  id: true,
  inferenceId: true,
  artifactType: true,
  version: true,
  status: true,
  storageId: true,
  bucketOrContainer: true,
  key: true,
  contentType: true,
  sizeBytes: true,
  checksumSha256: true,
  failureCode: true,
  retryable: true,
  updatedAt: true,
} as const;

export function createArtifactReadRepository(db: Db) {
  return {
    async list(
      inferenceId: string,
      allowedTypes: readonly ArtifactType[],
      opts: { limit: number; offset: number },
    ) {
      if (allowedTypes.length === 0) {
        return { rows: [], total: 0 };
      }

      const where: Prisma.ArtifactRecordWhereInput = {
        inferenceId,
        artifactType: { in: [...allowedTypes] },
      };
      const [rows, total] = await Promise.all([
        db.artifactRecord.findMany({
          where,
          select: ARTIFACT_READ_SELECT,
          orderBy: [
            { artifactType: "asc" },
            { version: "desc" },
            { id: "asc" },
          ],
          take: opts.limit,
          skip: opts.offset,
        }),
        db.artifactRecord.count({ where }),
      ]);
      return { rows, total };
    },

    /** Exact identity only; no implicit latest version and no old AVAILABLE fallback. */
    findExact(
      inferenceId: string,
      artifactType: ArtifactType,
      version: number,
    ) {
      return db.artifactRecord.findFirst({
        where: { inferenceId, artifactType, version },
        select: ARTIFACT_READ_SELECT,
      });
    },

    /**
     * A published report is only valid for the same inference/version/artifact
     * and the current inference snapshot. A null inference snapshot cannot have
     * a published report, so the query is skipped without inventing one.
     */
    findPublishedPdfReport(
      inferenceId: string,
      version: number,
      artifactId: string,
      sourceSnapshotId: string | null,
    ) {
      if (sourceSnapshotId === null) {
        return Promise.resolve(null);
      }
      return db.pdfReport.findFirst({
        where: {
          inferenceId,
          version,
          artifactId,
          sourceSnapshotId,
          status: "AVAILABLE",
        },
        select: { version: true },
      });
    },
  };
}

export type ArtifactReadRepository = ReturnType<
  typeof createArtifactReadRepository
>;
