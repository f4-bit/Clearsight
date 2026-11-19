import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/storage.js", () => ({
  StorageService: {
    ensureBucket: vi.fn(),
    upload: vi.fn().mockResolvedValue("raw-retinas/key.jpg"),
    getDownloadUrl: vi.fn().mockResolvedValue("http://localhost:9000/gradcam.png"),
    getMlDownloadUrl: vi.fn().mockResolvedValue("http://minio:9000/retina.jpg"),
    getObjectStream: vi.fn(),
  },
  s3Client: {},
}));

vi.mock("../src/workers/inference.queue.js", () => ({
  inferenceQueue: { add: vi.fn() },
  enqueueInference: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  INFERENCE_QUEUE_NAME: "inference-jobs",
}));

vi.mock("../src/services/sanitizer.js", () => ({
  sanitizeImage: vi.fn(async () => ({
    buffer: Buffer.from("sanitized"),
    hashMd5: "d41d8cd98f00b204e9800998ecf8427e",
    format: "jpeg",
  })),
}));

import { PrismaPg } from "@prisma/adapter-pg";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app.js";
import { PrismaClient as GeneratedPrismaClient } from "../src/generated/prisma/client.js";
import { adminUserListResponseSchema } from "../src/schemas/auth.js";
import { createClinicalAccessService } from "../src/services/clinical-access.js";
import type { PrismaClient } from "../src/lib/prisma.js";
import { StorageService } from "../src/services/storage.js";
import { enqueueInference } from "../src/workers/inference.queue.js";
import { bearer, buildTestApp, TEST_ENV } from "./helpers/app.js";
import { createTestPrisma, makeSession, makeStudy, makeUser, resetDb, testDatabaseUrl } from "./helpers/db.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

type Role = "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN";
interface User {
  id: string;
  role: Role;
}
interface Study {
  patient: { id: string };
  consultation: { id: string };
  image: { id: string; eyeSide: string };
  inference: { id: string };
}

let doctorA: User;
let doctorB: User;
let admin: User;
let researcher: User;
let headersA: { authorization: string };
let headersB: { authorization: string };
let headersAdmin: { authorization: string };
let headersResearcher: { authorization: string };

beforeAll(async () => {
  app = await buildTestApp(prisma);
});

beforeEach(async () => {
  vi.mocked(StorageService.upload).mockClear();
  vi.mocked(StorageService.getMlDownloadUrl).mockClear();
  vi.mocked(StorageService.getDownloadUrl).mockClear();
  vi.mocked(enqueueInference).mockClear();

  await resetDb(prisma);
  doctorA = await makeUser(prisma, "OFTALMOLOGO");
  doctorB = await makeUser(prisma, "OFTALMOLOGO");
  admin = await makeUser(prisma, "ADMIN");
  researcher = await makeUser(prisma, "INVESTIGADOR");
  headersA = await bearer(app, prisma, doctorA);
  headersB = await bearer(app, prisma, doctorB);
  headersAdmin = await bearer(app, prisma, admin);
  headersResearcher = await bearer(app, prisma, researcher);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeConsultationWithImage(
  doctorId: string,
  eyeSide: "OD" | "OS" = "OD",
): Promise<Study> {
  const patient = await prisma.patient.create({ data: { ownerDoctorId: doctorId } });
  const consultation = await prisma.consultation.create({
    data: { patientId: patient.id, doctorId },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide,
      storagePath: `2026/10/${randomUUID()}.jpg`,
    },
  });
  const inference = await prisma.inference.create({ data: { imageId: image.id } });
  return { patient, consultation, image, inference };
}

async function grant(
  recipient: User,
  study: { inference: { id: string }; consultation: { id: string } },
  over: {
    readResult?: boolean;
    readArtifacts?: boolean;
    readPdf?: boolean;
    canExport?: boolean;
    createdAt?: Date;
    expiresAt?: Date;
    revokedAt?: Date | null;
  } = {},
): Promise<string> {
  const row = await prisma.inferenceAccessGrant.create({
    data: {
      inferenceId: study.inference.id,
      consultationId: study.consultation.id,
      recipientUserId: recipient.id,
      approvalReference: `APPROVAL-${randomUUID()}`,
      readResult: over.readResult ?? false,
      readArtifacts: over.readArtifacts ?? false,
      readPdf: over.readPdf ?? false,
      canExportGoldStandard: over.canExport ?? false,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
      ...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
    },
  });
  return row.id;
}

type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; content: Buffer };

