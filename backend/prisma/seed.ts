import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Clearsight database...");

  // 1. Seed Users
  const passwordHash = await bcrypt.hash("clearsight123", 10);

  const doctor = await prisma.user.upsert({
    where: { email: "doctor@clearsight.clinic" },
    update: {},
    create: {
      email: "doctor@clearsight.clinic",
      passwordHash,
      role: "OPHTHALMOLOGIST",
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: "admin@clearsight.clinic" },
    update: {},
    create: {
      email: "admin@clearsight.clinic",
      passwordHash,
      role: "ADMIN",
    },
  });

  const researcher = await prisma.user.upsert({
    where: { email: "researcher@clearsight.clinic" },
    update: {},
    create: {
      email: "researcher@clearsight.clinic",
      passwordHash,
      role: "RESEARCHER",
    },
  });

  // 2. Seed Demo Patient
  const patient = await prisma.patient.create({
    data: {
      externalCode: "PAT-2026-001",
      age: 64,
      gender: "F",
      clinicalHistoryFlags: {
        family_glaucoma: true,
        hypertension: true,
        diabetes: false,
      },
      clinicalData: {
        Age: 64,
        Gender: 0,
        dioptre_1: 0.5,
        dioptre_2: -0.75,
        astigmatism: 90,
        "Phakic/Pseudophakic": 1,
        Pneumatic: 16.5,
        Perkins: 16.0,
        Pachymetry: 540,
        Axial_Length: 23.5,
        VF_DM: -2.1,
      },
    },
  });

  // 3. Seed Demo Consultation
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      status: "COMPLETADA",
      clinicalData: patient.clinicalData as any,
    },
  });

  // 4. Seed Demo Image & Inference
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide: "OD",
      storagePath: "raw-retinas/demo/sample_od.jpg",
      hashMd5: "d41d8cd98f00b204e9800998ecf8427e",
    },
  });

  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      predictedClass: 2, // Glaucoma
      confidence: 0.942,
      probabilities: { normal: 0.02, suspect: 0.038, glaucoma: 0.942 },
      gradcamPath: "gradcam-overlays/demo/sample_od_gradcam.png",
      modelVersion: "v1.0.0-onnx",
    },
  });

  // 5. Seed Demo Feedback (Gold Standard)
  await prisma.clinicalFeedback.create({
    data: {
      consultationId: consultation.id,
      inferenceId: inference.id,
      doctorId: doctor.id,
      predictedClass: 2,
      validatedClass: 2,
      confidence: 0.95,
      agreement: true,
      doctorNotes: "Confirmed advanced cup-to-disc excavation with thinning neuroretinal rim.",
      isGoldStandard: true,
      clinicalData: patient.clinicalData as any,
    },
  });

  console.log("Seeding completed successfully.");
  console.log(`Doctor: ${doctor.email} / clearsight123`);
  console.log(`Admin: ${admin.email} / clearsight123`);
  console.log(`Researcher: ${researcher.email} / clearsight123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
