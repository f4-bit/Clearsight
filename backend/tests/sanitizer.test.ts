import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ImageSanitizationError,
  MAX_SANITIZER_INPUT_BYTES,
  sanitizeImage,
} from "../src/services/sanitizer.js";

describe("Image Sanitizer Service", () => {
  it("strips metadata, preserves dimensions and computes md5 hash", async () => {
    // Create synthetic test JPEG image with EXIF metadata in memory
    const testImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 10, g: 120, b: 200 },
      },
    })
      .withMetadata({
        exif: {
          IFD0: {
            Artist: "Doctor Clinic",
          },
        },
      })
      .jpeg()
      .toBuffer();

    // Verify initial test image HAS exif
    const initialMeta = await sharp(testImage).metadata();
    expect(initialMeta.exif).toBeDefined();

    const sanitized = await sanitizeImage(testImage);

    expect(sanitized.buffer).toBeInstanceOf(Buffer);
    expect(sanitized.hashMd5).toHaveLength(32);
    expect(sanitized.width).toBe(100);
    expect(sanitized.height).toBe(100);

    // Verify metadata was completely stripped
    const cleanMeta = await sharp(sanitized.buffer).metadata();
    expect(cleanMeta.exif).toBeUndefined();
  });

  it("accepts a JPEG at or above 512px and re-encodes it as JPEG", async () => {
    const input = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .withMetadata({ exif: { IFD0: { Artist: "retina" } } })
      .jpeg({ quality: 90 })
      .toBuffer();

    const sanitized = await sanitizeImage(input);
    const outputMeta = await sharp(sanitized.buffer).metadata();

    expect(outputMeta.format).toBe("jpeg");
    expect(outputMeta.width).toBe(512);
    expect(outputMeta.height).toBe(512);
    expect(outputMeta.exif).toBeUndefined();
    expect(sanitized.hashMd5).toMatch(/^[0-9a-f]{32}$/);
  });

  it("accepts a PNG at or above 512px, preserves dimensions and strips EXIF", async () => {
    const input = await sharp({
      create: {
        width: 640,
        height: 512,
        channels: 3,
        background: { r: 200, g: 120, b: 40 },
      },
    })
      .withMetadata({ exif: { IFD0: { Artist: "retina" } } })
      .png()
      .toBuffer();

    const sanitized = await sanitizeImage(input);
    const outputMeta = await sharp(sanitized.buffer).metadata();

    expect(outputMeta.format).toBe("jpeg");
    expect(outputMeta.width).toBe(640);
    expect(outputMeta.height).toBe(512);
    expect(outputMeta.exif).toBeUndefined();
  });

  it("rejects an input larger than the 20 MiB sanitizer limit", async () => {
    const oversized = Buffer.alloc(MAX_SANITIZER_INPUT_BYTES + 1);
    await expect(sanitizeImage(oversized)).rejects.toMatchObject({
      code: "image_too_large",
    });
  });

  it("rejects invalid bytes with a safe, non-leaking error", async () => {
    const error = await sanitizeImage(Buffer.from("not-an-image")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImageSanitizationError);
    expect(error).toMatchObject({ code: "image_invalid" });
    expect((error as Error).message).not.toContain("not-an-image");
    expect((error as Error).cause).toBeUndefined();
  });

  it("maps a sharp decode failure to the same safe invalid-image error", async () => {
    const truncatedPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    await expect(sanitizeImage(truncatedPng)).rejects.toMatchObject({
      code: "image_invalid",
    });
  });
});
