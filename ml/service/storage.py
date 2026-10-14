from __future__ import annotations

import os
from typing import Protocol
from urllib.parse import urlparse

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
        self.minio_required = settings.minio_required
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
        try:
            self.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=payload,
                ContentType=content_type,
            )
        except Exception:
            if self.minio_required:
                raise
            return None
        return f"s3://{bucket}/{key}"


class AzureBlobArtifactStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = None
        if settings.minio_required and not all(
            [
                settings.minio_endpoint,
                settings.minio_secret_key,
            ]
        ):
            raise RuntimeError("Azure Blob Storage configuration is incomplete")

        account_url = settings.minio_endpoint or ""
        if account_url and not account_url.startswith(("http://", "https://")):
            account_url = f"https://{account_url}"

        connection_string = os.getenv(
            "AZURE_STORAGE_CONNECTION_STRING"
        ) or os.getenv("ML_AZURE_STORAGE_CONNECTION_STRING")

        if not connection_string and not all(
            [account_url, settings.minio_secret_key]
        ):
            return

        from azure.storage.blob import BlobServiceClient

        if connection_string:
            self.client = BlobServiceClient.from_connection_string(
                connection_string
            )
        else:
            self.client = BlobServiceClient(
                account_url=account_url,
                credential=settings.minio_secret_key,
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
        from azure.storage.blob import ContentSettings

        try:
            container = self.client.get_container_client(bucket)
            container.upload_blob(
                name=key,
                data=payload,
                overwrite=True,
                content_settings=ContentSettings(content_type=content_type),
            )
        except Exception:
            if self.settings.minio_required:
                raise
            return None
        return f"azure://{bucket}/{key}"


def _is_azure_blob_endpoint(endpoint: str | None) -> bool:
    if not endpoint:
        return False
    candidate = endpoint
    if "://" in candidate:
        candidate = urlparse(candidate).hostname or ""
    candidate = candidate.split("/")[0].split(":")[0]
    return candidate.endswith("blob.core.windows.net")


def create_artifact_store(settings: Settings) -> ArtifactStore:
    if _is_azure_blob_endpoint(settings.minio_endpoint):
        return AzureBlobArtifactStore(settings)
    return MinioArtifactStore(settings)
