import {
  CLASS_LABEL_SET,
  canonicalClassIndex,
} from "../schemas/common.js";
import {
  CLINICAL_FEATURE_NAMES,
  ClinicalFeaturesSchema,
  type ClinicalFeatures,
} from "../schemas/clinical.js";
import type { JobResponse, ModelPrediction } from "../schemas/inference.js";
import type {
  InferenceRunExecution,
  InferenceRunRepository,
  TerminalInferenceUpdate,
} from "../repositories/inference-run.repo.js";
import {
  MlClientError,
  MlClientHttpError,
  type MlClient,
} from "../services/ml-client.js";
import {
  INFERENCE_MAX_POLLS,
  INFERENCE_POLL_INTERVAL_MS,
  isTerminalInferenceStatus,
  type InferenceJobData,
  type InferenceTerminalStatus,
} from "./inference.contracts.js";

export interface ProcessInferenceOutcome {
  inferenceId: string;
  status: InferenceTerminalStatus;
  skipped: boolean;
  finishedAt: string;
}

export interface InferenceProcessorDeps {
  db: InferenceRunRepository;
  mlClient: Pick<MlClient, "submitInference" | "getJobStatus">;
  /** Trusted signer backed by the same StorageService/allowlist as 4.1. */
  signMlDownloadUrl: (storagePath: string) => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export type InferenceProcessor = (
  data: InferenceJobData,
) => Promise<ProcessInferenceOutcome>;

export class InferenceRetryableError extends Error {
  constructor() {
    super("inference dispatch is retryable");
    this.name = "InferenceRetryableError";
  }
}

export class InferenceTerminalError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "InferenceTerminalError";
  }
}

class InvalidJobContextError extends Error {}
class InvalidResultError extends Error {}
class IdentityMismatchError extends Error {}

interface ResolvedJobContext {
  readonly clinicalFeatures: ClinicalFeatures;
  readonly eyeSide: "OD" | "OS";
  readonly expectedContext: InferenceJobData["expectedContext"] | null;
  readonly modelVersion: string | null;
  readonly snapshotModelVersions: Record<string, string> | null;
  readonly snapshotArtifactNames: string[];
}

export function createInferenceProcessor(
  deps: InferenceProcessorDeps,
): InferenceProcessor {
  const pollIntervalMs = deps.pollIntervalMs ?? INFERENCE_POLL_INTERVAL_MS;
  const maxPolls = deps.maxPolls ?? INFERENCE_MAX_POLLS;

  return async (data) => {
    const execution = await deps.db.findExecution(data.inferenceId);
    if (execution === null) {
      throw new InferenceTerminalError("execution_not_found");
    }
    if (isTerminalInferenceStatus(execution.status)) {
      return outcome(deps, execution.id, execution.status, true);
    }

    let context: ResolvedJobContext;
    try {
      context = resolveJobContext(data, execution);
    } catch (error) {
      if (error instanceof InvalidJobContextError) {
        // Reject before ML and do not touch existing evidence or status.
        throw new InferenceTerminalError("invalid_job_context");
      }
      throw error;
    }

    // A duplicate/racing worker may have finished during the previous step.
    const beforeSubmit = await deps.db.findExecution(execution.id);
    if (beforeSubmit === null) {
      throw new InferenceTerminalError("execution_not_found");
    }
    if (isTerminalInferenceStatus(beforeSubmit.status)) {
      return outcome(deps, beforeSubmit.id, beforeSubmit.status, true);
    }

    const imageUrl = await resolveImageUrl(deps, beforeSubmit, data);

    let accepted;
    try {
      accepted = await deps.mlClient.submitInference({
        inference_id: execution.id,
        image_url: imageUrl,
        eye_side: data.eyeSide,
        clinical_features: context.clinicalFeatures,
        model_version: context.modelVersion,
        expected_context: context.expectedContext
          ? {
              schema_version: context.expectedContext.schemaVersion,
              fingerprint_sha256: context.expectedContext.fingerprintSha256,
            }
          : undefined,
      });
    } catch (error) {
      return handleUpstreamError(error);
    }
    if (accepted.inferenceId !== execution.id) {
      throw new InferenceTerminalError("identity_mismatch");
    }

    let statusResponse: JobResponse;
    try {
      statusResponse = await deps.mlClient.getJobStatus(accepted.jobId);
    } catch (error) {
      return handleUpstreamError(error);
    }

    let polls = 0;
    while (!isTerminalInferenceStatus(statusResponse.status) && polls < maxPolls) {
      await deps.sleep(pollIntervalMs);
      try {
        statusResponse = await deps.mlClient.getJobStatus(accepted.jobId);
      } catch (error) {
        return handleUpstreamError(error);
      }
      polls += 1;
    }

    if (!isTerminalInferenceStatus(statusResponse.status)) {
      // Timeout is retryable; BullMQ persists FAILED only when attempts run out.
      throw new InferenceRetryableError();
    }

    const latest = await deps.db.findExecution(execution.id);
    if (latest === null) {
      throw new InferenceTerminalError("execution_not_found");
    }
    if (isTerminalInferenceStatus(latest.status)) {
      return outcome(deps, latest.id, latest.status, true);
    }

    const update = updateForTerminal(statusResponse, execution, context);
    return persistTerminal(deps, execution.id, update);
  };
}

