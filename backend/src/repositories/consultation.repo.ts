import { prisma } from "../lib/prisma.js";
import { ConsultationCreate } from "../schemas/consultation.js";

export class ConsultationRepository {
  static async create(data: ConsultationCreate & { doctorId: string }) {
    return prisma.consultation.create({
      data: {
        patientId: data.patientId,
        doctorId: data.doctorId,
        status: data.status,
        clinicalData: data.clinicalData ?? {},
      },
    });
  }

  static async findById(id: string) {
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

  static async updateStatus(id: string, status: string) {
    return prisma.consultation.update({
      where: { id },
      data: { status },
    });
  }
}
