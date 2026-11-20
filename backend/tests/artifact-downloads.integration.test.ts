import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { ArtifactReadRepository } from "../src/repositories/artifact.repo.js";
import { createArtifactReadRepository } from "../src/repositories/artifact.repo.js";
import type { ArtifactReferenceContext } from "../src/services/artifact-reference.js";
import type { ArtifactStoragePort } from "../src/services/storage.js";
import { StorageProviderError } from "../src/services/storage-provider.js";
import { FEATURES } from "./fixtures/clinical.js";
import { bearer, buildTestApp } from "./helpers/app.js";
import { createTestPrisma, makeUser, resetDb } from "./helpers/db.js";

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
  image: { id: string };
  snapshot: { id: string };
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

const TTL = 3600;

interface LogCapture {
  stream: Writable;
  lines: string[];
  text: () => string;
  clear: () => void;
}

function createLogCapture(): LogCapture {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines,
    text: () => lines.join(""),
    clear: () => {
      lines.length = 0;
    },
  };
}

function parsedLogs(capture: LogCapture): Array<Record<string, any>> {
  return capture
    .text()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function contextFor(bucket: string): ArtifactReferenceContext {
  return {
    provider: "minio",
    storageId: "minio-local",
    // Deliberately includes non-default mask/overlay/pdf buckets and no need
    // for the image/Grad-CAM defaults to be present.
    allowedBuckets: [
      "raw-retinas",
      "gradcam-overlays",
      "mask-bucket",
      "overlay-bucket",
      "pdf-bucket",
      bucket,
    ],
    defaultBucket: bucket,
  };
}

const storage = {
  getArtifactReferenceContext: vi.fn((kind: "image" | "gradcam") =>
    contextFor(kind === "image" ? "raw-retinas" : "gradcam-overlays"),
  ),
  getArtifactRecordContext: vi.fn((bucket: string) => contextFor(bucket)),
  getDownloadTtlSeconds: vi.fn(() => TTL),
  getDownloadUrl: vi.fn(async () => "https://signed.example/artifact"),
  getMlDownloadUrl: vi.fn(async () => "http://minio:9000/retina.jpg"),
} satisfies ArtifactStoragePort;

const realRepo = createArtifactReadRepository(prisma);
const repoSpy: ArtifactReadRepository = {
  list: vi.fn(realRepo.list),
  findExact: vi.fn(realRepo.findExact),
  findPublishedPdfReport: vi.fn(realRepo.findPublishedPdfReport),
};

beforeAll(async () => {
  app = await buildTestApp(prisma, {
    storage,
    artifactReadRepository: repoSpy,
  });
});

beforeEach(async () => {
  vi.mocked(storage.getArtifactReferenceContext).mockReset();
  vi.mocked(storage.getArtifactReferenceContext).mockImplementation((kind) =>
    contextFor(kind === "image" ? "raw-retinas" : "gradcam-overlays"),
  );
  vi.mocked(storage.getArtifactRecordContext).mockReset();
  vi.mocked(storage.getArtifactRecordContext).mockImplementation((bucket) =>
    contextFor(bucket),
  );
  vi.mocked(storage.getDownloadTtlSeconds).mockReset();
  vi.mocked(storage.getDownloadTtlSeconds).mockReturnValue(TTL);
  vi.mocked(storage.getDownloadUrl).mockReset();
  vi.mocked(storage.getDownloadUrl).mockResolvedValue(
    "https://signed.example/artifact",
  );
  vi.mocked(repoSpy.list).mockClear();
  vi.mocked(repoSpy.findExact).mockClear();
  vi.mocked(repoSpy.findPublishedPdfReport).mockClear();

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

async function seedStudy(doctorId: string, eyeSide: "OD" | "OS" = "OD"): Promise<Study> {
  const patient = await prisma.patient.create({ data: { ownerDoctorId: doctorId } });
  const consultation = await prisma.consultation.create({
    data: {
      patientId: patient.id,
      doctorId,
      status: "COMPLETED",
      clinicalData: { ...FEATURES } as Prisma.InputJsonValue,
    },
  });
  const image = await prisma.image.create({
    data: {
      consultationId: consultation.id,
      eyeSide,
      storagePath: `2026/10/${randomUUID()}.jpg`,
    },
  });
  const snapshot = await prisma.clinicalSnapshot.create({
    data: {
      consultationId: consultation.id,
      rawPayload: { eyeSide, clinicalFeatures: FEATURES } as Prisma.InputJsonValue,
      normalizedPayload: { eyeSide, values: FEATURES } as Prisma.InputJsonValue,
      schemaVersion: "ml-zscore-f32-v1",
      modelVersions: { model: "2026-09-24" } as Prisma.InputJsonValue,
    },
  });
  const inference = await prisma.inference.create({
    data: {
      imageId: image.id,
      consultationId: consultation.id,
      eyeSide,
      snapshotId: snapshot.id,
      status: "COMPLETED",
      modelVersion: "2026-09-24",
      artifacts: { mask: `s3://mask-bucket/${randomUUID()}.png` },
    },
  });
  return { patient, consultation, image, snapshot, inference };
}

async function makeArtifact(
  inferenceId: string,
  artifactType: "mask" | "overlay" | "pdf" | "gradcam" | "shap",
  version: number,
  opts: {
    status?: "NOT_SUPPORTED" | "NOT_REQUESTED" | "PENDING" | "AVAILABLE" | "FAILED";
    bucket?: string;
    key?: string;
    contentType?: string;
  } = {},
) {
  const status = opts.status ?? "AVAILABLE";
  const bucket = opts.bucket ?? `${artifactType}-bucket`;
  return prisma.artifactRecord.create({
    data: {
      inferenceId,
      artifactType,
      version,
      status,
      ...(status === "AVAILABLE"
        ? {
            storageId: "minio-local",
            bucketOrContainer: bucket,
            key: opts.key ?? `${artifactType}/v${version}.bin`,
            contentType:
              opts.contentType ??
              (artifactType === "pdf" ? "application/pdf" : "image/png"),
            sizeBytes: 123n,
            checksumSha256: "a".repeat(64),
            availableAt: new Date(),
          }
        : {}),
      ...(status === "FAILED"
        ? { failureCode: "UPLOAD_FAILED", retryable: true }
        : {}),
    },
  });
}

async function makePdfReport(
  study: Study,
  version: number,
  artifactId: string,
  status: "PENDING" | "AVAILABLE" = "AVAILABLE",
) {
  return prisma.pdfReport.create({
    data: {
      inferenceId: study.inference.id,
      version,
      artifactId,
      sourceSnapshotId: study.snapshot.id,
      status,
      dataVersion: "clinical-v1",
      modelVersions: { model: "2026-09-24" },
      renderingInputs: { result: "inline" },
      ...(status === "AVAILABLE" ? { availableAt: new Date() } : {}),
    },
  });
}

async function grant(
  recipient: User,
  study: Study,
  over: {
    readResult?: boolean;
    readArtifacts?: boolean;
    readPdf?: boolean;
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
      approvalReference: `APP-${randomUUID()}`,
      readResult: over.readResult ?? false,
      readArtifacts: over.readArtifacts ?? false,
      readPdf: over.readPdf ?? false,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
      ...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
    },
  });
  return row.id;
}

function listUrl(study: Study, query = ""): string {
  return `/inferences/${study.inference.id}/artifacts${query}`;
}

function urlFor(study: Study, type: string, query = ""): string {
  return `/inferences/${study.inference.id}/artifacts/${type}/url${query}`;
}

async function auditRows(action: string) {
  return prisma.auditEvent.findMany({
    where: { action },
    orderBy: { occurredAt: "asc" },
  });
}

describe("artifact listing and versioned URL", () => {
  it("lists only authorized rows, filters before count, and orders stably", async () => {
    const study = await seedStudy(doctorA.id);
    const gradcam = await makeArtifact(study.inference.id, "gradcam", 1, {
      status: "NOT_SUPPORTED",
    });
    await makeArtifact(study.inference.id, "mask", 1, { status: "FAILED" });
    const maskV2 = await makeArtifact(study.inference.id, "mask", 2, { status: "PENDING" });
    const maskV3 = await makeArtifact(study.inference.id, "mask", 3, {
      bucket: "mask-bucket",
      key: "mask/v3.png",
    });
    await makeArtifact(study.inference.id, "overlay", 1, {
      bucket: "overlay-bucket",
    });
    await makeArtifact(study.inference.id, "pdf", 1, { bucket: "pdf-bucket" });

    const owner = await app.inject({
      method: "GET",
      url: listUrl(study, "?limit=2&offset=0"),
      headers: headersA,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["cache-control"]).toBe("no-store");
    expect(owner.json()).toMatchObject({ total: 6, limit: 2, offset: 0 });
    expect(owner.json().items).toHaveLength(2);
    expect(owner.json().items[0]).toMatchObject({
      artifactId: gradcam.id,
      version: 1,
      reference: { artifactType: "gradcam", status: "NOT_SUPPORTED" },
    });
    expect(owner.json().items[1]).toMatchObject({
      artifactId: maskV3.id,
      version: 3,
      reference: { artifactType: "mask", status: "AVAILABLE" },
    });

    const pageTwo = await app.inject({
      method: "GET",
      url: listUrl(study, "?type=mask&limit=1&offset=1"),
      headers: headersA,
    });
    expect(pageTwo.json()).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(pageTwo.json().items).toEqual([
      expect.objectContaining({ artifactId: maskV2.id, version: 2 }),
    ]);

    // readArtifacts without readPdf: pdf is neither returned nor counted.
    await grant(researcher, study, { readArtifacts: true });
    const artifactOnly = await app.inject({
      method: "GET",
      url: listUrl(study, "?limit=100"),
      headers: headersResearcher,
    });
    expect(artifactOnly.statusCode).toBe(200);
    expect(artifactOnly.json()).toMatchObject({ total: 5, limit: 100, offset: 0 });
    expect(
      artifactOnly
        .json()
        .items.some((item: { reference: { artifactType: string } }) =>
          ["pdf"].includes(item.reference.artifactType),
        ),
    ).toBe(false);

    const requestedPdf = await app.inject({
      method: "GET",
      url: listUrl(study, "?type=pdf"),
      headers: headersResearcher,
    });
    expect(requestedPdf.statusCode).toBe(200);
    expect(requestedPdf.json()).toMatchObject({ items: [], total: 0 });

    // readPdf alone sees only the pdf; a valid non-pdf type is an empty 200.
    const pdfOnlyUser = await makeUser(prisma, "INVESTIGADOR");
    const pdfOnlyHeaders = await bearer(app, prisma, pdfOnlyUser);
    await grant(pdfOnlyUser, study, { readPdf: true });
    const pdfOnly = await app.inject({
      method: "GET",
      url: listUrl(study, "?type=pdf"),
      headers: pdfOnlyHeaders,
    });
    expect(pdfOnly.statusCode).toBe(200);
    expect(pdfOnly.json()).toMatchObject({ total: 1 });
    const nonPdf = await app.inject({
      method: "GET",
      url: listUrl(study, "?type=mask"),
      headers: pdfOnlyHeaders,
    });
    expect(nonPdf.statusCode).toBe(200);
    expect(nonPdf.json()).toMatchObject({ items: [], total: 0 });

    // The injected repository is the one used by the route.
    expect(repoSpy.list).toHaveBeenCalledWith(
      study.inference.id,
      expect.arrayContaining(["mask", "overlay", "gradcam", "shap", "pdf"]),
      expect.objectContaining({ limit: 2, offset: 0 }),
    );
  });

  it("enforces owner/doctor and explicit grant matrix and unions split grants", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, { bucket: "mask-bucket" });
    await makeArtifact(study.inference.id, "pdf", 1, { bucket: "pdf-bucket" });

    const get = (headers: { authorization: string }, query = "") =>
      app.inject({ method: "GET", url: listUrl(study, query), headers });

    expect((await get(headersA)).statusCode).toBe(200);
    expect((await get(headersB)).statusCode).toBe(404);
    expect((await get(headersAdmin)).statusCode).toBe(404);
    expect((await get(headersResearcher)).statusCode).toBe(404);

    // readResult alone is not an artifact capability.
    await grant(researcher, study, { readResult: true });
    expect((await get(headersResearcher)).statusCode).toBe(404);

    // ADMIN also requires an explicit grant.
    const adminUser = await makeUser(prisma, "ADMIN");
    const adminHeaders = await bearer(app, prisma, adminUser);
    await grant(adminUser, study, { readArtifacts: true });
    expect((await get(adminHeaders)).statusCode).toBe(200);

    // Two active grants must union: readArtifacts from one, readPdf from another.
    const splitUser = await makeUser(prisma, "INVESTIGADOR");
    const splitHeaders = await bearer(app, prisma, splitUser);
    await grant(splitUser, study, { readArtifacts: true });
    expect((await get(splitHeaders)).statusCode).toBe(200);
    expect((await get(splitHeaders, "?type=pdf")).json()).toMatchObject({
      items: [],
      total: 0,
    });
    // URL capability is checked before the row lookup: pdf exists but is denied.
    expect(
      (
        await app.inject({
          method: "GET",
          url: urlFor(study, "pdf", "?version=1"),
          headers: splitHeaders,
        })
      ).statusCode,
    ).toBe(404);
    await grant(splitUser, study, { readPdf: true });
    expect((await get(splitHeaders, "?type=pdf")).json()).toMatchObject({
      total: 1,
    });

    // Expired and revoked grants do not participate.
    const expiredUser = await makeUser(prisma, "INVESTIGADOR");
    const expiredHeaders = await bearer(app, prisma, expiredUser);
    await grant(expiredUser, study, {
      readArtifacts: true,
      createdAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 1),
    });
    expect((await get(expiredHeaders)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: urlFor(study, "mask", "?version=1"),
          headers: expiredHeaders,
        })
      ).statusCode,
    ).toBe(404);

    const revokedUser = await makeUser(prisma, "INVESTIGADOR");
    const revokedHeaders = await bearer(app, prisma, revokedUser);
    await grant(revokedUser, study, {
      readArtifacts: true,
      createdAt: new Date(Date.now() - 3_600_000),
      revokedAt: new Date(),
    });
    expect((await get(revokedHeaders)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: urlFor(study, "mask", "?version=1"),
          headers: revokedHeaders,
        })
      ).statusCode,
    ).toBe(404);

    // A pdf-only grant cannot request a non-pdf URL even when the row exists.
    const pdfOnlyUser = await makeUser(prisma, "INVESTIGADOR");
    const pdfOnlyHeaders = await bearer(app, prisma, pdfOnlyUser);
    await grant(pdfOnlyUser, study, { readPdf: true });
    expect(
      (
        await app.inject({
          method: "GET",
          url: urlFor(study, "mask", "?version=1"),
          headers: pdfOnlyHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns an empty 200 for no rows and never fabricates rows from Inference.artifacts", async () => {
    const study = await seedStudy(doctorA.id);
    const res = await app.inject({
      method: "GET",
      url: listUrl(study, "?limit=20"),
      headers: headersA,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    const url = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(url.statusCode).toBe(404);
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it("requires an explicit int32 version and a binary type; no implicit latest", async () => {
    const study = await seedStudy(doctorA.id);
    const maskV1 = await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/v1.png",
    });
    const maskV2 = await makeArtifact(study.inference.id, "mask", 2, {
      bucket: "mask-bucket",
      key: "mask/v2.png",
    });

    const url = (type: string, query: string) =>
      app.inject({ method: "GET", url: urlFor(study, type, query), headers: headersA });

    for (const query of [
      "",
      "?version=0",
      "?version=-1",
      "?version=1.5",
      "?version=2147483648",
      "?version=abc",
      "?version=1&extra=1",
    ]) {
      const res = await url("mask", query);
      expect(res.statusCode, query).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    for (const type of ["result", "unknown"]) {
      expect((await url(type, "?version=1")).statusCode).toBe(400);
    }
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();

    const v1 = await url("mask", "?version=1");
    expect(v1.statusCode).toBe(200);
    expect(v1.headers["cache-control"]).toBe("no-store");
    expect(v1.json()).toMatchObject({
      artifactType: "mask",
      status: "AVAILABLE",
      url: "https://signed.example/artifact",
      expiresInSeconds: TTL,
      contentType: "image/png",
      reportVersion: null,
    });
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(
      "mask-bucket",
      "mask/v1.png",
      TTL,
    );

    const v2 = await url("mask", "?version=2");
    expect(v2.statusCode).toBe(200);
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(
      "mask-bucket",
      "mask/v2.png",
      TTL,
    );

    expect((await url("mask", "?version=3")).statusCode).toBe(404);
    expect(storage.getDownloadUrl).toHaveBeenCalledTimes(2);
    expect([maskV1.id, maskV2.id]).toHaveLength(2);
  });

  it("returns 200 nulls without storage calls for every non-AVAILABLE state", async () => {
    const study = await seedStudy(doctorA.id);
    const versions: Array<{
      type: "mask" | "overlay";
      version: number;
      status: "NOT_SUPPORTED" | "NOT_REQUESTED" | "PENDING" | "FAILED";
    }> = [
      { type: "mask", version: 1, status: "NOT_SUPPORTED" },
      { type: "mask", version: 2, status: "NOT_REQUESTED" },
      { type: "mask", version: 3, status: "PENDING" },
      { type: "mask", version: 4, status: "FAILED" },
      { type: "overlay", version: 1, status: "PENDING" },
    ];
    for (const entry of versions) {
      await makeArtifact(study.inference.id, entry.type, entry.version, {
        status: entry.status,
      });
    }

    for (const entry of versions) {
      const res = await app.inject({
        method: "GET",
        url: urlFor(study, entry.type, `?version=${entry.version}`),
        headers: headersA,
      });
      expect(res.statusCode, `${entry.type} ${entry.version}`).toBe(200);
      expect(res.json()).toMatchObject({
        artifactType: entry.type,
        status: entry.status,
        url: null,
        expiresInSeconds: null,
        contentType: null,
        reportVersion: null,
      });
    }
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it("requires a valid published PDF report and returns its exact version", async () => {
    const study = await seedStudy(doctorA.id);
    const pdfWithReport = await makeArtifact(study.inference.id, "pdf", 1, {
      bucket: "pdf-bucket",
    });
    await makePdfReport(study, 1, pdfWithReport.id);

    const ok = await app.inject({
      method: "GET",
      url: urlFor(study, "pdf", "?version=1"),
      headers: headersA,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      artifactType: "pdf",
      status: "AVAILABLE",
      contentType: "application/pdf",
      reportVersion: 1,
    });

    // AVAILABLE pdf with only a PENDING report is not a valid publication.
    const pdfPendingReport = await makeArtifact(study.inference.id, "pdf", 2, {
      bucket: "pdf-bucket",
    });
    await makePdfReport(study, 2, pdfPendingReport.id, "PENDING");
    const missing = await app.inject({
      method: "GET",
      url: urlFor(study, "pdf", "?version=2"),
      headers: headersA,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.body).not.toContain("https://signed.example");
    const incident = await auditRows("REPORT_NOT_AVAILABLE");
    expect(incident).toHaveLength(1);
    expect(incident[0]).toMatchObject({
      actorKind: "USER",
      actorUserId: doctorA.id,
      targetType: "ARTIFACT",
      targetId: pdfPendingReport.id,
      outcome: "FAILURE",
      metadata: { reasonCode: "REPORT_NOT_AVAILABLE" },
    });
    expect(storage.getDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("maps only storage_object_missing to 409 and keeps the AVAILABLE row immutable", async () => {
    const study = await seedStudy(doctorA.id);
    const mask = await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/immutable.png",
    });
    const before = await prisma.artifactRecord.findUniqueOrThrow({ where: { id: mask.id } });

    vi.mocked(storage.getDownloadUrl).mockRejectedValueOnce(
      new StorageProviderError("storage_object_missing"),
    );
    const missing = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.body).not.toContain("mask-bucket");
    expect(missing.body).not.toContain("mask/immutable.png");
    const incident = await auditRows("ARTIFACT_OBJECT_MISSING");
    expect(incident).toHaveLength(1);
    expect(incident[0]).toMatchObject({
      targetId: mask.id,
      outcome: "FAILURE",
      metadata: { reasonCode: "STORAGE_OBJECT_MISSING" },
    });
    expect(
      await prisma.artifactRecord.findUniqueOrThrow({ where: { id: mask.id } }),
    ).toMatchObject({
      status: "AVAILABLE",
      storageId: before.storageId,
      bucketOrContainer: before.bucketOrContainer,
      key: before.key,
      availableAt: before.availableAt,
    });

    // Permission/network and unknown failures are generic 503, never fake 404.
    for (const failure of [
      new StorageProviderError("storage_permission_denied"),
      new StorageProviderError("storage_unavailable"),
      new Error("CANARY_SECRET https://secret.example/object"),
    ]) {
      vi.mocked(storage.getDownloadUrl).mockRejectedValueOnce(failure);
      const res = await app.inject({
        method: "GET",
        url: urlFor(study, "mask", "?version=1"),
        headers: headersA,
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain("CANARY_SECRET");
      expect(res.body).not.toContain("secret.example");
      expect(res.body).not.toContain("mask-bucket");
    }
    expect(storage.getDownloadUrl).toHaveBeenCalledTimes(4);
  });

  it("fails closed on an unallowlisted row context before the SDK", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "unlisted-bucket",
      key: "mask/x.png",
    });
    vi.mocked(storage.getArtifactRecordContext).mockImplementationOnce(() => {
      throw new Error("find the allowlist yourself");
    });

    const res = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("unlisted-bucket");
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it("signs with an explicit artifact-only allowlist without raw defaults", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/explicit.png",
    });
    vi.mocked(storage.getArtifactRecordContext).mockImplementationOnce(
      (bucket) => ({
        provider: "minio",
        storageId: "minio-local",
        allowedBuckets: ["mask-bucket", "overlay-bucket", "pdf-bucket"],
        defaultBucket: bucket,
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(res.statusCode).toBe(200);
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(
      "mask-bucket",
      "mask/explicit.png",
      TTL,
    );
  });

  it("does not return a URL when the fresh session or grant check fails after signing", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, { bucket: "mask-bucket" });
    const session = await prisma.userSession.findFirstOrThrow({
      where: { userId: doctorA.id },
      orderBy: { createdAt: "desc" },
    });
    vi.mocked(storage.getDownloadUrl).mockImplementationOnce(async () => {
      await prisma.userSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), reasonCode: "TEST_REVOKED" },
      });
      return "https://signed.example/revoked-session";
    });

    const revoked = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).not.toContain("revoked-session");
    expect(await auditRows("ARTIFACT_URL_ISSUED")).toHaveLength(0);

    const grantUser = await makeUser(prisma, "INVESTIGADOR");
    const grantHeaders = await bearer(app, prisma, grantUser);
    const grantId = await grant(grantUser, study, { readArtifacts: true });
    vi.mocked(storage.getDownloadUrl).mockImplementationOnce(async () => {
      await prisma.inferenceAccessGrant.update({
        where: { id: grantId },
        data: { revokedAt: new Date() },
      });
      return "https://signed.example/revoked-grant";
    });
    const lost = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: grantHeaders,
    });
    expect(lost.statusCode).toBe(404);
    expect(lost.body).not.toContain("revoked-grant");
    expect(await auditRows("ARTIFACT_URL_ISSUED")).toHaveLength(0);
  });

  it("commits ARTIFACT_URL_ISSUED before returning and returns 503 if audit fails", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, { bucket: "mask-bucket" });
    const failArtifact = await makeArtifact(study.inference.id, "mask", 2, {
      bucket: "mask-bucket",
      key: "mask/v2.png",
    });

    const ok = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(ok.statusCode).toBe(200);
    const events = await auditRows("ARTIFACT_URL_ISSUED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: "USER",
      actorUserId: doctorA.id,
      targetType: "ARTIFACT",
      outcome: "SUCCESS",
      metadata: { reasonCode: "AUTHORIZED_READ" },
    });

    await prisma.$executeRawUnsafe(
      `ALTER TABLE audit_events ADD CONSTRAINT qa_fail_artifact_url CHECK (target_id IS DISTINCT FROM '${failArtifact.id}'::uuid)`,
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: urlFor(study, "mask", "?version=2"),
        headers: headersA,
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain("https://signed.example/artifact");
      expect(await auditRows("ARTIFACT_URL_ISSUED")).toHaveLength(1);
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE audit_events DROP CONSTRAINT qa_fail_artifact_url",
      );
    }
  });

  it("sets no-store on list/URL failures and never leaks locators", async () => {
    const study = await seedStudy(doctorA.id);
    const notFoundRes = await app.inject({
      method: "GET",
      url: listUrl(study),
      headers: headersB,
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.headers["cache-control"]).toBe("no-store");
    expect(notFoundRes.body).not.toContain("mask-bucket");

    const badQuery = await app.inject({
      method: "GET",
      url: listUrl(study, "?limit=0"),
      headers: headersA,
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.headers["cache-control"]).toBe("no-store");

    const unauthorizedRes = await app.inject({
      method: "GET",
      url: listUrl(study),
    });
    expect(unauthorizedRes.statusCode).toBe(401);
    expect(unauthorizedRes.headers["cache-control"]).toBe("no-store");
  });
});

