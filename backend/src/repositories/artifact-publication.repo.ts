import { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../lib/prisma.js";
import type { ArtifactType } from "../schemas/inference.js";

const ARTIFACT_PUBLICATION_SELECT = {
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
  availableAt: true,
} as const;

const TERMINAL_PUBLICATION_STATUSES = [
  "COMPLETED",
  "REVIEW_REQUIRED",
] as const;
const MAX_PUBLICATION_CANDIDATE_LIMIT = 100;

/**
 * A required binary artifact still needs publication when it has no row yet,
 * is PENDING (interrupted attempt) or is FAILED retryable. A permanent FAILED
 * row is deliberately excluded so the reconciler does not loop forever.
 */
function needsArtifact(type: ArtifactType): Prisma.InferenceWhereInput {
  return {
    OR: [
      { artifactRecords: { none: { artifactType: type } } },
      {
        artifactRecords: {
          some: { artifactType: type, status: "PENDING" },
        },
      },
      {
        artifactRecords: {
          some: {
            artifactType: type,
            status: "FAILED",
            retryable: true,
          },
        },
      },
    ],
  };
}

const PDF_REPORT_PUBLICATION_SELECT = {
  id: true,
  inferenceId: true,
  version: true,
  artifactId: true,
  sourceSnapshotId: true,
  status: true,
  dataVersion: true,
  modelVersions: true,
  renderingInputs: true,
  createdAt: true,
  availableAt: true,
  artifact: {
    select: {
      failureCode: true,
      retryable: true,
    },
  },
} as const;

export interface ArtifactPublicationRow {
  readonly id: string;
  readonly inferenceId: string;
  readonly artifactType: string;
  readonly version: number;
  readonly status: string;
  readonly storageId: string | null;
  readonly bucketOrContainer: string | null;
  readonly key: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: bigint | null;
  readonly checksumSha256: string | null;
  readonly failureCode: string | null;
  readonly retryable: boolean;
  readonly availableAt: Date | null;
}

export interface PdfReportPublicationRow {
  readonly id: string;
  readonly inferenceId: string;
  readonly version: number;
  readonly artifactId: string | null;
  readonly sourceSnapshotId: string | null;
  readonly status: string;
  readonly dataVersion: string;
  readonly modelVersions: Prisma.JsonValue;
  readonly renderingInputs: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly availableAt: Date | null;
  readonly artifact: { failureCode: string | null; retryable: boolean } | null;
}

export interface PublicationInference {
  readonly id: string;
  readonly consultationId: string | null;
  readonly eyeSide: string | null;
  readonly snapshotId: string | null;
  readonly imageId: string;
  readonly predictedClass: number | null;
  readonly confidence: number | null;
  readonly probabilities: Prisma.JsonValue;
  readonly cdr: number | null;
  readonly cdrVertical: number | null;
  readonly quality: Prisma.JsonValue;
  readonly elapsedSeconds: number | null;
  readonly modelVersion: string | null;
  readonly modelVersions: Prisma.JsonValue;
  readonly modelPredictions: Prisma.JsonValue;
  readonly artifacts: Prisma.JsonValue;
  readonly status: string | null;
  readonly createdAt: Date;
  readonly image: { readonly storagePath: string };
  readonly snapshot: {
    readonly id: string;
    readonly consultationId: string;
    readonly schemaVersion: string;
    readonly rawPayload: Prisma.JsonValue;
    readonly modelVersions: Prisma.JsonValue;
  } | null;
}

export interface ArtifactAvailableData {
  readonly storageId: string;
  readonly bucketOrContainer: string;
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly availableAt: Date;
}

export interface PendingPdfReportInput {
  readonly id: string;
  readonly inferenceId: string;
  readonly version: number;
  readonly sourceSnapshotId: string | null;
  readonly dataVersion: string;
  readonly modelVersions: Prisma.InputJsonValue;
  readonly renderingInputs: Prisma.InputJsonValue;
}

export interface FinalizePdfAvailableInput {
  readonly artifactId: string;
  readonly reportId: string;
  readonly metadata: ArtifactAvailableData;
}

export interface PdfReportListRow {
  readonly id: string;
  readonly inferenceId: string;
  readonly version: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly availableAt: Date | null;
  readonly artifact: { failureCode: string | null } | null;
}

export interface ArtifactPublicationRepository {
  /**
   * Bounded ids of terminal inferences whose required artifacts/report still
   * need publication or a retryable retry. It never returns raw result data.
   */
  findPublicationCandidates(limit: number): Promise<string[]>;
  findInference(inferenceId: string): Promise<PublicationInference | null>;
  findArtifact(
    inferenceId: string,
    artifactType: ArtifactType,
    version: number,
  ): Promise<ArtifactPublicationRow | null>;
  ensurePendingArtifact(input: {
    readonly inferenceId: string;
    readonly artifactType: ArtifactType;
    readonly version: number;
  }): Promise<ArtifactPublicationRow>;
  markArtifactAvailable(
    id: string,
    data: ArtifactAvailableData,
  ): Promise<ArtifactPublicationRow | null>;
  markArtifactFailed(
    id: string,
    failureCode: string,
    retryable: boolean,
  ): Promise<ArtifactPublicationRow | null>;
  findLatestPdfReport(
    inferenceId: string,
  ): Promise<PdfReportPublicationRow | null>;
  ensurePendingPdfReport(
    input: PendingPdfReportInput,
  ): Promise<PdfReportPublicationRow>;
  markPdfReportPending(id: string): Promise<boolean>;
  /** Allowed only while PENDING; refreshes data_version + rendering_inputs. */
  updatePdfReportContent(
    id: string,
    dataVersion: string,
    renderingInputs: Prisma.InputJsonValue,
  ): Promise<boolean>;
  finalizePdfAvailable(
    input: FinalizePdfAvailableInput,
  ): Promise<{
    readonly artifact: ArtifactPublicationRow;
    readonly report: PdfReportPublicationRow;
  } | null>;
  finalizePdfFailed(input: {
    readonly artifactId: string;
    readonly reportId: string;
    readonly failureCode: string;
    readonly retryable: boolean;
  }): Promise<void>;
  listPdfReports(inferenceId: string): Promise<PdfReportListRow[]>;
}

class PdfFinalizeConflict extends Error {
  constructor() {
    super("PDF report finalization conflict");
    this.name = "PdfFinalizeConflict";
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findArtifactById(
  db: PrismaClient,
  id: string,
): Promise<ArtifactPublicationRow | null> {
  return db.artifactRecord.findUnique({
    where: { id },
    select: ARTIFACT_PUBLICATION_SELECT,
  });
}

async function findPdfReportById(
  db: PrismaClient,
  id: string,
): Promise<PdfReportPublicationRow | null> {
  return db.pdfReport.findUnique({
    where: { id },
    select: PDF_REPORT_PUBLICATION_SELECT,
  });
}

/**
 * Write side of artifact publication. The 3.4 read repository stays separate
 * and read-only; this module owns row creation/transitions and report listing.
 */
export function createArtifactPublicationRepository(
  db: PrismaClient,
): ArtifactPublicationRepository {
  return {
    findPublicationCandidates: async (limit) => {
      if (!Number.isInteger(limit) || limit < 1) {
        return [];
      }
      const take = Math.min(limit, MAX_PUBLICATION_CANDIDATE_LIMIT);
      const rows = await db.inference.findMany({
        where: {
          status: { in: [...TERMINAL_PUBLICATION_STATUSES] },
          OR: [
            needsArtifact("mask"),
            needsArtifact("overlay"),
            needsArtifact("pdf"),
            // Repair a PDF AVAILABLE whose report row is missing. This is a
            // pair-consistency case, not a retry of a permanent failure.
            {
              AND: [
                { pdfReports: { none: {} } },
                {
                  artifactRecords: {
                    some: { artifactType: "pdf", status: "AVAILABLE" },
                  },
                },
              ],
            },
            { pdfReports: { some: { status: "PENDING" } } },
            {
              pdfReports: {
                some: {
                  status: "FAILED",
                  artifact: { is: { retryable: true } },
                },
              },
            },
          ],
        },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      });
      return rows.map((row) => row.id);
    },

    findInference: (inferenceId) =>
      db.inference.findUnique({
        where: { id: inferenceId },
        select: {
          id: true,
          consultationId: true,
          eyeSide: true,
          snapshotId: true,
          imageId: true,
          predictedClass: true,
          confidence: true,
          probabilities: true,
          cdr: true,
          cdrVertical: true,
          quality: true,
          elapsedSeconds: true,
          modelVersion: true,
          modelVersions: true,
          modelPredictions: true,
          artifacts: true,
          status: true,
          createdAt: true,
          image: { select: { storagePath: true } },
          snapshot: {
            select: {
              id: true,
              consultationId: true,
              schemaVersion: true,
              rawPayload: true,
              modelVersions: true,
            },
          },
        },
      }),

    findArtifact: (inferenceId, artifactType, version) =>
      db.artifactRecord.findUnique({
        where: {
          inferenceId_artifactType_version: {
            inferenceId,
            artifactType,
            version,
          },
        },
        select: ARTIFACT_PUBLICATION_SELECT,
      }),

    ensurePendingArtifact: async (input) => {
      try {
        return await db.artifactRecord.upsert({
          where: {
            inferenceId_artifactType_version: {
              inferenceId: input.inferenceId,
              artifactType: input.artifactType,
              version: input.version,
            },
          },
          create: {
            inferenceId: input.inferenceId,
            artifactType: input.artifactType,
            version: input.version,
            status: "PENDING",
          },
          update: {},
          select: ARTIFACT_PUBLICATION_SELECT,
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
        const row = await db.artifactRecord.findUnique({
          where: {
            inferenceId_artifactType_version: {
              inferenceId: input.inferenceId,
              artifactType: input.artifactType,
              version: input.version,
            },
          },
          select: ARTIFACT_PUBLICATION_SELECT,
        });
        if (row === null) {
          throw error;
        }
        return row;
      }
    },

    markArtifactAvailable: async (id, data) => {
      await db.artifactRecord.updateMany({
        where: { id, status: { not: "AVAILABLE" } },
        data: {
          status: "AVAILABLE",
          storageId: data.storageId,
          bucketOrContainer: data.bucketOrContainer,
          key: data.key,
          contentType: data.contentType,
          sizeBytes: BigInt(data.sizeBytes),
          checksumSha256: data.checksumSha256,
          failureCode: null,
          retryable: false,
          availableAt: data.availableAt,
        },
      });
      return findArtifactById(db, id);
    },

    markArtifactFailed: async (id, failureCode, retryable) => {
      await db.artifactRecord.updateMany({
        where: { id, status: { not: "AVAILABLE" } },
        data: {
          status: "FAILED",
          storageId: null,
          bucketOrContainer: null,
          key: null,
          contentType: null,
          sizeBytes: null,
          checksumSha256: null,
          failureCode,
          retryable,
          availableAt: null,
        },
      });
      return findArtifactById(db, id);
    },

    findLatestPdfReport: (inferenceId) =>
      db.pdfReport.findFirst({
        where: { inferenceId },
        orderBy: [{ version: "desc" }, { id: "asc" }],
        select: PDF_REPORT_PUBLICATION_SELECT,
      }),

    ensurePendingPdfReport: async (input) => {
      try {
        return await db.pdfReport.upsert({
          where: {
            inferenceId_version: {
              inferenceId: input.inferenceId,
              version: input.version,
            },
          },
          create: {
            id: input.id,
            inferenceId: input.inferenceId,
            version: input.version,
            sourceSnapshotId: input.sourceSnapshotId,
            status: "PENDING",
            documentKind: "basic",
            dataVersion: input.dataVersion,
            modelVersions: input.modelVersions,
            renderingInputs: input.renderingInputs,
          },
          update: {},
          select: PDF_REPORT_PUBLICATION_SELECT,
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
        const row = await db.pdfReport.findUnique({
          where: {
            inferenceId_version: {
              inferenceId: input.inferenceId,
              version: input.version,
            },
          },
          select: PDF_REPORT_PUBLICATION_SELECT,
        });
        if (row === null) {
          throw error;
        }
        return row;
      }
    },

    markPdfReportPending: async (id) => {
      const affected = await db.pdfReport.updateMany({
        where: { id, status: "FAILED" },
        data: { status: "PENDING", availableAt: null },
      });
      return affected.count > 0;
    },

    updatePdfReportContent: async (id, dataVersion, renderingInputs) => {
      const affected = await db.pdfReport.updateMany({
        where: { id, status: "PENDING" },
        data: { dataVersion, renderingInputs },
      });
      return affected.count > 0;
    },

    finalizePdfAvailable: async (input) => {
      try {
        return await db.$transaction(async (tx) => {
          await tx.artifactRecord.updateMany({
            where: { id: input.artifactId, status: { not: "AVAILABLE" } },
            data: {
              status: "AVAILABLE",
              storageId: input.metadata.storageId,
              bucketOrContainer: input.metadata.bucketOrContainer,
              key: input.metadata.key,
              contentType: input.metadata.contentType,
              sizeBytes: BigInt(input.metadata.sizeBytes),
              checksumSha256: input.metadata.checksumSha256,
              failureCode: null,
              retryable: false,
              availableAt: input.metadata.availableAt,
            },
          });
          const reportUpdate = await tx.pdfReport.updateMany({
            where: { id: input.reportId, status: "PENDING" },
            data: {
              status: "AVAILABLE",
              artifactId: input.artifactId,
              availableAt: input.metadata.availableAt,
            },
          });
          // Never commit a half-published pair. A concurrent FAILED transition
          // must roll back the artifact update above.
          if (reportUpdate.count !== 1) {
            throw new PdfFinalizeConflict();
          }

          const [artifact, report] = await Promise.all([
            tx.artifactRecord.findUnique({
              where: { id: input.artifactId },
              select: ARTIFACT_PUBLICATION_SELECT,
            }),
            tx.pdfReport.findUnique({
              where: { id: input.reportId },
              select: PDF_REPORT_PUBLICATION_SELECT,
            }),
          ]);
          if (artifact === null || report === null) {
            throw new PdfFinalizeConflict();
          }
          if (
            artifact.status !== "AVAILABLE" ||
            report.status !== "AVAILABLE"
          ) {
            throw new PdfFinalizeConflict();
          }
          if (
            artifact.storageId !== input.metadata.storageId ||
            artifact.bucketOrContainer !== input.metadata.bucketOrContainer ||
            artifact.key !== input.metadata.key ||
            artifact.contentType !== input.metadata.contentType ||
            artifact.sizeBytes !== BigInt(input.metadata.sizeBytes) ||
            artifact.checksumSha256 !== input.metadata.checksumSha256
          ) {
            // A concurrent winner published different bytes. Roll back instead
            // of freezing a report against a divergent artifact.
            throw new PdfFinalizeConflict();
          }
          return { artifact, report };
        });
      } catch (error) {
        if (error instanceof PdfFinalizeConflict) {
          return null;
        }
        throw error;
      }
    },

    finalizePdfFailed: async (input) => {
      await db.$transaction(async (tx) => {
        await tx.artifactRecord.updateMany({
          where: { id: input.artifactId, status: { not: "AVAILABLE" } },
          data: {
            status: "FAILED",
            storageId: null,
            bucketOrContainer: null,
            key: null,
            contentType: null,
            sizeBytes: null,
            checksumSha256: null,
            failureCode: input.failureCode,
            retryable: input.retryable,
            availableAt: null,
          },
        });
        await tx.pdfReport.updateMany({
          where: { id: input.reportId, status: { not: "AVAILABLE" } },
          data: {
            status: "FAILED",
            artifactId: input.artifactId,
            availableAt: null,
          },
        });
      });
    },

    listPdfReports: (inferenceId) =>
      db.pdfReport.findMany({
        where: { inferenceId },
        orderBy: [{ version: "desc" }, { id: "asc" }],
        select: {
          id: true,
          inferenceId: true,
          version: true,
          status: true,
          createdAt: true,
          availableAt: true,
          artifact: { select: { failureCode: true } },
        },
      }),
  };
}
