import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, makeStudy, makeUser, resetDb } from "./helpers/db.js";
import { bearer, buildTestApp } from "./helpers/app.js";

const prisma = createTestPrisma();
let app: FastifyInstance;

beforeAll(async () => {
  app = buildTestApp(prisma);
  await app.ready();
});
beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function setup(over: Parameters<typeof makeStudy>[1] extends infer T ? Partial<T> : never = {}) {
  const doctor = await makeUser(prisma, "OFTALMOLOGO");
  const study = await makeStudy(prisma, { doctorId: doctor.id, ...over });
  const post = (payload: unknown, user: { id: string; role: "OFTALMOLOGO" | "INVESTIGADOR" | "ADMIN" } = doctor) =>
    app.inject({ method: "POST", url: "/feedback", headers: bearer(app, user), payload: payload as object });
  const body = (extra: object = {}) => ({
    consultation_id: study.consultation.id,
    inference_id: study.inference.id,
    validated_class: 0,
    ...extra,
  });
  return { doctor, study, post, body };
}

describe("POST /feedback", () => {
  it("401 without a valid token", async () => {
    const { body } = await setup();
    expect((await app.inject({ method: "POST", url: "/feedback", payload: body() })).statusCode).toBe(401);
    const forged = await app.inject({ method: "POST", url: "/feedback", payload: body(), headers: { authorization: "Bearer nope" } });
    expect(forged.statusCode).toBe(401);
  });

  it("403 for roles other than OFTALMOLOGO", async () => {
    const { post, body } = await setup();
    for (const role of ["INVESTIGADOR", "ADMIN"] as const) {
      const other = await makeUser(prisma, role);
      expect((await post(body(), other)).statusCode).toBe(403);
    }
  });

  it("403 when the consultation belongs to another doctor", async () => {
    const { post, body } = await setup();
    const intruder = await makeUser(prisma, "OFTALMOLOGO");
    expect((await post(body(), intruder)).statusCode).toBe(403);
    expect(await prisma.clinicalFeedback.count()).toBe(0);
  });

  it("403 when the body claims to be another doctor", async () => {
    const { post, body } = await setup();
    expect((await post(body({ doctor_id: randomUUID() }))).statusCode).toBe(403);
  });

  it("404 for an unknown inference; 422 when consultation_id does not match", async () => {
    const { post, body } = await setup();
    expect((await post(body({ inference_id: randomUUID() }))).statusCode).toBe(404);
    expect((await post(body({ consultation_id: randomUUID() }))).statusCode).toBe(422);
  });

  it.each([
    ["class out of range", { validated_class: 3 }],
    ["missing class", { validated_class: undefined }],
    ["gold on no-concluyente", { validated_class: null, is_gold_standard: true }],
    ["bad uuid", { inference_id: "x" }],
    ["notes too long", { doctor_notes: "a".repeat(5001) }],
  ])("422 on %s", async (_name, extra) => {
    const { post, body } = await setup();
    const res = await post(body(extra));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("validation_error");
    expect(await prisma.clinicalFeedback.count()).toBe(0);
  });

  it("stores the verdict and derives model output + agreement server-side", async () => {
    const { doctor, study, post, body } = await setup({ predictedClass: 2, confidence: 0.77 });

    // The client lies about prediction/confidence/agreement: all ignored.
    const res = await post(body({ validated_class: 2, is_gold_standard: true, doctor_notes: "ok", predicted_class: 0, confidence: 0.01, agreement: false }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      consultation_id: study.consultation.id,
      inference_id: study.inference.id,
      doctor_id: doctor.id,
      validated_class: 2,
      predicted_class: 2,
      confidence: 0.77,
      agreement: true,
      doctor_notes: "ok",
      is_gold_standard: true,
    });
    const row = await prisma.clinicalFeedback.findFirstOrThrow();
    expect(row.clinicalData).toMatchObject({ Age: 63, "Phakic/Pseudophakic": 1, VF_DM: -3.2 });
  });

  it("agreement is false when the doctor rectifies the model", async () => {
    const { post, body } = await setup({ predictedClass: 1 });
    expect((await post(body({ validated_class: 0 }))).json().agreement).toBe(false);
  });

  it("'no concluyente' (null) is accepted, has no agreement and is never gold", async () => {
    const { post, body } = await setup();
    const res = await post(body({ validated_class: null }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ validated_class: null, agreement: null, is_gold_standard: false });
  });

  it("agreement is null when the model produced no class (REVIEW_REQUIRED)", async () => {
    const { post, body } = await setup({ predictedClass: null, confidence: null });
    expect((await post(body({ validated_class: 1 }))).json()).toMatchObject({ predicted_class: null, agreement: null });
  });

  it("is an upsert: re-sending overwrites the doctor's previous verdict", async () => {
    const { post, body } = await setup({ predictedClass: 1 });
    const first = (await post(body({ validated_class: 0 }))).json();
    const second = (await post(body({ validated_class: 1, is_gold_standard: true }))).json();

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ validated_class: 1, agreement: true, is_gold_standard: true });
    expect(second.created_at).toBe(first.created_at);
    expect(await prisma.clinicalFeedback.count()).toBe(1);
  });

  it("can demote a previous gold-standard verdict to inconclusive", async () => {
    const { post, body } = await setup();
    await post(body({ validated_class: 1, is_gold_standard: true }));
    const res = await post(body({ validated_class: null }));
    expect(res.json()).toMatchObject({ validated_class: null, is_gold_standard: false });
  });
});

describe("GET /health", () => {
  it("is public", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
  });
});
