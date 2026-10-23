import { prisma } from "../lib/prisma.js";
import { PatientCreate } from "../schemas/patient.js";

export class PatientRepository {
  static async create(data: PatientCreate) {
    return prisma.patient.create({
      data: {
        externalCode: data.externalCode,
        age: data.age,
        gender: data.gender,
        clinicalHistoryFlags: data.clinicalHistoryFlags ?? {},
        clinicalData: (data.clinicalData as any) ?? {},
      },
    });
  }

  static async findById(id: string) {
    return prisma.patient.findUnique({
      where: { id },
      include: {
        consultations: {
          include: {
            images: {
              include: { inferences: true },
            },
          },
        },
      },
    });
  }

  static async list(limit = 20, offset = 0) {
    return prisma.patient.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: "desc" },
    });
  }
}
