import { isDeepStrictEqual } from "node:util";
import type { IdempotencyRecord } from "../generated/prisma/client.js";
import type { PrismaClient } from "../lib/prisma.js";
import { CLINICAL_FEATURE_NAMES, type ClinicalFeatures } from "../schemas/clinical.js";
import {
  assertPreparedSnapshotConsistent,
  PreparedClinicalSnapshotResponseSchema,
  type PreparedClinicalSnapshotResponse,
} from "../schemas/clinical-context.js";
import type { IdempotencyRepository } from "../repositories/idempotency.repo.js";
import {
  canonicalizeClinicalFeatures,
  IDEMPOTENCY_SCOPE,
  type AcceptedIdempotencyResponse,
} from "./idempotency.js";
import {
  isTerminalInferenceStatus,
  type InferenceJobData,
} from "../workers/inference.contracts.js";

export type DispatchFailureCode =
  | "not_pending"
  | "inconsistent_record"
  | "load_failed"
  | "sign_failed"
  | "enqueue_failed"
  | "mark_failed"
  | "dispatch_failed";

export class PendingExecutionError extends Error {
  constructor(readonly code: DispatchFailureCode) {
    super(code);
    this.name = "PendingExecutionError";
  }
}

export interface PendingExecution {
  readonly inference: {
    readonly id: string;
    readonly status: string | null;
  };
  readonly image: {
    readonly id: string;
    readonly consultationId: string;
    readonly eyeSide: "OD" | "OS";
    readonly storagePath: string;
  };
  readonly clinicalFeatures: ClinicalFeatures;
  readonly modelVersion: string;
  readonly expectedContext: {
    readonly schemaVersion: string;
    readonly fingerprintSha256: string;
  };
}

/**
 * Session-less validation shared by the authenticated resume path and the
 * background reconciler. It reads the trusted execution/snapshot/owner rows,
 * never request data, and throws a safe PendingExecutionError when the record
 * cannot be dispatched consistently.
 */
export async function loadPendingExecution(
  prisma: PrismaClient,
  record: IdempotencyRecord,
  expectedClinicalFeatures?: ClinicalFeatures,
): Promise<PendingExecution> {
  let inference;
  try {
    inference = await prisma.inference.findUnique({
      where: { id: record.inferenceId },
      include: {
        image: { include: { consultation: true } },
        snapshot: true,
        consultation: true,
      },
    });
  } catch {
    throw new PendingExecutionError("load_failed");
  }

  if (inference === null || inference.snapshot === null) {
    throw new PendingExecutionError("inconsistent_record");
  }
  const image = inference.image;
  const snapshot = inference.snapshot;
  const owner = inference.consultation ?? image.consultation;

  if (
    inference.id !== record.inferenceId ||
    record.scope !== IDEMPOTENCY_SCOPE ||
    record.actorUserId !== owner?.doctorId ||
    inference.imageId !== image.id ||
    inference.snapshotId !== snapshot.id ||
    inference.eyeSide !== image.eyeSide ||
    (inference.consultationId !== null &&
      inference.consultationId !== snapshot.consultationId) ||
    snapshot.consultationId !== image.consultationId
  ) {
    throw new PendingExecutionError("inconsistent_record");
  }

  const rawPayload = snapshot.rawPayload;
  if (
    rawPayload === null ||
    typeof rawPayload !== "object" ||
    Array.isArray(rawPayload)
  ) {
    throw new PendingExecutionError("inconsistent_record");
  }
  const raw = rawPayload as Record<string, unknown>;
  if (raw.eyeSide !== image.eyeSide) {
    throw new PendingExecutionError("inconsistent_record");
  }

  let clinicalFeatures: ClinicalFeatures;
  try {
    clinicalFeatures = canonicalizeClinicalFeatures(raw.clinicalFeatures);
  } catch {
    throw new PendingExecutionError("inconsistent_record");
  }
  if (expectedClinicalFeatures !== undefined) {
    for (const name of CLINICAL_FEATURE_NAMES) {
      if (clinicalFeatures[name] !== expectedClinicalFeatures[name]) {
        throw new PendingExecutionError("inconsistent_record");
      }
    }
  }

  const normalizedPayload = snapshot.normalizedPayload;
  if (
    normalizedPayload === null ||
    typeof normalizedPayload !== "object" ||
    Array.isArray(normalizedPayload)
  ) {
    throw new PendingExecutionError("inconsistent_record");
  }
  const normalized = normalizedPayload as Record<string, unknown>;
  if (normalized.eyeSide !== image.eyeSide) {
    throw new PendingExecutionError("inconsistent_record");
  }
  const { eyeSide: _storedEyeSide, ...preparedNormalized } = normalized;

  let prepared: PreparedClinicalSnapshotResponse;
  try {
    prepared = PreparedClinicalSnapshotResponseSchema.parse({
      rawCanonical: { clinicalFeatures },
      normalizedPayload: preparedNormalized,
      schemaVersion: snapshot.schemaVersion,
      modelVersions: snapshot.modelVersions,
      contextFingerprintSha256: preparedNormalized.contextFingerprintSha256,
    });
    assertPreparedSnapshotConsistent(prepared, clinicalFeatures);
  } catch {
    throw new PendingExecutionError("inconsistent_record");
  }

  if (!isDeepStrictEqual(snapshot.modelVersions, record.resolvedModelVersions)) {
    throw new PendingExecutionError("inconsistent_record");
  }
  const modelVersion = prepared.modelVersions.manifest;
  if (typeof modelVersion !== "string" || modelVersion.length === 0) {
    throw new PendingExecutionError("inconsistent_record");
  }

  return {
    inference: { id: inference.id, status: inference.status },
    image: {
      id: image.id,
      consultationId: image.consultationId,
      eyeSide: image.eyeSide as "OD" | "OS",
      storagePath: image.storagePath,
    },
    clinicalFeatures,
    modelVersion,
    expectedContext: {
      schemaVersion: prepared.schemaVersion,
      fingerprintSha256: prepared.contextFingerprintSha256,
    },
  };
}

