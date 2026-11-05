import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
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

// Client used only to generate presigned URLs consumed by the ML process. ML runs inside
// the Docker network and must not receive localhost URLs, so when ML_PUBLIC_HOST is set
// (e.g. "minio:9000") we sign against that network hostname instead.
const mlEndpointUrl = env.ML_PUBLIC_HOST
  ? `${endpointProtocol}://${env.ML_PUBLIC_HOST}`
  : endpointUrl;

const mlS3Client = new S3Client({
  endpoint: mlEndpointUrl,
  region: "us-east-1",
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

export class StorageService {
  static async ensureBucket(bucketName: string): Promise<void> {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch {
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
      } catch (err) {
        // Ignored if already created concurrently
      }
    }
  }

  static async upload(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array,
    contentType = "image/jpeg"
  ): Promise<string> {
    await this.ensureBucket(bucket);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    return `${bucket}/${key}`;
  }

  static async getDownloadUrl(bucket: string, key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    return getSignedUrl(s3Client as any, command, { expiresIn });
  }

  static async getMlDownloadUrl(bucket: string, key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    return getSignedUrl(mlS3Client as any, command, { expiresIn });
  }

  static async getObjectStream(bucket: string, key: string): Promise<Readable> {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    return response.Body as Readable;
  }
}
