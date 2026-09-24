from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

INFERENCE_REQUESTS = Counter(
    "clearsight_ml_inference_requests_total",
    "ML inference requests",
    ["status"],
)
INFERENCE_DURATION = Histogram(
    "clearsight_ml_inference_duration_seconds",
    "ML inference duration",
)
GPU_ERRORS = Counter(
    "clearsight_ml_gpu_errors_total",
    "ML GPU errors",
)


def metrics_response() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
