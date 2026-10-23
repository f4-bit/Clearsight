import crypto from "node:crypto";
import sharp from "sharp";
/**
 * Strips all EXIF, TIFF, and device metadata from medical retina images.
 * Keeps pixel fidelity, standardizes orientation, and computes MD5 hash.
 */
export async function sanitizeImage(inputBuffer) {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    // Strip all metadata (sharp strips all EXIF/ICC metadata by default when withMetadata is omitted)
    const cleanBuffer = await image
        .rotate()
        .jpeg({
        quality: 95,
        chromaSubsampling: "4:4:4", // Preserves microvascular resolution
        force: false,
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
}
//# sourceMappingURL=sanitizer.js.map