import type { JwtPayload } from "../schemas/auth.js";
import type { ClinicalFeatures } from "../schemas/clinical.js";
import {
  assertPreparedSnapshotConsistent,
  PreparedClinicalSnapshotResponseSchema,
  PrepareClinicalSnapshotRequestSchema,
  type PreparedClinicalSnapshotResponse,
} from "../schemas/clinical-context.js";
import {
  conflict,
  forbidden,
  HttpError,
  notFound,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "../lib/http-error.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type {
  IdempotencyRecord,
  Prisma,
} from "../generated/prisma/client.js";
import type { PrismaClient } from "../lib/prisma.js";
import { createRepositories } from "../repositories/index.js";
import {
  createIdempotencyRepository,
  type IdempotencyRepository,
} from "../repositories/idempotency.repo.js";
import { AuthSessionError, type AuthSessionService, type SafePrincipal } from "./session.js";
import type { ClinicalAccessService, ClinicalSubject } from "./clinical-access.js";
import {
  buildIdempotencyPayloadHash,
  IDEMPOTENCY_SCOPE,
  parseAcceptedResponse,
  parseIdempotencyKey,
  type AcceptedIdempotencyResponse,
} from "./idempotency.js";
import {
  loadPendingExecution as loadPendingExecutionData,
  PendingExecutionError,
  type PendingExecution,
} from "./inference-dispatch.js";
import {
  MlClientHttpError,
  type ClinicalContextPreparer,
} from "./ml-client.js";
import {
  isTerminalInferenceStatus,
  type InferenceJobData,
} from "../workers/inference.contracts.js";

export interface InferenceCreationInput {
  subject: ClinicalSubject;
  claims: JwtPayload;
  idempotencyKey: string;
  imageId: string;
  eyeSide: "OD" | "OS";
  clinicalFeatures: ClinicalFeatures;
  modelVersion?: string | null;
  reanalysisOf?: string | null;
}

export interface InferenceCreationResult {
  inferenceId: string;
  jobId: string;
  status: "QUEUED";
}

export interface InferenceCreationDeps {
  prisma: PrismaClient;
  access: ClinicalAccessService;
  authService: Pick<AuthSessionService, "verifySession">;
  mlClient: ClinicalContextPreparer;
  enqueue: (data: InferenceJobData) => Promise<{ id?: string }>;
  databaseSchema?: string;
  now?: () => Date;
  /** Trusted seam for focused tests of durable idempotency failures. */
  idempotencyRepositoryFactory?: (
    db: PrismaClient | Prisma.TransactionClient,
    options: { databaseSchema?: string },
  ) => IdempotencyRepository;
}

interface ParentInferenceContext {
  readonly id: string;
  readonly consultationId: string | null;
  readonly eyeSide: string | null;
  readonly image: {
    readonly id: string;
    readonly consultationId: string;
    readonly eyeSide: string;
  } | null;
}

interface LockedImageContext {
  readonly id: string;
  readonly consultationId: string;
  readonly eyeSide: "OD" | "OS";
}

export interface InferenceCreationService {
  create(input: InferenceCreationInput): Promise<InferenceCreationResult>;
}

interface CreatedExecutionTx {
  readonly kind: "created";
  readonly inference: { readonly id: string };
  readonly image: LockedImageContext;
  readonly record: IdempotencyRecord;
}

interface ExistingExecutionTx {
  readonly kind: "existing";
  readonly record: IdempotencyRecord;
}

type ExecutionTxResult = CreatedExecutionTx | ExistingExecutionTx;

/** Unique-index final guard when the advisory lock is bypassed by a race. */
class IdempotencyRaceError extends Error {
  constructor() {
    super("idempotency race");
    this.name = "IdempotencyRaceError";
  }
}

