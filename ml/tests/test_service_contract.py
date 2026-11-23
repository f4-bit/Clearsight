from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import Mock
from uuid import uuid4

import httpx
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import ml.inference.pipeline as pipeline_module
import ml.service.main as service_main
from ml.config import Settings, get_settings
from ml.inference.classification import ClassifierPrediction
from ml.inference.pipeline import InferencePipeline
from ml.inference.url_policy import SignedImageUrlError
from ml.service.main import Runtime, create_app
from ml.service.queue import InMemoryJobQueue
from ml.service.schemas import InferenceRequest

MANIFEST = json.loads(
    (Path(__file__).resolve().parents[1] / "models" / "manifest.json").read_text(
        encoding="utf-8"
    )
)
FEATURES = {name: 0.0 for name in MANIFEST["clinical_features"]}
AUTH = {"Authorization": "Bearer secret-token"}


class _Queue:
    def __init__(self) -> None:
        self.requests: list[InferenceRequest] = []

    async def enqueue(self, request: InferenceRequest) -> Any:
        self.requests.append(request)
        return request.inference_id


class _Pipeline:
    manifest = {"version": "test"}


class _ArtifactStore:
    def ensure_storage(self) -> None:
        return None


class _TrackingSegmentation:
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, *_: Any, **__: Any) -> Any:
        self.calls += 1
        raise AssertionError("segmentation must not run for an invalid URL")


class _TrackingClassification:
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, *_: Any, **__: Any) -> Any:
        self.calls += 1
        raise AssertionError("classification must not run for an invalid URL")


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "device": "cpu",
        "redis_url": None,
        "api_token": "secret-token",
        "allowed_signed_url_hosts": ("example.test",),
        "allow_http_signed_urls": False,
    }
    values.update(overrides)
    return replace(get_settings(), **values)


