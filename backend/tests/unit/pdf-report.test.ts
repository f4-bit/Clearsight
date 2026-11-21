import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  CLINICAL_FEATURE_KEYS,
  renderBasicPdf,
  type RenderBasicPdfInput,
} from "../../src/services/pdf-report.js";

const INFERENCE_ID = "11111111-1111-4111-8111-111111111111";
const CONSULTATION_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";

const PROBABILITIES = {
  Glaucoma: 0.1,
  Non_Glaucoma: 0.03,
  Suspicious_Glaucoma: 0.87,
};

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
};

async function buildInput(): Promise<RenderBasicPdfInput> {
  const original = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ exif: { IFD0: { Copyright: "EXIF_CANARY_ABC" } } })
    .toBuffer();
  const mask = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  const overlay = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
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
      probabilities: PROBABILITIES,
      cdr: 0.42,
      cdrVertical: 0.38,
      quality: { segmentation: 0.91, blur: 0.02 },
      elapsedSeconds: 3.5,
      modelVersion: "v1",
      modelVersions: { manifest: "resnet50-v1", retina: "r2" },
      modelPredictions: {
        resnet50: {
          predictedClass: "Suspicious_Glaucoma",
          confidence: 0.87,
          probabilities: PROBABILITIES,
        },
      },
      status: "COMPLETED",
      createdAt: "2026-11-20T10:00:00.000Z",
    },
    snapshot: {
      consultationId: CONSULTATION_ID,
      schemaVersion: "ml-zscore-f32-v1",
      rawPayload: FEATURES,
      modelVersions: { manifest: "resnet50-v1" },
    },
    image: {
      storagePath: "raw-retinas/case/secret-key.png",
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

interface ExtractedPdf {
  readonly text: string;
  readonly imageCount: number;
  readonly pages: number;
}

async function extractPdf(pdf: Buffer): Promise<ExtractedPdf> {
  const loadingTask = getDocument({
    data: new Uint8Array(pdf),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages = doc.numPages;
  const imageOps = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ].filter((value): value is number => typeof value === "number"),
  );

  let text = "";
  let imageCount = 0;
  for (let index = 1; index <= pages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    text +=
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ") + "\n";
    const operators = await page.getOperatorList();
    for (const fn of operators.fnArray) {
      if (imageOps.has(fn)) {
        imageCount += 1;
      }
    }
  }
  await doc.destroy();
  return { text: text.replace(/\s+/g, " ").trim(), imageCount, pages };
}

interface EmbeddedImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Decodes the embedded image XObjects in document order (original, mask, overlay). */
async function extractEmbeddedImages(pdf: Buffer): Promise<EmbeddedImage[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(pdf),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const images: EmbeddedImage[] = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const operators = await page.getOperatorList();
    for (let op = 0; op < operators.fnArray.length; op += 1) {
      if (operators.fnArray[op] !== OPS.paintImageXObject) {
        continue;
      }
      const args = operators.argsArray[op] as unknown as unknown[];
      const objId = args[0];
      const img = await new Promise<EmbeddedImage>((resolve) => {
        (
          page.objs as unknown as {
            get(id: unknown, cb: (obj: EmbeddedImage) => void): unknown;
          }
        ).get(objId, resolve);
      });
      images.push({
        width: img.width,
        height: img.height,
        data: Uint8Array.from(img.data),
      });
    }
  }
  await doc.destroy();
  return images;
}

/** High-frequency pattern: any lossy re-encode would visibly corrupt it. */
function noiseRgbRaw(width: number, height: number, seed: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 7 + y * 13 + seed) % 256;
      raw[i + 1] = (x * 251 + y * 3 + seed * 2) % 256;
      raw[i + 2] = ((x ^ y) * 17 + seed * 3) % 256;
    }
  }
  return raw;
}

