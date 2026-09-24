import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _optional_env(name: str) -> str | None:
    value = os.getenv(name)
    return value if value else None


def _json_env(name: str) -> list[float] | None:
    value = os.getenv(name)
    if not value:
        return None
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError(f"{name} must be a JSON list")
    return [float(item) for item in parsed]


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    device: str
    model_cache_dir: Path
    model_manifest_path: Path
    redis_url: str | None
    queue_name: str
    api_token: str | None
    allow_http_signed_urls: bool
    allowed_signed_url_hosts: tuple[str, ...]
    max_image_bytes: int
    request_timeout_seconds: float
    min_image_side: int
    minio_endpoint: str | None
    minio_access_key: str | None
    minio_secret_key: str | None
    minio_secure: bool
    mask_bucket: str | None
    overlay_bucket: str | None
    minio_required: bool
    clinical_mean: list[float] | None
    clinical_std: list[float] | None

    @property
    def gpu_required(self) -> bool:
        return self.device.startswith("cuda")


def get_settings() -> Settings:
    allowed_hosts = tuple(
        host.strip()
        for host in (os.getenv("ML_ALLOWED_SIGNED_URL_HOSTS", "")).split(",")
        if host.strip()
    )
    default_manifest = Path(__file__).resolve().parent / "models" / "manifest.json"
    default_cache = Path.home() / ".cache" / "clearsight" / "models"
    return Settings(
        host=os.getenv("ML_HOST", "0.0.0.0"),
        port=int(os.getenv("ML_PORT", "8000")),
        device=os.getenv("ML_DEVICE", "cuda"),
        model_cache_dir=Path(os.getenv("ML_MODEL_CACHE_DIR", str(default_cache))),
        model_manifest_path=Path(
            os.getenv("ML_MANIFEST_PATH", str(default_manifest))
        ),
        redis_url=_optional_env("ML_REDIS_URL"),
        queue_name=os.getenv("ML_QUEUE_NAME", "clearsight:ml:inference"),
        api_token=_optional_env("ML_API_TOKEN"),
        allow_http_signed_urls=os.getenv("ML_ALLOW_HTTP_SIGNED_URLS", "false").lower()
        == "true",
        allowed_signed_url_hosts=allowed_hosts,
        max_image_bytes=int(os.getenv("ML_MAX_IMAGE_BYTES", str(25 * 1024 * 1024))),
        request_timeout_seconds=float(os.getenv("ML_REQUEST_TIMEOUT_SECONDS", "30")),
        min_image_side=int(os.getenv("ML_MIN_IMAGE_SIDE", "512")),
        minio_endpoint=_optional_env("ML_MINIO_ENDPOINT"),
        minio_access_key=_optional_env("ML_MINIO_ACCESS_KEY"),
        minio_secret_key=_optional_env("ML_MINIO_SECRET_KEY"),
        minio_secure=os.getenv("ML_MINIO_SECURE", "false").lower() == "true",
        mask_bucket=_optional_env("ML_MASK_BUCKET"),
        overlay_bucket=_optional_env("ML_OVERLAY_BUCKET"),
        minio_required=os.getenv("ML_MINIO_REQUIRED", "true").lower() == "true",
        clinical_mean=_json_env("ML_CLINICAL_MEAN_JSON"),
        clinical_std=_json_env("ML_CLINICAL_STD_JSON"),
    )


@lru_cache
def cached_settings() -> Settings:
    return get_settings()
