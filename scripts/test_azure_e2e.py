#!/usr/bin/env python
"""End-to-end verification of the Clearsight ML inference pipeline.

The script drives a deployed (or local) Clearsight ``ml-service`` through a full
multimodal inference cycle:

1.  Health check against ``/health/ready``.
2.  Synthetic retinal image generation (or a supplied image file/URL) together
    with the required eleven clinical features.
3.  Submission of an inference job via ``POST /v1/inferences``.
4.  Polling of ``GET /v1/inferences/{job_id}`` until a terminal status.
5.  Assertions over the returned ``label`` / ``predicted_class``,
    ``confidence``, ``probabilities`` and CDR values.

Example::

    python scripts/test_azure_e2e.py --base-url https://clearsight.example.net
    python scripts/test_azure_e2e.py --image-url https://acct.blob.core.windows.net/raw.png
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

DEFAULT_MANIFEST_PATH = ROOT / "ml" / "models" / "manifest.json"
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "REVIEW_REQUIRED"}
PROBABILITY_SUM_TOLERANCE = 0.01


class VerificationError(RuntimeError):
    """Raised when an end-to-end assertion fails."""


def load_manifest(path: Path | str = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_clinical_features(
    manifest: Mapping[str, Any],
    overrides: Mapping[str, float] | None = None,
) -> dict[str, float]:
    """Assemble the eleven clinical features using manifest Z-score means."""

    names = list(manifest["clinical_features"])
    means = list(manifest.get("clinical_mean") or [])
    features: dict[str, float] = {}
    for index, name in enumerate(names):
        value = means[index] if index < len(means) else 0.0
        features[str(name)] = float(value)
    for key, value in (overrides or {}).items():
        if key not in features:
            raise VerificationError(f"Unknown clinical feature override: {key}")
        features[key] = float(value)
    return features


def build_inference_request(
    image_url: str,
    manifest: Mapping[str, Any],
    *,
    inference_id: str | None = None,
    eye_side: str = "OD",
    model_version: str | None = None,
    clinical_overrides: Mapping[str, float] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "inference_id": inference_id or str(uuid.uuid4()),
        "image_url": image_url,
        "eye_side": eye_side,
        "clinical_features": build_clinical_features(manifest, clinical_overrides),
    }
    if model_version:
        payload["model_version"] = model_version
    return payload


def generate_synthetic_retinal_image(size: int = 768, seed: int = 42) -> bytes:
    """Render a deterministic fundus-like PNG for pipeline certification."""

    import cv2
    import numpy as np

    rng = np.random.default_rng(seed)
    image = np.zeros((size, size, 3), dtype=np.uint8)
    center = (size // 2, size // 2)
    cv2.circle(image, center, int(size * 0.46), (45, 32, 88), -1)

    disc_center = (int(size * 0.62), int(size * 0.5))
    cv2.ellipse(
        image,
        disc_center,
        (int(size * 0.11), int(size * 0.13)),
        0,
        0,
        360,
        (170, 195, 215),
        -1,
    )
    cv2.ellipse(
        image,
        disc_center,
        (int(size * 0.05), int(size * 0.06)),
        0,
        0,
        360,
        (228, 240, 246),
        -1,
    )

    for offset in range(6):
        angle = offset * 60.0
        radians = angle * 3.141592653589793 / 180.0
        end = (
            int(disc_center[0] + size * 0.3 * np.cos(radians)),
            int(disc_center[1] + size * 0.3 * np.sin(radians)),
        )
        cv2.line(image, disc_center, end, (110, 135, 165), 2)

    noise = rng.integers(0, 16, image.shape, dtype=np.uint8)
    image = cv2.add(image, noise)

    success, buffer = cv2.imencode(".png", image)
    if not success:
        raise VerificationError("Failed to encode the synthetic retinal image")
    return buffer.tobytes()


@contextmanager
def serve_image(payload: bytes, filename: str = "synthetic_retina.png") -> Iterator[str]:
    """Serve ``payload`` over a throwaway local HTTP server and yield its URL."""

    import tempfile

    with tempfile.TemporaryDirectory(prefix="clearsight-e2e-") as directory:
        path = Path(directory) / filename
        path.write_bytes(payload)
        handler = partial(SimpleHTTPRequestHandler, directory=directory)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address[0], server.server_address[1]
            yield f"http://{host}:{port}/{filename}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


@contextmanager
def image_source(image_url: str | None, image_path: str | None) -> Iterator[str]:
    """Yield the image URL the service should download.

    When ``image_url`` is provided it is used verbatim. Otherwise a local image
    (or a freshly generated synthetic retina) is served over a throwaway HTTP
    server, so the full download/decode path is exercised end to end.
    """

    if image_url:
        yield image_url
        return
    payload = (
        Path(image_path).read_bytes()
        if image_path
        else generate_synthetic_retinal_image()
    )
    filename = Path(image_path).name if image_path else "synthetic_retina.png"
    with serve_image(payload, filename) as url:
        yield url


def _auth_headers(api_token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_token}"} if api_token else {}


def wait_for_health(
    client: httpx.Client,
    *,
    timeout: float,
    interval: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error = "health endpoint unreachable"
    while time.monotonic() < deadline:
        try:
            response = client.get("/health/ready")
            if response.status_code == 200:
                return response.json()
            last_error = f"HTTP {response.status_code}: {response.text[:200]}"
        except httpx.HTTPError as error:  # pragma: no cover - network dependent
            last_error = str(error)
        time.sleep(interval)
    raise VerificationError(f"Service did not become ready: {last_error}")


def submit_inference(
    client: httpx.Client,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> dict[str, Any]:
    response = client.post("/v1/inferences", json=payload, headers=dict(headers))
    if response.status_code != 202:
        raise VerificationError(
            f"Inference submission failed with HTTP {response.status_code}: {response.text[:300]}"
        )
    accepted = response.json()
    if accepted.get("status") not in {"QUEUED", "DOWNLOADING", "LOCALIZING",
                                      "SEGMENTING", "CLASSIFYING", "COMPLETED"}:
        raise VerificationError(f"Unexpected submission status: {accepted.get('status')}")
    if not accepted.get("job_id"):
        raise VerificationError("Submission response is missing job_id")
    return accepted


def poll_job(
    client: httpx.Client,
    job_id: str,
    headers: Mapping[str, str],
    *,
    timeout: float,
    interval: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/inferences/{job_id}", headers=dict(headers))
        if response.status_code == 404:
            raise VerificationError(f"Inference job {job_id} was not found")
        if response.status_code != 200:
            raise VerificationError(
                f"Job polling failed with HTTP {response.status_code}: {response.text[:300]}"
            )
        last = response.json()
        if last.get("status") in TERMINAL_STATUSES:
            return last
        time.sleep(interval)
    raise VerificationError(
        f"Timed out after {timeout:.0f}s waiting for job {job_id} "
        f"(last status: {last.get('status')})"
    )


def validate_result(
    job: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    allow_review: bool = False,
) -> list[str]:
    """Return a list of validation problems (empty when the result is valid)."""

    problems: list[str] = []
    status = job.get("status")
    if status == "FAILED":
        return [f"Inference failed: {job.get('message')}"]
    if status not in {"COMPLETED", "REVIEW_REQUIRED"}:
        problems.append(f"Unexpected terminal status: {status}")

    result = job.get("result")
    if not isinstance(result, Mapping):
        problems.append("Job response is missing the inference result")
        return problems

    cdr = result.get("cdr")
    if not isinstance(cdr, int | float):
        problems.append("Result is missing a numeric cdr value")
    elif not 0.0 <= float(cdr) <= 1.0:
        problems.append(f"cdr out of range: {cdr}")

    if status == "REVIEW_REQUIRED":
        # Review results intentionally omit the classification head output.
        if not allow_review:
            problems.append("Inference requires manual review (pass --allow-review to accept)")
        return problems

    probabilities = result.get("probabilities")
    class_names = set(manifest.get("class_names", []))
    if not isinstance(probabilities, Mapping) or not probabilities:
        problems.append("Result is missing class probabilities")
    else:
        if class_names and set(probabilities) != class_names:
            problems.append(
                f"Probability keys {sorted(probabilities)} do not match {sorted(class_names)}"
            )
        for name, value in probabilities.items():
            if not isinstance(value, int | float) or not 0.0 <= float(value) <= 1.0:
                problems.append(f"Probability '{name}' is invalid: {value!r}")
        total = sum(float(value) for value in probabilities.values())
        if abs(total - 1.0) > PROBABILITY_SUM_TOLERANCE:
            problems.append(f"Probabilities do not sum to 1.0 (got {total:.4f})")

    predicted_class = result.get("label") or result.get("predicted_class")
    if predicted_class is None:
        problems.append("Result is missing label / predicted_class")
    elif class_names and predicted_class not in class_names:
        problems.append(f"label/predicted_class '{predicted_class}' is not in {sorted(class_names)}")

    confidence = result.get("confidence")
    if not isinstance(confidence, int | float):
        problems.append("Result is missing a numeric confidence")
    elif not 0.0 <= float(confidence) <= 1.0:
        problems.append(f"confidence out of range: {confidence}")

    if not result.get("model_predictions"):
        problems.append("Result is missing per-model predictions")
    if not result.get("artifacts"):
        problems.append("Result is missing segmentation artifacts")

    return problems


def run_verification(args: argparse.Namespace) -> dict[str, Any]:
    manifest = load_manifest(args.manifest)
    headers = _auth_headers(args.api_token)
    report: dict[str, Any] = {
        "base_url": args.base_url,
        "manifest": str(args.manifest),
        "checks": {},
    }

    with image_source(args.image_url, str(args.image) if args.image else None) as image_url:
        request_payload = build_inference_request(
            image_url,
            manifest,
            inference_id=args.inference_id,
            eye_side=args.eye_side,
            model_version=args.model_version,
        )
        report["request"] = request_payload

        with httpx.Client(
            base_url=args.base_url.rstrip("/"),
            timeout=args.request_timeout,
        ) as client:
            if not args.skip_health:
                health = wait_for_health(
                    client,
                    timeout=args.timeout,
                    interval=args.poll_interval,
                )
                report["checks"]["health_check"] = health
            accepted = submit_inference(client, request_payload, headers)
            report["checks"]["inference_submission"] = accepted
            job = poll_job(
                client,
                accepted["job_id"],
                headers,
                timeout=args.timeout,
                interval=args.poll_interval,
            )
            report["checks"]["job_polling"] = {
                "status": job.get("status"),
                "stage": job.get("stage"),
            }
            report["job"] = job
            problems = validate_result(job, manifest, allow_review=args.allow_review)
            report["checks"]["results_validation"] = {"problems": problems}
            if problems:
                raise VerificationError("; ".join(problems))

    report["result"] = "PASSED"
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="End-to-end verification of the Clearsight ML inference service.",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("CLEARSIGHT_API_BASE_URL", "http://localhost:8000"),
        help="Base URL of the Clearsight ml-service (default: http://localhost:8000).",
    )
    parser.add_argument(
        "--api-token",
        default=os.getenv("CLEARSIGHT_API_TOKEN") or os.getenv("ML_API_TOKEN"),
        help="Bearer token for the service (defaults to CLEARSIGHT_API_TOKEN/ML_API_TOKEN).",
    )
    parser.add_argument(
        "--image-url",
        default=None,
        help="Signed image URL the service should download. Generates and serves a "
        "synthetic image locally when omitted.",
    )
    parser.add_argument(
        "--image",
        type=Path,
        default=None,
        help="Local retinal image to serve over HTTP instead of the synthetic one.",
    )
    parser.add_argument("--eye-side", choices=["OD", "OS"], default="OD")
    parser.add_argument("--inference-id", default=None)
    parser.add_argument("--model-version", default=None)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST_PATH,
        help="Model manifest used for class names and clinical feature means.",
    )
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--request-timeout", type=float, default=30.0)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument(
        "--allow-review",
        action="store_true",
        help="Accept REVIEW_REQUIRED results (quality gate) as a passing outcome.",
    )
    parser.add_argument(
        "--skip-health",
        action="store_true",
        help="Skip the initial health check (useful when polling an already woken service).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Emit the verification report as JSON.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = run_verification(args)
    except VerificationError as error:
        failure = {"result": "FAILED", "error": str(error)}
        if args.as_json:
            print(json.dumps(failure, indent=2, sort_keys=True))
        else:
            print(f"[clearsight] E2E verification FAILED: {error}")
        return 1

    if args.as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        job = report.get("job", {})
        result = job.get("result") or {}
        predicted = result.get("label") or result.get("predicted_class")
        print("[clearsight] E2E verification PASSED")
        print(f"  base_url      : {report['base_url']}")
        print(f"  status        : {job.get('status')}")
        print(f"  label         : {predicted}")
        print(f"  confidence    : {result.get('confidence')}")
        print(f"  cdr           : {result.get('cdr')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
