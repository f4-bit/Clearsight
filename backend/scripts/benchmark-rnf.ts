import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import sharp from "sharp";

/**
 * RNF full-flow benchmark harness (load -> result).
 *
 * This script is NOT executed by the closing change or the test suite. It only
 * documents and implements the measurement methodology: each sample creates a
 * consultation, uploads a synthetic sanitized image, submits an inference with
 * an Idempotency-Key and polls until the delivery stops. It reports observed
 * values (p95/median/mean) and the declared environment. It never asserts an
 * RNF target nor claims compliance.
 */

interface Options {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly patientId: string;
  readonly clinicalFeatures: Record<string, unknown>;
  readonly concurrency: number;
  readonly iterations: number;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly imageSize: number;
  readonly eyeSide: "OD" | "OS";
}

interface Sample {
  readonly index: number;
  readonly loadMs: number;
  readonly submitMs: number;
  readonly resultMs: number;
  readonly totalMs: number;
  readonly status: string;
}

interface Failure {
  readonly index: number;
  readonly message: string;
}

interface ApiResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T | null;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
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
    }
  }
  return values;
}

function readOption(
  values: Map<string, string>,
  name: string,
  envName: string,
): string | undefined {
  return values.get(name) ?? process.env[envName];
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.round(ratio * (sorted.length - 1)));
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function summarize(values: readonly number[]): {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const mean =
    sorted.length === 0
      ? 0
      : sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    meanMs: Number(mean.toFixed(3)),
    medianMs: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    minMs: Number((sorted[0] ?? 0).toFixed(3)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function loadOptions(): Promise<Options> {
  const values = parseArgs(process.argv.slice(2));
  const baseUrl = readOption(values, "base-url", "RNF_BASE_URL");
  const accessToken = readOption(values, "access-token", "RNF_ACCESS_TOKEN");
  const patientId = readOption(values, "patient-id", "RNF_PATIENT_ID");
  const featuresPath = readOption(
    values,
    "clinical-features",
    "RNF_CLINICAL_FEATURES_FILE",
  );

  if (baseUrl === undefined) {
    throw new Error("--base-url (or RNF_BASE_URL) is required");
  }
  if (accessToken === undefined) {
    throw new Error("--access-token (or RNF_ACCESS_TOKEN) is required");
  }
  if (patientId === undefined) {
    throw new Error("--patient-id (or RNF_PATIENT_ID) is required");
  }
  if (featuresPath === undefined) {
    throw new Error(
      "--clinical-features <json-file> (or RNF_CLINICAL_FEATURES_FILE) is required",
    );
  }

  const parsedFeatures: unknown = JSON.parse(await readFile(featuresPath, "utf8"));
  if (
    parsedFeatures === null ||
    typeof parsedFeatures !== "object" ||
    Array.isArray(parsedFeatures)
  ) {
    throw new Error("clinical features file must contain a JSON object");
  }

  const eyeSideRaw = values.get("eye-side") ?? process.env.RNF_EYE_SIDE ?? "OD";
  if (eyeSideRaw !== "OD" && eyeSideRaw !== "OS") {
    throw new Error("--eye-side must be OD or OS");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accessToken,
    patientId,
    clinicalFeatures: parsedFeatures as Record<string, unknown>,
    concurrency: positiveInt(
      readOption(values, "concurrency", "RNF_CONCURRENCY"),
      50,
      "concurrency",
    ),
    iterations: positiveInt(
      readOption(values, "iterations", "RNF_ITERATIONS"),
      50,
      "iterations",
    ),
    pollIntervalMs: positiveInt(
      readOption(values, "poll-interval-ms", "RNF_POLL_INTERVAL_MS"),
      500,
      "poll-interval-ms",
    ),
    timeoutMs: positiveInt(
      readOption(values, "timeout-ms", "RNF_TIMEOUT_MS"),
      180_000,
      "timeout-ms",
    ),
    imageSize: positiveInt(
      readOption(values, "image-size", "RNF_IMAGE_SIZE"),
      640,
      "image-size",
    ),
    eyeSide: eyeSideRaw,
  };
}

async function requestJson<T>(
  options: Options,
  path: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<ApiResponse<T>> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length === 0 ? null : (JSON.parse(text) as T),
  };
}

async function requestMultipart<T>(
  options: Options,
  path: string,
  payload: Buffer,
  contentType: string,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      "content-type": contentType,
    },
    body: payload,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length === 0 ? null : (JSON.parse(text) as T),
  };
}

