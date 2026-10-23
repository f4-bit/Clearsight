import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
const endpointProtocol = env.MINIO_SECURE ? "https" : "http";
const endpointUrl = `${endpointProtocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
export const s3Client = new S3Client({
    endpoint: endpointUrl,
    region: "us-east-1",
    credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true, // Required for MinIO
});
export class StorageService {
    static async ensureBucket(bucketName) {
        try {
            await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        }
        catch {
            try {
                await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
            }
            catch (err) {
                // Ignored if already created concurrently
            }
        }
    }
    static async upload(bucket, key, body, contentType = "image/jpeg") {
        await this.ensureBucket(bucket);
        await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));
        return `${bucket}/${key}`;
    }
    static async getDownloadUrl(bucket, key, expiresIn = 3600) {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });
        return getSignedUrl(s3Client, command, { expiresIn });
    }
    static async getObjectStream(bucket, key) {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return response.Body;
    }
}
//# sourceMappingURL=storage.js.map