function resolveJobContext(
  data: InferenceJobData,
  execution: InferenceRunExecution,
): ResolvedJobContext {
  if (execution.imageId !== data.imageId || execution.image.id !== data.imageId) {
    throw new InvalidJobContextError();
  }
  if (
    execution.image.eyeSide !== data.eyeSide ||
    (execution.eyeSide !== null && execution.eyeSide !== data.eyeSide)
  ) {
    throw new InvalidJobContextError();
  }

  const jobFeatures = ClinicalFeaturesSchema.safeParse(data.clinicalFeatures);
  if (!jobFeatures.success) {
    throw new InvalidJobContextError();
  }

  if (execution.snapshot === null) {
    // Legacy execution: no persisted pin and no snapshot to reconstruct.
    if (data.expectedContext !== undefined) {
      throw new InvalidJobContextError();
    }
    return {
      clinicalFeatures: jobFeatures.data,
      eyeSide: data.eyeSide,
      expectedContext: null,
      modelVersion: execution.modelVersion ?? data.modelVersion ?? null,
      snapshotModelVersions: null,
      snapshotArtifactNames: [],
    };
  }

  if (data.expectedContext === undefined) {
    throw new InvalidJobContextError();
  }
  const expected = data.expectedContext;
  const snapshot = execution.snapshot;
  if (snapshot.schemaVersion !== expected.schemaVersion) {
    throw new InvalidJobContextError();
  }

  const rawPayload = asRecord(snapshot.rawPayload);
  if (rawPayload === null) {
    throw new InvalidJobContextError();
  }
  if (
    rawPayload.eyeSide !== data.eyeSide ||
    (execution.eyeSide !== null && rawPayload.eyeSide !== execution.eyeSide) ||
    rawPayload.eyeSide !== execution.image.eyeSide
  ) {
    throw new InvalidJobContextError();
  }
  const snapshotFeatures = ClinicalFeaturesSchema.safeParse(
    rawPayload.clinicalFeatures,
  );
  if (!snapshotFeatures.success) {
    throw new InvalidJobContextError();
  }
  for (const name of CLINICAL_FEATURE_NAMES) {
    if (snapshotFeatures.data[name] !== jobFeatures.data[name]) {
      throw new InvalidJobContextError();
    }
  }

  const normalizedPayload = asRecord(snapshot.normalizedPayload);
  if (normalizedPayload === null) {
    throw new InvalidJobContextError();
  }
  if (normalizedPayload.contextFingerprintSha256 !== expected.fingerprintSha256) {
    throw new InvalidJobContextError();
  }
  const descriptor = asRecord(normalizedPayload.descriptor);
  const modelDescriptor = descriptor ? asRecord(descriptor.model) : null;
  const artifactDescriptor = modelDescriptor
    ? asRecord(modelDescriptor.artifacts)
    : null;
  if (artifactDescriptor === null) {
    throw new InvalidJobContextError();
  }
  const snapshotArtifactNames = Object.keys(artifactDescriptor);
  if (snapshotArtifactNames.length === 0) {
    throw new InvalidJobContextError();
  }

  const snapshotModelVersions = asStringRecord(snapshot.modelVersions);
  if (snapshotModelVersions === null) {
    throw new InvalidJobContextError();
  }
  const manifestVersion = snapshotModelVersions.manifest;
  if (
    typeof manifestVersion !== "string" ||
    manifestVersion === "" ||
    descriptor === null ||
    descriptor.schema_version !== expected.schemaVersion ||
    modelDescriptor === null ||
    modelDescriptor.manifest_version !== manifestVersion
  ) {
    throw new InvalidJobContextError();
  }
  if (data.modelVersion != null && data.modelVersion !== manifestVersion) {
    throw new InvalidJobContextError();
  }
  if (execution.modelVersion != null && execution.modelVersion !== manifestVersion) {
    throw new InvalidJobContextError();
  }
  for (const name of snapshotArtifactNames) {
    const version = snapshotModelVersions[name];
    if (typeof version !== "string" || version === "") {
      throw new InvalidJobContextError();
    }
  }

  return {
    clinicalFeatures: snapshotFeatures.data,
    eyeSide: data.eyeSide,
    expectedContext: expected,
    modelVersion: manifestVersion,
    snapshotModelVersions,
    snapshotArtifactNames,
  };
}