export function createInferenceCreationService(
  deps: InferenceCreationDeps,
): InferenceCreationService {
  const databaseSchema = deps.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const now = deps.now ?? (() => new Date());

  const repositoryFactory =
    deps.idempotencyRepositoryFactory ?? createIdempotencyRepository;

  return {
    async create(input) {
      if (input.subject.role !== "OFTALMOLOGO") {
        throw forbidden("Clinical write requires the OFTALMOLOGO role");
      }
      const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
      const payloadHash = buildIdempotencyPayloadHash(input);
      const idempotencyRepository = repositoryFactory(deps.prisma, {
        databaseSchema,
      });

      // A durable replay is answered before ownership reads, ML prepare,
      // storage signing or queue dispatch.
      const existing = await findExistingIdempotencyRecord(
        idempotencyRepository,
        input.subject.id,
        idempotencyKey,
      );
      if (existing !== null) {
        return replayExisting(
          deps,
          repositoryFactory,
          databaseSchema,
          input,
          existing,
          payloadHash,
        );
      }

      // Ownership and laterality are decided before the slow ML call.
      const { image, consultation } = await deps.access.getOwnedImageContext(
        input.subject,
        input.imageId,
      );
      if (input.eyeSide !== image.eyeSide) {
        throw unprocessable("eyeSide does not match the stored image laterality");
      }
      if (image.consultationId !== consultation.id) {
        throw unprocessable("The image does not belong to the requested consultation");
      }

      const parent =
        input.reanalysisOf == null
          ? null
          : await loadParentForOwnership(input.subject, input.reanalysisOf, deps);
      if (parent !== null) {
        assertParentContext(parent, image);
      }

      const prepared = await prepareSnapshot(deps.mlClient, input);
      const freshPrincipal = await revalidatePrincipal(deps.authService, input);

      let result: ExecutionTxResult;
      try {
        result = await createExecutionTx(
          deps,
          databaseSchema,
          input,
          prepared,
          freshPrincipal,
          now,
          idempotencyKey,
          payloadHash,
          repositoryFactory,
        );
      } catch (error) {
        if (!(error instanceof IdempotencyRaceError)) {
          throw error;
        }
        const raced = await findExistingIdempotencyRecord(
          idempotencyRepository,
          input.subject.id,
          idempotencyKey,
        );
        if (raced !== null) {
          return replayExisting(
            deps,
            repositoryFactory,
            databaseSchema,
            input,
            raced,
            payloadHash,
          );
        }
        throw serviceUnavailable("Inference creation is temporarily unavailable");
      }

      if (result.kind === "existing") {
        return replayExisting(
          deps,
          repositoryFactory,
          databaseSchema,
          input,
          result.record,
          payloadHash,
        );
      }

      // The created path reconstructs the job from the immutable DB snapshot,
      // not from the prepared in-memory object. Both a first dispatch and any
      // later resume use exactly the same validation/signing/enqueue path.
      return dispatchPending(
        deps,
        repositoryFactory,
        databaseSchema,
        input,
        result.record,
      );
    },
  };
}

async function findExistingIdempotencyRecord(
  repository: IdempotencyRepository,
  actorUserId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  try {
    return await repository.findByActorScopeKey(
      actorUserId,
      IDEMPOTENCY_SCOPE,
      key,
    );
  } catch {
    throw serviceUnavailable("Idempotency store is temporarily unavailable");
  }
}

async function replayExisting(
  deps: InferenceCreationDeps,
  repositoryFactory: NonNullable<
    InferenceCreationDeps["idempotencyRepositoryFactory"]
  >,
  databaseSchema: string,
  input: InferenceCreationInput,
  record: IdempotencyRecord,
  payloadHash: string,
): Promise<InferenceCreationResult> {
  if (record.payloadHash !== payloadHash) {
    await authorizeReplay(deps, input, record);
    throw conflict("Idempotency-Key was already used with a different payload");
  }
  if (record.state === "ACCEPTED") {
    await authorizeReplay(deps, input, record);
    return parseAcceptedResponse(record);
  }
  if (record.state === "PENDING") {
    return dispatchPending(
      deps,
      repositoryFactory,
      databaseSchema,
      input,
      record,
    );
  }
  throw serviceUnavailable("Idempotency record is inconsistent");
}