def _client(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> tuple[TestClient, _Queue]:
    monkeypatch.setattr(service_main, "get_settings", lambda: settings)
    queue = _Queue()
    application = create_app(initialize_runtime=False)
    application.state.runtime = Runtime(
        pipeline=_Pipeline(),  # type: ignore[arg-type]
        queue=queue,
        settings=settings,
    )
    return TestClient(application), queue


def _body(image_url: str = "https://example.test/image.png") -> dict[str, Any]:
    return {
        "inference_id": str(uuid4()),
        "image_url": image_url,
        "eye_side": "OD",
        "clinical_features": dict(FEATURES),
    }


def _pipeline(
    settings: Settings,
) -> tuple[InferencePipeline, _TrackingSegmentation, _TrackingClassification]:
    segmentation = _TrackingSegmentation()
    classification = _TrackingClassification()
    pipeline = InferencePipeline(
        settings=settings,
        segmentation=segmentation,  # type: ignore[arg-type]
        classification=classification,  # type: ignore[arg-type]
        artifact_store=_ArtifactStore(),  # type: ignore[arg-type]
        manifest={"version": "test"},
    )
    return pipeline, segmentation, classification


def _install_mock_transport(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    real_client = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(pipeline_module.httpx, "Client", factory)


@pytest.mark.parametrize("scenario", ["complete", "review", "legacy", "store_failure"])
def test_pipeline_publishes_only_available_evidence(monkeypatch, scenario):
    seg = Mock()
    classifier = Mock()
    store = Mock()
    uploaded = {}

    def upload(bucket, key, data, content_type):
        name = Path(key).stem
        if scenario == "store_failure" and name == "gradcam":
            raise RuntimeError("temporary store failure")
        uploaded[name] = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        return f"s3://test-evidence/{key}"

    store.upload_bytes.side_effect = upload
    mask = np.zeros((512, 512, 3), dtype=np.float32)
    if scenario != "review":
        cv2.circle(mask, (256, 256), 90, (0, 1, 0), -1)
        cv2.circle(mask, (256, 256), 40, (0, 0, 1), -1)
    seg.predict.return_value = mask
    classes = dict(zip(MANIFEST["class_names"], [0.2, 0.7, 0.1]))
    cams = np.zeros((3, 4, 4), dtype=np.float32)
    cams[1, 2:, :2] = 1
    classifier.predict.return_value = {
        name: ClassifierPrediction(classes, "Non_Glaucoma", 0.7, None if scenario == "legacy" else cams)
        for name in MANIFEST["ensemble"]
    }
    pipe = InferencePipeline(_settings(), seg, classifier, store, MANIFEST)
    image = np.random.default_rng(71).integers(0, 256, (640, 640, 3), dtype=np.uint8)
    monkeypatch.setattr(pipe, "_download_image", lambda url: cv2.imencode(".png", image)[1].tobytes())
    result = pipe.run(InferenceRequest.model_validate(_body()))
    assert {"mask", "overlay", "clahe"} <= result["artifacts"].keys()
    assert uploaded["clahe"].shape == uploaded["overlay"].shape
    if scenario == "review":
        classifier.predict.assert_not_called()
        assert result["label"] is None and result["status"] == "REVIEW_REQUIRED"
    else:
        assert result["label"] == "Non_Glaucoma" and result["status"] == "COMPLETED"
    if scenario == "complete":
        classifier_input = classifier.predict.call_args.args[0]
        rgb = np.rint(classifier_input[:3].transpose(1, 2, 0) * 255).astype(np.uint8)
        np.testing.assert_array_equal(uploaded["gradcam_base"], rgb[:, :, ::-1])
        assert uploaded["gradcam"].shape == uploaded["gradcam_base"].shape
    else:
        assert not {"gradcam", "gradcam_base"}.intersection(result["artifacts"])


def test_valid_signed_url_returns_202_and_enqueues_once(monkeypatch: pytest.MonkeyPatch) -> None:
    client, queue = _client(monkeypatch, _settings())

    response = client.post("/v1/inferences", json=_body(), headers=AUTH)

    assert response.status_code == 202
    assert response.json()["status"] == "QUEUED"
    assert len(queue.requests) == 1


def test_minio_http_dev_with_explicit_flag_and_exact_host_port_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        allowed_signed_url_hosts=("minio:9000",),
        allow_http_signed_urls=True,
    )
    client, queue = _client(monkeypatch, settings)

    response = client.post(
        "/v1/inferences",
        json=_body("http://minio:9000/bucket/image.png"),
        headers=AUTH,
    )

    assert response.status_code == 202
    assert len(queue.requests) == 1


@pytest.mark.parametrize(
    "extra",
    [
        {"cdr": 0.2},
        {"cdr_vertical": 0.2},
        {"unknown": True},
    ],
)
def test_invalid_json_contract_is_rejected_without_queue(
    monkeypatch: pytest.MonkeyPatch,
    extra: dict[str, Any],
) -> None:
    client, queue = _client(monkeypatch, _settings())
    body = _body()
    body.update(extra)

    response = client.post("/v1/inferences", json=body, headers=AUTH)

    assert response.status_code == 422
    assert queue.requests == []


def test_unknown_clinical_feature_is_rejected_without_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, queue = _client(monkeypatch, _settings())
    body = _body()
    body["clinical_features"]["unknown"] = 0.0

    response = client.post("/v1/inferences", json=body, headers=AUTH)

    assert response.status_code == 422
    assert queue.requests == []


def test_multipart_request_is_rejected_without_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, queue = _client(monkeypatch, _settings())

    response = client.post(
        "/v1/inferences",
        files={"file": ("image.png", b"not-an-image", "image/png")},
        headers=AUTH,
    )

    assert response.status_code == 422
    assert queue.requests == []


def test_missing_content_type_keeps_json_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    client, queue = _client(monkeypatch, _settings())

    response = client.post(
        "/v1/inferences",
        content=json.dumps(_body()),
        headers=AUTH,
    )

    assert response.status_code == 202
    assert len(queue.requests) == 1


@pytest.mark.parametrize(
    ("url", "allowed", "allow_http", "code"),
    [
        (
            "https://evil.test/secret-marker",
            ("example.test",),
            False,
            "image_url_host_not_allowed",
        ),
        (
            "https://example.test/image.png",
            (),
            False,
            "image_url_host_allowlist_required",
        ),
        (
            "http://example.test/image.png",
            (),
            True,
            "image_url_host_allowlist_required",
        ),
        (
            "http://example.test/image.png",
            ("example.test",),
            False,
            "http_image_urls_disabled",
        ),
        (
            "https://user:pass@example.test/image.png",
            ("example.test",),
            False,
            "invalid_image_url_userinfo",
        ),
        (
            "https://example.test/image.png#fragment",
            ("example.test",),
            False,
            "invalid_image_url_fragment",
        ),
        (
            "https://example.test:99999/image.png",
            ("example.test",),
            False,
            "invalid_image_url_port",
        ),
        (
            "https://example.test:0/image.png",
            ("example.test",),
            False,
            "invalid_image_url_port",
        ),
        (
            "file:///tmp/image.png",
            ("example.test",),
            False,
            "invalid_image_url_scheme",
        ),
        (
            "data:image/png;base64,AAAA",
            ("example.test",),
            False,
            "invalid_image_url_scheme",
        ),
        (
            "https:///image.png",
            ("example.test",),
            False,
            "invalid_image_url_host",
        ),
        (
            "https://[::1",
            ("example.test",),
            False,
            "invalid_image_url",
        ),
    ],
)
def test_invalid_image_url_is_rejected_before_queue(
    monkeypatch: pytest.MonkeyPatch,
    url: str,
    allowed: tuple[str, ...],
    allow_http: bool,
    code: str,
) -> None:
    settings = _settings(
        allowed_signed_url_hosts=allowed,
        allow_http_signed_urls=allow_http,
    )
    client, queue = _client(monkeypatch, settings)

    response = client.post("/v1/inferences", json=_body(url), headers=AUTH)

    assert response.status_code == 422
    assert response.json()["detail"] == code
    assert url not in response.text
    assert queue.requests == []


def test_pipeline_rejects_invalid_url_before_http_client_and_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, segmentation, classification = _pipeline(_settings())
    client_calls = 0

    def trap(*_: Any, **__: Any) -> Any:
        nonlocal client_calls
        client_calls += 1
        raise AssertionError("HTTP client must not be constructed")

    monkeypatch.setattr(pipeline_module.httpx, "Client", trap)

    with pytest.raises(SignedImageUrlError) as error:
        pipeline.run(
            InferenceRequest.model_validate(_body("https://evil.test/secret-marker")),
            lambda _: None,
        )

    assert error.value.code == "image_url_host_not_allowed"
    assert "secret-marker" not in str(error.value)
    assert client_calls == 0
    assert segmentation.calls == 0
    assert classification.calls == 0


@pytest.mark.parametrize("status_code", [301, 302, 307])
def test_downloader_blocks_redirects_without_following(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    pipeline, _, _ = _pipeline(_settings())
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            status_code,
            headers={"location": "https://evil.test/next"},
        )

    captured: dict[str, Any] = {}
    real_client = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        captured.update(kwargs)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(pipeline_module.httpx, "Client", factory)

    with pytest.raises(ValueError, match=f"HTTP {status_code}"):
        pipeline._download_image("https://example.test/image.png")

    assert captured["follow_redirects"] is False
    assert len(seen) == 1
    assert str(seen[0].url) == "https://example.test/image.png"


def test_downloader_rejects_oversized_content_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings(max_image_bytes=4))

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "5"},
            content=b"12345",
        )

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="maximum allowed size"):
        pipeline._download_image("https://example.test/image.png")


