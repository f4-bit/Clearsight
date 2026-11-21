import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ZodError } from "zod";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories/index.js";
import {
  createInferenceRunRepository,
  type TerminalInferenceUpdate,
} from "../src/repositories/inference-run.repo.js";
import { createTestPrisma, makeStudy, makeUser, resetDb, testDatabaseUrl } from "./helpers/db.js";

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
    const consultation = await repos.consultations.create({
      patientId: patient.id,
      doctorId: doctor.id,
      status: "QUEUED",
      clinicalData: {},
    });
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

  it("stores the ML result through CAS and resolves inferences by job id", async () => {
    const doctor = await makeUser(prisma);
    const { image } = await makeStudy(prisma, { doctorId: doctor.id });
    const jobId = randomUUID();
    const created = await repos.inferences.create({ imageId: image.id, jobId });

    expect(created.modelVersions).toEqual({});
    expect(created.modelPredictions).toEqual({});

    const modelVersions = {
      manifest: "2026-09-24",
      backend: "pytorch",
      efficientnet_b3: "repo/efficientnet_b3@revision-efficientnet_b3",
      resnet50: "repo/resnet50@revision-resnet50",
    };
    const modelPredictions = {
      efficientnet_b3: {
        probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
        predictedClass: "Glaucoma",
        confidence: 0.8,
      },
    };
    const saved = await createInferenceRunRepository(prisma).saveTerminalResult(
      created.id,
      {
        status: "COMPLETED",
        predictedClass: 2,
        confidence: 0.72,
        probabilities: {
          Glaucoma: 0.1,
          Non_Glaucoma: 0.18,
          Suspicious_Glaucoma: 0.72,
        },
        modelVersions,
        modelPredictions,
        cdr: 0.61,
        cdrVertical: 0.66,
        quality: { review_required: false },
        artifacts: { gradcam_url: "x" },
        elapsedSeconds: 2.4,
        gradcamPath: "g.png",
        modelVersion: "2026-09-24",
      },
    );
    expect(saved).toBe(true);

    const stored = await repos.inferences.findById(created.id);
    expect(stored).toMatchObject({
      status: "COMPLETED",
      predictedClass: 2,
      cdr: 0.61,
      cdrVertical: 0.66,
      modelVersion: "2026-09-24",
      modelVersions,
      modelPredictions,
    });
    expect((await repos.inferences.findByJobId(jobId))?.id).toBe(created.id);

    const ctx = await repos.inferences.findWithContext(created.id);
    expect(ctx?.image.consultation.doctorId).toBe(doctor.id);
    await expect(repos.inferences.create({ imageId: image.id, jobId })).rejects.toMatchObject({ code: "P2002" });
  });

  it("does not duplicate or overwrite terminal result/evidence on repeated persistence", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const runRepository = createInferenceRunRepository(prisma);
    const terminal: TerminalInferenceUpdate = {
      status: "COMPLETED",
      predictedClass: 1,
      confidence: 0.91,
      probabilities: {
        Glaucoma: 0.05,
        Non_Glaucoma: 0.91,
        Suspicious_Glaucoma: 0.04,
      },
      modelVersions: { manifest: "2026-09-24" },
      modelPredictions: {},
      cdr: 0.4,
      cdrVertical: 0.45,
      quality: {},
      artifacts: { mask: "s3://masks/mask.png" },
      elapsedSeconds: 1.2,
      gradcamPath: null,
      modelVersion: "2026-09-24",
    };

    expect(
      await runRepository.saveTerminalResult(study.inference.id, terminal),
    ).toBe(true);
    const firstRow = await prisma.inference.findUniqueOrThrow({
      where: { id: study.inference.id },
    });

    await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "mask",
        version: 1,
        status: "PENDING",
      },
    });
    await prisma.pdfReport.create({
      data: { inferenceId: study.inference.id, version: 1, dataVersion: "v1" },
    });
    await prisma.clinicalFeedback.create({
      data: {
        consultationId: study.consultation.id,
        inferenceId: study.inference.id,
        doctorId: doctor.id,
      },
    });

    expect(
      await runRepository.saveTerminalResult(study.inference.id, {
        ...terminal,
        predictedClass: 2,
        confidence: 0.1,
        artifacts: { overlay: "s3://overlays/other.png" },
      }),
    ).toBe(false);

    const after = await prisma.inference.findUniqueOrThrow({
      where: { id: study.inference.id },
    });
    expect(after).toEqual(firstRow);
    expect(await prisma.artifactRecord.count()).toBe(1);
    expect(await prisma.pdfReport.count()).toBe(1);
    expect(await prisma.clinicalFeedback.count()).toBe(1);

    await expect(
      prisma.artifactRecord.create({
        data: {
          inferenceId: study.inference.id,
          artifactType: "mask",
          version: 1,
          status: "PENDING",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.pdfReport.create({
        data: {
          inferenceId: study.inference.id,
          version: 1,
          dataVersion: "v1",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.clinicalFeedback.create({
        data: {
          consultationId: study.consultation.id,
          inferenceId: study.inference.id,
          doctorId: doctor.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
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
    const trusted = { kind: "trusted-offline" } as const;
    expect(await repos.feedback.listGoldStandard({ limit: 10, scope: trusted })).toHaveLength(3);
    expect(await repos.feedback.listGoldStandard({ limit: 2, scope: trusted })).toHaveLength(3); // limit + 1 sentinel
    expect(
      await repos.feedback.listGoldStandard({
        since: new Date(Date.now() + 60_000),
        limit: 10,
        scope: trusted,
      }),
    ).toHaveLength(0);
  });

  it("an empty approved pair scope returns nothing, never the whole dataset", async () => {
    const doctor = await makeUser(prisma);
    for (let i = 0; i < 2; i++) {
      const s = await makeStudy(prisma, { doctorId: doctor.id });
      await repos.feedback.upsertVerdict(verdict({ c: s.consultation.id, i: s.inference.id, d: doctor.id }, { isGoldStandard: true }));
    }
    expect(await repos.feedback.countGoldStandard()).toBe(2);
    expect(
      await repos.feedback.listGoldStandard({ limit: 10, scope: { kind: "approved-inferences", pairs: [] } }),
    ).toEqual([]);
  });

  it("an approved pair scope matches exact (inference, consultation) pairs and excludes cross-case rows", async () => {
    const doctor = await makeUser(prisma);
    const a = await makeStudy(prisma, { doctorId: doctor.id });
    const b = await makeStudy(prisma, { doctorId: doctor.id });
    await repos.feedback.upsertVerdict(verdict({ c: a.consultation.id, i: a.inference.id, d: doctor.id }, { isGoldStandard: true }));
    await repos.feedback.upsertVerdict(verdict({ c: b.consultation.id, i: b.inference.id, d: doctor.id }, { isGoldStandard: true }));
    // Legacy mismatch: the feedback row keeps inference A but is re-pointed to
    // consultation B, so the (A.inference, A.consultation) pair no longer holds.
    await prisma.clinicalFeedback.updateMany({
      where: { inferenceId: a.inference.id },
      data: { consultationId: b.consultation.id },
    });

    const onlyA = await repos.feedback.listGoldStandard({
      limit: 10,
      scope: { kind: "approved-inferences", pairs: [{ inferenceId: a.inference.id, consultationId: a.consultation.id }] },
    });
    expect(onlyA).toEqual([]);

    const both = await repos.feedback.listGoldStandard({
      limit: 10,
      scope: {
        kind: "approved-inferences",
        pairs: [
          { inferenceId: a.inference.id, consultationId: a.consultation.id },
          { inferenceId: b.inference.id, consultationId: b.consultation.id },
        ],
      },
    });
    expect(both.map((row) => row.inferenceId)).toEqual([b.inference.id]);
  });
});

describe("clinical snapshots", () => {
  const snapshotInput = (consultationId: string) => ({
    consultationId,
    rawPayload: {
      age: 63,
      laterality: "OD",
      nested: { values: [1, "x", null, true] },
    },
    normalizedPayload: {
      age: 63,
      features: { cdr: 0.4 },
    },
    schemaVersion: "clinical-v1",
    modelVersions: {
      classifier: { name: "efficientnet", version: "2026-09-24" },
      segmenter: { versions: ["v1", "v2"] },
    },
  });

  it("round-trips raw, normalized and nested model versions exactly", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const input = snapshotInput(study.consultation.id);

    const created = await repos.snapshots.create(input);
    expect(created.consultationId).toBe(study.consultation.id);
    expect(created.schemaVersion).toBe("clinical-v1");
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await repos.snapshots.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.rawPayload).toEqual(input.rawPayload);
    expect(found?.normalizedPayload).toEqual(input.normalizedPayload);
    expect(found?.modelVersions).toEqual(input.modelVersions);
  });

  it("stores an omitted modelVersions as the unresolved empty object", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const { modelVersions: _modelVersions, ...input } = snapshotInput(study.consultation.id);

    const created = await repos.snapshots.create(input);

    expect(created.modelVersions).toEqual({});
    expect((await repos.snapshots.findById(created.id))?.modelVersions).toEqual({});
  });

  it("keeps the snapshot intact when consultation data or the input object changes", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const input = snapshotInput(study.consultation.id);
    const originalRaw = structuredClone(input.rawPayload);
    const originalNormalized = structuredClone(input.normalizedPayload);
    const originalVersions = structuredClone(input.modelVersions);

    const created = await repos.snapshots.create(input);
    await repos.consultations.updateClinicalData(study.consultation.id, { changed: true });
    input.rawPayload.age = 99;
    input.rawPayload.nested.values.push("mutated");
    input.normalizedPayload.features.cdr = 0.9;
    input.modelVersions.classifier.version = "changed";

    expect(created.rawPayload).toEqual(originalRaw);
    const found = await repos.snapshots.findById(created.id);
    expect(found?.rawPayload).toEqual(originalRaw);
    expect(found?.normalizedPayload).toEqual(originalNormalized);
    expect(found?.modelVersions).toEqual(originalVersions);
  });

  it("rejects invalid payloads and versions before any insert", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const valid = snapshotInput(study.consultation.id);

    await expect(
      repos.snapshots.create({ ...valid, rawPayload: [] } as unknown as typeof valid),
    ).rejects.toThrow(ZodError);
    await expect(
      repos.snapshots.create({
        ...valid,
        normalizedPayload: { deep: { date: new Date() } },
      } as unknown as typeof valid),
    ).rejects.toThrow(ZodError);
    await expect(
      repos.snapshots.create({ ...valid, schemaVersion: "   " }),
    ).rejects.toThrow(ZodError);
    const { schemaVersion: _schemaVersion, ...withoutVersion } = valid;
    await expect(
      repos.snapshots.create(withoutVersion as unknown as typeof valid),
    ).rejects.toThrow(ZodError);

    expect(await prisma.clinicalSnapshot.count()).toBe(0);
  });

  it("returns null for malformed and unknown UUIDs", async () => {
    expect(await repos.snapshots.findById("not-a-uuid")).toBeNull();
    expect(await repos.snapshots.findById("")).toBeNull();
    expect(await repos.snapshots.findById(randomUUID())).toBeNull();
  });

  it("works with a transaction client and rolls back with the caller", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    let snapshotId: string | undefined;

    await expect(
      prisma.$transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        const created = await txRepos.snapshots.create(snapshotInput(study.consultation.id));
        snapshotId = created.id;
        expect(await txRepos.snapshots.findById(created.id)).not.toBeNull();
        throw new Error("rollback snapshot");
      }),
    ).rejects.toThrow("rollback snapshot");

    expect(snapshotId).toBeDefined();
    expect(await repos.snapshots.findById(snapshotId as string)).toBeNull();
  });

  it("denies direct UPDATE/DELETE for the application role", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const created = await repos.snapshots.create(snapshotInput(study.consultation.id));

    const app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
    try {
      await app.query("SET ROLE clearsight_app");
      await expect(
        app.query("UPDATE clinical_snapshots SET schema_version = 'changed' WHERE id = $1", [created.id]),
      ).rejects.toThrow(/permission denied for table clinical_snapshots/);
      await expect(
        app.query("DELETE FROM clinical_snapshots WHERE id = $1", [created.id]),
      ).rejects.toThrow(/permission denied for table clinical_snapshots/);
    } finally {
      await app.query("RESET ROLE");
      await app.end();
    }

    expect((await repos.snapshots.findById(created.id))?.schemaVersion).toBe("clinical-v1");
  });

  it("keeps the database trigger rejecting owner updates and deletes", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    const created = await repos.snapshots.create(snapshotInput(study.consultation.id));

    const owner = new Client({ connectionString: testDatabaseUrl() });
    await owner.connect();
    try {
      await expect(
        owner.query("UPDATE clinical_snapshots SET created_at = $2 WHERE id = $1", [created.id, new Date(0)]),
      ).rejects.toThrow(/clinical_snapshots are immutable/);
      await expect(
        owner.query("DELETE FROM clinical_snapshots WHERE id = $1", [created.id]),
      ).rejects.toThrow(/clinical_snapshots are immutable/);
    } finally {
      await owner.end();
    }
  });

  it("resetDb clears snapshots through the consultations cascade", async () => {
    const doctor = await makeUser(prisma);
    const study = await makeStudy(prisma, { doctorId: doctor.id });
    await repos.snapshots.create(snapshotInput(study.consultation.id));
    expect(await prisma.clinicalSnapshot.count()).toBe(1);

    await resetDb(prisma);

    expect(await prisma.clinicalSnapshot.count()).toBe(0);
    expect(await prisma.consultation.count()).toBe(0);
  });
});