async function authorizeReplay(
  deps: InferenceCreationDeps,
  input: InferenceCreationInput,
  record: IdempotencyRecord,
): Promise<SafePrincipal> {
  const principal = await revalidatePrincipal(deps.authService, input);
  if (principal.role !== "OFTALMOLOGO") {
    throw forbidden("Clinical write requires the OFTALMOLOGO role");
  }
  if (principal.id !== record.actorUserId) {
    throw notFound("Inference");
  }
  try {
    await deps.access.getInferenceForRead(
      { id: principal.id, role: principal.role },
      record.inferenceId,
      "readResult",
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw serviceUnavailable("Idempotency replay is temporarily unavailable");
  }
  return principal;
}

async function dispatchPending(
  deps: InferenceCreationDeps,
  repositoryFactory: NonNullable<
    InferenceCreationDeps["idempotencyRepositoryFactory"]
  >,
  databaseSchema: string,
  input: InferenceCreationInput,
  record: IdempotencyRecord,
): Promise<InferenceCreationResult> {
  if (record.state !== "PENDING") {
    if (record.state === "ACCEPTED") {
      await authorizeReplay(deps, input, record);
      return parseAcceptedResponse(record);
    }
    throw serviceUnavailable("Idempotency record is inconsistent");
  }

  // Fresh session/role/ownership before any signing or queue side effect.
  await authorizeReplay(deps, input, record);
  const pending = await loadPendingExecution(deps, input, record);

  // A terminal execution is proof that the original 202 must be accepted
  // without re-signing or re-enqueueing an already-consumed job.
  if (isTerminalInferenceStatus(pending.inference.status)) {
    return markAcceptedAndReturn(
      deps,
      repositoryFactory,
      databaseSchema,
      input,
      record,
      pending.inference.id,
    );
  }

  await enqueueOrPending(deps, {
    inferenceId: pending.inference.id,
    imageId: pending.image.id,
    eyeSide: pending.image.eyeSide,
    clinicalFeatures: pending.clinicalFeatures,
    modelVersion: pending.modelVersion,
    expectedContext: pending.expectedContext,
  });

  // The actor may have been revoked while signing/enqueueing. If so, leave the
  // record PENDING and let a later legitimate session resume it.
  await authorizeReplay(deps, input, record);

  return markAcceptedAndReturn(
    deps,
    repositoryFactory,
    databaseSchema,
    input,
    record,
    pending.inference.id,
  );
}

async function markAcceptedAndReturn(
  deps: InferenceCreationDeps,
  repositoryFactory: NonNullable<
    InferenceCreationDeps["idempotencyRepositoryFactory"]
  >,
  databaseSchema: string,
  input: InferenceCreationInput,
  record: IdempotencyRecord,
  inferenceId: string,
): Promise<AcceptedIdempotencyResponse> {
  const responseBody: AcceptedIdempotencyResponse = {
    inferenceId,
    jobId: inferenceId,
    status: "QUEUED",
  };
  const repository = repositoryFactory(deps.prisma, { databaseSchema });

  let affected: number;
  try {
    affected = await repository.markAccepted(record.id, responseBody);
  } catch {
    throw serviceUnavailable("Inference was created but dispatch is pending");
  }

  if (affected === 0) {
    let current: IdempotencyRecord | null;
    try {
      current = await repository.findById(record.id);
    } catch {
      throw serviceUnavailable("Inference was created but dispatch is pending");
    }
    if (current !== null && current.state === "ACCEPTED") {
      await authorizeReplay(deps, input, current);
      return parseAcceptedResponse(current);
    }
    throw serviceUnavailable("Inference was created but dispatch is pending");
  }
  return responseBody;
}

async function loadPendingExecution(
  deps: InferenceCreationDeps,
  input: InferenceCreationInput,
  record: IdempotencyRecord,
): Promise<PendingExecution> {
  try {
    return await loadPendingExecutionData(
      deps.prisma,
      record,
      input.clinicalFeatures,
    );
  } catch (error) {
    if (error instanceof PendingExecutionError && error.code !== "load_failed") {
      throw serviceUnavailable("Idempotency record is inconsistent");
    }
    throw serviceUnavailable("Idempotency replay is temporarily unavailable");
  }
}

async function loadParentForOwnership(
  subject: ClinicalSubject,
  parentId: string,
  deps: InferenceCreationDeps,
): Promise<ParentInferenceContext> {
  // Uniform 404 for foreign/missing parents before any ML call.
  await deps.access.getInferenceForRead(subject, parentId, "readResult");
  const parent = await deps.prisma.inference.findUnique({
    where: { id: parentId },
    include: { image: true },
  });
  if (parent === null) {
    throw notFound("Inference");
  }
  return {
    id: parent.id,
    consultationId: parent.consultationId,
    eyeSide: parent.eyeSide,
    image: parent.image
      ? {
          id: parent.image.id,
          consultationId: parent.image.consultationId,
          eyeSide: parent.image.eyeSide,
        }
      : null,
  };
}

function assertParentContext(
  parent: ParentInferenceContext,
  image: { consultationId: string; eyeSide: string },
): void {
  const parentConsultationId = parent.consultationId ?? parent.image?.consultationId;
  const parentEyeSide = parent.eyeSide ?? parent.image?.eyeSide;
  if (
    parentConsultationId === undefined ||
    parentEyeSide === undefined ||
    parentConsultationId !== image.consultationId ||
    parentEyeSide !== image.eyeSide
  ) {
    throw unprocessable("reanalysis must stay in the same consultation and eye context");
  }
}

async function prepareSnapshot(
  mlClient: ClinicalContextPreparer,
  input: InferenceCreationInput,
): Promise<PreparedClinicalSnapshotResponse> {
  const request = PrepareClinicalSnapshotRequestSchema.parse({
    clinical_features: input.clinicalFeatures,
    requested_model_version: input.modelVersion ?? null,
  });

  let raw: unknown;
  try {
    raw = await mlClient.prepareClinicalSnapshot(request);
  } catch (error) {
    if (error instanceof MlClientHttpError && error.status === 422) {
      throw unprocessable("Clinical snapshot input is not accepted");
    }
    throw serviceUnavailable("Clinical context preparation is unavailable");
  }

  try {
    const prepared = PreparedClinicalSnapshotResponseSchema.parse(raw);
    assertPreparedSnapshotConsistent(prepared, input.clinicalFeatures);
    return prepared;
  } catch {
    throw serviceUnavailable("Clinical context preparation is unavailable");
  }
}

async function revalidatePrincipal(
  authService: Pick<AuthSessionService, "verifySession">,
  input: InferenceCreationInput,
): Promise<SafePrincipal> {
  let principal: SafePrincipal;
  try {
    principal = await authService.verifySession(input.claims);
  } catch (error) {
    if (
      error instanceof AuthSessionError &&
      error.code === "AUTH_SESSION_INVALID"
    ) {
      throw unauthorized();
    }
    throw serviceUnavailable("Authentication is temporarily unavailable");
  }
  if (principal.id !== input.subject.id) {
    throw unauthorized();
  }
  return principal;
}

async function createExecutionTx(
  deps: InferenceCreationDeps,
  databaseSchema: string,
  input: InferenceCreationInput,
  prepared: PreparedClinicalSnapshotResponse,
  principal: SafePrincipal,
  now: () => Date,
  idempotencyKey: string,
  payloadHash: string,
  repositoryFactory: NonNullable<
    InferenceCreationDeps["idempotencyRepositoryFactory"]
  >,
): Promise<ExecutionTxResult> {
  try {
    return await deps.prisma.$transaction(async (tx) => {
      const idempotency = repositoryFactory(tx, { databaseSchema });
      // Serialize the whole create before taking the existing, ordered
      // principal/session/image/parent locks. The unique index is the final
      // guard if a race ever bypasses this advisory lock.
      await idempotency.lock(
        input.subject.id,
        IDEMPOTENCY_SCOPE,
        idempotencyKey,
      );
      await lockPrincipal(tx, databaseSchema, principal, now);
      // Mirror the trigger lock order: parent inference -> parent image -> child image.
      if (input.reanalysisOf != null) {
        await lockParentContext(tx, databaseSchema, input.reanalysisOf);
      }
      await lockImage(tx, databaseSchema, input.imageId);

      const existing = await idempotency.findByActorScopeKey(
        input.subject.id,
        IDEMPOTENCY_SCOPE,
        idempotencyKey,
      );
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) {
          throw conflict(
            "Idempotency-Key was already used with a different payload",
          );
        }
        return { kind: "existing", record: existing };
      }

      const repos = createRepositories(tx);
      const lockedImage = await tx.image.findFirst({
        where: {
          id: input.imageId,
          consultation: { doctorId: principal.id },
        },
        include: { consultation: true },
      });
      if (lockedImage === null) {
        throw notFound("Image");
      }
      if (lockedImage.eyeSide !== input.eyeSide) {
        throw unprocessable("eyeSide does not match the stored image laterality");
      }

      if (input.reanalysisOf != null) {
        const lockedParent = await tx.inference.findFirst({
          where: {
            id: input.reanalysisOf,
            image: { consultation: { doctorId: principal.id } },
          },
          include: { image: true },
        });
        if (lockedParent === null) {
          throw notFound("Inference");
        }
        assertParentContext(
          {
            id: lockedParent.id,
            consultationId: lockedParent.consultationId,
            eyeSide: lockedParent.eyeSide,
            image: lockedParent.image
              ? {
                  id: lockedParent.image.id,
                  consultationId: lockedParent.image.consultationId,
                  eyeSide: lockedParent.image.eyeSide,
                }
              : null,
          },
          lockedImage,
        );
      }

      const snapshot = await repos.snapshots.create({
        consultationId: lockedImage.consultationId,
        rawPayload: {
          eyeSide: lockedImage.eyeSide,
          clinicalFeatures: input.clinicalFeatures,
        },
        normalizedPayload: {
          ...prepared.normalizedPayload,
          eyeSide: lockedImage.eyeSide,
        },
        schemaVersion: prepared.schemaVersion,
        modelVersions: prepared.modelVersions,
      });

      const inference = await repos.inferences.create({
        imageId: lockedImage.id,
        consultationId: lockedImage.consultationId,
        eyeSide: lockedImage.eyeSide as "OD" | "OS",
        snapshotId: snapshot.id,
        reanalysisOfId: input.reanalysisOf ?? null,
        status: "QUEUED",
        modelVersion: prepared.modelVersions.manifest,
      });

      const record = await idempotency.createPending({
        actorUserId: principal.id,
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        payloadHash,
        inferenceId: inference.id,
        resolvedModelVersions: prepared.modelVersions,
      });

      return {
        kind: "created",
        inference: { id: inference.id },
        image: {
          id: lockedImage.id,
          consultationId: lockedImage.consultationId,
          eyeSide: lockedImage.eyeSide as "OD" | "OS",
        },
        record,
      };
    });
  } catch (error) {
    mapContextRaceError(error);
  }
}

