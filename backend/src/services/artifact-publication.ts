import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../lib/prisma.js";
import {
  createArtifactPublicationRepository,
  type ArtifactPublicationRepository,
  type ArtifactPublicationRow,
  type PdfReportPublicationRow,
  type PublicationInference,
} from "../repositories/artifact-publication.repo.js";
import {
  ArtifactContentError,
  describeArtifactBytes,
  loadArtifactBytes,
  resolveArtifactContentLocation,
  type ArtifactContentEnv,
  type ArtifactContentKind,
} from "./artifact-content.js";
import {
  PdfReportError,
  renderBasicPdf,
  type RenderBasicPdfInput,
} from "./pdf-report.js";
import { StorageProviderError } from "./storage-provider.js";
import { StorageService } from "./storage.js";

type BinaryArtifactKind = "mask" | "overlay";
type RenderArtifactKind = "image" | "mask" | "overlay";

export interface ArtifactPublicationStoragePort {
  readonly storageId: string;
  loadBytes(reference: string, kind: ArtifactContentKind): Promise<Buffer>;
  upload(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
}

export interface ArtifactPublicationDeps {
  readonly repository: ArtifactPublicationRepository;
  readonly storage: ArtifactPublicationStoragePort;
  readonly contentEnv?: ArtifactContentEnv;
  /** PDF bucket; defaults to MINIO_BUCKET_PDF. Missing/blank fails closed. */
  readonly pdfBucket?: string | null;
  readonly renderPdf?: typeof renderBasicPdf;
  readonly now?: () => Date;
  readonly generateReportId?: () => string;
}

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly artifactType: string;
  readonly version: number;
  readonly status: string;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly failureCode: string | null;
  readonly retryable: boolean;
}

export interface PublishedPdfReport {
  readonly reportId: string;
  readonly inferenceId: string;
  readonly version: number;
  readonly status: "PENDING" | "AVAILABLE" | "FAILED";
  readonly dataVersion: string;
  readonly failureCode: string | null;
  readonly retryable: boolean;
}

export interface ArtifactPublicationResult {
  readonly inferenceId: string;
  readonly artifacts: readonly PublishedArtifact[];
  readonly report: PublishedPdfReport | null;
}

export interface ArtifactPublicationService {
  publish(inferenceId: string): Promise<ArtifactPublicationResult>;
}

export type ArtifactPublicationErrorCode =
  | "inference_not_found"
  | "publication_failed";

/** Safe service-level failure; no reference, key or storage detail is echoed. */
export class ArtifactPublicationError extends Error {
  readonly code: ArtifactPublicationErrorCode;

  constructor(code: ArtifactPublicationErrorCode) {
    super("Artifact publication failed");
    this.name = "ArtifactPublicationError";
    this.code = code;
  }
}

class PublicationArtifactFailure extends Error {
  readonly failureCode: string;
  readonly retryable: boolean;

