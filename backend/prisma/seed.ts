/**
 * Development / demo seed. Idempotent (fixed UUIDs + upserts) and fully
 * synthetic: no real patient data. Refuses to run in production.
 *
 *   npx prisma db seed            (uses prisma.config.ts -> migrations.seed)
 *   SEED_CONSULTATIONS=60 npx prisma db seed
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { createPrismaClient } from "../src/lib/prisma.js";
import { CLASS_LABELS } from "../src/schemas/common.js";
import { CLINICAL_FEATURE_NAMES, type ClinicalFeatureName } from "../src/schemas/clinical.js";
import type { UserRole } from "../src/generated/prisma/enums.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to seed a production database");
}

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://clearsight:clearsight@localhost:5432/clearsight";
const password = process.env.SEED_PASSWORD ?? "ChangeMe123!";
const CONSULTATIONS = Number(process.env.SEED_CONSULTATIONS ?? 12);

/** Deterministic v4-shaped UUIDs so re-seeding upserts instead of duplicating. */
const KIND = { user: 1, patient: 2, consultation: 3, image: 4, inference: 5 } as const;
const uuid = (kind: keyof typeof KIND, n: number) =>
  `0000000${KIND[kind]}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** mulberry32: tiny seeded PRNG, keeps the dataset reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20261027);
const gauss = () => {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};

// Means/stds from ml/models/manifest.json (clinical_mean / clinical_std).
const MEAN = [60.72, 0.6, 0.67, -1.02, 91.25, 0.66, 13.4, 4.43, 520.5, 23.13, -1.47];
const STD = [13.27, 0.49, 2.03, 0.81, 42.87, 0.47, 7.17, 7.7, 104.6, 3.36, 4.27];
const BINARY = new Set<ClinicalFeatureName>(["Gender", "Phakic/Pseudophakic"]);

function clinicalFor(diagnosticClass: number): Record<string, number> {
  // Glaucoma (0): higher IOP, worse visual field. Suspicious (2): in between.
  const shift = diagnosticClass === 0 ? 1 : diagnosticClass === 2 ? 0.5 : 0;
  const out: Record<string, number> = {};
  CLINICAL_FEATURE_NAMES.forEach((name, i) => {
    if (BINARY.has(name)) {
      out[name] = random() < (MEAN[i] as number) ? 1 : 0;
      return;
    }
    let z = gauss() * 0.6;
    if (name === "Perkins" || name === "Pneumatic") z += shift;
    if (name === "VF_DM") z -= shift;
    out[name] = Math.round(((MEAN[i] as number) + z * (STD[i] as number)) * 100) / 100;
  });
  out["Age"] = Math.round(out["Age"] as number);
  return out;
}

const prisma = createPrismaClient(databaseUrl);

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  const users: { n: number; email: string; fullName: string; role: UserRole }[] = [
    { n: 1, email: "doctor1@clearsight.test", fullName: "Dra. Seed Uno", role: "OFTALMOLOGO" },
    { n: 2, email: "doctor2@clearsight.test", fullName: "Dr. Seed Dos", role: "OFTALMOLOGO" },
    { n: 3, email: "researcher@clearsight.test", fullName: "Investigador Seed", role: "INVESTIGADOR" },
    { n: 4, email: "admin@clearsight.test", fullName: "Admin Seed", role: "ADMIN" },
  ];
  for (const user of users) {
    const data = { email: user.email, fullName: user.fullName, role: user.role, passwordHash, isActive: true };
    await prisma.user.upsert({ where: { id: uuid("user", user.n) }, create: { id: uuid("user", user.n), ...data }, update: data });
  }
  const doctors = [uuid("user", 1), uuid("user", 2)];

  let gold = 0;
  for (let i = 1; i <= CONSULTATIONS; i++) {
    const trueClass = i % 3; // 0 Glaucoma, 1 Non_Glaucoma, 2 Suspicious_Glaucoma
    const doctorId = doctors[i % 2] as string;
    const clinical = clinicalFor(trueClass);

    const patientId = uuid("patient", i);
    const patientData = {
      externalCode: `SEED-${String(i).padStart(4, "0")}`,
      age: clinical["Age"] as number,
      gender: clinical["Gender"] === 1 ? "M" : "F",
      clinicalHistoryFlags: { family_history: i % 4 === 0 },
      clinicalData: {},
    };
    await prisma.patient.upsert({ where: { id: patientId }, create: { id: patientId, ...patientData }, update: patientData });

    const consultationId = uuid("consultation", i);
    const consultationData = {
      patientId,
      doctorId,
      status: i === 5 ? "REVIEW_REQUIRED" : "COMPLETED",
      clinicalData: clinical,
    };
    await prisma.consultation.upsert({
      where: { id: consultationId },
      create: { id: consultationId, ...consultationData },
      update: consultationData,
    });

    for (const [eyeIndex, eyeSide] of (["OD", "OS"] as const).entries()) {
      const n = i * 2 + eyeIndex;
      const imageId = uuid("image", n);
      const imageData = {
        consultationId,
        eyeSide,
        storagePath: `2026/10/${imageId}.jpg`,
        hashMd5: imageId.replaceAll("-", ""),
      };
      await prisma.image.upsert({ where: { id: imageId }, create: { id: imageId, ...imageData }, update: imageData });

      // The model is right ~80% of the time.
      const predicted = random() < 0.8 ? trueClass : (trueClass + 1 + Math.floor(random() * 2)) % 3;
      const confidence = Math.round((0.55 + random() * 0.4) * 1000) / 1000;
      const rest = (1 - confidence) / 2;
      const probabilities = Object.fromEntries(
        CLASS_LABELS.map((label, c) => [label, Math.round((c === predicted ? confidence : rest) * 1000) / 1000]),
      );
      const inferenceId = uuid("inference", n);
      const inferenceData = {
        imageId,
        jobId: `0000000${KIND.inference}-0000-4000-9000-${n.toString(16).padStart(12, "0")}`,
        predictedClass: predicted,
        confidence,
        probabilities,
        cdr: Math.round((0.3 + random() * 0.5) * 1000) / 1000,
        cdrVertical: Math.round((0.3 + random() * 0.5) * 1000) / 1000,
        quality: { review_required: i === 5 },
        artifacts: {},
        elapsedSeconds: Math.round((1 + random() * 3) * 100) / 100,
        gradcamPath: `gradcam/${inferenceId}.png`,
        modelVersion: "2026-09-24",
      };
      await prisma.inference.upsert({ where: { id: inferenceId }, create: { id: inferenceId, ...inferenceData }, update: inferenceData });

      // Doctors validate the OD of 3 out of 4 consultations (all three classes covered).
      if (eyeSide === "OD" && i % 4 !== 0) {
        // The REVIEW_REQUIRED consultation (quality gate) is left inconclusive.
        const inconclusive = i === 5;
        const validated = inconclusive ? null : trueClass;
        const isGold = !inconclusive && i % 5 !== 0;
        if (isGold) gold++;
        const verdict = {
          consultationId,
          predictedClass: predicted,
          validatedClass: validated,
          confidence,
          agreement: validated === null ? null : validated === predicted,
          doctorNotes: inconclusive ? "Imagen de baja calidad (seed)" : null,
          isGoldStandard: isGold,
          clinicalData: clinical,
        };
        await prisma.clinicalFeedback.upsert({
          where: { inferenceId_doctorId: { inferenceId, doctorId } },
          create: { inferenceId, doctorId, ...verdict },
          update: verdict,
        });
      }
    }
  }

  console.log(
    `Seeded ${users.length} users, ${CONSULTATIONS} patients/consultations (${CONSULTATIONS * 2} images/inferences), ${gold} gold-standard feedback rows.`,
  );
  console.log(`Seed users share the password from SEED_PASSWORD (default "ChangeMe123!"): development only.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
