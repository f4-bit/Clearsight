import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLINICAL_FEATURE_NAMES } from "../src/schemas/clinical.js";
import { CSV_COLUMNS, pseudonymize, toCsv, type GoldStandardRow } from "../src/services/gold-standard-export.js";
import { createRepositories } from "../src/repositories/index.js";
import { bearer, buildTestApp, TEST_ENV } from "./helpers/app.js";
import { createTestPrisma, FEATURES, makeStudy, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
const repos = createRepositories(prisma);
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp(prisma);
});
beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

interface Study {
  inference: { id: string };
  consultation: { id: string };
}

/** Explicit active export approval for exactly one inference/consultation pair. */
async function grantExport(recipientUserId: string, study: Study): Promise<void> {
  await prisma.inferenceAccessGrant.create({
    data: {
      inferenceId: study.inference.id,
      consultationId: study.consultation.id,
      recipientUserId,
      approvalReference: `EXPORT-${randomUUID()}`,
      canExportGoldStandard: true,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function seedFeedback(
  doctorId: string,
  opts: { validated: number | null; gold: boolean; predicted?: number | null; notes?: string; clinicalData?: Record<string, unknown>; modelVersion?: string },
) {
  const study = await makeStudy(prisma, { doctorId, predictedClass: opts.predicted ?? 1, clinicalData: opts.clinicalData, modelVersion: opts.modelVersion });
  const predicted = study.inference.predictedClass;
  await repos.feedback.upsertVerdict({
    consultationId: study.consultation.id, inferenceId: study.inference.id, doctorId,
    predictedClass: predicted, validatedClass: opts.validated, confidence: study.inference.confidence,
    agreement: opts.validated === null || predicted === null ? null : opts.validated === predicted,
    doctorNotes: opts.notes ?? null, isGoldStandard: opts.gold, clinicalData: opts.clinicalData ?? { ...FEATURES },
  });
  return study;
}

const get = async (
  query: string,
  user: { id: string; role: "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN" },
) =>
  app.inject({
    method: "GET",
    url: `/export/gold-standard${query}`,
    headers: await bearer(app, prisma, user),
  });

describe("GET /export/gold-standard", () => {
  it("401 anonymous, 403 for ophthalmologists, 403 without grant, 200 with an active grant", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const admin = await makeUser(prisma, "ADMIN");
    const study = await seedFeedback(doctor.id, { validated: 0, gold: true, predicted: 0 });

    expect((await app.inject({ method: "GET", url: "/export/gold-standard" })).statusCode).toBe(401);
    expect((await get("", doctor)).statusCode).toBe(403);
    expect((await get("", researcher)).statusCode).toBe(403);
    expect((await get("", admin)).statusCode).toBe(403);

    await grantExport(researcher.id, study);
    await grantExport(admin.id, study);
    expect((await get("", researcher)).statusCode).toBe(200);
    expect((await get("", admin)).statusCode).toBe(200);
  });

  it("422 on invalid query parameters for an authorized dataset account", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const study = await seedFeedback(doctor.id, { validated: 1, gold: true });
    await grantExport(researcher.id, study);
    for (const q of ["?format=xml", "?limit=0", "?limit=999999", "?since=yesterday"]) {
      expect((await get(q, researcher)).statusCode, q).toBe(422);
    }
  });

  it("returns only approved gold-standard rows, anonymized, with features and labels", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const gold = await seedFeedback(doctor.id, { validated: 2, gold: true, predicted: 1, notes: "paciente Juan Perez, HC 123" });
    await seedFeedback(doctor.id, { validated: 1, gold: false });
    await seedFeedback(doctor.id, { validated: null, gold: false });
    await grantExport(researcher.id, gold);

    const res = await get("", researcher);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ count: 1, has_more: false });

    const [item] = body.items;
    expect(item).toMatchObject({
      inference_id: gold.inference.id,
      eye_side: "OD",
      model_version: "2026-09-24",
      predicted_class: 1,
      validated_class: 2,
      validated_label: "Suspicious_Glaucoma",
      agreement: false,
      is_gold_standard: true,
      features: { ...FEATURES },
    });
    expect(Object.keys(item.features)).toEqual([...CLINICAL_FEATURE_NAMES]);
    expect(item.doctor_id).toBe(pseudonymize(TEST_ENV.EXPORT_HMAC_SECRET, doctor.id));

    const raw = res.body;
    for (const secret of [doctor.id, gold.consultation.id, gold.patient.id, "Juan Perez", "doctor_notes"]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("never exports a gold row whose inference is not explicitly approved", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const approved = await seedFeedback(doctor.id, { validated: 0, gold: true });
    const unapproved = await seedFeedback(doctor.id, { validated: 1, gold: true });
    await grantExport(researcher.id, approved);

    const body = (await get("", researcher)).json();
    expect(body.count).toBe(1);
    expect(body.items[0].inference_id).toBe(approved.inference.id);
    expect(body.items[0].inference_id).not.toBe(unapproved.inference.id);
  });

  it("never exports a cross-case legacy feedback row even if both ids are individually approved", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const studyA = await seedFeedback(doctor.id, { validated: 0, gold: true });
    const studyB = await seedFeedback(doctor.id, { validated: 1, gold: true });
    // Legacy mismatch: the feedback row keeps inference A but is re-pointed to
    // consultation B. Approving both pairs must not export the cross-case row.
    await prisma.clinicalFeedback.updateMany({
      where: { inferenceId: studyA.inference.id },
      data: { consultationId: studyB.consultation.id },
    });
    await grantExport(researcher.id, studyA);
    await grantExport(researcher.id, studyB);

    const body = (await get("", researcher)).json();
    expect(body.items.map((i: { inference_id: string }) => i.inference_id)).toEqual([
      studyB.inference.id,
    ]);
  });

  it("ignores client-supplied scope ids instead of expanding the approved set", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const approved = await seedFeedback(doctor.id, { validated: 0, gold: true });
    const unapproved = await seedFeedback(doctor.id, { validated: 1, gold: true });
    await grantExport(researcher.id, approved);

    const body = (
      await get(
        `?ids=${unapproved.inference.id}&inferenceId=${unapproved.inference.id}&consultationId=${unapproved.consultation.id}`,
        researcher,
      )
    ).json();
    expect(body.count).toBe(1);
    expect(body.items[0].inference_id).toBe(approved.inference.id);
  });

  it("falls back to the consultation's clinical data when the feedback snapshot is empty", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const s = await seedFeedback(doctor.id, { validated: 0, gold: true });
    await prisma.clinicalFeedback.updateMany({ where: { inferenceId: s.inference.id }, data: { clinicalData: {} } });
    await grantExport(researcher.id, s);

    const [item] = (await get("", researcher)).json().items;
    expect(item.features.Age).toBe(FEATURES.Age);
  });

  it("pseudonyms are stable per doctor and differ between doctors", async () => {
    const d1 = await makeUser(prisma, "OFTALMOLOGO");
    const d2 = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const s1 = await seedFeedback(d1.id, { validated: 0, gold: true });
    const s2 = await seedFeedback(d1.id, { validated: 1, gold: true });
    const s3 = await seedFeedback(d2.id, { validated: 1, gold: true });
    await grantExport(researcher.id, s1);
    await grantExport(researcher.id, s2);
    await grantExport(researcher.id, s3);

    const ids = (await get("", researcher)).json().items.map((i: { doctor_id: string }) => i.doctor_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("honours the approved scope before limit/has_more and since", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const studies = [];
    for (let i = 0; i < 3; i++) studies.push(await seedFeedback(doctor.id, { validated: i % 3, gold: true }));
    for (const study of studies) await grantExport(researcher.id, study);

    const page = (await get("?limit=2", researcher)).json();
    expect(page).toMatchObject({ count: 2, has_more: true });

    const future = encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString());
    expect((await get(`?since=${future}`, researcher)).json()).toMatchObject({ count: 0, has_more: false });
    const past = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
    expect((await get(`?since=${past}`, researcher)).json().count).toBe(3);
  });

  it("CSV: headers match what scripts/retrain_cycle.py reads", async () => {
    const doctor = await makeUser(prisma, "OFTALMOLOGO");
    const researcher = await makeUser(prisma, "INVESTIGADOR");
    const study = await seedFeedback(doctor.id, { validated: 0, gold: true, predicted: 0 });
    await grantExport(researcher.id, study);

    const res = await get("?format=csv", researcher);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="gold-standard-\d{4}-\d{2}-\d{2}\.csv"/);

    const [header, line] = res.body.trim().split("\n") as [string, string];
    const columns = header.split(",");
    expect(columns).toEqual([...CSV_COLUMNS]);
    for (const needed of ["inference_id", "validated_class", "predicted_class", "doctor_id", "agreement", "is_gold_standard", ...CLINICAL_FEATURE_NAMES]) {
      expect(columns).toContain(needed);
    }
    const row = Object.fromEntries(columns.map((c, i) => [c, line.split(",")[i]]));
    expect(row).toMatchObject({ validated_class: "0", predicted_class: "0", agreement: "true", is_gold_standard: "true", Age: "63", "Phakic/Pseudophakic": "1", VF_DM: "-3.2" });
  });
});

describe("toCsv", () => {
  const row = (over: Partial<GoldStandardRow>): GoldStandardRow => ({
    inference_id: "i", doctor_id: "d", eye_side: "OD", image_path: "2026/10/a.jpg", model_version: "v1",
    predicted_class: null, validated_class: 1, validated_label: "Non_Glaucoma", agreement: null, is_gold_standard: true,
    validated_at: "2026-10-27T00:00:00.000Z",
    features: Object.fromEntries(CLINICAL_FEATURE_NAMES.map((n) => [n, null])) as GoldStandardRow["features"],
    ...over,
  });

  it("leaves nulls blank, quotes commas/quotes/newlines and neutralizes formula injection", () => {
    const csv = toCsv([row({ model_version: '=HYPERLINK("x")', image_path: "a,b\nc" })]);
    const line = csv.split("\n").slice(1).join("\n");
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain('"a,b\nc"');
    expect(line.split(",")[2]).toBe(""); // predicted_class null
  });

  it("emits only the header for an empty batch", () => {
    expect(toCsv([]).trim().split("\n")).toHaveLength(1);
  });
});
