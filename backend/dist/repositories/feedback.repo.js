import { prisma } from "../lib/prisma.js";
export class FeedbackRepository {
    static async create(data) {
        return prisma.clinicalFeedback.create({
            data: {
                consultationId: data.consultationId,
                inferenceId: data.inferenceId,
                doctorId: data.doctorId,
                validatedClass: data.validatedClass,
                predictedClass: data.predictedClass,
                confidence: data.confidence,
                agreement: data.agreement,
                doctorNotes: data.doctorNotes,
                isGoldStandard: data.isGoldStandard,
                clinicalData: data.clinicalData ?? {},
            },
        });
    }
    static async findGoldStandard(limit = 100, offset = 0) {
        return prisma.clinicalFeedback.findMany({
            where: { isGoldStandard: true },
            take: limit,
            skip: offset,
            orderBy: { createdAt: "desc" },
        });
    }
}
//# sourceMappingURL=feedback.repo.js.map