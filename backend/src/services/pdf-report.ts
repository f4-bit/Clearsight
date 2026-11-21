import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import sharp from "sharp";
import { CLASS_LABELS } from "../schemas/common.js";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const BODY_SIZE = 9;
const BODY_LINE_HEIGHT = 12;
const TITLE_SIZE = 16;
const HEADING_SIZE = 11;
const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2000;
const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Fixed, generic running header. No real institution or logo is embedded. */
const RUNNING_HEADER = "Clearsight - Informe de apoyo a la investigación";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_STATUSES = new Set([
  "QUEUED",
  "DOWNLOADING",
  "LOCALIZING",
  "SEGMENTING",
  "CLASSIFYING",
  "COMPLETED",
  "REVIEW_REQUIRED",
  "FAILED",
]);

/**
 * The 11 clinical variables known to the ML request contract. There is no
 * backend codebook yet, so every value is rendered as non-interpretable.
 */
export const CLINICAL_FEATURE_KEYS = [
  "Age",
  "Gender",
  "dioptre_1",
  "dioptre_2",
  "astigmatism",
  "Phakic/Pseudophakic",
  "Pneumatic",
  "Perkins",
  "Pachymetry",
  "Axial_Length",
  "VF_DM",
] as const;

export interface PdfInferenceInput {
  readonly id: string;
  readonly consultationId?: string | null;
  readonly eyeSide?: string | null;
  readonly predictedClass: number | null;
  readonly confidence: number | null;
  readonly probabilities?: Readonly<Record<string, number>> | null;
  readonly cdr: number | null;
  readonly cdrVertical: number | null;
  readonly quality?: Readonly<Record<string, unknown>> | null;
  readonly elapsedSeconds?: number | null;
  readonly modelVersion?: string | null;
  readonly modelVersions?: Readonly<Record<string, unknown>> | null;
  readonly modelPredictions?: Readonly<Record<string, unknown>> | null;
  readonly status?: string | null;
  readonly createdAt?: Date | string | null;
}

export interface PdfSnapshotInput {
  readonly consultationId?: string | null;
  readonly schemaVersion: string;
  readonly rawPayload?: unknown;
  readonly modelVersions?: Readonly<Record<string, unknown>> | null;
}

export interface PdfImageInput {
  readonly storagePath: string;
  readonly eyeSide?: string | null;
}

export interface RenderBasicPdfInput {
  readonly inference: PdfInferenceInput;
  readonly snapshot: PdfSnapshotInput;
  readonly image: PdfImageInput;
  /** Original upload bytes. Loaded by the caller through the artifact seam. */
  readonly originalBytes?: Uint8Array | null;
  /** Mask bytes resolved from Inference.artifacts, never gradcamPath. */
  readonly maskBytes?: Uint8Array | null;
  /** Overlay bytes resolved from Inference.artifacts, never gradcamPath. */
  readonly overlayBytes?: Uint8Array | null;
  readonly reportId: string;
  readonly version: number;
  readonly generatedAt?: Date | string;
  readonly warnings?: readonly string[];
  readonly reviewRequired?: boolean;
}

export type PdfReportErrorCode =
  | "pdf_report_invalid_input"
  | "pdf_report_missing_artifact"
  | "pdf_report_image_too_large"
  | "pdf_report_image_invalid"
  | "pdf_report_too_large"
  | "pdf_report_render_failed";

/**
 * Safe renderer failure. Messages never echo IDs, references, storage paths,
 * patient data or SDK details.
 */
export class PdfReportError extends Error {
  readonly code: PdfReportErrorCode;

  constructor(code: PdfReportErrorCode) {
    super("PDF report rendering failed");
    this.name = "PdfReportError";
    this.code = code;
  }
}

function fail(code: PdfReportErrorCode): never {
  throw new PdfReportError(code);
}

interface PdfFonts {
  readonly body: PDFFont;
  readonly bold: PDFFont;
}

interface PageWriter {
  page: PDFPage;
  y: number;
}

interface PreparedImage {
  readonly bytes: Buffer;
  readonly format: "jpeg" | "png";
  readonly width: number;
  readonly height: number;
}