function updateForTerminal(
  statusResponse: JobResponse,
  execution: InferenceRunExecution,
  context: ResolvedJobContext,
): TerminalInferenceUpdate {
  if (statusResponse.status === "COMPLETED") {
    try {
      return completedUpdate(statusResponse, execution, context);
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        throw new InferenceTerminalError("identity_mismatch");
      }
      if (error instanceof InvalidResultError) {
        throw new InferenceTerminalError("invalid_result");
      }
      throw error;
    }
  }
  if (statusResponse.status === "REVIEW_REQUIRED") {
    try {
      return reviewUpdate(statusResponse, execution, context);
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        throw new InferenceTerminalError("identity_mismatch");
      }
      throw error;
    }
  }
  return failedTerminalUpdate();
}

function completedUpdate(
  statusResponse: JobResponse,
  execution: InferenceRunExecution,
  context: ResolvedJobContext,
): TerminalInferenceUpdate {
  const result = statusResponse.result;
  if (!result) throw new InvalidResultError();
  assertResultIdentity(result, execution, context.eyeSide);
  const predictedClass = canonicalClassIndex(result.label);
  if (predictedClass === null) throw new InvalidResultError();
  const confidence = finiteUnit(result.confidence);
  if (confidence === null) throw new InvalidResultError();
  const probabilities = parseProbabilities(result.probabilities, true);
  if (probabilities === null) throw new InvalidResultError();
  const quality = asRecord(result.quality);
  const artifacts = asStringRecord(result.artifacts);
  const modelVersions = asStringRecord(result.modelVersions);
  const modelPredictions = asModelPredictions(result.modelPredictions);
  if (
    quality === null ||
    artifacts === null ||
    modelVersions === null ||
    modelPredictions === null ||
    !versionsCompatible(modelVersions, context, true)
  ) {
    throw new InvalidResultError();
  }
  const cdr = finiteOrNull(result.cdr);
  const cdrVertical = finiteOrNull(result.cdrVertical);
  const elapsedSeconds = finiteNonNegative(result.elapsedSeconds);
  if (
    cdr === undefined ||
    cdrVertical === undefined ||
    elapsedSeconds === null
  ) {
    throw new InvalidResultError();
  }

  return {
    status: "COMPLETED",
    predictedClass,
    confidence,
    probabilities,
    modelVersions,
    modelPredictions,
    cdr,
    cdrVertical,
    quality,
    artifacts,
    elapsedSeconds,
    gradcamPath: artifactPath(artifacts, "gradcam"),
    modelVersion:
      context.modelVersion ??
      primaryVersion(modelVersions, execution.modelVersion),
  };
}