def test_downloader_rejects_oversized_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings(max_image_bytes=4))

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=iter([b"12", b"345"]))

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="maximum allowed size"):
        pipeline._download_image("https://example.test/image.png")


def test_downloader_network_error_is_safe_and_does_not_echo_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings())

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("secret-marker", request=request)

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="^image_download_failed$") as error:
        pipeline._download_image("https://example.test/secret-marker")

    assert "secret-marker" not in str(error.value)


def test_downloader_passes_the_configured_request_timeout_to_the_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(request_timeout_seconds=7.5)
    pipeline, _, _ = _pipeline(settings)
    captured: dict[str, Any] = {}
    real_client = httpx.Client

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"12345")

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        captured.update(kwargs)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(pipeline_module.httpx, "Client", factory)

    assert pipeline._download_image("https://example.test/image.png") == b"12345"
    assert captured["timeout"] == 7.5


def test_downloader_timeout_fails_safely_without_echoing_the_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings())

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("secret-marker", request=request)

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="^image_download_failed$") as error:
        pipeline._download_image("https://example.test/secret-marker")

    assert "secret-marker" not in str(error.value)


def test_downloader_normalizes_httpx_invalid_url_to_safe_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings())

    def invalid_url(*_: Any, **__: Any) -> Any:
        raise httpx.InvalidURL("secret-invalid-url")

    monkeypatch.setattr(pipeline_module.httpx, "Client", invalid_url)

    with pytest.raises(ValueError, match="^image_download_failed$") as error:
        pipeline._download_image("https://example.test/image.png")

    assert "secret-invalid-url" not in str(error.value)