describe("renderBasicPdf", () => {
  it("renders a valid PDF with all metadata and three embedded images", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf(input);
    const extracted = await extractPdf(pdf);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(extracted.imageCount).toBe(3);
    expect(extracted.pages).toBeGreaterThanOrEqual(4);

    expect(extracted.text).toContain(CONSULTATION_ID);
    expect(extracted.text).toContain(INFERENCE_ID);
    expect(extracted.text).toContain(REPORT_ID);
    expect(extracted.text).toContain("OD");
    expect(extracted.text).toContain("ml-zscore-f32-v1");
    expect(extracted.text).toContain("Tiempo de inferencia (s): 3.500");
    expect(extracted.text).toContain("Model version (legacy): v1");
    expect(extracted.text).toContain("Suspicious_Glaucoma");
    expect(extracted.text).toContain("índice 2");
    expect(extracted.text).toContain("CDR (área): 0.4200");
    expect(extracted.text).toContain("CDR vertical (clínico): 0.3800");
    expect(extracted.text).toContain("CDR de área y CDR vertical no son intercambiables");
    expect(extracted.text).toContain("Probabilidades canónicas");
    expect(extracted.text).toContain("Este reporte es apoyo a investigación y no sustituye el criterio médico");
    expect(extracted.text).toContain(
      "Grad-CAM: NOT_SUPPORTED (no incluido en el PDF básico)",
    );
    expect(extracted.text).toContain(
      "SHAP: NOT_SUPPORTED (no incluido en el PDF básico)",
    );
    expect(extracted.text).toContain("Imagen original sanitizada (sin EXIF)");
    expect(extracted.text).toContain("Mask de segmentación");
    expect(extracted.text).toContain("Overlay de segmentación");

    const featureLines = extracted.text.match(/\(no interpretable\)/g) ?? [];
    expect(featureLines).toHaveLength(CLINICAL_FEATURE_KEYS.length);
    for (const key of CLINICAL_FEATURE_KEYS) {
      expect(extracted.text).toContain(key);
    }
  });

  it("never renders storage paths, keys, signed URLs or EXIF metadata", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf(input);
    const extracted = await extractPdf(pdf);

    expect(extracted.text).not.toContain("raw-retinas");
    expect(extracted.text).not.toContain("secret-key");
    expect(extracted.text).not.toContain("://");
    expect(extracted.text).not.toContain("sig=");
    expect(pdf.includes(Buffer.from("EXIF_CANARY_ABC", "ascii"))).toBe(false);
  });

  it("fails with a typed error when a mandatory artifact is missing", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, maskBytes: null }),
    ).rejects.toMatchObject({ code: "pdf_report_missing_artifact" });
  });

  it("accepts a partial REVIEW_REQUIRED input and states the limitation", async () => {
    const input = await buildInput();
    const reviewInput: RenderBasicPdfInput = {
      ...input,
      inference: { ...input.inference, status: "REVIEW_REQUIRED" },
      maskBytes: null,
      overlayBytes: null,
      originalBytes: input.originalBytes,
    };
    const pdf = await renderBasicPdf(reviewInput);
    const extracted = await extractPdf(pdf);

    expect(extracted.imageCount).toBe(1);
    expect(extracted.text).toContain("REVIEW_REQUIRED");
    expect(extracted.text).toContain("Revisión requerida");
    expect(extracted.text).toContain("Reporte parcial de revisión");
    expect(extracted.text).toContain("Evidencia faltante: mask, overlay");
    expect(extracted.text).toContain("Evidencia parcial: falta mask, overlay");
    expect(extracted.text).toContain("Grad-CAM: NOT_SUPPORTED");
    expect(extracted.text).toContain("SHAP: NOT_SUPPORTED");
  });

  it("rejects a corrupt image even in review mode", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        originalBytes: Buffer.from("not-an-image", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "pdf_report_image_invalid" });
  });

  it("rejects invalid report identifiers before rendering", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, reportId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it("fails with a typed error when the original image is missing", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, originalBytes: null }),
    ).rejects.toMatchObject({ code: "pdf_report_missing_artifact" });
  });

  it("fails with a typed error when the overlay is missing", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, overlayBytes: null }),
    ).rejects.toMatchObject({ code: "pdf_report_missing_artifact" });
  });

  it("treats empty artifact bytes as a missing artifact", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, originalBytes: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "pdf_report_missing_artifact" });
  });

  it("rejects non-binary artifact payloads", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        originalBytes: "not-bytes" as unknown as Uint8Array,
      }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it("rejects invalid inference identifiers before rendering", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        inference: { ...input.inference, id: "not-a-uuid" },
      }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it("rejects invalid consultation identifiers before rendering", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        inference: { ...input.inference, consultationId: "not-a-uuid" },
        snapshot: { ...input.snapshot, consultationId: null },
      }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it.each([[0], [-3], [1.5]])(
    "rejects a non-positive or fractional report version (%s)",
    async (version) => {
      const input = await buildInput();
      await expect(
        renderBasicPdf({ ...input, version }),
      ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
    },
  );

  it("rejects an empty snapshot schema version", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        snapshot: { ...input.snapshot, schemaVersion: "   " },
      }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it("rejects an unparseable generation date", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({ ...input, generatedAt: "not-a-date" }),
    ).rejects.toMatchObject({ code: "pdf_report_invalid_input" });
  });

  it("rejects an artifact over the input byte limit", async () => {
    const input = await buildInput();
    await expect(
      renderBasicPdf({
        ...input,
        originalBytes: Buffer.alloc(25 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "pdf_report_image_too_large" });
  });

  it("renders report version and the generation and analysis dates", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf(input);
    const extracted = await extractPdf(pdf);

    expect(extracted.text).toContain("Version: 1");
    expect(extracted.text).toContain(
      "Fecha de generación: 2026-11-20T11:00:00.000Z",
    );
    expect(extracted.text).toContain(
      "Fecha de análisis: 2026-11-20T10:00:00.000Z",
    );
    expect(extracted.text).toContain("Página 1 de");
  });

  it("renders caller-supplied warnings verbatim in the limitations section", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      warnings: ["Calidad de segmentación baja (0.31)"],
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.text).toContain("Advertencias y limitaciones");
    expect(extracted.text).toContain("Calidad de segmentación baja (0.31)");
  });

  it("labels model prediction and model version sources", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf(input);
    const extracted = await extractPdf(pdf);

    expect(extracted.text).toContain("Model versions del snapshot:");
    expect(extracted.text).toContain("Model versions del resultado:");
    expect(extracted.text).toContain("Predicciones por modelo:");
    expect(extracted.text).toContain(
      "resnet50: clase=Suspicious_Glaucoma, confianza=0.8700",
    );
    expect(extracted.text).toContain("manifest: resnet50-v1");
    expect(extracted.text).toContain("retina: r2");
  });

  it("redacts signed URLs and local paths from free-text fields", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      inference: {
        ...input.inference,
        modelVersion: "https://evil.example/model?sig=abc",
        modelVersions: { "https://key.example/m": "v2" },
        quality: {
          nota: "https://q.example/x?sig=1",
          ruta: "C:\\temp\\secret-file.png",
        },
      },
      warnings: [
        "Firma: https://account.blob.core.windows.net/c/b?sp=r&sig=SECRETSIG",
      ],
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.text).not.toContain("://");
    expect(extracted.text).not.toContain("sig=");
    expect(extracted.text).not.toContain("SECRETSIG");
    expect(extracted.text).not.toContain("evil.example");
    expect(extracted.text).not.toContain("blob.core.windows.net");
    expect(extracted.text).not.toContain("secret-file");
    expect((extracted.text.match(/\[no mostrado\]/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("never renders PHI-style rawPayload fields outside the 11 clinical features", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      snapshot: {
        ...input.snapshot,
        rawPayload: {
          ...FEATURES,
          externalCode: "EXT-CODE-777",
          patientName: "Juan Perez",
        },
      },
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.text).not.toContain("EXT-CODE-777");
    expect(extracted.text).not.toContain("Juan Perez");
    expect(extracted.text).not.toContain("externalCode");
    const featureLines = extracted.text.match(/\(no interpretable\)/g) ?? [];
    expect(featureLines).toHaveLength(CLINICAL_FEATURE_KEYS.length);
  });

  it("drops out-of-range probabilities instead of rendering them", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      inference: {
        ...input.inference,
        probabilities: {
          Glaucoma: 1.5,
          Non_Glaucoma: -0.2,
          Suspicious_Glaucoma: Number.NaN,
        },
      },
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.text).toContain("0 Glaucoma: no disponible");
    expect(extracted.text).toContain("1 Non_Glaucoma: no disponible");
    expect(extracted.text).toContain("2 Suspicious_Glaucoma: no disponible");
    expect(extracted.text).not.toContain("Glaucoma: 1.5000");
    expect(extracted.text).not.toContain("Non_Glaucoma: -0.2000");
    expect(extracted.text).not.toContain("150.00%");
    expect(extracted.text).not.toContain("-20.00%");
  });

  it.each([[99], [-1], [1.5], [null]])(
    "shows no disponible for an unusable predicted class (%s)",
    async (predictedClass) => {
      const input = await buildInput();
      const pdf = await renderBasicPdf({
        ...input,
        inference: { ...input.inference, predictedClass },
      });
      const extracted = await extractPdf(pdf);

      expect(extracted.text).toContain("Clase predicha: no disponible");
      expect(extracted.text).not.toContain("índice");
    },
  );

  it("survives malformed model metadata without inventing values", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      inference: {
        ...input.inference,
        modelVersions: { nested: { a: 1 }, ok: "x" },
        modelPredictions: {
          broken: "not-a-record",
          weird: {
            predictedClass: 5,
            confidence: "bad",
            probabilities: { Glaucoma: 2 },
          },
        },
      },
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.text).toContain("ok: x");
    expect(extracted.text).not.toContain("nested");
    expect(extracted.text).toContain("weird: clase=no disponible");
    expect(extracted.text).not.toContain("[object Object]");
  });

  it("embeds mask and overlay evidence without lossy re-encoding", async () => {
    const input = await buildInput();
    const maskRaw = noiseRgbRaw(63, 47, 5);
    const overlayRaw = noiseRgbRaw(31, 19, 11);
    const maskBytes = await sharp(maskRaw, {
      raw: { width: 63, height: 47, channels: 3 },
    })
      .png()
      .toBuffer();
    const overlayBytes = await sharp(overlayRaw, {
      raw: { width: 31, height: 19, channels: 3 },
    })
      .png()
      .toBuffer();

    const pdf = await renderBasicPdf({
      ...input,
      maskBytes,
      overlayBytes,
    });
    const images = await extractEmbeddedImages(pdf);

    expect(images).toHaveLength(3);
    expect([images[0]!.width, images[0]!.height]).toEqual([120, 80]);
    expect([images[1]!.width, images[1]!.height]).toEqual([63, 47]);
    expect([images[2]!.width, images[2]!.height]).toEqual([31, 19]);
    expect(Buffer.compare(Buffer.from(images[1]!.data), maskRaw)).toBe(0);
    expect(Buffer.compare(Buffer.from(images[2]!.data), overlayRaw)).toBe(0);
  });

  it("renders a full-absence review report that names every missing artifact", async () => {
    const input = await buildInput();
    const pdf = await renderBasicPdf({
      ...input,
      inference: { ...input.inference, status: "REVIEW_REQUIRED" },
      originalBytes: null,
      maskBytes: null,
      overlayBytes: null,
    });
    const extracted = await extractPdf(pdf);

    expect(extracted.imageCount).toBe(0);
    expect(extracted.text).toContain("REVIEW_REQUIRED");
    expect(extracted.text).toContain("Revisión requerida");
    expect(extracted.text).toContain("Reporte parcial de revisión");
    expect(extracted.text).toContain("no se declara completitud");
    expect(extracted.text).toContain(
      "Evidencia parcial: falta imagen original, mask, overlay",
    );
    expect(extracted.text).toContain(
      "Evidencia faltante: imagen original, mask, overlay",
    );
    expect(extracted.text).toContain("Grad-CAM: NOT_SUPPORTED");
    expect(extracted.text).toContain("SHAP: NOT_SUPPORTED");
  });
});
