import { cpus, arch, platform, release, totalmem } from "node:os";
import sharp from "sharp";
import {
  renderBasicPdf,
  type RenderBasicPdfInput,
} from "../src/services/pdf-report.js";

/**
 * Lightweight HU08 measurement harness.
 *
 * It renders N synthetic basic reports and reports elapsed time, environment,
 * output size and embedded image count. It is intentionally NOT executed by the
 * test suite or the closing change; run it only in an approved isolated
 * environment and report observed values without asserting compliance.
 */

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const CONSULTATION_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";

const FEATURES = {
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
} as const;

interface Sample {
  readonly index: number;
  readonly elapsedMs: number;
  readonly bytes: number;
  readonly imageCount: number;
}

interface Summary {
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanBytes: number;
  readonly meanImageCount: number;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): {
  iterations: number;
  imageSize: number;
  warmup: number;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(argument.slice(2), next);
      index += 1;
    } else {
      values.set(argument.slice(2), "true");
    }
  }
  return {
    iterations: parsePositiveInt(
      values.get("iterations") ?? process.env.BENCHMARK_PDF_ITERATIONS,
      20,
      "iterations",
    ),
    imageSize: parsePositiveInt(
      values.get("image-size") ?? process.env.BENCHMARK_PDF_IMAGE_SIZE,
      768,
      "image-size",
    ),
    warmup: parsePositiveInt(
      values.get("warmup") ?? process.env.BENCHMARK_PDF_WARMUP,
      3,
      "warmup",
    ),
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.round(ratio * (sorted.length - 1)));
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function summarize(samples: readonly Sample[]): Summary {
  const elapsed = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const bytes = samples.map((sample) => sample.bytes);
  const images = samples.map((sample) => sample.imageCount);
  const mean = (values: readonly number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((total, value) => total + value, 0) / values.length;
  return {
    meanMs: Number(mean(elapsed).toFixed(3)),
    medianMs: Number(percentile(elapsed, 0.5).toFixed(3)),
    p95Ms: Number(percentile(elapsed, 0.95).toFixed(3)),
    minMs: Number((elapsed[0] ?? 0).toFixed(3)),
    maxMs: Number((elapsed[elapsed.length - 1] ?? 0).toFixed(3)),
    meanBytes: Math.round(mean(bytes)),
    meanImageCount: Number(mean(images).toFixed(2)),
  };
}

async function buildSyntheticInput(
  imageSize: number,
): Promise<RenderBasicPdfInput> {
  const original = await sharp({
    create: {
      width: imageSize,
      height: imageSize,
      channels: 3,
      background: { r: 128, g: 72, b: 40 },
    },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
  const mask = await sharp({
    create: {
      width: imageSize,
      height: imageSize,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  const overlay = await sharp({
    create: {
      width: imageSize,
      height: imageSize,
      channels: 3,
      background: { r: 220, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer();

  return {
    inference: {
      id: INFERENCE_ID,
      consultationId: CONSULTATION_ID,
      eyeSide: "OD",
      predictedClass: 2,
      confidence: 0.87,
      probabilities: {
        Glaucoma: 0.1,
        Non_Glaucoma: 0.03,
        Suspicious_Glaucoma: 0.87,
      },
      cdr: 0.42,
      cdrVertical: 0.38,
      quality: { segmentation: 0.91, blur: 0.02 },
      elapsedSeconds: 3.5,
      modelVersion: "benchmark-v1",
      modelVersions: { manifest: "benchmark-v1" },
      modelPredictions: {
        ensemble: {
          predictedClass: "Suspicious_Glaucoma",
          confidence: 0.87,
          probabilities: {
            Glaucoma: 0.1,
            Non_Glaucoma: 0.03,
            Suspicious_Glaucoma: 0.87,
          },
        },
      },
      status: "COMPLETED",
      createdAt: "2026-11-20T10:00:00.000Z",
    },
    snapshot: {
      consultationId: CONSULTATION_ID,
      schemaVersion: "benchmark-schema-v1",
      rawPayload: FEATURES,
      modelVersions: { manifest: "benchmark-v1" },
    },
    image: {
      storagePath: "raw-retinas/benchmark.jpg",
      eyeSide: "OD",
    },
    originalBytes: original,
    maskBytes: mask,
    overlayBytes: overlay,
    reportId: REPORT_ID,
    version: 1,
    generatedAt: "2026-11-20T11:00:00.000Z",
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = await buildSyntheticInput(options.imageSize);

  for (let index = 0; index < options.warmup; index += 1) {
    await renderBasicPdf(input);
  }

  const samples: Sample[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const started = performance.now();
    const pdf = await renderBasicPdf(input);
    samples.push({
      index,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      bytes: pdf.byteLength,
      imageCount: 3,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        tool: "benchmark-pdf",
        measuredAt: new Date().toISOString(),
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpuCount: cpus().length,
          totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
        },
        workload: {
          iterations: options.iterations,
          warmup: options.warmup,
          imageSize: options.imageSize,
          embeddedImagesPerReport: 3,
        },
        summary: summarize(samples),
        samples,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `benchmark-pdf failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