function reviewUpdate(
  statusResponse: JobResponse,
  execution: InferenceRunExecution,
  context: ResolvedJobContext,
): TerminalInferenceUpdate {
  const base: TerminalInferenceUpdate = {
    status: "REVIEW_REQUIRED",
    predictedClass: null,
    confidence: null,
    probabilities: {},
    modelVersions: {},
    modelPredictions: {},
    cdr: null,
    cdrVertical: null,
    quality: {},
    artifacts: {},
    elapsedSeconds: null,
    gradcamPath: null,
    modelVersion: context.modelVersion ?? execution.modelVersion,
  };
  const result = statusResponse.result;
  if (!result) return base;
  try {
    assertResultIdentity(result, execution, context.eyeSide);
  } catch (error) {
    if (error instanceof InvalidResultError) return base;
    throw error;
  }

  const probabilities = parseProbabilities(result.probabilities, false);
  const quality = asRecord(result.quality);
  const artifacts = asStringRecord(result.artifacts);
  const modelVersions = asStringRecord(result.modelVersions);
  const modelPredictions = asModelPredictions(result.modelPredictions);
  if (
    quality === null ||
    artifacts === null ||
    modelVersions === null ||
    !versionsCompatible(modelVersions, context, false)
  ) {
    return base;
  }

  const acceptedProbabilities = probabilities ?? {};
  const diagnosticsValid =
    probabilities !== null &&
    Object.keys(acceptedProbabilities).length > 0 &&
    modelPredictions !== null;
  return {
    ...base,
    predictedClass: diagnosticsValid
      ? canonicalClassIndex(result.label)
      : null,
    confidence: diagnosticsValid ? finiteUnit(result.confidence) : null,
    probabilities: acceptedProbabilities,
    modelVersions,
    modelPredictions: modelPredictions ?? {},
    cdr: nullable(finiteOrNull(result.cdr)),
    cdrVertical: nullable(finiteOrNull(result.cdrVertical)),
    quality,
    artifacts,
    elapsedSeconds: finiteNonNegative(result.elapsedSeconds),
    gradcamPath: artifactPath(artifacts, "gradcam"),
    modelVersion:
      context.modelVersion ??
      primaryVersion(modelVersions, execution.modelVersion),
  };
}

export function failedTerminalUpdate(): TerminalInferenceUpdate {
  return {
    status: "FAILED",
    predictedClass: null,
    confidence: null,
    probabilities: {},
    modelVersions: {},
    modelPredictions: {},
    cdr: null,
    cdrVertical: null,
    quality: {},
    artifacts: {},
    elapsedSeconds: null,
    gradcamPath: null,
  };
}

async function persistTerminal(
  deps: InferenceProcessorDeps,
  inferenceId: string,
  update: TerminalInferenceUpdate,
): Promise<ProcessInferenceOutcome> {
  const saved = await deps.db.saveTerminalResult(inferenceId, update);
  if (saved) {
    return outcome(deps, inferenceId, update.status, false);
  }
  const current = await deps.db.findExecution(inferenceId);
  if (current !== null && isTerminalInferenceStatus(current.status)) {
    return outcome(deps, current.id, current.status, true);
  }
  throw new InferenceTerminalError("terminal_conflict");
}