export type DispatchPendingOutcome =
  | {
      readonly ok: true;
      readonly inferenceId: string;
      readonly alreadyTerminal: boolean;
    }
  | { readonly ok: false; readonly code: DispatchFailureCode };

export interface InferenceDispatchDeps {
  readonly prisma: PrismaClient;
  readonly repository: Pick<IdempotencyRepository, "markAccepted" | "findById">;
  readonly signMlDownloadUrl: (storagePath: string) => Promise<string>;
  readonly enqueue: (data: InferenceJobData) => Promise<{ id?: string }>;
}

export interface InferenceDispatchService {
  dispatchPendingExecution(record: IdempotencyRecord): Promise<DispatchPendingOutcome>;
}

export function createInferenceDispatchService(
  deps: InferenceDispatchDeps,
): InferenceDispatchService {
  return {
    async dispatchPendingExecution(record) {
      if (record.state !== "PENDING") {
        return { ok: false, code: "not_pending" };
      }

      let pending: PendingExecution;
      try {
        pending = await loadPendingExecution(deps.prisma, record);
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof PendingExecutionError
              ? error.code
              : "load_failed",
        };
      }

      const accepted = async (alreadyTerminal: boolean) => {
        const responseBody: AcceptedIdempotencyResponse = {
          inferenceId: pending.inference.id,
          jobId: pending.inference.id,
          status: "QUEUED",
        };
        try {
          const affected = await deps.repository.markAccepted(
            record.id,
            responseBody,
          );
          if (affected > 0) {
            return {
              ok: true as const,
              inferenceId: pending.inference.id,
              alreadyTerminal,
            };
          }
          const current = await deps.repository.findById(record.id);
          if (current !== null && current.state === "ACCEPTED") {
            return {
              ok: true as const,
              inferenceId: pending.inference.id,
              alreadyTerminal,
            };
          }
          return { ok: false as const, code: "mark_failed" as const };
        } catch {
          return { ok: false as const, code: "mark_failed" as const };
        }
      };

      if (isTerminalInferenceStatus(pending.inference.status)) {
        return accepted(true);
      }

      let imageUrl: string;
      try {
        imageUrl = await deps.signMlDownloadUrl(pending.image.storagePath);
      } catch {
        return { ok: false, code: "sign_failed" };
      }

      try {
        await deps.enqueue({
          inferenceId: pending.inference.id,
          imageId: pending.image.id,
          eyeSide: pending.image.eyeSide,
          clinicalFeatures: pending.clinicalFeatures,
          modelVersion: pending.modelVersion,
          expectedContext: pending.expectedContext,
        });
      } catch {
        return { ok: false, code: "enqueue_failed" };
      }

      return accepted(false);
    },
  };
}
