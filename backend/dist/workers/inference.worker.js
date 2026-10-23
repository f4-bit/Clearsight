import { Worker } from "bullmq";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { mlClient } from "../services/ml-client.js";
import { INFERENCE_QUEUE_NAME } from "./inference.queue.js";
const connection = {
    url: env.REDIS_URL,
};
export function startInferenceWorker() {
    const worker = new Worker(INFERENCE_QUEUE_NAME, async (job) => {
        const { inferenceId, imageId, imageUrl, eyeSide, clinicalFeatures, modelVersion } = job.data;
        // 1. Submit to ML Service
        const accepted = await mlClient.submitInference({
            inference_id: inferenceId,
            image_url: imageUrl,
            eye_side: eyeSide,
            clinical_features: clinicalFeatures,
            model_version: modelVersion,
        });
        // 2. Poll until ML inference completes (or fails)
        let attempts = 0;
        const maxAttempts = 60; // 60 * 2s = 120s max
        let statusResponse = await mlClient.getJobStatus(accepted.jobId);
        while (statusResponse.status !== "COMPLETED" &&
            statusResponse.status !== "FAILED" &&
            attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            statusResponse = await mlClient.getJobStatus(accepted.jobId);
            attempts++;
        }
        if (statusResponse.status !== "COMPLETED" || !statusResponse.result) {
            throw new Error(`Inference job ${accepted.jobId} did not complete successfully. Status: ${statusResponse.status}`);
        }
        const result = statusResponse.result;
        // Map string label to integer class (0: Normal, 1: Suspect, 2: Glaucoma)
        const labelMap = {
            normal: 0,
            suspect: 1,
            glaucoma: 2,
        };
        const predictedClass = result.label
            ? labelMap[result.label.toLowerCase()] ?? 0
            : null;
        // 3. Persist to PostgreSQL via Prisma
        const gradcamPath = result.artifacts?.gradcam ?? null;
        const primaryVersion = result.modelVersions?.resnet50 ??
            result.modelVersions?.efficientnet_b3 ??
            modelVersion ??
            "v1";
        await prisma.inference.update({
            where: { id: inferenceId },
            data: {
                predictedClass,
                confidence: result.confidence,
                probabilities: result.probabilities ?? {},
                gradcamPath,
                modelVersion: primaryVersion,
            },
        });
        // 4. Update parent consultation status if all inferences are done
        const inferenceRecord = await prisma.inference.findUnique({
            where: { id: inferenceId },
            include: { image: true },
        });
        if (inferenceRecord?.image?.consultationId) {
            await prisma.consultation.update({
                where: { id: inferenceRecord.image.consultationId },
                data: { status: "COMPLETADA" },
            });
        }
        return result;
    }, {
        connection,
        concurrency: 4,
    });
    worker.on("completed", (job) => {
        console.log(`[Worker] Inference job completed: ${job.id}`);
    });
    worker.on("failed", (job, err) => {
        console.error(`[Worker] Inference job failed: ${job?.id}`, err);
    });
    return worker;
}
if (process.argv[1]?.endsWith("inference.worker.ts") || process.argv[1]?.endsWith("inference.worker.js")) {
    console.log("[Worker] Starting standalone Clearsight BullMQ inference worker...");
    startInferenceWorker();
}
//# sourceMappingURL=inference.worker.js.map