def test_downloader_rejects_invalid_content_length_without_raw_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings())

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "secret-length"},
            content=b"ok",
        )

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="^image_download_failed$") as error:
        pipeline._download_image("https://example.test/image.png")

    assert "secret-length" not in str(error.value)


def test_downloader_accepts_valid_bounded_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _, _ = _pipeline(_settings(max_image_bytes=10))

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "5"},
            content=b"12345",
        )

    _install_mock_transport(monkeypatch, handler)

    assert pipeline._download_image("https://example.test/image.png") == b"12345"


@pytest.mark.parametrize("oversize", ["header", "stream"])
def test_pipeline_rejects_oversized_payload_before_inference(
    monkeypatch: pytest.MonkeyPatch,
    oversize: str,
) -> None:
    pipeline, segmentation, classification = _pipeline(_settings(max_image_bytes=4))

    def handler(_: httpx.Request) -> httpx.Response:
        if oversize == "header":
            return httpx.Response(
                200,
                headers={"content-length": "5"},
                content=b"12345",
            )
        return httpx.Response(200, content=iter([b"12", b"345"]))

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(ValueError, match="maximum allowed size"):
        pipeline.run(InferenceRequest.model_validate(_body()), lambda _: None)

    assert segmentation.calls == 0
    assert classification.calls == 0


def test_legacy_invalid_url_job_fails_with_safe_message_without_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    pipeline, segmentation, classification = _pipeline(settings)

    def trap(*_: Any, **__: Any) -> Any:
        raise AssertionError("HTTP client must not be constructed")

    monkeypatch.setattr(pipeline_module.httpx, "Client", trap)
    queue = InMemoryJobQueue(settings)
    request = InferenceRequest.model_validate(_body("https://evil.test/secret-marker"))

    async def _run() -> dict[str, Any] | None:
        job_id = await queue.enqueue(request)
        await queue.start(pipeline)
        state: dict[str, Any] | None = None
        for _ in range(200):
            state = await queue.get(job_id)  # type: ignore[arg-type]
            if state is not None and state["status"] == "FAILED":
                break
            await asyncio.sleep(0.01)
        await queue.close()
        return state

    state = asyncio.run(_run())

    assert state is not None
    assert state["status"] == "FAILED"
    assert state["message"] == "image_url_host_not_allowed"
    assert "secret-marker" not in state["message"]
    assert segmentation.calls == 0
    assert classification.calls == 0
