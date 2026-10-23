export interface SanitizedImage {
    buffer: Buffer;
    hashMd5: string;
    width?: number;
    height?: number;
    format: string;
}
/**
 * Strips all EXIF, TIFF, and device metadata from medical retina images.
 * Keeps pixel fidelity, standardizes orientation, and computes MD5 hash.
 */
export declare function sanitizeImage(inputBuffer: Buffer): Promise<SanitizedImage>;