interface NormalizedRenderInput {
  readonly inferenceId: string;
  readonly consultationId: string | null;
  readonly eyeSide: string;
  readonly reportId: string;
  readonly version: number;
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly analyzedAt: string;
  readonly status: string;
  readonly elapsedSeconds: string;
  readonly legacyModelVersion: string;
  readonly review: boolean;
  readonly predictedClass: string;
  readonly confidence: string;
  readonly probabilities: readonly string[];
  readonly cdr: string;
  readonly cdrVertical: string;
  readonly quality: readonly string[];
  readonly snapshotModelVersions: readonly string[];
  readonly resultModelVersions: readonly string[];
  readonly modelPredictions: readonly string[];
  readonly clinicalFeatures: readonly string[];
  readonly warnings: readonly string[];
  readonly missingArtifacts: readonly string[];
  readonly originalBytes: Uint8Array | null;
  readonly maskBytes: Uint8Array | null;
  readonly overlayBytes: Uint8Array | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDecimal(value: number, digits = 4): string {
  return value.toFixed(digits);
}

function formatProbability(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "no disponible";
  }
  return `${formatDecimal(value, 4)} (${(value * 100).toFixed(2)}%)`;
}

function formatOptionalNumber(value: unknown, digits = 4): string {
  const number = finiteNumber(value);
  return number === null ? "no disponible" : formatDecimal(number, digits);
}

