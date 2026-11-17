import type { FastifyPluginAsync } from "fastify";
import { forbidden, notFound, unprocessable } from "../lib/http-error.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import type { Repositories } from "../repositories/index.js";
import { extractClinicalFeatures } from "../schemas/clinical.js";
import {
  FeedbackCreate,
  GoldStandardQuery,
  type FeedbackRead,
} from "../schemas/feedback.js";
import { buildGoldStandardExport, toCsv } from "../services/gold-standard-export.js";

export interface FeedbackRoutesOptions {
  repos: Repositories;
  exportHmacSecret: string;
}

type FeedbackRow = Awaited<ReturnType<Repositories["feedback"]["upsertVerdict"]>>;

export function toFeedbackRead(row: FeedbackRow): FeedbackRead {
  return {
    id: row.id,
    consultation_id: row.consultationId,
    inference_id: row.inferenceId,
    doctor_id: row.doctorId,
    validated_class: row.validatedClass,
    predicted_class: row.predictedClass,
    confidence: row.confidence,
    agreement: row.agreement,
    doctor_notes: row.doctorNotes,
    is_gold_standard: row.isGoldStandard,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const feedbackRoutes: FastifyPluginAsync<FeedbackRoutesOptions> = async (app, opts) => {
  const { repos, exportHmacSecret } = opts;

  /**
   * Doctor validates / rectifies / marks as inconclusive a model inference.
   * Idempotent per (inference, doctor): sending it again overwrites the
   * previous verdict (always 200 with the stored row).
   */
  app.post(
    "/feedback",
    { preHandler: [authenticate, requireRole("OFTALMOLOGO")] },
    async (request) => {
      const body = FeedbackCreate.parse(request.body);
      const doctorId = request.user.sub;

      if (body.doctor_id !== undefined && body.doctor_id !== doctorId) {
        throw forbidden("doctor_id does not match the authenticated user");
      }

      const inference = await repos.inferences.findWithContext(body.inference_id);
      if (!inference) throw notFound("Inference");

      const consultation = inference.image.consultation;
      if (consultation.id !== body.consultation_id) {
        throw unprocessable("consultation_id does not match the inference's consultation");
      }
      if (consultation.doctorId !== doctorId) {
        throw forbidden("You can only give feedback on your own consultations");
      }

      // Server-side truth: never trust client-supplied model output or agreement.
      const predictedClass = inference.predictedClass;
      const validatedClass = body.validated_class;
      const agreement =
        validatedClass !== null && predictedClass !== null ? validatedClass === predictedClass : null;

      const saved = await repos.feedback.upsertVerdict({
        consultationId: consultation.id,
        inferenceId: inference.id,
        doctorId,
        predictedClass,
        validatedClass,
        confidence: inference.confidence,
        agreement,
        doctorNotes: body.doctor_notes ?? null,
        isGoldStandard: body.is_gold_standard,
        clinicalData: extractClinicalFeatures(consultation.clinicalData),
      });

      return toFeedbackRead(saved);
    },
  );

  /**
   * Anonymized gold-standard batch for retraining (JSON or CSV).
   * Researchers/auditors and admins only.
   */
  app.get(
    "/export/gold-standard",
    { preHandler: [authenticate, requireRole("INVESTIGADOR", "ADMIN")] },
    async (request, reply) => {
      const query = GoldStandardQuery.parse(request.query);
      const since = query.since ? new Date(query.since) : undefined;

      const { rows, hasMore } = await buildGoldStandardExport(repos.feedback, {
        since,
        limit: query.limit,
        hmacSecret: exportHmacSecret,
      });

      reply.header("x-has-more", String(hasMore));
      reply.header("cache-control", "no-store");

      if (query.format === "csv") {
        const stamp = new Date().toISOString().slice(0, 10);
        return reply
          .type("text/csv; charset=utf-8")
          .header("content-disposition", `attachment; filename="gold-standard-${stamp}.csv"`)
          .send(toCsv(rows));
      }

      return {
        count: rows.length,
        has_more: hasMore,
        generated_at: new Date().toISOString(),
        items: rows,
      };
    },
  );
};