async function resolveImageUrl(
  deps: InferenceProcessorDeps,
  execution: InferenceRunExecution,
  data: InferenceJobData,
): Promise<string> {
  const storagePath = execution.image.storagePath;
  if (typeof storagePath === "string" && storagePath.trim() !== "") {
    try {
      return await deps.signMlDownloadUrl(storagePath);
    } catch {
      // Signing is retried; BullMQ writes FAILED only after attempts run out.
      throw new InferenceRetryableError();
    }
  }
  if (typeof data.imageUrl === "string" && data.imageUrl.trim() !== "") {
    return data.imageUrl;
  }
  throw new InferenceRetryableError();
}

function handleUpstreamError(error: unknown): never {
  if (isRetryableMlError(error)) {
    throw new InferenceRetryableError();
  }
  throw new InferenceTerminalError("ml_rejected");
}

function isRetryableMlError(error: unknown): boolean {
  if (error instanceof MlClientHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof MlClientError) {
    return true;
  }
  return true;
}

function outcome(
  deps: InferenceProcessorDeps,
  inferenceId: string,
  status: InferenceTerminalStatus,
  skipped: boolean,
): ProcessInferenceOutcome {
  return {
    inferenceId,
    status,
    skipped,
    finishedAt: deps.now().toISOString(),
  };
}

function assertResultIdentity(
  result: NonNullable<JobResponse["result"]>,
  execution: InferenceRunExecution,
  eyeSide: "OD" | "OS",
): void {
  if (result.inferenceId !== execution.id || result.eyeSide !== eyeSide) {
    throw new IdentityMismatchError();
  }
}

function parseProbabilities(
  probabilities: Record<string, number>,
  requireAll: boolean,
): Record<string, number> | null {
  const entries = Object.entries(probabilities);
  if (entries.length === 0) return requireAll ? null : {};
  const parsed: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (!CLASS_LABEL_SET.has(name) || finiteUnit(value) === null) {
      return null;
    }
    defineOwn(parsed, name, value);
  }
  if (requireAll && Object.keys(parsed).length !== CLASS_LABEL_SET.size) {
    return null;
  }
  return parsed;
}

function versionsCompatible(
  resultVersions: Record<string, string>,
  context: ResolvedJobContext,
  requireAll: boolean,
): boolean {
  if (context.snapshotModelVersions === null) return true;
  for (const name of context.snapshotArtifactNames) {
    const expected = context.snapshotModelVersions[name];
    const actual = resultVersions[name];
    if (actual === undefined) {
      if (requireAll) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

function primaryVersion(
  versions: Record<string, string>,
  fallback: string | null,
): string | null {
  return (
    versions.efficientnet_b3 ??
    versions.resnet50 ??
    versions.segmentation ??
    fallback ??
    null
  );
}

function artifactPath(
  artifacts: Record<string, string>,
  name: string,
): string | null {
  const value = artifacts[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteUnit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function finiteOrNull(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value ?? null;
  return Number.isFinite(value) ? value : undefined;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") return null;
    defineOwn(parsed, key, item);
  }
  return parsed;
}

function asModelPredictions(
  value: unknown,
): Record<string, ModelPrediction> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const parsed: Record<string, ModelPrediction> = {};
  for (const [name, item] of Object.entries(record)) {
    const prediction = asRecord(item);
    if (prediction === null) return null;
    const probabilityEntries = asFiniteNumberRecord(prediction.probabilities);
    if (probabilityEntries === null) return null;
    const probabilities = parseProbabilities(probabilityEntries, true);
    const predictedClass = prediction.predictedClass;
    const confidence = finiteUnit(prediction.confidence);
    if (
      probabilities === null ||
      typeof predictedClass !== "string" ||
      canonicalClassIndex(predictedClass) === null ||
      confidence === null
    ) {
      return null;
    }
    defineOwn(parsed, name, {
      probabilities,
      predictedClass,
      confidence,
    });
  }
  return parsed;
}

function asFiniteNumberRecord(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const parsed: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!isFiniteNumber(item)) return null;
    defineOwn(parsed, key, item);
  }
  return parsed;
}

function defineOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