function safeText(value: string, maxLength = 160): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return "no disponible";
  }
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}...`;
  }
  if (
    /:\/\//.test(cleaned) ||
    /(^|[?&])(sig|x-amz-signature|x-amz-credential|x-amz-security-token)=/i.test(
      cleaned,
    ) ||
    /\\/.test(cleaned) ||
    /^[A-Za-z]:[\\/]/.test(cleaned)
  ) {
    return "[no mostrado]";
  }
  return cleaned;
}

function safeLabel(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) {
    return "[sin nombre]";
  }
  if (cleaned.length > 80) {
    return cleaned.slice(0, 80);
  }
  if (/:\/\//.test(cleaned) || /\\/.test(cleaned)) {
    return "[no mostrado]";
  }
  return cleaned;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "no disponible";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatDecimal(value, 4) : "no disponible";
  }
  if (typeof value === "boolean") {
    return value ? "si" : "no";
  }
  if (typeof value === "string") {
    return safeText(value);
  }
  return "[objeto]";
}

function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return "no disponible";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "no disponible";
  }
  return date.toISOString();
}

function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("pdf_report_invalid_input");
  }
  return value.toLowerCase();
}

function readProbabilityMap(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const number = finiteNumber(raw);
    if (number !== null && number >= 0 && number <= 1) {
      result[key] = number;
    }
  }
  return result;
}

function probabilityLines(
  probabilities: Record<string, number> | null,
): string[] {
  return CLASS_LABELS.map((label, index) => {
    return `${index} ${label}: ${formatProbability(probabilities?.[label])}`;
  });
}

function predictedClassText(value: unknown): string {
  const index = finiteNumber(value);
  if (
    index === null ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= CLASS_LABELS.length
  ) {
    return "no disponible";
  }
  const label = CLASS_LABELS[index];
  return label === undefined
    ? `índice ${index}`
    : `índice ${index} (${label})`;
}

function modelVersionLines(value: unknown): string[] {
  const record = asRecord(value);
  if (record === null) {
    return ["no disponible"];
  }
  const entries = Object.entries(record)
    .filter(
      ([, raw]) =>
        typeof raw === "string" ||
        typeof raw === "number" ||
        typeof raw === "boolean",
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return ["no disponible"];
  }
  return entries.map(
    ([key, raw]) => `${safeLabel(key)}: ${formatScalar(raw)}`,
  );
}

function modelPredictionLines(value: unknown): string[] {
  const record = asRecord(value);
  if (record === null) {
    return ["no disponible"];
  }
  const lines: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const prediction = asRecord(record[key]);
    if (prediction === null) {
      continue;
    }
    const predicted =
      typeof prediction.predictedClass === "string"
        ? safeText(prediction.predictedClass)
        : "no disponible";
    const confidence = formatOptionalNumber(prediction.confidence);
    const probabilities = readProbabilityMap(prediction.probabilities);
    const probabilityText =
      probabilities === null
        ? "no disponible"
        : CLASS_LABELS.map(
            (label) => `${label}=${formatProbability(probabilities[label])}`,
          ).join(", ");
    lines.push(
      `${safeLabel(key)}: clase=${predicted}, confianza=${confidence}, probabilidades=[${probabilityText}]`,
    );
  }
  return lines.length === 0 ? ["no disponible"] : lines;
}

function qualityLines(value: unknown): string[] {
  const record = asRecord(value);
  if (record === null) {
    return ["no disponible"];
  }
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return ["no disponible"];
  }
  return keys.map(
    (key) => `${safeLabel(key)}: ${formatScalar(record[key])}`,
  );
}

function clinicalFeatureLines(rawPayload: unknown): string[] {
  const record = asRecord(rawPayload);
  return CLINICAL_FEATURE_KEYS.map((key) => {
    const value =
      record !== null && Object.prototype.hasOwnProperty.call(record, key)
        ? record[key]
        : undefined;
    return `${key}: ${formatScalar(value)} (no interpretable)`;
  });
}

function readOptionalBytes(
  value: Uint8Array | null | undefined,
): Uint8Array | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(value instanceof Uint8Array)) {
    fail("pdf_report_invalid_input");
  }
  return value.byteLength > 0 ? value : null;
}

function normalizeInput(input: RenderBasicPdfInput): NormalizedRenderInput {
  if (input === null || typeof input !== "object") {
    fail("pdf_report_invalid_input");
  }
  const inference = input.inference;
  const snapshot = input.snapshot;
  const image = input.image;
  if (
    inference === null ||
    typeof inference !== "object" ||
    snapshot === null ||
    typeof snapshot !== "object" ||
    image === null ||
    typeof image !== "object"
  ) {
    fail("pdf_report_invalid_input");
  }

  const inferenceId = assertUuid(inference.id);
  const reportId = assertUuid(input.reportId);
  if (!Number.isInteger(input.version) || input.version < 1) {
    fail("pdf_report_invalid_input");
  }
  if (typeof image.storagePath !== "string") {
    fail("pdf_report_invalid_input");
  }

  const rawConsultationId =
    inference.consultationId ?? snapshot.consultationId ?? null;
  const consultationId =
    rawConsultationId === null ? null : assertUuid(rawConsultationId);
  const rawEyeSide = inference.eyeSide ?? image.eyeSide ?? null;
  const eyeSide =
    rawEyeSide === "OD" || rawEyeSide === "OS" ? rawEyeSide : "no disponible";
  const status =
    typeof inference.status === "string" && KNOWN_STATUSES.has(inference.status)
      ? inference.status
      : "no disponible";
  const review =
    input.reviewRequired === true ||
    inference.status === "REVIEW_REQUIRED";

  if (
    typeof snapshot.schemaVersion !== "string" ||
    snapshot.schemaVersion.trim().length === 0
  ) {
    fail("pdf_report_invalid_input");
  }
  const schemaVersion = safeText(snapshot.schemaVersion, 128);

  let generatedAt: string;
  if (input.generatedAt === undefined) {
    generatedAt = new Date().toISOString();
  } else {
    generatedAt = formatDate(input.generatedAt);
    if (generatedAt === "no disponible") {
      fail("pdf_report_invalid_input");
    }
  }

  const originalBytes = readOptionalBytes(input.originalBytes);
  const maskBytes = readOptionalBytes(input.maskBytes);
  const overlayBytes = readOptionalBytes(input.overlayBytes);

  const missingArtifacts: string[] = [];
  if (originalBytes === null) {
    missingArtifacts.push("imagen original");
  }
  if (maskBytes === null) {
    missingArtifacts.push("mask");
  }
  if (overlayBytes === null) {
    missingArtifacts.push("overlay");
  }
  if (!review && missingArtifacts.length > 0) {
    fail("pdf_report_missing_artifact");
  }

  const warnings: string[] = [];
  if (review) {
    warnings.push(
      "Revisión requerida: el resultado requiere revisión humana; la ejecución no se declara completa.",
    );
  }
  if (missingArtifacts.length > 0) {
    warnings.push(
      `Evidencia parcial: falta ${missingArtifacts.join(", ")}.`,
    );
  }
  if (Array.isArray(input.warnings)) {
    for (const warning of input.warnings) {
      if (typeof warning === "string" && warning.trim().length > 0) {
        warnings.push(safeText(warning, 240));
      }
    }
  }
  warnings.push(
    "Este reporte es apoyo a investigación y no sustituye el criterio médico.",
  );

  const probabilities = readProbabilityMap(inference.probabilities);
  const confidence = finiteNumber(inference.confidence);
  const elapsedSeconds = finiteNumber(inference.elapsedSeconds);
  const legacyModelVersion =
    typeof inference.modelVersion === "string" &&
    inference.modelVersion.trim().length > 0
      ? safeText(inference.modelVersion, 128)
      : "no disponible";

  return {
    inferenceId,
    consultationId,
    eyeSide,
    reportId,
    version: input.version,
    schemaVersion,
    generatedAt,
    analyzedAt: formatDate(inference.createdAt),
    status,
    elapsedSeconds:
      elapsedSeconds === null
        ? "no disponible"
        : formatDecimal(elapsedSeconds, 3),
    legacyModelVersion,
    review,
    predictedClass: predictedClassText(inference.predictedClass),
    confidence:
      confidence === null ? "no disponible" : formatProbability(confidence),
    probabilities: probabilityLines(probabilities),
    cdr: formatOptionalNumber(inference.cdr),
    cdrVertical: formatOptionalNumber(inference.cdrVertical),
    quality: qualityLines(inference.quality),
    snapshotModelVersions: modelVersionLines(snapshot.modelVersions),
    resultModelVersions: modelVersionLines(inference.modelVersions),
    modelPredictions: modelPredictionLines(inference.modelPredictions),
    clinicalFeatures: clinicalFeatureLines(snapshot.rawPayload),
    warnings,
    missingArtifacts,
    originalBytes,
    maskBytes,
    overlayBytes,
  };
}

async function prepareInputImage(
  bytes: Uint8Array,
  mode: "original" | "evidence",
): Promise<PreparedImage> {
  if (bytes.byteLength === 0) {
    fail("pdf_report_image_invalid");
  }
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    fail("pdf_report_image_too_large");
  }
  try {
    const pipeline = sharp(Buffer.from(bytes), {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    if (mode === "original") {
      const output = await pipeline
        .rotate()
        .resize({
          width: MAX_IMAGE_DIMENSION,
          height: MAX_IMAGE_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      return {
        bytes: output.data,
        format: "jpeg",
        width: output.info.width,
        height: output.info.height,
      };
    }
    // Lossless PNG keeps mask/overlay evidence; no rotation or resampling.
    const output = await pipeline
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: output.data,
      format: "png",
      width: output.info.width,
      height: output.info.height,
    };
  } catch (error) {
    if (error instanceof PdfReportError) {
      throw error;
    }
    fail("pdf_report_image_invalid");
  }
}

function toPdfText(value: string): string {
  // Helvetica uses WinAnsi; keep Latin-1 and replace anything unsupported.
  return value.replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    let current = "";
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      let remainder = word;
      while (font.widthOfTextAtSize(remainder, size) > maxWidth) {
        let cut = remainder.length - 1;
        while (
          cut > 1 &&
          font.widthOfTextAtSize(remainder.slice(0, cut), size) > maxWidth
        ) {
          cut -= 1;
        }
        lines.push(remainder.slice(0, cut));
        remainder = remainder.slice(cut);
      }
      current = remainder;
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }
  return lines.length === 0 ? [""] : lines;
}

function createWriter(doc: PDFDocument): PageWriter {
  return {
    page: doc.addPage([A4_WIDTH, A4_HEIGHT]),
    y: A4_HEIGHT - MARGIN,
  };
}

function ensureSpace(
  doc: PDFDocument,
  writer: PageWriter,
  needed: number,
): void {
  if (writer.y - needed < MARGIN) {
    writer.page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    writer.y = A4_HEIGHT - MARGIN;
  }
}

function writeSpacer(writer: PageWriter, amount: number): void {
  writer.y -= amount;
}

function writeText(
  doc: PDFDocument,
  writer: PageWriter,
  fonts: PdfFonts,
  text: string,
  options: {
    readonly size?: number;
    readonly bold?: boolean;
    readonly lineHeight?: number;
    readonly color?: ReturnType<typeof rgb>;
  } = {},
): void {
  const size = options.size ?? BODY_SIZE;
  const font = options.bold === true ? fonts.bold : fonts.body;
  const lineHeight = options.lineHeight ?? size + 3;
  const color = options.color ?? rgb(0.12, 0.12, 0.12);
  const lines = wrapText(toPdfText(text), font, size, CONTENT_WIDTH);
  for (const line of lines) {
    ensureSpace(doc, writer, lineHeight);
    writer.page.drawText(line, {
      x: MARGIN,
      y: writer.y - size,
      size,
      font,
      color,
    });
    writer.y -= lineHeight;
  }
}

function writeHeading(
  doc: PDFDocument,
  writer: PageWriter,
  fonts: PdfFonts,
  text: string,
): void {
  writeSpacer(writer, 6);
  ensureSpace(doc, writer, HEADING_SIZE + BODY_LINE_HEIGHT);
  writeText(doc, writer, fonts, text, {
    size: HEADING_SIZE,
    bold: true,
    lineHeight: HEADING_SIZE + 4,
    color: rgb(0.05, 0.2, 0.35),
  });
  writeSpacer(writer, 2);
}

function writeLabelValue(
  doc: PDFDocument,
  writer: PageWriter,
  fonts: PdfFonts,
  label: string,
  value: string,
): void {
  writeText(doc, writer, fonts, `${label}: ${value}`);
}

async function addImagePage(
  doc: PDFDocument,
  fonts: PdfFonts,
  image: PreparedImage,
  caption: string,
): Promise<void> {
  const page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  const embedded =
    image.format === "jpeg"
      ? await doc.embedJpg(image.bytes)
      : await doc.embedPng(image.bytes);
  const maxWidth = A4_WIDTH - MARGIN * 2;
  const maxHeight = A4_HEIGHT - MARGIN * 2 - 24;
  const scale = Math.min(
    maxWidth / embedded.width,
    maxHeight / embedded.height,
    1,
  );
  const width = embedded.width * scale;
  const height = embedded.height * scale;
  page.drawImage(embedded, {
    x: (A4_WIDTH - width) / 2,
    y: (A4_HEIGHT - height) / 2 - 8,
    width,
    height,
  });
  page.drawText(toPdfText(caption), {
    x: MARGIN,
    y: MARGIN,
    size: BODY_SIZE,
    font: fonts.body,
    color: rgb(0.3, 0.3, 0.3),
  });
}

function addRunningHeaderAndPageNumbers(
  doc: PDFDocument,
  font: PDFFont,
): void {
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, index) => {
    const header = toPdfText(RUNNING_HEADER);
    page.drawText(header, {
      x: MARGIN,
      y: A4_HEIGHT - MARGIN / 2,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
    const text = `Página ${index + 1} de ${total}`;
    page.drawText(text, {
      x: A4_WIDTH - MARGIN - font.widthOfTextAtSize(text, 8),
      y: MARGIN / 2,
      size: 8,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
  });
}

/**
 * Pure PDF renderer: no DB/storage reads or writes. The caller resolves the
 * original/mask/overlay bytes through the shared artifact-content seam and
 * supplies the immutable reportId/version from 6.2.
 */
export async function renderBasicPdf(
  input: RenderBasicPdfInput,
): Promise<Buffer> {
  try {
    const normalized = normalizeInput(input);

    const original =
      normalized.originalBytes === null
        ? null
        : await prepareInputImage(normalized.originalBytes, "original");
    const mask =
      normalized.maskBytes === null
        ? null
        : await prepareInputImage(normalized.maskBytes, "evidence");
    const overlay =
      normalized.overlayBytes === null
        ? null
        : await prepareInputImage(normalized.overlayBytes, "evidence");

    const doc = await PDFDocument.create();
    const fonts: PdfFonts = {
      body: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    const writer = createWriter(doc);

    writeText(doc, writer, fonts, "Clearsight - Reporte básico de inferencia", {
      size: TITLE_SIZE,
      bold: true,
      lineHeight: TITLE_SIZE + 6,
      color: rgb(0.05, 0.2, 0.35),
    });
    writeText(
      doc,
      writer,
      fonts,
      "Documento de apoyo a investigación. No sustituye el criterio médico.",
      { size: BODY_SIZE, color: rgb(0.45, 0.05, 0.05) },
    );

    writeHeading(doc, writer, fonts, "Identificación pseudónima");
    writeLabelValue(doc, writer, fonts, "Consulta", normalized.consultationId ?? "no disponible");
    writeLabelValue(doc, writer, fonts, "Inferencia", normalized.inferenceId);
    writeLabelValue(doc, writer, fonts, "Ojo", normalized.eyeSide);
    writeLabelValue(doc, writer, fonts, "Reporte", normalized.reportId);
    writeLabelValue(doc, writer, fonts, "Version", String(normalized.version));
    writeLabelValue(doc, writer, fonts, "Fecha de generación", normalized.generatedAt);
    writeLabelValue(doc, writer, fonts, "Fecha de análisis", normalized.analyzedAt);
    writeText(
      doc,
      writer,
      fonts,
      "Este reporte no incluye datos identificatorios del paciente.",
    );

    writeHeading(doc, writer, fonts, "Estado de la ejecución");
    writeLabelValue(doc, writer, fonts, "Estado", normalized.status);
    writeLabelValue(
      doc,
      writer,
      fonts,
      "Tiempo de inferencia (s)",
      normalized.elapsedSeconds,
    );
    if (normalized.review) {
      writeText(
        doc,
        writer,
        fonts,
        "Revisión requerida: la ejecución requiere revisión humana.",
      );
      writeText(
        doc,
        writer,
        fonts,
        "Reporte parcial de revisión: no se declara completitud.",
      );
    }
    if (normalized.missingArtifacts.length > 0) {
      writeText(
        doc,
        writer,
        fonts,
        `Evidencia faltante: ${normalized.missingArtifacts.join(", ")}.`,
      );
    }

    writeHeading(doc, writer, fonts, "Snapshot y modelos");
    writeLabelValue(
      doc,
      writer,
      fonts,
      "Snapshot schemaVersion",
      normalized.schemaVersion,
    );
    writeLabelValue(
      doc,
      writer,
      fonts,
      "Model version (legacy)",
      normalized.legacyModelVersion,
    );
    writeText(doc, writer, fonts, "Model versions del snapshot:");
    normalized.snapshotModelVersions.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );
    writeText(doc, writer, fonts, "Model versions del resultado:");
    normalized.resultModelVersions.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );
    writeText(doc, writer, fonts, "Predicciones por modelo:");
    normalized.modelPredictions.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );

    writeHeading(doc, writer, fonts, "Resultado de la inferencia");
    writeLabelValue(doc, writer, fonts, "Clase predicha", normalized.predictedClass);
    writeLabelValue(doc, writer, fonts, "Confianza", normalized.confidence);
    writeText(doc, writer, fonts, "Probabilidades canónicas:");
    normalized.probabilities.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );
    writeLabelValue(doc, writer, fonts, "CDR (área)", normalized.cdr);
    writeLabelValue(
      doc,
      writer,
      fonts,
      "CDR vertical (clínico)",
      normalized.cdrVertical,
    );
    writeText(
      doc,
      writer,
      fonts,
      "CDR de área y CDR vertical no son intercambiables.",
    );
    writeText(doc, writer, fonts, "Calidad:");
    normalized.quality.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );

    writeHeading(
      doc,
      writer,
      fonts,
      "Variables clínicas (no interpretables)",
    );
    writeText(
      doc,
      writer,
      fonts,
      "Sin codebook backend verificado; los valores no deben interpretarse clínicamente.",
    );
    normalized.clinicalFeatures.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );

    writeHeading(doc, writer, fonts, "Advertencias y limitaciones");
    normalized.warnings.forEach((line) =>
      writeText(doc, writer, fonts, `- ${line}`),
    );

    writeHeading(doc, writer, fonts, "Explicabilidad");
    writeText(
      doc,
      writer,
      fonts,
      "Grad-CAM: NOT_SUPPORTED (no incluido en el PDF básico).",
    );
    writeText(
      doc,
      writer,
      fonts,
      "SHAP: NOT_SUPPORTED (no incluido en el PDF básico).",
    );

    writeHeading(doc, writer, fonts, "Evidencia embebida");
    writeText(
      doc,
      writer,
      fonts,
      `Imagen original: ${original === null ? "no disponible" : "incluida (sanitizada, sin EXIF)"}.`,
    );
    writeText(
      doc,
      writer,
      fonts,
      `Mask: ${mask === null ? "no disponible" : "incluida"}.`,
    );
    writeText(
      doc,
      writer,
      fonts,
      `Overlay: ${overlay === null ? "no disponible" : "incluida"}.`,
    );

    if (original !== null) {
      await addImagePage(
        doc,
        fonts,
        original,
        "Imagen original sanitizada (sin EXIF)",
      );
    }
    if (mask !== null) {
      await addImagePage(doc, fonts, mask, "Mask de segmentación");
    }
    if (overlay !== null) {
      await addImagePage(doc, fonts, overlay, "Overlay de segmentación");
    }

    addRunningHeaderAndPageNumbers(doc, fonts.body);
    const bytes = Buffer.from(await doc.save());
    if (bytes.byteLength > MAX_PDF_BYTES) {
      fail("pdf_report_too_large");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PdfReportError) {
      throw error;
    }
    fail("pdf_report_render_failed");
  }
}