// QA regression holes (mutation-verified): each test fails if the key line it
// guards is deleted or inverted. Source code is never touched.
describe("artifact read scope regression holes", () => {
  it("never resolves an artifact row that belongs to a different inference", async () => {
    const studyA = await seedStudy(doctorA.id);
    const studyB = await seedStudy(doctorA.id);
    const foreign = await makeArtifact(studyB.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/other-inference.png",
    });
    expect(foreign.inferenceId).toBe(studyB.inference.id);

    // The caller owns both executions, so only the row scope may deny A -> B.
    const viaA = await app.inject({
      method: "GET",
      url: urlFor(studyA, "mask", "?version=1"),
      headers: headersA,
    });
    expect(viaA.statusCode).toBe(404);
    expect(viaA.body).not.toContain("mask/other-inference.png");
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();

    const listA = await app.inject({
      method: "GET",
      url: listUrl(studyA),
      headers: headersA,
    });
    expect(listA.statusCode).toBe(200);
    expect(listA.json()).toEqual({ items: [], total: 0, limit: 20, offset: 0 });

    const viaB = await app.inject({
      method: "GET",
      url: urlFor(studyB, "mask", "?version=1"),
      headers: headersA,
    });
    expect(viaB.statusCode).toBe(200);
    expect(storage.getDownloadUrl).toHaveBeenCalledTimes(1);
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(
      "mask-bucket",
      "mask/other-inference.png",
      TTL,
    );
  });

  it("rejects a row location outside the trusted context before the SDK", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "evil-bucket",
      key: "mask/evil.png",
    });

    // The context seam answers, but the 3.3 trusted parse must still reject a
    // poisoned DB row whose bucket is not in the allowlist.
    vi.mocked(storage.getArtifactRecordContext).mockImplementationOnce(
      (bucket) => ({
        provider: "minio",
        storageId: "minio-local",
        allowedBuckets: ["raw-retinas", "gradcam-overlays"],
        defaultBucket: bucket,
      }),
    );
    const unlisted = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(unlisted.statusCode).toBe(503);
    expect(unlisted.body).not.toContain("evil-bucket");
    expect(unlisted.body).not.toContain("mask/evil.png");
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();

    // A row pointing at a foreign storageId must fail the same trusted parse.
    await prisma.artifactRecord.create({
      data: {
        inferenceId: study.inference.id,
        artifactType: "overlay",
        version: 1,
        status: "AVAILABLE",
        storageId: "azure-blob-default",
        bucketOrContainer: "overlay-bucket",
        key: "overlay/cross-provider.png",
        contentType: "image/png",
        sizeBytes: 123n,
        checksumSha256: "b".repeat(64),
        availableAt: new Date(),
      },
    });
    const mismatched = await app.inject({
      method: "GET",
      url: urlFor(study, "overlay", "?version=1"),
      headers: headersA,
    });
    expect(mismatched.statusCode).toBe(503);
    expect(mismatched.body).not.toContain("cross-provider");
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns the TTL configured in the storage port, not a hardcoded value", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/ttl.png",
    });
    vi.mocked(storage.getDownloadTtlSeconds).mockReturnValue(300);

    const res = await app.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ expiresInSeconds: 300 });
    expect(storage.getDownloadTtlSeconds).toHaveBeenCalled();
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(
      "mask-bucket",
      "mask/ttl.png",
      300,
    );
  });

  it("denies a forbidden type before any artifact row lookup", async () => {
    const study = await seedStudy(doctorA.id);
    await makeArtifact(study.inference.id, "mask", 1, { bucket: "mask-bucket" });
    const pdf = await makeArtifact(study.inference.id, "pdf", 1, {
      bucket: "pdf-bucket",
    });

    const researcherUser = await makeUser(prisma, "INVESTIGADOR");
    const researcherHeaders = await bearer(app, prisma, researcherUser);
    await grant(researcherUser, study, { readArtifacts: true });

    // The pdf row exists, but the capability check must win before the lookup.
    const res = await app.inject({
      method: "GET",
      url: urlFor(study, "pdf", "?version=1"),
      headers: researcherHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("pdf-bucket");
    expect(res.body).not.toContain(pdf.id);
    expect(repoSpy.findExact).not.toHaveBeenCalled();
    expect(repoSpy.findPublishedPdfReport).not.toHaveBeenCalled();
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("artifact download log redaction", () => {
  let capture: LogCapture;
  let logged: FastifyInstance;

  beforeAll(async () => {
    capture = createLogCapture();
    logged = await buildTestApp(prisma, {
      storage,
      artifactReadRepository: repoSpy,
      logger: true,
      logDestination: capture.stream,
    });
  });

  beforeEach(() => {
    capture.clear();
  });

  afterAll(async () => {
    await logged.close();
  });

  it("keeps reqId, method and status while censoring canary queries before validation", async () => {
    const health = await logged.inject({
      method: "GET",
      url: "/health?X-Amz-Signature=CANARY_HEALTH_SIG&token=CANARY_HEALTH_TOKEN",
    });
    expect(health.statusCode).toBe(200);
    await flushLogs();

    const healthOutput = capture.text();
    for (const leak of ["CANARY_HEALTH_SIG", "CANARY_HEALTH_TOKEN", "X-Amz-Signature"]) {
      expect(healthOutput).not.toContain(leak);
    }
    let entries = parsedLogs(capture);
    const healthIncoming = entries.find((entry) => entry.msg === "incoming request");
    expect(healthIncoming).toMatchObject({
      req: { method: "GET", url: "[REDACTED]" },
    });
    expect(typeof healthIncoming?.reqId).toBe("string");
    expect(entries.find((entry) => entry.msg === "request completed")).toMatchObject({
      reqId: healthIncoming?.reqId,
      res: { statusCode: 200 },
    });

    capture.clear();
    const unauthorized = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask/url?version=1&X-Amz-Signature=CANARY_SIG&token=CANARY_TOKEN&encoded=https%3A%2F%2Fsecret.example%2Fobject`,
    });
    expect(unauthorized.statusCode).toBe(401);
    await flushLogs();

    const unauthorizedOutput = capture.text();
    for (const leak of [
      "CANARY_SIG",
      "CANARY_TOKEN",
      "X-Amz-Signature",
      "secret.example",
      "version=1",
    ]) {
      expect(unauthorizedOutput).not.toContain(leak);
    }
    entries = parsedLogs(capture);
    expect(entries.find((entry) => entry.msg === "incoming request")).toMatchObject({
      req: { method: "GET", url: "[REDACTED]" },
    });
    expect(entries.find((entry) => entry.msg === "request completed")).toMatchObject({
      res: { statusCode: 401 },
    });
  });

  it("returns a generic 404 body without echoing the request URL", async () => {
    const res = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask/unknown-action?X-Amz-Signature=CANARY_404_BODY_SIG&token=CANARY_404_BODY_TOKEN&encoded=https%3A%2F%2Fsecret.example`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: "Route not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(res.body).not.toContain("CANARY_404_BODY_SIG");
    expect(res.body).not.toContain("X-Amz-Signature");
    expect(res.body).not.toContain("/artifacts");

    await flushLogs();
    const output = capture.text();
    for (const leak of [
      "CANARY_404_BODY_SIG",
      "CANARY_404_BODY_TOKEN",
      "X-Amz-Signature",
      "secret.example",
      "/artifacts",
    ]) {
      expect(output).not.toContain(leak);
    }
    const completed = parsedLogs(capture).find(
      (entry) => entry.msg === "request completed",
    );
    expect(completed).toMatchObject({ res: { statusCode: 404 } });
  });

  it("logs a successful download without the signed URL or locators", async () => {
    const study = await seedStudy(doctorA.id);
    const artifact = await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/v1.png",
    });
    vi.mocked(storage.getDownloadUrl).mockResolvedValueOnce(
      "https://signed.example/mask/v1.png?X-Amz-Signature=CANARY_URL_SIG&token=CANARY_URL_TOKEN",
    );

    const res = await logged.inject({
      method: "GET",
      url: urlFor(study, "mask", "?version=1"),
      headers: headersA,
    });
    expect(res.statusCode).toBe(200);
    // The HTTP body legitimately carries the signed URL (3.4); only logs are
    // restricted, so the response is asserted instead of hidden.
    expect(res.json()).toMatchObject({
      url: "https://signed.example/mask/v1.png?X-Amz-Signature=CANARY_URL_SIG&token=CANARY_URL_TOKEN",
    });
    await flushLogs();

    const output = capture.text();
    for (const leak of [
      "CANARY_URL_SIG",
      "CANARY_URL_TOKEN",
      "signed.example",
      "mask-bucket",
      "mask/v1.png",
    ]) {
      expect(output).not.toContain(leak);
    }
    const entries = parsedLogs(capture);
    const incoming = entries.find((entry) => entry.msg === "incoming request");
    expect(incoming).toMatchObject({ req: { method: "GET", url: "[REDACTED]" } });
    expect(entries.find((entry) => entry.msg === "request completed")).toMatchObject({
      reqId: incoming?.reqId,
      res: { statusCode: 200 },
    });

    const events = await auditRows("ARTIFACT_URL_ISSUED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetType: "ARTIFACT",
      targetId: artifact.id,
      outcome: "SUCCESS",
      metadata: { reasonCode: "AUTHORIZED_READ" },
    });
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("mask/v1.png");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("CANARY_URL_SIG");
  });

  it("logs missing, storage and audit failures without secrets or locators", async () => {
    const study = await seedStudy(doctorA.id);
    const artifact = await makeArtifact(study.inference.id, "mask", 1, {
      bucket: "mask-bucket",
      key: "mask/v1.png",
    });
    const auditArtifact = await makeArtifact(study.inference.id, "mask", 2, {
      bucket: "mask-bucket",
      key: "mask/v2.png",
    });
    const download = (version = 1) =>
      logged.inject({
        method: "GET",
        url: urlFor(study, "mask", `?version=${version}`),
        headers: headersA,
      });

    vi.mocked(storage.getDownloadUrl).mockRejectedValueOnce(
      new StorageProviderError("storage_object_missing"),
    );
    const missing = await download();
    expect(missing.statusCode).toBe(409);
    await flushLogs();
    const missingOutput = capture.text();
    for (const leak of ["mask-bucket", "mask/v1.png", "CANARY"]) {
      expect(missingOutput).not.toContain(leak);
    }
    expect(parsedLogs(capture).find((entry) => entry.msg === "request completed")).toMatchObject({
      res: { statusCode: 409 },
    });
    const incidents = await auditRows("ARTIFACT_OBJECT_MISSING");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ targetId: artifact.id, outcome: "FAILURE" });

    capture.clear();
    vi.mocked(storage.getDownloadUrl).mockRejectedValueOnce(
      new Error(
        "CANARY_SECRET https://secret.example/object?sig=CANARY_SIG&token=CANARY_TOKEN",
      ),
    );
    const failed = await download();
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("CANARY_SECRET");
    expect(failed.body).not.toContain("secret.example");
    await flushLogs();
    const failedOutput = capture.text();
    for (const leak of [
      "CANARY_SECRET",
      "CANARY_SIG",
      "CANARY_TOKEN",
      "secret.example",
      "mask-bucket",
      "mask/v1.png",
    ]) {
      expect(failedOutput).not.toContain(leak);
    }
    expect(parsedLogs(capture).find((entry) => entry.msg === "request completed")).toMatchObject({
      res: { statusCode: 503 },
    });

    capture.clear();
    await prisma.$executeRawUnsafe(
      `ALTER TABLE audit_events ADD CONSTRAINT qa_fail_artifact_log CHECK (target_id IS DISTINCT FROM '${auditArtifact.id}'::uuid)`,
    );
    try {
      const auditFailure = await download(2);
      expect(auditFailure.statusCode).toBe(503);
      expect(auditFailure.body).not.toContain("https://signed.example");
      await flushLogs();
      const auditOutput = capture.text();
      for (const leak of [
        "https://signed.example",
        "mask-bucket",
        "mask/v1.png",
        "mask/v2.png",
        "CANARY",
      ]) {
        expect(auditOutput).not.toContain(leak);
      }
      expect(
        parsedLogs(capture).find((entry) => entry.msg === "request completed"),
      ).toMatchObject({ res: { statusCode: 503 } });
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE audit_events DROP CONSTRAINT qa_fail_artifact_log",
      );
    }
  });

  // Gap HITO23/3.7: autogenerated framework logs on failure paths. Pino
  // redact.paths cannot censor Fastify's "route not found" message, which
  // interpolates the raw request URL (lib/log-controller.js routeNotFound).
  const CANARY_Q =
    "?X-Amz-Signature=CANARY_SIG&token=CANARY_TOKEN&encoded=https%3A%2F%2Fsecret.example%2Fobject%3Fsig%3DCANARY_ENC";
  const URL_LEAKS = [
    "CANARY_SIG",
    "CANARY_TOKEN",
    "CANARY_ENC",
    "X-Amz-Signature",
    "secret.example",
    "/artifacts",
  ];

  function expectAutogeneratedLogsClean(
    capture: LogCapture,
    method: string,
    statusCode: number,
  ): void {
    const output = capture.text();
    for (const leak of URL_LEAKS) {
      expect(output).not.toContain(leak);
    }
    const entries = parsedLogs(capture);
    expect(entries.find((entry) => entry.msg === "incoming request")).toMatchObject(
      { req: { method, url: "[REDACTED]" } },
    );
    const completed = entries.find((entry) => entry.msg === "request completed");
    expect(completed).toMatchObject({ res: { statusCode } });
    expect(completed?.reqId).toBe(
      entries.find((entry) => entry.msg === "incoming request")?.reqId,
    );
    expect(typeof completed?.reqId).toBe("string");
  }

  it("keeps unknown artifact action 404s out of the autogenerated logs", async () => {
    const res = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask/unknown-action${CANARY_Q}`,
      headers: headersA,
    });
    expect(res.statusCode).toBe(404);
    await flushLogs();
    expectAutogeneratedLogsClean(capture, "GET", 404);
  });

  it("keeps malformed artifact path 404s out of the autogenerated logs", async () => {
    const res = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask${CANARY_Q}`,
      headers: headersA,
    });
    expect(res.statusCode).toBe(404);
    await flushLogs();
    expectAutogeneratedLogsClean(capture, "GET", 404);
  });

  it("keeps wrong-method download requests out of the autogenerated logs", async () => {
    // Fastify resolves a method mismatch through the not-found handler
    // (fastify/fastify#862): 404 on the wire, same routeNotFound log path.
    const res = await logged.inject({
      method: "POST",
      url: `/inferences/${randomUUID()}/artifacts/mask/url${CANARY_Q}`,
      headers: headersA,
    });
    expect(res.statusCode).toBe(404);
    await flushLogs();
    expectAutogeneratedLogsClean(capture, "POST", 404);
  });

  it("rejects hostile query keys without changing authorization or audit semantics", async () => {
    // A CSRF-style hostile query must not alter authorization outcomes.
    const unauth = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask/url${CANARY_Q}`,
    });
    expect(unauth.statusCode).toBe(401);
    expect(await auditRows("ARTIFACT_URL_ISSUED")).toHaveLength(0);
    expect(await auditRows("ARTIFACT_OBJECT_MISSING")).toHaveLength(0);

    capture.clear();
    // A valid version plus unknown keys fails the strict query schema: the
    // hostile URL neither smuggles a success nor writes audit events.
    const strict = await logged.inject({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/mask/url?version=1&X-Amz-Signature=CANARY_SIG&token=CANARY_TOKEN&encoded=https%3A%2F%2Fsecret.example%2Fobject`,
      headers: headersA,
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.json()).toMatchObject({
      error: "bad_request",
      message: "A positive artifact version is required",
      statusCode: 400,
    });
    await flushLogs();
    expectAutogeneratedLogsClean(capture, "GET", 400);
    expect(await auditRows("ARTIFACT_URL_ISSUED")).toHaveLength(0);
    expect(await auditRows("ARTIFACT_OBJECT_MISSING")).toHaveLength(0);
  });
});
