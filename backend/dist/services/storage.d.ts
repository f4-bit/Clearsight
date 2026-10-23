import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
export declare const s3Client: S3Client;
export declare class StorageService {
    static ensureBucket(bucketName: string): Promise<void>;
    static upload(bucket: string, key: string, body: Buffer | Uint8Array, contentType?: string): Promise<string>;
    static getDownloadUrl(bucket: string, key: string, expiresIn?: number): Promise<string>;
    static getObjectStream(bucket: string, key: string): Promise<Readable>;
}
