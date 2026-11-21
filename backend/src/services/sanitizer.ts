import crypto from "node:crypto";
import sharp from "sharp";

export interface SanitizedImage {
  buffer: Buffer;
  hashMd5: string;
  width?: number;
  height?: number;
  format: string;
}

export const MAX_SANITIZER_INPUT_BYTES = 20 * 1024 * 1024;

export type ImageSanitizationErrorCode =
  | "image_too_large"
  | "image_invalid";

/** Safe sanitizer failure; never carries the sharp cause or input bytes. */
export class ImageSanitizationError extends Error {
  readonly code: ImageSanitizationErrorCode;

  constructor(code: ImageSanitizationErrorCode) {
    super(
      code === "image_too_large"
        ? "Image exceeds the sanitizer size limit"
        : "Image is invalid or unsupported",
    );
    this.name = "ImageSanitizationError";
    this.code = code;
  }
}

/**
 * Strips all EXIF, TIFF, and device metadata from medical retina images.
 * Keeps pixel fidelity, standardizes orientation, and computes MD5 hash.
 */
export async function sanitizeImage(inputBuffer: Buffer): Promise<SanitizedImage> {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new ImageSanitizationError("image_invalid");
  }
  if (inputBuffer.length > MAX_SANITIZER_INPUT_BYTES) {
    throw new ImageSanitizationError("image_too_large");
  }

  try {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();

    // Strip all metadata (sharp strips all EXIF/ICC metadata by default when withMetadata is omitted)
    const cleanBuffer = await image
      .rotate()
      .jpeg({
        quality: 95,
        chromaSubsampling: "4:4:4", // Preserves microvascular resolution
      })
      .toBuffer();

    const hashMd5 = crypto.createHash("md5").update(cleanBuffer).digest("hex");

    return {
      buffer: cleanBuffer,
      hashMd5,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format ?? "jpeg",
    };
  } catch (error) {
    if (error instanceof ImageSanitizationError) {
      throw error;
    }
    throw new ImageSanitizationError("image_invalid");
  }
}