function multipart(
  boundary: string,
  parts: ReadonlyArray<
    | { readonly name: string; readonly value: string }
    | { readonly name: string; readonly filename: string; readonly content: Buffer }
  >,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        ),
      );
      continue;
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      part.content,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function buildSyntheticImage(size: number): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 128, g: 72, b: 40 },
    },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function pollUntilTerminal(
  options: Options,
  inferenceId: string,
  deadline: number,
): Promise<{ status: string; elapsedMs: number }> {
  const started = performance.now();
  while (Date.now() < deadline) {
    const response = await requestJson<{
      status?: unknown;
      pollingStop?: unknown;
      delivery?: { deliveryTerminal?: unknown };
    }>(options, `/inferences/${inferenceId}`, { method: "GET" });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`GET /inferences/:id returned ${response.status}`);
    }
    const status = String(response.body.status ?? "UNKNOWN");
    const pollingStop = String(response.body.pollingStop ?? "CONTINUE");
    const deliveryTerminal = response.body.delivery?.deliveryTerminal === true;
    if (pollingStop !== "CONTINUE" || deliveryTerminal) {
      return { status, elapsedMs: performance.now() - started };
    }
    await sleep(options.pollIntervalMs);
  }
  throw new Error("inference polling timed out");
}

async function runSample(
  options: Options,
  index: number,
  image: Buffer,
): Promise<Sample> {
  const deadline = Date.now() + options.timeoutMs;
  const started = performance.now();

  const consultation = await requestJson<{ id?: unknown }>(
    options,
    "/consultations",
    {
      method: "POST",
      body: JSON.stringify({
        patientId: options.patientId,
        status: "QUEUED",
        clinicalData: options.clinicalFeatures,
      }),
    },
  );
  if (consultation.status !== 201 || typeof consultation.body?.id !== "string") {
    throw new Error(`POST /consultations returned ${consultation.status}`);
  }
  const consultationId = consultation.body.id;

  const boundary = `----clearsight-rnf${randomUUID()}`;
  const form = multipart(boundary, [
    { name: "eyeSide", value: options.eyeSide },
    { name: "file", filename: "retina.jpg", content: image },
  ]);
  const upload = await requestMultipart<{ id?: unknown }>(
    options,
    `/consultations/${consultationId}/images`,
    form,
    `multipart/form-data; boundary=${boundary}`,
  );
  if (upload.status !== 201 || typeof upload.body?.id !== "string") {
    throw new Error(`POST /consultations/:id/images returned ${upload.status}`);
  }
  const loadMs = performance.now() - started;

  const submitStarted = performance.now();
  const inference = await requestJson<{ inferenceId?: unknown }>(
    options,
    "/inferences",
    {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({
        imageId: upload.body.id,
        eyeSide: options.eyeSide,
        clinicalFeatures: options.clinicalFeatures,
      }),
    },
  );
  if (inference.status !== 202 || typeof inference.body?.inferenceId !== "string") {
    throw new Error(`POST /inferences returned ${inference.status}`);
  }
  const inferenceId = inference.body.inferenceId;
  const submitMs = performance.now() - submitStarted;

  const terminal = await pollUntilTerminal(options, inferenceId, deadline);
  return {
    index,
    loadMs: Number(loadMs.toFixed(3)),
    submitMs: Number(submitMs.toFixed(3)),
    resultMs: Number(terminal.elapsedMs.toFixed(3)),
    totalMs: Number((performance.now() - started).toFixed(3)),
    status: terminal.status,
  };
}

async function main(): Promise<void> {
  const options = await loadOptions();
  const image = await buildSyntheticImage(options.imageSize);

  const samples: Sample[] = [];
  const failures: Failure[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.iterations) {
        return;
      }
      try {
        samples.push(await runSample(options, index, image));
      } catch (error) {
        failures.push({
          index,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  };

  const workers = Math.min(options.concurrency, options.iterations);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  samples.sort((left, right) => left.index - right.index);
  const totals = samples.map((sample) => sample.totalMs);
  const loads = samples.map((sample) => sample.loadMs);
  const submits = samples.map((sample) => sample.submitMs);
  const results = samples.map((sample) => sample.resultMs);

  process.stdout.write(
    `${JSON.stringify(
      {
        tool: "benchmark-rnf",
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
          concurrency: options.concurrency,
          imageSize: options.imageSize,
          eyeSide: options.eyeSide,
          pollIntervalMs: options.pollIntervalMs,
          timeoutMs: options.timeoutMs,
          flow: "create consultation -> upload synthetic image -> POST /inferences -> poll delivery",
        },
        observed: {
          completed: samples.length,
          failed: failures.length,
          statuses: samples.reduce<Record<string, number>>((counts, sample) => {
            counts[sample.status] = (counts[sample.status] ?? 0) + 1;
            return counts;
          }, {}),
        },
        metricsMs: {
          load: summarize(loads),
          submit: summarize(submits),
          result: summarize(results),
          total: summarize(totals),
        },
        failures,
        samples,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `benchmark-rnf failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
