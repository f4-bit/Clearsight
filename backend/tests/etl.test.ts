import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runEtl } from "../scripts/etl-feedback.js";
import { CSV_COLUMNS } from "../src/services/gold-standard-export.js";
import { createRepositories } from "../src/repositories/index.js";
import { createTestPrisma, makeStudy, makeUser, resetDb } from "./helpers/db.js";

const prisma = createTestPrisma();
const repos = createRepositories(prisma);
const hmacSecret = "etl-test-secret-etl-test-secret-1234";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clearsight-etl-"));
});
beforeEach(() => resetDb(prisma));
afterEach(() => undefined);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

async function addGold(doctorId: string, validated: number, predicted: number) {
  const s = await makeStudy(prisma, { doctorId, predictedClass: predicted });
  await repos.feedback.upsertVerdict({
    consultationId: s.consultation.id, inferenceId: s.inference.id, doctorId,
    predictedClass: predicted, validatedClass: validated, confidence: 0.9, agreement: validated === predicted,
    doctorNotes: null, isGoldStandard: true, clinicalData: s.consultation.clinicalData as Record<string, unknown>,
  });
}

describe("runEtl", () => {
  it("writes the CSV, reports class distribution and agreement", async () => {
    const doctor = await makeUser(prisma);
    await addGold(doctor.id, 0, 0);
    await addGold(doctor.id, 1, 1);
    await addGold(doctor.id, 2, 1);

    const out = join(dir, "gold.csv");
    const result = await runEtl(prisma, { out, format: "csv", hmacSecret });

    expect(result).toMatchObject({
      status: "written", rows: 3, hasMore: false,
      classDistribution: { Glaucoma: 1, Non_Glaucoma: 1, Suspicious_Glaucoma: 1 },
    });
    expect(result.agreementRate).toBeCloseTo(2 / 3);
    const lines = (await readFile(out, "utf8")).trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
  });

  it("writes JSON when asked", async () => {
    const doctor = await makeUser(prisma);
    await addGold(doctor.id, 1, 1);
    const out = join(dir, "gold.json");
    await runEtl(prisma, { out, format: "json", hmacSecret });
    const parsed = JSON.parse(await readFile(out, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].validated_label).toBe("Non_Glaucoma");
  });

  it("--min-samples: writes nothing until enough new gold rows accumulate", async () => {
    const doctor = await makeUser(prisma);
    await addGold(doctor.id, 0, 0);
    await addGold(doctor.id, 1, 1);
    const out = join(dir, "gated.csv");

    const short = await runEtl(prisma, { out, format: "csv", hmacSecret, minSamples: 3 });
    expect(short).toMatchObject({ status: "insufficient", rows: 2, out: null });
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });

    await addGold(doctor.id, 2, 2);
    expect((await runEtl(prisma, { out, format: "csv", hmacSecret, minSamples: 3 })).status).toBe("written");
  });

  it("incremental runs: the state file only exports rows validated since the last run", async () => {
    const doctor = await makeUser(prisma);
    await addGold(doctor.id, 0, 0);
    await addGold(doctor.id, 1, 1);
    const state = join(dir, "state.json");
    const out = join(dir, "inc.csv");

    const first = await runEtl(prisma, { out, format: "csv", hmacSecret, statePath: state });
    expect(first.rows).toBe(2);
    expect(JSON.parse(await readFile(state, "utf8")).since).toBe(first.watermark);

    await new Promise((resolve) => setTimeout(resolve, 15));
    await addGold(doctor.id, 2, 2);
    const second = await runEtl(prisma, { out, format: "csv", hmacSecret, statePath: state });
    expect(second.rows).toBe(1);
    expect(second.classDistribution.Suspicious_Glaucoma).toBe(1);

    const third = await runEtl(prisma, { out, format: "csv", hmacSecret, statePath: state });
    expect(third.rows).toBe(0);
  });

  it("excludes non-gold and 'no concluyente' feedback", async () => {
    const doctor = await makeUser(prisma);
    const s = await makeStudy(prisma, { doctorId: doctor.id });
    await repos.feedback.upsertVerdict({
      consultationId: s.consultation.id, inferenceId: s.inference.id, doctorId: doctor.id,
      predictedClass: 1, validatedClass: null, confidence: 0.9, agreement: null, doctorNotes: null, isGoldStandard: false, clinicalData: {},
    });
    const result = await runEtl(prisma, { out: join(dir, "none.csv"), format: "csv", hmacSecret });
    expect(result).toMatchObject({ rows: 0, agreementRate: null });
  });
});
