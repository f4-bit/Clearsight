import type { ConsultationCreate } from "../schemas/consultation.js";
import type { JobStatus } from "../schemas/common.js";
import type { ArtifactStatus } from "../schemas/inference.js";
import type {
  ConsultationCompletionInput,
  ExecutionCompletionInput,
} from "../services/consultation-completion.js";
import type { Db, JsonObject } from "./types.js";

interface ArtifactStateRow {
  readonly inferenceId: string;
  readonly artifactType: string;
  readonly version: number;
  readonly status: string;
  readonly retryable: boolean;
}

interface PdfReportStateRow {
  readonly inferenceId: string;
  readonly version: number;
  readonly status: string;
  readonly artifact: { readonly retryable: boolean } | null;
}

export interface ConsultationCompletionRecord {
  readonly requiredExecutionIds: readonly string[];
  readonly requiredSetVersion: string | null;
  readonly input: ConsultationCompletionInput;
}

export interface RequiredSelectionUpdate {
  readonly requiredExecutionIds: readonly string[];
  readonly requiredSetVersion: string;
  readonly requiredSetFrozenAt: Date;
}

function artifactState(row: ArtifactStateRow | undefined) {
  return {
    status: (row?.status as ArtifactStatus | undefined) ?? null,
    retryable: row?.retryable ?? false,
  };
}

function pickArtifact(
  rows: readonly ArtifactStateRow[],
  artifactType: string,
  version?: number,
): ArtifactStateRow | undefined {
  const matching = rows
    .filter((row) => row.artifactType === artifactType)
    .sort((left, right) => right.version - left.version);
  if (version !== undefined) {
    return matching.find((row) => row.version === version);
  }
  return matching[0];
}

function pickLatestReport(
  rows: readonly PdfReportStateRow[],
): PdfReportStateRow | undefined {
  return [...rows].sort((left, right) => right.version - left.version)[0];
}

function buildExecutionState(
  inferenceId: string,
  status: string | null,
  artifacts: readonly ArtifactStateRow[],
  reports: readonly PdfReportStateRow[],
): ExecutionCompletionInput {
  const latestReport = pickLatestReport(reports);
  const pdfArtifact = latestReport
    ? pickArtifact(artifacts, "pdf", latestReport.version)
    : pickArtifact(artifacts, "pdf");
  return {
    inferenceId,
    status,
    mask: artifactState(pickArtifact(artifacts, "mask")),
    overlay: artifactState(pickArtifact(artifacts, "overlay")),
    pdf: artifactState(pdfArtifact),
    pdfReport: {
      status: (latestReport?.status as ArtifactStatus | undefined) ?? null,
      retryable: latestReport?.artifact?.retryable ?? false,
    },
  };
}

export function createConsultationRepository(db: Db) {
  return {
    create: (input: ConsultationCreate) =>
      db.consultation.create({
        data: {
          patientId: input.patientId,
          status: input.status ?? "QUEUED",
          clinicalData: (input.clinicalData ?? {}) as JsonObject,
          doctorId: input.doctorId as string,
        },
      }),

    findById: (id: string) => db.consultation.findUnique({ where: { id } }),

    findWithImages: (id: string) =>
      db.consultation.findUnique({
        where: { id },
        include: { images: { orderBy: { eyeSide: "asc" }, include: { inferences: true } } },
      }),

    /**
     * Batch read for 2.3/2.6. It returns only statuses (no locators) and
     * represents every required id, including ids whose execution row is
     * missing. Artifact/PDF versions are collapsed to the latest relevant row.
     */
    findCompletionInput: async (
      id: string,
    ): Promise<ConsultationCompletionRecord | null> => {
      const consultation = await db.consultation.findUnique({
        where: { id },
        select: {
          requiredExecutionIds: true,
          requiredSetVersion: true,
        },
      });
      if (consultation === null) {
        return null;
      }
      const requiredExecutionIds = consultation.requiredExecutionIds;
      if (requiredExecutionIds.length === 0) {
        return {
          requiredExecutionIds,
          requiredSetVersion: consultation.requiredSetVersion,
          input: { requiredExecutionIds, executions: [] },
        };
      }

      const [inferences, artifacts, reports] = await Promise.all([
        db.inference.findMany({
          where: { id: { in: [...requiredExecutionIds] } },
          select: { id: true, status: true },
        }),
        db.artifactRecord.findMany({
          where: { inferenceId: { in: [...requiredExecutionIds] } },
          select: {
            inferenceId: true,
            artifactType: true,
            version: true,
            status: true,
            retryable: true,
          },
        }),
        db.pdfReport.findMany({
          where: { inferenceId: { in: [...requiredExecutionIds] } },
          select: {
            inferenceId: true,
            version: true,
            status: true,
            artifact: { select: { retryable: true } },
          },
        }),
      ]);

      const statusById = new Map(
        inferences.map((inference) => [inference.id, inference.status]),
      );
      const executions = requiredExecutionIds.map((inferenceId) =>
        buildExecutionState(
          inferenceId,
          statusById.get(inferenceId) ?? null,
          artifacts.filter(
            (artifact) => artifact.inferenceId === inferenceId,
          ),
          reports.filter((report) => report.inferenceId === inferenceId),
        ),
      );

      return {
        requiredExecutionIds,
        requiredSetVersion: consultation.requiredSetVersion,
        input: { requiredExecutionIds, executions },
      };
    },

    findExecutionState: async (
      inferenceId: string,
    ): Promise<ExecutionCompletionInput | null> => {
      const inference = await db.inference.findUnique({
        where: { id: inferenceId },
        select: { id: true, status: true },
      });
      if (inference === null) {
        return null;
      }
      const [artifacts, reports] = await Promise.all([
        db.artifactRecord.findMany({
          where: { inferenceId },
          select: {
            inferenceId: true,
            artifactType: true,
            version: true,
            status: true,
            retryable: true,
          },
        }),
        db.pdfReport.findMany({
          where: { inferenceId },
          select: {
            inferenceId: true,
            version: true,
            status: true,
            artifact: { select: { retryable: true } },
          },
        }),
      ]);
      return buildExecutionState(
        inference.id,
        inference.status,
        artifacts,
        reports,
      );
    },

    setRequiredSelection: (
      id: string,
      input: RequiredSelectionUpdate,
    ) =>
      db.consultation.update({
        where: { id },
        data: {
          requiredExecutionIds: [...input.requiredExecutionIds],
          requiredSetVersion: input.requiredSetVersion,
          requiredSetFrozenAt: input.requiredSetFrozenAt,
        },
        select: {
          id: true,
          requiredExecutionIds: true,
          requiredSetVersion: true,
          requiredSetFrozenAt: true,
        },
      }),

    listByDoctor: (doctorId: string, opts: { limit?: number; offset?: number; status?: JobStatus } = {}) =>
      db.consultation.findMany({
        where: { doctorId, ...(opts.status && { status: opts.status }) },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
      }),

    listByPatient: (patientId: string) =>
      db.consultation.findMany({ where: { patientId }, orderBy: { createdAt: "desc" } }),

    updateStatus: (id: string, status: JobStatus) =>
      db.consultation.update({ where: { id }, data: { status } }),

    updateClinicalData: (id: string, clinicalData: Record<string, unknown>) =>
      db.consultation.update({ where: { id }, data: { clinicalData: clinicalData as JsonObject } }),

    delete: (id: string) => db.consultation.delete({ where: { id } }),
  };
}
export type ConsultationRepository = ReturnType<typeof createConsultationRepository>;