function mapContextRaceError(error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }
  const code = extractPostgresCode(error);
  if (code === "23503" || code === "P2003") {
    throw notFound("Inference");
  }
  if (code === "23514" || code === "23001") {
    throw unprocessable("Inference context is no longer valid");
  }
  if (code === "23505" || code === "P2002") {
    throw new IdempotencyRaceError();
  }
  if (code !== null) {
    throw serviceUnavailable("Inference creation is temporarily unavailable");
  }
  throw error;
}

function extractPostgresCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (typeof meta?.code === "string") return meta.code;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function lockPrincipal(
  tx: Prisma.TransactionClient,
  schema: string,
  principal: SafePrincipal,
  now: () => Date,
): Promise<void> {
  const users = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      role: string;
      is_active: boolean;
      token_version: number;
    }>
  >(
    `SELECT id, role, is_active, token_version FROM "${schema}".users WHERE id = $1::uuid FOR SHARE`,
    principal.id,
  );
  const user = users[0];
  if (
    user === undefined ||
    !user.is_active ||
    user.role !== principal.role ||
    user.token_version !== principal.tokenVersion
  ) {
    throw unauthorized();
  }

  const sessions = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      user_id: string;
      issued_token_version: number;
      expires_at: Date | string;
      revoked_at: Date | string | null;
    }>
  >(
    `SELECT id, user_id, issued_token_version, expires_at, revoked_at FROM "${schema}".user_sessions WHERE id = $1::uuid FOR SHARE`,
    principal.sessionId,
  );
  const session = sessions[0];
  if (
    session === undefined ||
    session.user_id !== principal.id ||
    session.revoked_at !== null ||
    session.issued_token_version !== principal.tokenVersion ||
    new Date(session.expires_at).getTime() <= now().getTime()
  ) {
    throw unauthorized();
  }
}