function multipart(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----clearsight${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        part.content,
        Buffer.from("\r\n"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(
  headers: { authorization: string },
  consultationId: string,
  eyeSides: string[],
) {
  const form = multipart([
    ...eyeSides.map((value) => ({ name: "eyeSide", value })),
    { name: "file", filename: "retina.jpg", content: Buffer.from("fake-jpeg") },
  ]);
  return app.inject({
    method: "POST",
    url: `/consultations/${consultationId}/images`,
    headers: { ...headers, "content-type": form.contentType },
    payload: form.payload,
  });
}

describe("clinical ownership and grants", () => {
  it("makes patients doctor-owned, server-assigned and invisible to other roles", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/patients",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { externalCode: "P-1", age: 60, gender: "M" },
    });
    expect(created.statusCode).toBe(201);
    const patientId = created.json().id as string;
    const stored = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(stored.ownerDoctorId).toBe(doctorA.id);

    // A client-supplied owner/actor field is rejected before any creation.
    const spoof = await app.inject({
      method: "POST",
      url: "/patients",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { age: 40, ownerDoctorId: doctorA.id },
    });
    expect([400, 422]).toContain(spoof.statusCode);

    const listA = await app.inject({ method: "GET", url: "/patients", headers: headersA });
    expect(listA.json()).toHaveLength(1);
    const listB = await app.inject({ method: "GET", url: "/patients", headers: headersB });
    expect(listB.json()).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: `/patients/${patientId}`, headers: headersB }))
        .statusCode,
    ).toBe(404);
    for (const headers of [headersAdmin, headersResearcher]) {
      expect((await app.inject({ method: "GET", url: "/patients", headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: "GET", url: `/patients/${patientId}`, headers })).statusCode,
      ).toBe(403);
    }
  });

  it("denies a legacy NULL-owner patient profile even to the doctor who owns the consultation", async () => {
    const patient = await prisma.patient.create({ data: {} });
    const consultation = await prisma.consultation.create({
      data: { patientId: patient.id, doctorId: doctorA.id },
    });

    expect(
      (await app.inject({ method: "GET", url: `/patients/${patient.id}`, headers: headersA }))
        .statusCode,
    ).toBe(404);
    // The owned case still exposes only its own clinical data and opaque patient id.
    const ownCase = await app.inject({
      method: "GET",
      url: `/consultations/${consultation.id}`,
      headers: headersA,
    });
    expect(ownCase.statusCode).toBe(200);
    expect(ownCase.json().patientId).toBe(patient.id);
  });

  it("rejects a foreign patient, a doctorId hint from another doctor and extra fields", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/patients",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { age: 50 },
    });
    const patientId = created.json().id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/consultations",
          headers: { ...headersB, "content-type": "application/json" },
          payload: { patientId },
        })
      ).statusCode,
    ).toBe(404);

    const spoof = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { patientId, doctorId: doctorB.id },
    });
    expect(spoof.statusCode).toBe(403);

    const extra = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { patientId, ownerDoctorId: doctorA.id },
    });
    expect([400, 422]).toContain(extra.statusCode);

    const ownHint = await app.inject({
      method: "POST",
      url: "/consultations",
      headers: { ...headersA, "content-type": "application/json" },
      payload: { patientId, doctorId: doctorA.id },
    });
    expect(ownHint.statusCode).toBe(201);
    expect(ownHint.json().doctorId).toBe(doctorA.id);

    expect(
      (await app.inject({ method: "GET", url: `/consultations/${ownHint.json().id}`, headers: headersB }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/consultations/${ownHint.json().id}`, headers: headersAdmin }))
        .statusCode,
    ).toBe(403);
  });

  it("requires an explicit unique eyeSide before any upload and enforces ownership first", async () => {
    const study = await makeConsultationWithImage(doctorA.id);

    expect((await upload(headersA, study.consultation.id, [])).statusCode).toBe(422);
    expect(StorageService.upload).not.toHaveBeenCalled();

    expect((await upload(headersA, study.consultation.id, ["OD", "OS"])).statusCode).toBe(422);
    expect(StorageService.upload).not.toHaveBeenCalled();

    expect((await upload(headersA, study.consultation.id, ["XX"])).statusCode).toBe(422);
    expect(StorageService.upload).not.toHaveBeenCalled();

    const forged = await upload(headersB, study.consultation.id, ["OD"]);
    expect(forged.statusCode).toBe(404);
    expect(StorageService.upload).not.toHaveBeenCalled();

    expect((await upload(headersAdmin, study.consultation.id, ["OD"])).statusCode).toBe(403);
    expect(StorageService.upload).not.toHaveBeenCalled();

    const ok = await upload(headersA, study.consultation.id, ["os"]);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().eyeSide).toBe("OS");
    expect(StorageService.upload).toHaveBeenCalledTimes(1);
  });

  it("validates inference ownership and stored laterality before create/sign/queue", async () => {
    const own = await makeConsultationWithImage(doctorA.id, "OD");
    const foreign = await makeConsultationWithImage(doctorB.id, "OD");
    const features = {
      Age: 63,
      Gender: 1,
      dioptre_1: -1.5,
      dioptre_2: 0.5,
      astigmatism: 90,
      "Phakic/Pseudophakic": 1,
      Pneumatic: 18,
      Perkins: 17,
      Pachymetry: 540,
      Axial_Length: 24.1,
      VF_DM: -3.2,
    };

    const post = (imageId: string, extra: Record<string, unknown> = {}, headers = headersA) =>
      app.inject({
        method: "POST",
        url: "/inferences",
        headers: { ...headers, "content-type": "application/json" },
        payload: { imageId, eyeSide: "OD", clinicalFeatures: features, ...extra },
      });

    // Client imageUrl is an unknown strict field, rejected before any work.
    expect([400, 422]).toContain((await post(own.image.id, { imageUrl: "http://169.254.169.254/" })).statusCode);
    expect(enqueueInference).not.toHaveBeenCalled();

    // Contradictory laterality is rejected before create/sign/queue.
    expect((await post(own.image.id, { eyeSide: "OS" })).statusCode).toBe(422);
    expect(enqueueInference).not.toHaveBeenCalled();

    // Foreign image (and foreign-owned consultation) is a uniform 404.
    expect((await post(foreign.image.id)).statusCode).toBe(404);
    expect(enqueueInference).not.toHaveBeenCalled();

    // Non-doctors never write clinical data.
    expect((await post(own.image.id, {}, headersResearcher)).statusCode).toBe(403);
    expect(enqueueInference).not.toHaveBeenCalled();

    const before = await prisma.inference.count();
    const ok = await post(own.image.id);
    expect(ok.statusCode).toBe(202);
    expect(await prisma.inference.count()).toBe(before + 1);
    expect(enqueueInference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueInference).mock.calls[0]![0]).toMatchObject({
      eyeSide: "OD",
      imageId: own.image.id,
      imageUrl: "http://minio:9000/retina.jpg",
    });
  });

  it("rejects any client-supplied inferenceId identically before work and uses a server UUID when absent", async () => {
    const own = await makeConsultationWithImage(doctorA.id, "OD");
    const foreign = await makeConsultationWithImage(doctorB.id, "OD");
    const features = {
      Age: 63,
      Gender: 1,
      dioptre_1: -1.5,
      dioptre_2: 0.5,
      astigmatism: 90,
      "Phakic/Pseudophakic": 1,
      Pneumatic: 18,
      Perkins: 17,
      Pachymetry: 540,
      Axial_Length: 24.1,
      VF_DM: -3.2,
    };
    const baseline = await prisma.inference.count();
    const post = (extra: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/inferences",
        headers: { ...headersA, "content-type": "application/json" },
        payload: { imageId: own.image.id, eyeSide: "OD", clinicalFeatures: features, ...extra },
      });

    // A fresh id, an existing own id and an existing foreign id must be
    // indistinguishable: the strict body rejects the unknown field before any
    // ownership lookup, DB write, signed URL or queue dispatch.
    const supplied = [randomUUID(), own.inference.id, foreign.inference.id];
    const rejected: Array<{ statusCode: number; body: string }> = [];
    for (const inferenceId of supplied) {
      const res = await post({ inferenceId });
      rejected.push(res);
      expect(res.statusCode, inferenceId).toBe(400);
      expect(await prisma.inference.count()).toBe(baseline);
    }
    const firstBody = rejected[0]?.body;
    expect(firstBody).toBeDefined();
    for (const res of rejected) {
      expect(res.body).toBe(firstBody);
    }
    expect(enqueueInference).not.toHaveBeenCalled();
    expect(StorageService.getMlDownloadUrl).not.toHaveBeenCalled();

    // Without the field, the server generates the execution id.
    const ok = await post();
    expect(ok.statusCode).toBe(202);
    const created = ok.json() as { inferenceId: string; jobId: string; status: string };
    expect(created.inferenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.inferenceId).not.toBe(supplied[0]);
    expect(await prisma.inference.count()).toBe(baseline + 1);
    const stored = await prisma.inference.findUniqueOrThrow({
      where: { id: created.inferenceId },
    });
    expect(stored.imageId).toBe(own.image.id);
    expect(enqueueInference).toHaveBeenCalledTimes(1);
  });

  it("authorizes inference reads by owner or explicit active grant only", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    await prisma.inference.update({
      where: { id: study.inference.id },
      data: { predictedClass: 1, confidence: 0.8, gradcamPath: "gradcam/x.png" },
    });

    const get = (headers: { authorization: string }, path = `/inferences/${study.inference.id}`) =>
      app.inject({ method: "GET", url: path, headers });

    expect((await get(headersA)).statusCode).toBe(200);
    expect((await get(headersB)).statusCode).toBe(404);
    expect((await get(headersResearcher)).statusCode).toBe(404);
    expect((await get(headersAdmin)).statusCode).toBe(404);

    // Result-only grant: result visible, legacy gradcam path redacted.
    await grant(researcher, study, { readResult: true });
    const result = await get(headersResearcher);
    expect(result.statusCode).toBe(200);
    expect(result.json().gradcamPath).toBeNull();
    expect((await get(headersResearcher, `/inferences/${study.inference.id}/gradcam`)).statusCode).toBe(404);

    // Artifact-only grant cannot read the result, but can sign the artifact URL.
    const artifactUser = await makeUser(prisma, "INVESTIGADOR");
    const artifactHeaders = await bearer(app, prisma, artifactUser);
    await grant(artifactUser, study, { readArtifacts: true });
    expect((await get(artifactHeaders)).statusCode).toBe(404);
    expect(
      (await get(artifactHeaders, `/inferences/${study.inference.id}/gradcam`)).statusCode,
    ).toBe(200);
  });

  it("treats expiresAt == now as inactive and a later instant as active", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    const fixedNow = new Date("2027-01-01T00:00:00.000Z");
    const clocked = createClinicalAccessService(prisma, { now: () => fixedNow });

    await grant(researcher, study, {
      readResult: true,
      createdAt: new Date(fixedNow.getTime() - 3_600_000),
      expiresAt: new Date(fixedNow.getTime()),
    });
    await expect(
      clocked.getInferenceForRead(
        { id: researcher.id, role: "INVESTIGADOR" },
        study.inference.id,
        "readResult",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await grant(researcher, study, {
      readResult: true,
      createdAt: new Date(fixedNow.getTime() - 3_600_000),
      expiresAt: new Date(fixedNow.getTime() + 1),
    });
    await expect(
      clocked.getInferenceForRead(
        { id: researcher.id, role: "INVESTIGADOR" },
        study.inference.id,
        "readResult",
      ),
    ).resolves.toBeTruthy();
  });

  it("denies expired/revoked grants and does not inherit a parent grant to reanalysis", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    const now = Date.now();
    await grant(researcher, study, {
      readResult: true,
      createdAt: new Date(now - 7_200_000),
      expiresAt: new Date(now - 3_600_000),
    });
    expect(
      (
        await app.inject({ method: "GET", url: `/inferences/${study.inference.id}`, headers: headersResearcher })
      ).statusCode,
    ).toBe(404);

    const revokedUser = await makeUser(prisma, "INVESTIGADOR");
    const revokedHeaders = await bearer(app, prisma, revokedUser);
    await prisma.inferenceAccessGrant.create({
      data: {
        inferenceId: study.inference.id,
        consultationId: study.consultation.id,
        recipientUserId: revokedUser.id,
        approvalReference: `REVOKED-${randomUUID()}`,
        readResult: true,
        expiresAt: new Date(now + 3_600_000),
        createdAt: new Date(now - 1000),
        revokedAt: new Date(now),
      },
    });
    expect(
      (
        await app.inject({ method: "GET", url: `/inferences/${study.inference.id}`, headers: revokedHeaders })
      ).statusCode,
    ).toBe(404);

    // Parent grant only covers the exact inference UUID.
    const child = await prisma.inference.create({
      data: { imageId: study.image.id, reanalysisOfId: study.inference.id },
    });
    const parentUser = await makeUser(prisma, "INVESTIGADOR");
    const parentHeaders = await bearer(app, prisma, parentUser);
    await grant(parentUser, study, { readResult: true });
    expect(
      (
        await app.inject({ method: "GET", url: `/inferences/${study.inference.id}`, headers: parentHeaders })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/inferences/${child.id}`, headers: parentHeaders })).statusCode,
    ).toBe(404);
  });

  it("revokes outstanding grants on role/active changes, not on credential email or full-name rotation", async () => {
    const study = await makeStudy(prisma, { doctorId: doctorA.id });
    const grantId = await grant(researcher, study, { canExport: true });

    const emailChange = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { email: `moved-${randomUUID()}@clearsight.test` },
    });
    expect(emailChange.statusCode).toBe(200);
    const afterEmail = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(afterEmail.revokedAt).toBeNull();

    const nameChange = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { fullName: "Renamed Researcher" },
    });
    expect(nameChange.statusCode).toBe(200);
    const afterName = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(afterName.revokedAt).toBeNull();

    const roleChange = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { role: "OFTALMOLOGO" },
    });
    expect(roleChange.statusCode).toBe(200);
    const afterRole = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(afterRole.revokedAt).not.toBeNull();

    // Changing the role back never revives the old approval.
    const back = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { role: "INVESTIGADOR" },
    });
    expect(back.statusCode).toBe(200);
    const stillRevoked = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(stillRevoked.revokedAt?.getTime()).toBe(afterRole.revokedAt?.getTime());

    // Deactivation revokes and reactivation never revives: a new approval is
    // always required after an authorization-state change.
    const freshGrantId = await grant(researcher, study, { canExport: true });
    const deactivate = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);
    const afterDeactivate = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: freshGrantId } });
    expect(afterDeactivate.revokedAt).not.toBeNull();

    const reactivate = await app.inject({
      method: "PATCH",
      url: `/admin/users/${researcher.id}`,
      headers: { ...headersAdmin, "content-type": "application/json" },
      payload: { isActive: true },
    });
    expect(reactivate.statusCode).toBe(200);
    const afterReactivate = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: freshGrantId } });
    expect(afterReactivate.revokedAt?.getTime()).toBe(afterDeactivate.revokedAt?.getTime());
  });

  it("requires an active CAN_EXPORT grant for the export route", async () => {
    const study = await makeStudy(prisma, { doctorId: doctorA.id });
    const query = "/export/gold-standard?limit=10";
    expect(
      (await app.inject({ method: "GET", url: query, headers: headersResearcher })).statusCode,
    ).toBe(403);

    // A result-only grant is not an export grant.
    await grant(researcher, study, { readResult: true });
    expect(
      (await app.inject({ method: "GET", url: query, headers: headersResearcher })).statusCode,
    ).toBe(403);

    await grant(researcher, study, { canExport: true });
    expect(
      (await app.inject({ method: "GET", url: query, headers: headersResearcher })).statusCode,
    ).toBe(200);
  });

  it("applies revocation immediately on the next request with no cached grant scope", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    await prisma.inference.update({
      where: { id: study.inference.id },
      data: { predictedClass: 1, confidence: 0.8 },
    });
    const grantId = await grant(researcher, study, { readResult: true });

    const get = () =>
      app.inject({ method: "GET", url: `/inferences/${study.inference.id}`, headers: headersResearcher });
    expect((await get()).statusCode).toBe(200);

    // Same app instance, later request: the revocation is effective at once.
    await prisma.inferenceAccessGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });
    expect((await get()).statusCode).toBe(404);

    // A new approval (a new record) restores access; the revoked one never does.
    await grant(researcher, study, { readResult: true });
    expect((await get()).statusCode).toBe(200);
  });

  it("takes the actor only from the authenticated principal, never from query or body", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    await grant(researcher, study, { readResult: true });
    const spoofed = `?userId=${doctorA.id}&role=OFTALMOLOGO&actorId=${doctorA.id}&recipientUserId=${researcher.id}`;

    // The researcher's grant can never be borrowed through query parameters.
    expect(
      (await app.inject({ method: "GET", url: `/inferences/${study.inference.id}${spoofed}`, headers: headersAdmin }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/patients/${study.patient.id}${spoofed}`, headers: headersResearcher }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: `/consultations/${study.consultation.id}${spoofed}`, headers: headersB }))
        .statusCode,
    ).toBe(404);
  });

  it("keeps the account administration API privileged while patient rows stay denied", async () => {
    const users = await app.inject({ method: "GET", url: "/admin/users", headers: headersAdmin });
    expect(users.statusCode).toBe(200);
    // Verified response schema: { items, total, limit, offset }.
    const list = adminUserListResponseSchema.parse(users.json());
    expect(Array.isArray(list.items)).toBe(true);
    expect(typeof list.total).toBe("number");
    expect(typeof list.limit).toBe("number");
    expect(typeof list.offset).toBe("number");
    expect((await app.inject({ method: "GET", url: "/patients", headers: headersAdmin })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/admin/users", headers: headersResearcher })).statusCode,
    ).toBe(403);
  });

  it("rolls back the account change and the grant revocation when the audit write fails", async () => {
    const study = await makeStudy(prisma, { doctorId: doctorA.id });
    const grantId = await grant(researcher, study, { canExport: true });

    await prisma.$executeRawUnsafe(
      "ALTER TABLE audit_events ADD CONSTRAINT qa_fail_user_updated CHECK (action <> 'USER_UPDATED')",
    );
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/users/${researcher.id}`,
        headers: { ...headersAdmin, "content-type": "application/json" },
        payload: { role: "OFTALMOLOGO" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: researcher.id } });
      expect(unchanged.role).toBe("INVESTIGADOR");
      const grantRow = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
      expect(grantRow.revokedAt).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe("ALTER TABLE audit_events DROP CONSTRAINT qa_fail_user_updated");
    }
  });

  it("revokes grants through the real ORM path under the restricted clearsight_app role", async () => {
    const ownerIdentity = await prisma.$queryRawUnsafe<Array<{ session_user: string }>>(
      "SELECT session_user",
    );
    const ownerSessionUser = ownerIdentity[0]?.session_user;
    const study = await makeStudy(prisma, { doctorId: doctorA.id });
    const grantId = await grant(researcher, study, { canExport: true, readResult: true });

    const rolePrisma = new GeneratedPrismaClient({
      adapter: new PrismaPg(
        { connectionString: testDatabaseUrl(), options: "-c role=clearsight_app" },
        { schema: "public" },
      ),
    });
    let roleApp: FastifyInstance | undefined;
    try {
      const identity = await rolePrisma.$queryRawUnsafe<
        Array<{ current_user: string; session_user: string }>
      >("SELECT current_user, session_user");
      expect(identity).toEqual([
        { current_user: "clearsight_app", session_user: ownerSessionUser },
      ]);

      roleApp = await buildApp({ env: TEST_ENV, prisma: rolePrisma, databaseSchema: "public" });
      await roleApp.ready();

      const actorCurrent = await prisma.user.findUniqueOrThrow({
        where: { id: admin.id },
        select: { role: true, tokenVersion: true },
      });
      const actorSession = await makeSession(prisma, {
        id: admin.id,
        tokenVersion: actorCurrent.tokenVersion,
      });
      const token = roleApp.jwt.sign({
        sub: admin.id,
        role: actorCurrent.role,
        sessionId: actorSession.id,
        tokenVersion: actorCurrent.tokenVersion,
      });

      // The real account lifecycle path emits only the monotonic revoked_at
      // column update; any wider UPDATE would be denied for clearsight_app.
      const res = await roleApp.inject({
        method: "PATCH",
        url: `/admin/users/${researcher.id}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { role: "OFTALMOLOGO" },
      });
      expect(res.statusCode).toBe(200);

      const revoked = await prisma.inferenceAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
      expect(revoked.revokedAt).not.toBeNull();

      // The application role can never widen grant terms or create grants.
      await expect(
        rolePrisma.inferenceAccessGrant.updateMany({
          where: { id: grantId },
          data: { expiresAt: new Date(Date.now() + 7_200_000) },
        }),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        rolePrisma.inferenceAccessGrant.create({
          data: {
            inferenceId: study.inference.id,
            consultationId: study.consultation.id,
            recipientUserId: researcher.id,
            approvalReference: `APP-ROLE-${randomUUID()}`,
            canExportGoldStandard: true,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        }),
      ).rejects.toThrow(/permission denied/i);

      // Monotonic: an already revoked grant is never revoked twice or revived.
      const again = await rolePrisma.inferenceAccessGrant.updateMany({
        where: { id: grantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      expect(again.count).toBe(0);
    } finally {
      await roleApp?.close();
      await rolePrisma.$disconnect();
    }
  });

  it("uses only the injected database client for every clinical lookup (no global source)", async () => {
    const study = await makeConsultationWithImage(doctorA.id);
    await prisma.inference.update({
      where: { id: study.inference.id },
      data: { predictedClass: 1, confidence: 0.8, gradcamPath: "gradcam/x.png" },
    });

    const sentinel = new Error("QA_POISONED_DI_CLIENT");
    const poisonedModels = ["patient", "consultation", "image", "inference", "inferenceAccessGrant"];
    const poisoned = new Proxy(prisma, {
      get(target, prop) {
        if (typeof prop === "string" && poisonedModels.includes(prop)) {
          return new Proxy({}, { get: () => () => Promise.reject(sentinel) });
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;

    const poisonApp = await buildTestApp(poisoned);
    try {
      const requests: InjectOptions[] = [
        { method: "GET", url: "/patients", headers: headersA },
        { method: "GET", url: `/patients/${study.patient.id}`, headers: headersA },
        { method: "GET", url: `/consultations/${study.consultation.id}`, headers: headersA },
        { method: "GET", url: `/inferences/${study.inference.id}`, headers: headersA },
        { method: "GET", url: `/inferences/${study.inference.id}/gradcam`, headers: headersA },
        { method: "GET", url: "/export/gold-standard?limit=10", headers: headersResearcher },
        {
          method: "POST",
          url: "/consultations",
          headers: { ...headersA, "content-type": "application/json" },
          payload: { patientId: study.patient.id },
        },
      ];
      for (const req of requests) {
        const res = await poisonApp.inject(req);
        expect(res.statusCode, `${req.method} ${req.url}`).toBe(500);
        expect(res.body, `${req.method} ${req.url}`).not.toContain("QA_POISONED_DI_CLIENT");
      }
    } finally {
      await poisonApp.close();
    }

    // The authorizer itself also resolves every lookup through the injected db.
    const poisonedAccess = createClinicalAccessService(poisoned, {});
    await expect(
      poisonedAccess.getInferenceForRead(
        { id: researcher.id, role: "INVESTIGADOR" },
        study.inference.id,
        "readResult",
      ),
    ).rejects.toBe(sentinel);
    await expect(
      poisonedAccess.listActiveExportPairs({ id: researcher.id, role: "INVESTIGADOR" }),
    ).rejects.toBe(sentinel);
  });
});
