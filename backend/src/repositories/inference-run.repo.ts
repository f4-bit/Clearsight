import { Prisma } from "../generated/prisma/client.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type { ModelPrediction } from "../schemas/inference.js";
import type { Db } from "./types.js";
import {
  INFERENCE_TERMINAL_STATUSES,
  type InferenceTerminalStatus,
} from "../workers/inference.contracts.js";

export type InferenceRunExecution = Prisma.InferenceGetPayload<{
  include: { image: true; snapshot: true };
}>;

export interface TerminalInferenceUpdate {
  status: InferenceTerminalStatus;
  predictedClass?: number | null;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  modelVersions?: Record<string, string>;
  modelPredictions?: Record<string, ModelPrediction>;
  cdr?: number | null;
  cdrVertical?: number | null;
  quality?: Record<string, unknown>;
  artifacts?: Record<string, string>;
  elapsedSeconds?: number | null;
  gradcamPath?: string | null;
  modelVersion?: string | null;
}

export interface InferenceRunRepository {
  findExecution(inferenceId: string): Promise<InferenceRunExecution | null>;
  /** Compare-and-set: never overwrites an already terminal inference. */
  saveTerminalResult(
    inferenceId: string,
    update: TerminalInferenceUpdate,
  ): Promise<boolean>;
}

export interface InferenceRunRepositoryOptions {
  databaseSchema?: string;
}

export function createInferenceRunRepository(
  db: Db,
  options: InferenceRunRepositoryOptions = {},
): InferenceRunRepository {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const inferencesTable = Prisma.raw(
    `"${databaseSchema}"."inferences"`,
  );
  return {
    findExecution: (inferenceId) =>
      db.inference.findUnique({
        where: { id: inferenceId },
        include: { image: true, snapshot: true },
      }),

    saveTerminalResult: async (inferenceId, update) => {
      // Raw SQL keeps the JSON text exactly as received. Prisma's JSON input
      // sanitizer drops an own `__proto__` key, which would silently corrupt
      // legitimate model names. This remains one atomic compare-and-set.
      const assignments: Prisma.Sql[] = [
        Prisma.sql`status = ${update.status}`,
      ];
      if (update.predictedClass !== undefined) {
        assignments.push(Prisma.sql`predicted_class = ${update.predictedClass}`);
      }
      if (update.confidence !== undefined) {
        assignments.push(Prisma.sql`confidence = ${update.confidence}`);
      }
      if (update.probabilities !== undefined) {
        assignments.push(
          Prisma.sql`probabilities = ${JSON.stringify(update.probabilities)}::jsonb`,
        );
      }
      if (update.modelVersions !== undefined) {
        assignments.push(
          Prisma.sql`model_versions = ${JSON.stringify(update.modelVersions)}::jsonb`,
        );
      }
      if (update.modelPredictions !== undefined) {
        assignments.push(
          Prisma.sql`model_predictions = ${JSON.stringify(update.modelPredictions)}::jsonb`,
        );
      }
      if (update.cdr !== undefined) {
        assignments.push(Prisma.sql`cdr = ${update.cdr}`);
      }
      if (update.cdrVertical !== undefined) {
        assignments.push(Prisma.sql`cdr_vertical = ${update.cdrVertical}`);
      }
      if (update.quality !== undefined) {
        assignments.push(
          Prisma.sql`quality = ${JSON.stringify(update.quality)}::jsonb`,
        );
      }
      if (update.artifacts !== undefined) {
        assignments.push(
          Prisma.sql`artifacts = ${JSON.stringify(update.artifacts)}::jsonb`,
        );
      }
      if (update.elapsedSeconds !== undefined) {
        assignments.push(
          Prisma.sql`elapsed_seconds = ${update.elapsedSeconds}`,
        );
      }
      if (update.gradcamPath !== undefined) {
        assignments.push(Prisma.sql`gradcam_path = ${update.gradcamPath}`);
      }
      if (update.modelVersion !== undefined) {
        assignments.push(Prisma.sql`model_version = ${update.modelVersion}`);
      }

      const terminalStatuses = [...INFERENCE_TERMINAL_STATUSES];
      const affected = await db.$executeRaw(
        Prisma.sql`UPDATE ${inferencesTable}
          SET ${Prisma.join(assignments, ", ")}
          WHERE id = ${inferenceId}::uuid
            AND (status IS NULL OR status NOT IN (${Prisma.join(terminalStatuses)}))`,
      );
      return affected === 1;
    },
  };
}
