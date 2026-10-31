import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories/index.js";
import { createTestPrisma, makeStudy, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
const repos = createRepositories(prisma);

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe("users", () => {
  it("normalizes email, enforces uniqueness, updates and lists by role", async () => {
    const user = await repos.users.create({ email: " Doc@Clearsight.TEST ", passwordHash: "h", fullName: "Doc" });
    expect(user.email).toBe("doc@clearsight.test");
    expect(user.role).toBe("OFTALMOLOGO");
    expect(user.isActive).toBe(true);

    expect((await repos.users.findByEmail("DOC@clearsight.test"))?.id).toBe(user.id);
    await expect(repos.users.create({ email: "doc@clearsight.test", passwordHash: "h", fullName: "Dup" })).rejects.toMatchObject({ code: "P2002" });

    const updated = await repos.users.update(user.id, { isActive: false });
    expect(updated.isActive).toBe(false);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());

    await makeUser(prisma, "INVESTIGADOR");
    expect(await repos.users.list({ role: "INVESTIGADOR" })).toHaveLength(1);
  });

  it("cannot delete a user that still owns consultations (RESTRICT)", async () => {
    const doctor = await makeUser(prisma);
    await makeStudy(prisma, { doctorId: doctor.id });
    await expect(repos.users.delete(doctor.id)).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("patients", () => {
  it("creates with defaults, updates partially, finds by external code, paginates", async () => {
    const patient = await repos.patients.create({ externalCode: "HC-1", age: 60 });
    expect(patient.clinicalHistoryFlags).toEqual({});

    const updated = await repos.patients.update(patient.id, { age: 61, clinicalHistoryFlags: { diabetes: true } });
    expect(updated).toMatchObject({ age: 61, externalCode: "HC-1", clinicalHistoryFlags: { diabetes: true } });

    expect(await repos.patients.findByExternalCode("HC-1")).toHaveLength(1);
    await repos.patients.create({});
    expect(await repos.patients.list({ limit: 1 })).toHaveLength(1);
    expect(await repos.patients.list()).toHaveLength(2);
  });

  it("deleting a patient cascades to the whole clinical tree", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    await repos.feedback.upsertVerdict({
      consultationId: study.consultation.id, inferenceId: study.inference.id, doctorId: doctor.id,
      predictedClass: 1, validatedClass: 1, confidence: 0.9, agreement: true, doctorNotes: null, isGoldStandard: true, clinicalData: {},
    });

    await repos.patients.delete(study.patient.id);

    expect(await prisma.consultation.count()).toBe(0);
    expect(await prisma.image.count()).toBe(0);
    expect(await prisma.inference.count()).toBe(0);
    expect(await prisma.clinicalFeedback.count()).toBe(0);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("consultations / images / inferences", () => {
  it("defaults status to QUEUED and rejects statuses outside the shared vocabulary", async () => {
    const doctor = await makeUser(prisma);
    const patient = await repos.patients.create({});
    const consultation = await repos.consultations.create({ patientId: patient.id, doctorId: doctor.id });
    expect(consultation.status).toBe("QUEUED");

    expect((await repos.consultations.updateStatus(consultation.id, "REVIEW_REQUIRED")).status).toBe("REVIEW_REQUIRED");
    // Legacy vocabulary is rejected by the DB CHECK even if the type system is bypassed.
    await expect(prisma.consultation.update({ where: { id: consultation.id }, data: { status: "PENDIENTE" } })).rejects.toThrow();
    expect(await repos.consultations.listByDoctor(doctor.id, { status: "REVIEW_REQUIRED" })).toHaveLength(1);
    expect(await repos.consultations.listByDoctor(doctor.id, { status: "QUEUED" })).toHaveLength(0);
  });

  it("enforces eye_side OD/OS and finds duplicate uploads by hash", async () => {
    const doctor = await makeUser(prisma);
    const { consultation } = await makeStudy(prisma, { doctorId: doctor.id });
    const hash = "d41d8cd98f00b204e9800998ecf8427e";

    await repos.images.create({ consultationId: consultation.id, eyeSide: "OS", storagePath: "a.jpg", hashMd5: hash.toUpperCase() });
    expect(await repos.images.findByHash(hash)).toHaveLength(1);
    await expect(prisma.image.create({ data: { consultationId: consultation.id, eyeSide: "XX", storagePath: "b.jpg" } })).rejects.toThrow();
  });

  it("stores the ML result and resolves inferences by job id", async () => {
    const doctor = await makeUser(prisma);
    const { image } = await makeStudy(prisma, { doctorId: doctor.id });
    const jobId = randomUUID();
    const created = await repos.inferences.create({ imageId: image.id, jobId });

    const saved = await repos.inferences.saveResult(created.id, {
      predictedClass: 2, confidence: 0.72,
      probabilities: { Glaucoma: 0.1, Non_Glaucoma: 0.18, Suspicious_Glaucoma: 0.72 },
      cdr: 0.61, cdrVertical: 0.66, quality: { review_required: false }, artifacts: { gradcam_url: "x" },
      elapsedSeconds: 2.4, gradcamPath: "g.png", modelVersion: "v1",
    });
    expect(saved).toMatchObject({ predictedClass: 2, cdr: 0.61, cdrVertical: 0.66, modelVersion: "v1" });
    expect((await repos.inferences.findByJobId(jobId))?.id).toBe(created.id);

    const ctx = await repos.inferences.findWithContext(created.id);
    expect(ctx?.image.consultation.doctorId).toBe(doctor.id);
    await expect(repos.inferences.create({ imageId: image.id, jobId })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("feedback", () => {
  const verdict = (ids: { c: string; i: string; d: string }, over: Partial<Parameters<typeof repos.feedback.upsertVerdict>[0]> = {}) => ({
    consultationId: ids.c, inferenceId: ids.i, doctorId: ids.d,
    predictedClass: 1, validatedClass: 0, confidence: 0.9, agreement: false, doctorNotes: null, isGoldStandard: false, clinicalData: {},
    ...over,
  });

  it("upsert keeps one row per (inference, doctor) and refreshes updated_at", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const ids = { c: study.consultation.id, i: study.inference.id, d: doctor.id };

    const first = await repos.feedback.upsertVerdict(verdict(ids));
    const second = await repos.feedback.upsertVerdict(verdict(ids, { validatedClass: 1, agreement: true, isGoldStandard: true }));

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ validatedClass: 1, agreement: true, isGoldStandard: true });
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(await prisma.clinicalFeedback.count()).toBe(1);
  });

  it("two doctors can each give a verdict on the same inference", async () => {
    const a = await makeUser(prisma);
    const b = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: a.id });
    await repos.feedback.upsertVerdict(verdict({ c: study.consultation.id, i: study.inference.id, d: a.id }));
    await repos.feedback.upsertVerdict(verdict({ c: study.consultation.id, i: study.inference.id, d: b.id }));
    expect(await repos.feedback.listByConsultation(study.consultation.id)).toHaveLength(2);
  });

  it("allows validated_class NULL but the DB forbids gold standard on it", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const ids = { c: study.consultation.id, i: study.inference.id, d: doctor.id };

    const inconclusive = await repos.feedback.upsertVerdict(verdict(ids, { validatedClass: null, agreement: null }));
    expect(inconclusive.validatedClass).toBeNull();

    await expect(repos.feedback.upsertVerdict(verdict(ids, { validatedClass: null, agreement: null, isGoldStandard: true }))).rejects.toThrow(/gold_requires_label/);
  });

  it("listGoldStandard only returns gold rows, honours since/limit and reports has-more via limit+1", async () => {
    const doctor = await makeUser(prisma);
    for (const gold of [true, true, true, false]) {
      const s = await makeStudy(prisma, { doctorId: doctor.id });
      await repos.feedback.upsertVerdict(verdict({ c: s.consultation.id, i: s.inference.id, d: doctor.id }, { isGoldStandard: gold }));
    }
    expect(await repos.feedback.countGoldStandard()).toBe(3);
    expect(await repos.feedback.listGoldStandard({ limit: 10 })).toHaveLength(3);
    expect(await repos.feedback.listGoldStandard({ limit: 2 })).toHaveLength(3); // limit + 1 sentinel
    expect(await repos.feedback.listGoldStandard({ since: new Date(Date.now() + 60_000), limit: 10 })).toHaveLength(0);
  });
});
