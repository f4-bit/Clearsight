from __future__ import annotations

from typing import Protocol

from ml.config import Settings


class ArtifactStore(Protocol):
    def upload_bytes(
        self,
        bucket: str | None,
        key: str,
        payload: bytes,
        content_type: str,
    ) -> str | None:
        ...


class MinioArtifactStore:
    def __init__(self, settings: Settings) -> None:
        if settings.minio_required and not all(
            [
                settings.minio_endpoint,
                settings.minio_access_key,
                settings.minio_secret_key,
                settings.mask_bucket,
                settings.overlay_bucket,
            ]
        ):
            raise RuntimeError("MinIO configuration is incomplete")
        if not all(
            [
                settings.minio_endpoint,
                settings.minio_access_key,
                settings.minio_secret_key,
            ]
        ):
            self.client = None
            return
        import boto3
        from botocore.config import Config

        endpoint = settings.minio_endpoint or ""
        if not endpoint.startswith(("http://", "https://")):
            endpoint = f"{'https' if settings.minio_secure else 'http'}://{endpoint}"
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            region_name="us-east-1",
            config=Config(s3={"addressing_style": "path"}),
        )

    def upload_bytes(
        self,
        bucket: str | None,
        key: str,
        payload: bytes,
        content_type: str,
    ) -> str | None:
        if self.client is None or bucket is None:
            return None
        self.client.put_object(
            Bucket=bucket,
            Key=key,
            Body=payload,
            ContentType=content_type,
        )
        return f"s3://{bucket}/{key}"