  constructor(failureCode: string, retryable: boolean) {
    super("Artifact publication failed");
    this.name = "PublicationArtifactFailure";
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

interface LoadedRenderable {
  readonly bytes: Buffer;
  readonly size: number;
  readonly checksumSha256: string;
  readonly contentType: string;
}

interface ArtifactOutcome {
  readonly row: ArtifactPublicationRow;
  readonly bytes: Buffer | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForJson);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) {
        result[key] = normalizeForJson(entry);
      }
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

function computeDataVersion(content: unknown): string {
  return `pdfv1:${createHash("sha256")
    .update(canonicalJson(content))
    .digest("hex")}`;
}

/**
 * Placeholder for a retryable failure that happened before the content hash
 * could be computed. It is deterministic and non-empty because the schema
 * forbids NULL. A later successful retry replaces it while the report is
 * PENDING (narrow trigger migration), then finalizes AVAILABLE.
 */
function computePendingContentDataVersion(
  inferenceId: string,
  version: number,
): string {
  return computeDataVersion({
    inferenceId,
    version,
    state: "pending-content",
  });
}

function failureFromLoad(error: unknown): PublicationArtifactFailure {
  if (error instanceof PublicationArtifactFailure) {
    return error;
  }
  if (error instanceof ArtifactContentError) {
    switch (error.code) {
      case "artifact_content_invalid_config":
        return new PublicationArtifactFailure(
          "artifact_bucket_unconfigured",
          false,
        );
      case "artifact_content_missing":
        return new PublicationArtifactFailure("artifact_object_missing", true);
      case "artifact_content_empty":
        return new PublicationArtifactFailure("artifact_empty", true);
      case "artifact_content_too_large":
        return new PublicationArtifactFailure("artifact_too_large", false);
      case "artifact_content_invalid_reference":
        return new PublicationArtifactFailure(
          "artifact_reference_invalid",
          false,
        );
      case "artifact_content_invalid_content_type":
        return new PublicationArtifactFailure(
          "artifact_content_type_invalid",
          false,
        );
      case "artifact_content_read_failed":
        return new PublicationArtifactFailure("artifact_read_failed", true);
    }
  }
  if (error instanceof StorageProviderError) {
    if (error.code === "storage_object_missing") {
      return new PublicationArtifactFailure("artifact_object_missing", true);
    }
    if (error.code === "storage_permission_denied") {
      return new PublicationArtifactFailure(
        "storage_permission_denied",
        false,
      );
    }
    return new PublicationArtifactFailure("storage_unavailable", true);
  }
  return new PublicationArtifactFailure("artifact_publication_failed", true);
}

function failureFromPdf(error: unknown): PublicationArtifactFailure {
  if (error instanceof PublicationArtifactFailure) {
    return error;
  }
  if (error instanceof PdfReportError) {
    switch (error.code) {
      case "pdf_report_missing_artifact":
        return new PublicationArtifactFailure("artifact_missing", false);
      case "pdf_report_image_too_large":
        return new PublicationArtifactFailure("image_too_large", false);
      case "pdf_report_image_invalid":
        return new PublicationArtifactFailure("image_invalid", false);
      case "pdf_report_too_large":
        return new PublicationArtifactFailure("pdf_too_large", false);
      case "pdf_report_invalid_input":
        return new PublicationArtifactFailure("pdf_input_invalid", false);
      case "pdf_report_render_failed":
        return new PublicationArtifactFailure("pdf_render_failed", true);
    }
  }
  if (error instanceof ArtifactContentError) {
    return failureFromLoad(error);
  }
  if (error instanceof StorageProviderError) {
    if (error.code === "storage_object_missing") {
      return new PublicationArtifactFailure("artifact_object_missing", true);
    }
    if (error.code === "storage_permission_denied") {
      return new PublicationArtifactFailure(
        "storage_permission_denied",
        false,
      );
    }
    return new PublicationArtifactFailure("storage_upload_failed", true);
  }
  return new PublicationArtifactFailure("pdf_publication_failed", true);
}

function toPublishedArtifact(row: ArtifactPublicationRow): PublishedArtifact {
  return {
    artifactId: row.id,
    artifactType: row.artifactType,
    version: row.version,
    status: row.status,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    checksumSha256: row.checksumSha256,
    failureCode: row.failureCode,
    retryable: row.retryable,
  };
}

function toPublishedReport(
  row: PdfReportPublicationRow,
): PublishedPdfReport {
  return {
    reportId: row.id,
    inferenceId: row.inferenceId,
    version: row.version,
    status: row.status as PublishedPdfReport["status"],
    dataVersion: row.dataVersion,
    failureCode: row.artifact?.failureCode ?? null,
    retryable: row.artifact?.retryable ?? false,
  };
}

function artifactRowOrThrow(
  row: ArtifactPublicationRow | null,
  fallback: ArtifactPublicationRow,
): ArtifactPublicationRow {
  return row ?? fallback;
}

function buildRenderingInputs(input: {
  reportId: string;
  inferenceId: string;
  snapshotId: string;
  version: number;
  original: LoadedRenderable;
  mask: LoadedRenderable;
  overlay: LoadedRenderable;
}): Prisma.InputJsonValue {
  return {
    reportId: input.reportId,
    inferenceId: input.inferenceId,
    snapshotId: input.snapshotId,
    version: input.version,
    documentKind: "basic",
    rendererVersion: "pdf-report-v1",
    artifacts: {
      original: {
        size: input.original.size,
        checksumSha256: input.original.checksumSha256,
      },
      mask: {
        size: input.mask.size,
        checksumSha256: input.mask.checksumSha256,
      },
      overlay: {
        size: input.overlay.size,
        checksumSha256: input.overlay.checksumSha256,
      },
    },
  };
}

function buildDataVersionContent(input: {
  inference: PublicationInference;
  snapshot: NonNullable<PublicationInference["snapshot"]>;
  original: LoadedRenderable;
  mask: LoadedRenderable;
  overlay: LoadedRenderable;
}): unknown {
  return {
    renderer: "pdf-report-v1",
    snapshotId: input.snapshot.id,
    schemaVersion: input.snapshot.schemaVersion,
    snapshotModelVersions: input.snapshot.modelVersions,
    result: {
      predictedClass: input.inference.predictedClass,
      confidence: input.inference.confidence,
      probabilities: input.inference.probabilities,
      cdr: input.inference.cdr,
      cdrVertical: input.inference.cdrVertical,
      quality: input.inference.quality,
      elapsedSeconds: input.inference.elapsedSeconds,
      modelVersion: input.inference.modelVersion,
      modelVersions: input.inference.modelVersions,
      modelPredictions: input.inference.modelPredictions,
    },
    artifacts: {
      original: {
        size: input.original.size,
        checksumSha256: input.original.checksumSha256,
      },
      mask: {
        size: input.mask.size,
        checksumSha256: input.mask.checksumSha256,
      },
      overlay: {
        size: input.overlay.size,
        checksumSha256: input.overlay.checksumSha256,
      },
    },
  };
}

function buildPdfKey(inferenceId: string, version: number): string {
  return `${inferenceId}/v${version}.pdf`;
}

function resolvePdfBucket(configured: string | null | undefined): string {
  const bucket = configured === undefined ? env.MINIO_BUCKET_PDF : configured;
  if (typeof bucket !== "string" || bucket.trim().length === 0) {
    throw new PublicationArtifactFailure("pdf_bucket_unconfigured", false);
  }
  return bucket;
}

function modelVersionsForReport(inference: PublicationInference): Prisma.InputJsonObject {
  if (isRecord(inference.modelVersions)) {
    return inference.modelVersions as Prisma.InputJsonObject;
  }
  if (inference.snapshot !== null && isRecord(inference.snapshot.modelVersions)) {
    return inference.snapshot.modelVersions as Prisma.InputJsonObject;
  }
  return {};
}

function renderInputFor(input: {
  inference: PublicationInference;
  snapshot: NonNullable<PublicationInference["snapshot"]>;
  reportId: string;
  version: number;
  generatedAt: Date;
  original: LoadedRenderable;
  mask: LoadedRenderable;
  overlay: LoadedRenderable;
}): RenderBasicPdfInput {
  return {
    inference: {
      id: input.inference.id,
      consultationId: input.inference.consultationId,
      eyeSide: input.inference.eyeSide,
      predictedClass: input.inference.predictedClass,
      confidence: input.inference.confidence,
      probabilities: isRecord(input.inference.probabilities)
        ? (input.inference.probabilities as Record<string, number>)
        : null,
      cdr: input.inference.cdr,
      cdrVertical: input.inference.cdrVertical,
      quality: isRecord(input.inference.quality)
        ? input.inference.quality
        : null,
      elapsedSeconds: input.inference.elapsedSeconds,
      modelVersion: input.inference.modelVersion,
      modelVersions: isRecord(input.inference.modelVersions)
        ? input.inference.modelVersions
        : null,
      modelPredictions: isRecord(input.inference.modelPredictions)
        ? input.inference.modelPredictions
        : null,
      status: input.inference.status,
      createdAt: input.inference.createdAt,
    },
    snapshot: {
      consultationId: input.snapshot.consultationId,
      schemaVersion: input.snapshot.schemaVersion,
      rawPayload: input.snapshot.rawPayload,
      modelVersions: isRecord(input.snapshot.modelVersions)
        ? input.snapshot.modelVersions
        : null,
    },
    image: {
      storagePath: input.inference.image.storagePath,
      eyeSide: input.inference.eyeSide,
    },
    originalBytes: input.original.bytes,
    maskBytes: input.mask.bytes,
    overlayBytes: input.overlay.bytes,
    reportId: input.reportId,
    version: input.version,
    generatedAt: input.generatedAt,
    reviewRequired: input.inference.status === "REVIEW_REQUIRED",
  };
}

/**
 * Publishes mask/overlay, then renders/uploads/publishes the PDF and its
 * PdfReport. It never signs URLs, writes URLs to DB/logs or calls the ML.
 */
export function createArtifactPublicationService(
  deps: ArtifactPublicationDeps,
): ArtifactPublicationService {
  const now = deps.now ?? (() => new Date());
  const renderPdf = deps.renderPdf ?? renderBasicPdf;
  const generateReportId = deps.generateReportId ?? randomUUID;
  const contentEnv = deps.contentEnv;

  async function loadRenderable(
    reference: unknown,
    kind: RenderArtifactKind,
  ): Promise<LoadedRenderable> {
    if (typeof reference !== "string" || reference.trim().length === 0) {
      throw new PublicationArtifactFailure("artifact_missing", false);
    }
    const bytes = await deps.storage.loadBytes(reference, kind);
    const description = describeArtifactBytes(bytes);
    return {
      bytes,
      size: description.size,
      checksumSha256: description.checksumSha256,
      contentType: description.contentType,
    };
  }

  async function publishBinaryArtifact(
    inference: PublicationInference,
    kind: BinaryArtifactKind,
    reference: unknown,
  ): Promise<ArtifactOutcome> {
    const existing = await deps.repository.findArtifact(inference.id, kind, 1);
    if (existing !== null && existing.status === "AVAILABLE") {
      return { row: existing, bytes: null };
    }
    const artifact =
      existing ??
      (await deps.repository.ensurePendingArtifact({
        inferenceId: inference.id,
        artifactType: kind,
        version: 1,
      }));
    if (artifact.status === "AVAILABLE") {
      return { row: artifact, bytes: null };
    }

    if (typeof reference !== "string" || reference.trim().length === 0) {
      const failed = await deps.repository.markArtifactFailed(
        artifact.id,
        "artifact_missing",
        false,
      );
      return { row: artifactRowOrThrow(failed, artifact), bytes: null };
    }

    try {
      const location = resolveArtifactContentLocation(reference, kind, {
        env: contentEnv,
      });
      const bytes = await deps.storage.loadBytes(reference, kind);
      const description = describeArtifactBytes(bytes);
      const updated = await deps.repository.markArtifactAvailable(artifact.id, {
        storageId: location.storageId,
        bucketOrContainer: location.bucketOrContainer,
        key: location.key,
        contentType: description.contentType,
        sizeBytes: description.size,
        checksumSha256: description.checksumSha256,
        availableAt: now(),
      });
      return {
        row: artifactRowOrThrow(updated, artifact),
        bytes,
      };
    } catch (error) {
      const failure = failureFromLoad(error);
      const failed = await deps.repository.markArtifactFailed(
        artifact.id,
        failure.failureCode,
        failure.retryable,
      );
      return { row: artifactRowOrThrow(failed, artifact), bytes: null };
    }
  }

  async function publishFailedPdf(input: {
    inference: PublicationInference;
    latest: PdfReportPublicationRow | null;
    failure: PublicationArtifactFailure;
    additionalArtifacts?: readonly ArtifactPublicationRow[];
    dataVersion?: string;
    reportId?: string;
    version?: number;
  }): Promise<ArtifactPublicationResult> {
    const version =
      input.version ?? input.latest?.version ?? 1;
    const reportId = input.reportId ?? input.latest?.id ?? generateReportId();
    const dataVersion =
      input.dataVersion ??
      computePendingContentDataVersion(input.inference.id, version);

    const artifact = await deps.repository.ensurePendingArtifact({
      inferenceId: input.inference.id,
      artifactType: "pdf",
      version,
    });

    let report = await deps.repository.ensurePendingPdfReport({
      id: reportId,
      inferenceId: input.inference.id,
      version,
      sourceSnapshotId: input.inference.snapshotId,
      dataVersion,
      modelVersions: modelVersionsForReport(input.inference),
      // Neutral inputs: this row may be reused by a successful retry, so no
      // failure-specific or reference-bearing field is frozen here.
      renderingInputs: {
        inferenceId: input.inference.id,
        snapshotId: input.inference.snapshotId,
        reportId,
        version,
        documentKind: "basic",
        rendererVersion: "pdf-report-v1",
      },
    });

    if (report.status === "AVAILABLE") {
      return {
        inferenceId: input.inference.id,
        artifacts: [
          ...(input.additionalArtifacts ?? []).map(toPublishedArtifact),
          toPublishedArtifact(artifact),
        ],
        report: toPublishedReport(report),
      };
    }

    await deps.repository.finalizePdfFailed({
      artifactId: artifact.id,
      reportId: report.id,
      failureCode: input.failure.failureCode,
      retryable: input.failure.retryable,
    });

    const refreshed = await deps.repository.findLatestPdfReport(input.inference.id);
    report = refreshed?.version === version ? refreshed : report;

    return {
      inferenceId: input.inference.id,
      artifacts: [
        ...(input.additionalArtifacts ?? []).map(toPublishedArtifact),
        toPublishedArtifact(
          (await deps.repository.findArtifact(
            input.inference.id,
            "pdf",
            version,
          )) ?? artifact,
        ),
      ],
      report: toPublishedReport(report),
    };
  }

  return {
    async publish(inferenceId) {
      const inference = await deps.repository.findInference(inferenceId);
      if (inference === null) {
        throw new ArtifactPublicationError("inference_not_found");
      }

      const latest = await deps.repository.findLatestPdfReport(inference.id);
      if (latest !== null && latest.status === "AVAILABLE") {
        const rows = await Promise.all([
          deps.repository.findArtifact(inference.id, "mask", 1),
          deps.repository.findArtifact(inference.id, "overlay", 1),
          deps.repository.findArtifact(inference.id, "pdf", latest.version),
        ]);
        return {
          inferenceId: inference.id,
          artifacts: rows
            .filter((row): row is ArtifactPublicationRow => row !== null)
            .map(toPublishedArtifact),
          report: toPublishedReport(latest),
        };
      }

      const artifactsRecord = isRecord(inference.artifacts)
        ? inference.artifacts
        : null;
      const maskOutcome = await publishBinaryArtifact(
        inference,
        "mask",
        artifactsRecord?.mask,
      );
      const overlayOutcome = await publishBinaryArtifact(
        inference,
        "overlay",
        artifactsRecord?.overlay,
      );
      const binaryOutcomes = [maskOutcome, overlayOutcome];

      const failedBinary = binaryOutcomes.find(
        (outcome) => outcome.row.status !== "AVAILABLE",
      );
      if (failedBinary !== undefined) {
        const failure =
          failedBinary.row.failureCode === null
            ? new PublicationArtifactFailure("artifact_missing", false)
            : new PublicationArtifactFailure(
                failedBinary.row.failureCode,
                failedBinary.row.retryable,
              );
        return publishFailedPdf({
          inference,
          latest,
          failure,
          additionalArtifacts: binaryOutcomes.map((outcome) => outcome.row),
        });
      }

      if (inference.snapshot === null || inference.snapshotId === null) {
        return publishFailedPdf({
          inference,
          latest,
          failure: new PublicationArtifactFailure("snapshot_missing", false),
          additionalArtifacts: binaryOutcomes.map((outcome) => outcome.row),
        });
      }

      let original: LoadedRenderable;
      let mask: LoadedRenderable;
      let overlay: LoadedRenderable;
      try {
        original = await loadRenderable(inference.image.storagePath, "image");
        mask = await loadRenderable(artifactsRecord?.mask, "mask");
        overlay = await loadRenderable(artifactsRecord?.overlay, "overlay");
      } catch (error) {
        return publishFailedPdf({
          inference,
          latest,
          failure: failureFromPdf(error),
          additionalArtifacts: binaryOutcomes.map((outcome) => outcome.row),
        });
      }

      const dataVersion = computeDataVersion(
        buildDataVersionContent({
          inference,
          snapshot: inference.snapshot,
          original,
          mask,
          overlay,
        }),
      );

      const sameContent =
        latest !== null && latest.dataVersion === dataVersion;
      // A PENDING row belongs to an unfinished attempt, and a retryable FAILED
      // row is a transient failure: both must be reused instead of creating a
      // new version. Non-retryable failures remain explicit new attempts.
      const reusableFailure =
        latest !== null &&
        (latest.status === "PENDING" ||
          (latest.status === "FAILED" && latest.artifact?.retryable === true));
      const reused = latest !== null && (sameContent || reusableFailure);
      let version: number;
      let reportId: string;
      if (reused) {
        version = latest.version;
        reportId = latest.id;
      } else {
        version = (latest?.version ?? 0) + 1;
        reportId = generateReportId();
      }

      const renderingInputs = buildRenderingInputs({
        reportId,
        inferenceId: inference.id,
        snapshotId: inference.snapshot.id,
        version,
        original,
        mask,
        overlay,
      });

      const pdfArtifact = await deps.repository.ensurePendingArtifact({
        inferenceId: inference.id,
        artifactType: "pdf",
        version,
      });
      let report = await deps.repository.ensurePendingPdfReport({
        id: reportId,
        inferenceId: inference.id,
        version,
        sourceSnapshotId: inference.snapshot.id,
        dataVersion,
        modelVersions: modelVersionsForReport(inference),
        renderingInputs,
      });

      if (report.status === "AVAILABLE") {
        return {
          inferenceId: inference.id,
          artifacts: [
            ...binaryOutcomes.map((outcome) => toPublishedArtifact(outcome.row)),
            toPublishedArtifact(pdfArtifact),
          ],
          report: toPublishedReport(report),
        };
      }
      if (report.status === "FAILED") {
        await deps.repository.markPdfReportPending(report.id);
        report = { ...report, status: "PENDING", availableAt: null };
      }
      // A reused FAILED/PENDING row may carry the pending-content placeholder
      // and neutral rendering inputs. Refresh both provenance fields while the
      // row is PENDING, before finalizing AVAILABLE.
      if (reused || report.dataVersion !== dataVersion) {
        const changed = await deps.repository.updatePdfReportContent(
          report.id,
          dataVersion,
          renderingInputs,
        );
        if (!changed) {
          const refreshed = await deps.repository.findLatestPdfReport(
            inference.id,
          );
          if (
            refreshed !== null &&
            refreshed.version === report.version &&
            refreshed.status === "AVAILABLE"
          ) {
            return {
              inferenceId: inference.id,
              artifacts: [
                ...binaryOutcomes.map((outcome) =>
                  toPublishedArtifact(outcome.row),
                ),
                toPublishedArtifact(pdfArtifact),
              ],
              report: toPublishedReport(refreshed),
            };
          }
          return publishFailedPdf({
            inference,
            latest,
            failure: new PublicationArtifactFailure(
              "pdf_publication_failed",
              true,
            ),
            additionalArtifacts: binaryOutcomes.map((outcome) => outcome.row),
          });
        }
        report = { ...report, dataVersion };
      }

      const generatedAt = now();
      try {
        const pdfBuffer = await renderPdf(
          renderInputFor({
            inference,
            snapshot: inference.snapshot,
            reportId: report.id,
            version: report.version,
            generatedAt,
            original,
            mask,
            overlay,
          }),
        );
        const description = describeArtifactBytes(pdfBuffer);
        if (description.contentType !== "application/pdf") {
          throw new PublicationArtifactFailure(
            "pdf_content_type_invalid",
            false,
          );
        }
        const pdfBucket = resolvePdfBucket(deps.pdfBucket);
        const key = buildPdfKey(inference.id, report.version);
        await deps.storage.upload(
          pdfBucket,
          key,
          pdfBuffer,
          "application/pdf",
        );

        const finalized = await deps.repository.finalizePdfAvailable({
          artifactId: pdfArtifact.id,
          reportId: report.id,
          metadata: {
            storageId: deps.storage.storageId,
            bucketOrContainer: pdfBucket,
            key,
            contentType: description.contentType,
            sizeBytes: description.size,
            checksumSha256: description.checksumSha256,
            availableAt: generatedAt,
          },
        });
        if (finalized === null) {
          throw new PublicationArtifactFailure(
            "pdf_publication_failed",
            true,
          );
        }
        return {
          inferenceId: inference.id,
          artifacts: [
            ...binaryOutcomes.map((outcome) => toPublishedArtifact(outcome.row)),
            toPublishedArtifact(finalized.artifact),
          ],
          report: toPublishedReport(finalized.report),
        };
      } catch (error) {
        // A concurrent winner may already have committed the pair. Refresh
        // before any FAILED write so the loser never touches the winner.
        const winner = await deps.repository.findLatestPdfReport(inference.id);
        if (
          winner !== null &&
          winner.version === report.version &&
          winner.status === "AVAILABLE"
        ) {
          const winnerArtifact = await deps.repository.findArtifact(
            inference.id,
            "pdf",
            report.version,
          );
          return {
            inferenceId: inference.id,
            artifacts: [
              ...binaryOutcomes.map((outcome) =>
                toPublishedArtifact(outcome.row),
              ),
              toPublishedArtifact(winnerArtifact ?? pdfArtifact),
            ],
            report: toPublishedReport(winner),
          };
        }

        const failure = failureFromPdf(error);
        await deps.repository.finalizePdfFailed({
          artifactId: pdfArtifact.id,
          reportId: report.id,
          failureCode: failure.failureCode,
          retryable: failure.retryable,
        });
        const afterFailure = await deps.repository.findLatestPdfReport(
          inference.id,
        );
        report =
          afterFailure?.version === report.version ? afterFailure : report;
        return {
          inferenceId: inference.id,
          artifacts: [
            ...binaryOutcomes.map((outcome) => toPublishedArtifact(outcome.row)),
            toPublishedArtifact(
              (await deps.repository.findArtifact(
                inference.id,
                "pdf",
                report.version,
              )) ?? pdfArtifact,
            ),
          ],
          report: toPublishedReport(report),
        };
      }
    },
  };
}

/**
 * Production adapter: reads through the shared artifact seam and uploads
 * through the existing storage facade. No signed URLs are involved.
 */
export function createDefaultArtifactPublicationService(
  prisma: PrismaClient,
): ArtifactPublicationService {
  const repository = createArtifactPublicationRepository(prisma);
  return createArtifactPublicationService({
    repository,
    storage: {
      get storageId() {
        return StorageService.getStorageId();
      },
      loadBytes: (reference, kind) => loadArtifactBytes(reference, kind),
      upload: async (bucket, key, body, contentType) => {
        await StorageService.upload(bucket, key, body, contentType);
      },
    },
  });
}