async function lockParentContext(
  tx: Prisma.TransactionClient,
  schema: string,
  parentId: string,
): Promise<void> {
  const parents = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${schema}".inferences WHERE id = $1::uuid FOR SHARE`,
    parentId,
  );
  if (parents[0] === undefined) {
    throw notFound("Inference");
  }
  const parentRows = await tx.$queryRawUnsafe<Array<{ image_id: string }>>(
    `SELECT image_id FROM "${schema}".inferences WHERE id = $1::uuid`,
    parentId,
  );
  const parentImageId = parentRows[0]?.image_id;
  if (parentImageId === undefined) {
    throw notFound("Inference");
  }
  const parentImages = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${schema}".images WHERE id = $1::uuid FOR SHARE`,
    parentImageId,
  );
  if (parentImages[0] === undefined) {
    throw notFound("Inference");
  }
}

async function lockImage(
  tx: Prisma.TransactionClient,
  schema: string,
  imageId: string,
): Promise<void> {
  const images = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${schema}".images WHERE id = $1::uuid FOR SHARE`,
    imageId,
  );
  if (images[0] === undefined) {
    throw notFound("Image");
  }
}

async function enqueueOrPending(
  deps: InferenceCreationDeps,
  data: InferenceJobData,
): Promise<{ id?: string }> {
  try {
    return await deps.enqueue(data);
  } catch {
    throw serviceUnavailable("Inference was created but dispatch is pending");
  }
}
