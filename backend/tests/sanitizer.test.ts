import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeImage } from "../src/services/sanitizer.js";

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
});
