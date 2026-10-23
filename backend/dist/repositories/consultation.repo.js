import { prisma } from "../lib/prisma.js";
export class ConsultationRepository {
    static async create(data) {
        return prisma.consultation.create({
            data: {
                patientId: data.patientId,
                doctorId: data.doctorId,
                status: data.status,
                clinicalData: data.clinicalData ?? {},
            },
        });
    }
    static async findById(id) {
        return prisma.consultation.findUnique({
            where: { id },
            include: {
                images: {
                    include: {
                        inferences: true,
                    },
                },
                clinicalFeedback: true,
                patient: true,
            },
        });
    }
    static async updateStatus(id, status) {
        return prisma.consultation.update({
            where: { id },
            data: { status },
        });
    }
}
//# sourceMappingURL=consultation.repo.js.map