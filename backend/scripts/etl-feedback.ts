/**
 * ETL: doctor-validated feedback -> retraining dataset.
 *
 * Extracts gold-standard rows (is_gold_standard = true, validated_class not
 * null) from PostgreSQL, anonymizes them and writes a CSV/JSON that
 * `python scripts/retrain_cycle.py --samples <file>` consumes directly.
 *
 *   npx tsx scripts/etl-feedback.ts --out data/gold.csv
 *   npx tsx scripts/etl-feedback.ts --out data/gold.csv --state data/.etl-state.json --min-samples 50
 *
 * Exit codes: 0 ok, 3 not enough new samples (nothing written), 1 error.
 */
import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPrismaClient, type PrismaClient } from "../src/lib/prisma.js";
import { createFeedbackRepository } from "../src/repositories/feedback.repo.js";
import { CLASS_LABELS } from "../src/schemas/common.js";
import { buildGoldStandardExport, toCsv } from "../src/services/gold-standard-export.js";

export interface EtlOptions {
  out: string;
  format: "csv" | "json";
  /** Only rows validated after this instant. Overridden by the state file when present. */
  since?: Date;
  /** JSON file remembering the last exported `validated_at` between runs. */
  statePath?: string;
  /** Do nothing unless at least this many new gold-standard rows exist. */
  minSamples?: number;
  limit?: number;
  hmacSecret: string;
}

export interface EtlResult {
  status: "written" | "insufficient";
  rows: number;
  hasMore: boolean;
  watermark: string | null;
  out: string | null;
  classDistribution: Record<string, number>;
  agreementRate: number | null;
}

async function readWatermark(statePath?: string): Promise<Date | undefined> {
  if (!statePath) return undefined;
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as { since?: string };
    return parsed.since ? new Date(parsed.since) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function runEtl(prisma: PrismaClient, options: EtlOptions): Promise<EtlResult> {
  const feedback = createFeedbackRepository(prisma);
  const since = (await readWatermark(options.statePath)) ?? options.since;

  const { rows, hasMore } = await buildGoldStandardExport(feedback, {
    since,
    limit: options.limit ?? 50_000,
    hmacSecret: options.hmacSecret,
  });

  const classDistribution: Record<string, number> = Object.fromEntries(CLASS_LABELS.map((label) => [label, 0]));
  let compared = 0;
  let agreed = 0;
  for (const row of rows) {
    const label = row.validated_label;
    if (label) classDistribution[label] = (classDistribution[label] ?? 0) + 1;
    if (row.agreement !== null) {
      compared++;
      if (row.agreement) agreed++;
    }
  }
  const agreementRate = compared === 0 ? null : agreed / compared;

  if (options.minSamples !== undefined && rows.length < options.minSamples) {
    return { status: "insufficient", rows: rows.length, hasMore, watermark: since?.toISOString() ?? null, out: null, classDistribution, agreementRate };
  }

  const content = options.format === "csv" ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`;
  await writeAtomic(options.out, content);

  // Advance the watermark only after the file is safely on disk.
  const last = rows.at(-1);
  const watermark = last?.validated_at ?? since?.toISOString() ?? null;
  if (options.statePath && watermark) {
    await writeAtomic(options.statePath, `${JSON.stringify({ since: watermark }, null, 2)}\n`);
  }

  return { status: "written", rows: rows.length, hasMore, watermark, out: resolve(options.out), classDistribution, agreementRate };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "gold-standard.csv" },
      format: { type: "string" },
      since: { type: "string" },
      state: { type: "string" },
      "min-samples": { type: "string" },
      limit: { type: "string" },
    },
  });

  const format = (values.format ?? (values.out?.endsWith(".json") ? "json" : "csv")) as "csv" | "json";
  if (format !== "csv" && format !== "json") throw new Error(`--format must be csv or json, got "${format}"`);

  const hmacSecret = process.env.EXPORT_HMAC_SECRET;
  if (!hmacSecret) throw new Error("EXPORT_HMAC_SECRET is required (it pseudonymizes doctor ids)");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await runEtl(prisma, {
      out: values.out as string,
      format,
      since: values.since ? new Date(values.since) : undefined,
      statePath: values.state,
      minSamples: values["min-samples"] ? Number(values["min-samples"]) : undefined,
      limit: values.limit ? Number(values.limit) : undefined,
      hmacSecret,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "insufficient") {
      console.error(`Only ${result.rows} new gold-standard rows (< --min-samples); nothing written.`);
      return 3;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
