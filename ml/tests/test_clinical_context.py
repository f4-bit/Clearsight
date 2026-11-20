from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient

import ml.service.main as service_main
from ml.config import get_settings
from ml.inference.classification import (
    ResolvedClinicalParameters,
    normalize_clinical_features,
    resolve_clinical_parameters,
)
from ml.inference.pipeline import InferencePipeline
from ml.service.context import (
    FLOAT32_MAX,
    ClinicalContextError,
    ContextMismatchError,
    ContextUnavailableError,
    InvalidClinicalInputError,
    RequestedModelVersionError,
    RuntimeContext,
    build_runtime_context,
    prepare_clinical_snapshot,
    verify_expected_context,
)
from ml.service.main import Runtime, create_app
from ml.service.queue import (
    InMemoryJobQueue,
    RedisJobQueue,
    request_from_dict,
    request_to_dict,
)
from ml.service.schemas import InferenceRequest

MANIFEST_PATH = Path(__file__).resolve().parents[1] / "models" / "manifest.json"
MANIFEST: dict[str, Any] = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
FEATURES = tuple(MANIFEST["clinical_features"])
MEAN = tuple(float(value) for value in MANIFEST["clinical_mean"])
STD = tuple(float(value) for value in MANIFEST["clinical_std"])
ARTIFACT_NAMES = ("segmentation", "efficientnet_b3", "resnet50")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_artifacts(tmp_path: Path) -> dict[str, Path]:
    paths: dict[str, Path] = {}
    for name in ARTIFACT_NAMES:
        path = tmp_path / f"{name}.bin"
        path.write_bytes(f"artifact-{name}".encode())
        paths[name] = path
    return paths


def _manifest(
    paths: dict[str, Path],
    *,
    backend: str = "pytorch",
) -> dict[str, Any]:
    manifest = copy.deepcopy(MANIFEST)
    artifacts: dict[str, dict[str, str]] = {}
    for name, path in paths.items():
        sha256 = _sha256(path) if name == "segmentation" or backend == "pytorch" else "a" * 64
        artifacts[name] = {
            "repository": f"repo/{name}",
            "revision": f"revision-{name}",
            "filename": path.name,
            "sha256": sha256,
        }
    manifest["artifacts"] = artifacts
    return manifest


def _parameters(
    *,
    mean: tuple[float, ...] = MEAN,
    std: tuple[float, ...] = STD,
    mean_source: str = "manifest",
    std_source: str = "manifest",
) -> ResolvedClinicalParameters:
    return ResolvedClinicalParameters(
        feature_names=FEATURES,
        mean=mean,
        std=std,
        mean_source=mean_source,
        std_source=std_source,
    )


def _context(
    tmp_path: Path,
    *,
    backend: str = "pytorch",
    parameters: ResolvedClinicalParameters | None = None,
    manifest: dict[str, Any] | None = None,
    artifact_paths: dict[str, Path] | None = None,
) -> RuntimeContext:
    paths = artifact_paths or _write_artifacts(tmp_path)
    return build_runtime_context(
        manifest=manifest or _manifest(paths, backend=backend),
        backend=backend,
        parameters=parameters or _parameters(),
        artifact_paths=paths,
    )


def _features() -> dict[str, float]:
    return {name: 0.0 for name in FEATURES}


def _inference_body(context: RuntimeContext | None, *, include_pin: bool = True) -> dict[str, Any]:
    body: dict[str, Any] = {
        "inference_id": str(uuid4()),
        "image_url": "https://example.test/image.png",
        "eye_side": "OD",
        "clinical_features": _features(),
    }
    if include_pin and context is not None:
        body["expected_context"] = {
            "schema_version": context.schema_version,
            "fingerprint_sha256": context.fingerprint_sha256,
        }
    return body


class _Queue:
    def __init__(self) -> None:
        self.requests: list[InferenceRequest] = []

    async def enqueue(self, request: InferenceRequest) -> Any:
        self.requests.append(request)
        return request.inference_id


class _Pipeline:
    manifest = {"version": "test"}


def _client(
    monkeypatch: pytest.MonkeyPatch,
    context: RuntimeContext | None,
) -> tuple[TestClient, _Queue]:
    monkeypatch.setattr(
        service_main,
        "get_settings",
        lambda: replace(get_settings(), api_token="secret-token"),
    )
    queue = _Queue()
    application = create_app(initialize_runtime=False)
    application.state.runtime = Runtime(
        pipeline=_Pipeline(),
        queue=queue,
        context=context,
    )
    return TestClient(application), queue


def _auth() -> dict[str, str]:
    return {"Authorization": "Bearer secret-token"}


def test_prepare_uses_real_normalization_and_exact_raw_payload(tmp_path) -> None:
    context = _context(tmp_path)
    features = _features()

    prepared = prepare_clinical_snapshot(context, features)

    assert dict(prepared.raw_canonical) == {"clinicalFeatures": features}
    assert "eyeSide" not in prepared.raw_canonical
    expected = normalize_clinical_features(features, FEATURES, MEAN, STD)
    values = prepared.normalized_payload["values"]
    assert prepared.normalized_payload["orderedFeatureNames"] == list(FEATURES)
    assert prepared.normalized_payload["dtype"] == "float32"
    assert np.allclose(values, [float(value) for value in expected], atol=1e-6)
    assert prepared.schema_version == "ml-zscore-f32-v1"
    assert prepared.context_fingerprint_sha256 == context.fingerprint_sha256
    descriptor = prepared.normalized_payload["descriptor"]
    assert isinstance(descriptor, dict)
    assert descriptor["schema_version"] == "ml-zscore-f32-v1"
    assert descriptor["normalization"]["ordered_feature_names"] == list(FEATURES)
    assert len(descriptor["normalization"]["mean"]) == 11
    assert len(descriptor["normalization"]["std"]) == 11
    assert descriptor["model"]["binaries"]["resnet50"]["sha256"]
    assert descriptor["preprocessing"]["localization"]["gaussian_kernel_max"] == 151
    assert (
        prepared.normalized_payload["contextFingerprintSha256"]
        == context.fingerprint_sha256
    )
    canonical_json = prepared.normalized_payload["canonicalJson"]
    assert hashlib.sha256(canonical_json.encode("utf-8")).hexdigest() == (
        context.fingerprint_sha256
    )
    assert json.loads(canonical_json) == descriptor
    assert set(prepared.model_versions) == {
        "manifest",
        "backend",
        "segmentation",
        "efficientnet_b3",
        "resnet50",
    }


def test_prepare_legitimate_values_still_normalize_as_before(tmp_path) -> None:
    context = _context(tmp_path)
    features = {
        name: mean + std for name, mean, std in zip(FEATURES, MEAN, STD)
    }

    prepared = prepare_clinical_snapshot(context, features)

    expected = normalize_clinical_features(features, FEATURES, MEAN, STD)
    values = prepared.normalized_payload["values"]
    assert all(np.isfinite(values))
    assert np.allclose(values, [float(value) for value in expected], atol=1e-6)


def test_prepare_rejects_missing_extra_and_nonfinite_features(tmp_path) -> None:
    context = _context(tmp_path)

    with pytest.raises(ClinicalContextError):
        prepare_clinical_snapshot(context, {**_features(), "extra": 1.0})
    with pytest.raises(ClinicalContextError):
        prepare_clinical_snapshot(context, {k: v for k, v in _features().items() if k != "Age"})
    with pytest.raises(ClinicalContextError):
        prepare_clinical_snapshot(context, {**_features(), "Age": float("nan")})


def test_prepare_rejects_finite_float64_overflowing_float32(tmp_path) -> None:
    context = _context(tmp_path)
    features = {**_features(), "Pachymetry": 1e300}

    with pytest.raises(InvalidClinicalInputError):
        prepare_clinical_snapshot(context, features)


def test_prepare_rejects_normalized_overflow_with_valid_float32_params(tmp_path) -> None:
    parameters = _parameters(
        mean=(FLOAT32_MAX,) * len(FEATURES),
        std=(1.0,) * len(FEATURES),
    )
    context = _context(tmp_path, parameters=parameters)
    features = {name: -FLOAT32_MAX for name in FEATURES}

    with pytest.raises(InvalidClinicalInputError):
        prepare_clinical_snapshot(context, features)


def test_context_parameters_outside_float32_fail_closed(tmp_path) -> None:
    for parameters in [
        _parameters(mean=(1e300, *MEAN[1:])),
        _parameters(std=(1e300, *STD[1:])),
    ]:
        with pytest.raises(ClinicalContextError):
            _context(tmp_path, parameters=parameters)


def test_requested_model_version_must_match_runtime(tmp_path) -> None:
    context = _context(tmp_path)

    prepare_clinical_snapshot(context, _features(), context.manifest_version)
    with pytest.raises(RequestedModelVersionError):
        prepare_clinical_snapshot(context, _features(), "not-the-runtime-version")


def test_resolver_mixed_overrides_and_immutable_copy(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    manifest = _manifest(paths)
    settings = replace(
        get_settings(),
        device="cpu",
        clinical_mean=list(MEAN),
        clinical_std=None,
    )

    parameters = resolve_clinical_parameters(settings, manifest)
    assert parameters.mean_source == "env"
    assert parameters.std_source == "manifest"
    assert parameters.mean == MEAN
    assert parameters.std == STD

    settings.clinical_mean[0] = 999.0
    assert parameters.mean[0] == MEAN[0]

    context = _context(
        tmp_path,
        parameters=parameters,
        manifest=manifest,
        artifact_paths=paths,
    )
    mean_sources = {
        item["source"] for item in context.descriptor["normalization"]["mean"]
    }
    std_sources = {
        item["source"] for item in context.descriptor["normalization"]["std"]
    }
    assert mean_sources == {"env"}
    assert std_sources == {"manifest"}


def test_fingerprint_changes_with_parameters_preprocessing_backend_and_binary(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    base = _context(tmp_path, artifact_paths=paths, backend="pytorch")
    base_fingerprint = base.fingerprint_sha256

    changed_mean = _context(
        tmp_path,
        artifact_paths=paths,
        parameters=_parameters(mean=(MEAN[0] + 1.0, *MEAN[1:])),
        backend="pytorch",
    )
    assert changed_mean.fingerprint_sha256 != base_fingerprint

    changed_preprocessing_manifest = _manifest(paths, backend="pytorch")
    changed_preprocessing_manifest["segmentation"]["crop_margin"] += 1
    changed_preprocessing = _context(
        tmp_path,
        artifact_paths=paths,
        manifest=changed_preprocessing_manifest,
        backend="pytorch",
    )
    assert changed_preprocessing.fingerprint_sha256 != base_fingerprint

    changed_backend = _context(tmp_path, artifact_paths=paths, backend="onnx")
    assert changed_backend.fingerprint_sha256 != base_fingerprint

    onnx_before = _context(tmp_path, artifact_paths=paths, backend="onnx")
    paths["efficientnet_b3"].write_bytes(b"different-onnx-binary")
    onnx_after = _context(tmp_path, artifact_paths=paths, backend="onnx")
    assert onnx_after.fingerprint_sha256 != onnx_before.fingerprint_sha256
    assert (
        onnx_after.descriptor["model"]["artifacts"]["efficientnet_b3"]["sha256"]
        == onnx_before.descriptor["model"]["artifacts"]["efficientnet_b3"]["sha256"]
    )


def test_pytorch_binary_mismatch_fails_closed(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    manifest = _manifest(paths, backend="pytorch")
    paths["resnet50"].write_bytes(b"tampered")

    with pytest.raises(ClinicalContextError):
        _context(
            tmp_path,
            artifact_paths=paths,
            manifest=manifest,
            backend="pytorch",
        )


@pytest.mark.parametrize(
    "case",
    [
        "mean_length",
        "zero_std",
        "nan_mean",
        "missing_artifact",
        "missing_version",
        "bad_preprocessing",
        "bad_backend",
    ],
)
def test_invalid_contexts_fail_closed(tmp_path, case: str) -> None:
    paths = _write_artifacts(tmp_path)
    manifest = _manifest(paths)
    parameters = _parameters()

    if case == "mean_length":
        parameters = _parameters(mean=MEAN[:-1])
    elif case == "zero_std":
        parameters = _parameters(std=(0.0, *STD[1:]))
    elif case == "nan_mean":
        parameters = _parameters(mean=(float("nan"), *MEAN[1:]))
    elif case == "missing_artifact":
        paths.pop("resnet50")
    elif case == "missing_version":
        manifest["version"] = ""
    elif case == "bad_preprocessing":
        manifest["segmentation"]["crop_margin"] = -1
    elif case == "bad_backend":
        pass

    with pytest.raises(ClinicalContextError):
        _context(
            tmp_path,
            artifact_paths=paths,
            manifest=manifest,
            parameters=parameters,
            backend="tensorflow" if case == "bad_backend" else "pytorch",
        )


def test_context_metadata_has_no_paths_tokens_and_is_immutable(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    context = _context(tmp_path, artifact_paths=paths)

    assert str(tmp_path) not in context.canonical_json
    assert "secret-token" not in context.canonical_json
    assert (
        context.descriptor["model"]["binaries"]["resnet50"]["filename"]
        == paths["resnet50"].name
    )
    with pytest.raises(TypeError):
        context.descriptor["schema_version"] = "changed"  # type: ignore[index]
    with pytest.raises(TypeError):
        context.descriptor["model"]["backend"] = "changed"  # type: ignore[index]


def test_context_copies_manifest_preprocessing(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    manifest = _manifest(paths)
    context = _context(tmp_path, artifact_paths=paths, manifest=manifest)

    manifest["segmentation"]["crop_margin"] = 999
    assert context.preprocessing["crop"]["crop_margin"] != 999


def test_queue_round_trip_preserves_expected_context(tmp_path) -> None:
    context = _context(tmp_path)
    pinned = InferenceRequest.model_validate(_inference_body(context))
    restored = request_from_dict(request_to_dict(pinned))
    assert restored.expected_context == pinned.expected_context

    legacy = InferenceRequest.model_validate(_inference_body(None, include_pin=False))
    assert request_from_dict(request_to_dict(legacy)).expected_context is None


def test_prepare_does_not_rehash_binaries_per_request(tmp_path) -> None:
    paths = _write_artifacts(tmp_path)
    context = _context(tmp_path, artifact_paths=paths, backend="onnx")
    first = prepare_clinical_snapshot(context, _features())

    paths["efficientnet_b3"].write_bytes(b"changed-after-context")
    second = prepare_clinical_snapshot(context, _features())

    assert first.context_fingerprint_sha256 == second.context_fingerprint_sha256


def test_verify_expected_context(tmp_path) -> None:
    context = _context(tmp_path)

    verify_expected_context(
        context,
        schema_version=context.schema_version,
        fingerprint_sha256=context.fingerprint_sha256,
    )
    with pytest.raises(ContextMismatchError):
        verify_expected_context(
            context,
            schema_version=context.schema_version,
            fingerprint_sha256="b" * 64,
        )
    with pytest.raises(ContextMismatchError):
        verify_expected_context(
            context,
            schema_version="other",
            fingerprint_sha256=context.fingerprint_sha256,
        )
    with pytest.raises(ContextUnavailableError):
        verify_expected_context(
            None,
            schema_version=context.schema_version,
            fingerprint_sha256=context.fingerprint_sha256,
        )


def test_prepare_endpoint_requires_token_and_returns_wire_contract(
    tmp_path,
    monkeypatch,
) -> None:
    context = _context(tmp_path)
    client, _ = _client(monkeypatch, context)
    body = {"clinical_features": _features()}

    assert client.post("/v1/clinical-snapshots/prepare", json=body).status_code == 401

    response = client.post(
        "/v1/clinical-snapshots/prepare",
        json=body,
        headers=_auth(),
    )
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {
        "rawCanonical",
        "normalizedPayload",
        "schemaVersion",
        "modelVersions",
        "contextFingerprintSha256",
    }
    assert payload["rawCanonical"] == {"clinicalFeatures": body["clinical_features"]}
    assert payload["schemaVersion"] == "ml-zscore-f32-v1"
    assert payload["contextFingerprintSha256"] == context.fingerprint_sha256
    normalized = payload["normalizedPayload"]
    assert normalized["descriptor"]["normalization"]["epsilon"] == 1e-8
    assert normalized["descriptor"]["normalization"]["ordered_feature_names"] == list(FEATURES)
    assert normalized["descriptor"]["model"]["backend"] == "pytorch"
    assert normalized["contextFingerprintSha256"] == context.fingerprint_sha256
    assert hashlib.sha256(normalized["canonicalJson"].encode("utf-8")).hexdigest() == (
        context.fingerprint_sha256
    )
    assert json.loads(normalized["canonicalJson"]) == normalized["descriptor"]
    assert "secret-token" not in response.text
    assert str(tmp_path) not in response.text


def test_prepare_endpoint_rejects_unknown_fields_and_bad_version(
    tmp_path,
    monkeypatch,
) -> None:
    context = _context(tmp_path)
    client, _ = _client(monkeypatch, context)

    unknown = client.post(
        "/v1/clinical-snapshots/prepare",
        json={"clinical_features": _features(), "eye_side": "OD"},
        headers=_auth(),
    )
    assert unknown.status_code == 422

    bad_version = client.post(
        "/v1/clinical-snapshots/prepare",
        json={
            "clinical_features": _features(),
            "requested_model_version": "not-the-runtime-version",
        },
        headers=_auth(),
    )
    assert bad_version.status_code == 422

    matching = client.post(
        "/v1/clinical-snapshots/prepare",
        json={
            "clinical_features": _features(),
            "requested_model_version": context.manifest_version,
        },
        headers=_auth(),
    )
    assert matching.status_code == 200


def test_prepare_endpoint_returns_422_for_float32_overflow(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path)
    client, _ = _client(monkeypatch, context)
    features = {**_features(), "Pachymetry": 1e300}

    response = client.post(
        "/v1/clinical-snapshots/prepare",
        json={"clinical_features": features},
        headers=_auth(),
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid_clinical_features"
    assert "1e300" not in response.text
    assert str(tmp_path) not in response.text


def test_prepare_endpoint_fails_503_without_context(tmp_path, monkeypatch) -> None:
    client, _ = _client(monkeypatch, None)

    response = client.post(
        "/v1/clinical-snapshots/prepare",
        json={"clinical_features": _features()},
        headers=_auth(),
    )
    assert response.status_code == 503
    # Safe failure: no clinical ranges (mean/std), no paths, no values leaked.
    assert response.json()["detail"] == "context_unavailable"
    assert str(tmp_path) not in response.text
    for leaked in [repr(value) for value in MEAN + STD]:
        assert leaked not in response.text


def test_create_inference_rejects_bad_pin_before_enqueue(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path)
    client, queue = _client(monkeypatch, context)

    bad = _inference_body(context)
    bad["expected_context"]["fingerprint_sha256"] = "b" * 64  # type: ignore[index]
    response = client.post("/v1/inferences", json=bad, headers=_auth())
    assert response.status_code == 409
    assert queue.requests == []

    good = client.post(
        "/v1/inferences",
        json=_inference_body(context),
        headers=_auth(),
    )
    assert good.status_code == 202
    assert len(queue.requests) == 1


def test_legacy_unpinned_request_still_works_without_context(
    tmp_path,
    monkeypatch,
) -> None:
    client, queue = _client(monkeypatch, None)

    response = client.post(
        "/v1/inferences",
        json=_inference_body(None, include_pin=False),
        headers=_auth(),
    )
    assert response.status_code == 202
    assert len(queue.requests) == 1


def test_pinned_request_fails_503_without_context(tmp_path, monkeypatch) -> None:
    context_body = _inference_body(None, include_pin=False)
    context_body["expected_context"] = {
        "schema_version": "ml-zscore-f32-v1",
        "fingerprint_sha256": "a" * 64,
    }
    client, queue = _client(monkeypatch, None)

    response = client.post("/v1/inferences", json=context_body, headers=_auth())
    assert response.status_code == 503
    assert queue.requests == []


class _SentinelError(Exception):
    pass


def _pipeline(context: RuntimeContext | None) -> InferencePipeline:
    settings = replace(get_settings(), device="cpu", redis_url=None)
    pipeline = InferencePipeline(
        settings=settings,
        segmentation=object(),  # type: ignore[arg-type]
        classification=object(),  # type: ignore[arg-type]
        artifact_store=object(),  # type: ignore[arg-type]
        manifest=copy.deepcopy(MANIFEST),
        context=context,
    )
    pipeline._download_image = lambda _: (_ for _ in ()).throw(  # type: ignore[method-assign]
        _SentinelError()
    )
    return pipeline


def test_pipeline_rejects_pin_before_download(tmp_path) -> None:
    context = _context(tmp_path)
    pipeline = _pipeline(context)
    stages: list[str] = []
    body = _inference_body(context)
    body["expected_context"]["fingerprint_sha256"] = "b" * 64  # type: ignore[index]

    with pytest.raises(ContextMismatchError):
        pipeline.run(InferenceRequest.model_validate(body), stages.append)
    assert stages == []


def test_pipeline_requires_context_for_pinned_request(tmp_path) -> None:
    pipeline = _pipeline(None)
    stages: list[str] = []
    body = _inference_body(None, include_pin=False)
    body["expected_context"] = {
        "schema_version": "ml-zscore-f32-v1",
        "fingerprint_sha256": "a" * 64,
    }

    with pytest.raises(ContextUnavailableError):
        pipeline.run(InferenceRequest.model_validate(body), stages.append)
    assert stages == []


def test_pipeline_legacy_unpinned_request_reaches_download(tmp_path) -> None:
    pipeline = _pipeline(None)
    stages: list[str] = []

    with pytest.raises(_SentinelError):
        pipeline.run(
            InferenceRequest.model_validate(_inference_body(None, include_pin=False)),
            stages.append,
        )
    assert stages == ["DOWNLOADING"]


def test_pipeline_matching_pin_reaches_download(tmp_path) -> None:
    context = _context(tmp_path)
    pipeline = _pipeline(context)
    stages: list[str] = []

    with pytest.raises(_SentinelError):
        pipeline.run(InferenceRequest.model_validate(_inference_body(context)), stages.append)
    assert stages == ["DOWNLOADING"]


def test_build_runtime_keeps_legacy_routes_startable_when_context_fails(
    tmp_path,
    monkeypatch,
) -> None:
    manifest = copy.deepcopy(MANIFEST)
    paths = _write_artifacts(tmp_path)

    def _fake_load(_: Path) -> dict[str, Any]:
        return manifest

    def _fake_ensure(spec: Any, _: Path) -> Path:
        return paths[
            "segmentation"
            if spec.filename == manifest["artifacts"]["segmentation"]["filename"]
            else "efficientnet_b3"
            if spec.filename == manifest["artifacts"]["efficientnet_b3"]["filename"]
            else "resnet50"
        ]

    class _FakeSegmentation:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

    class _FakeClassification:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

    monkeypatch.setattr(service_main, "load_manifest", _fake_load)
    monkeypatch.setattr(service_main, "ensure_artifact", _fake_ensure)
    monkeypatch.setattr(service_main, "SegmentationRunner", _FakeSegmentation)
    monkeypatch.setattr(service_main, "ClassificationRunner", _FakeClassification)
    monkeypatch.setattr(service_main, "create_artifact_store", lambda _: object())
    monkeypatch.setattr(service_main, "create_job_queue", lambda _: object())

    settings = replace(
        get_settings(),
        device="cpu",
        inference_backend="pytorch",
        model_cache_dir=tmp_path,
        model_manifest_path=tmp_path / "manifest.json",
    )

    runtime = service_main.build_runtime(settings)

    assert runtime.context is None
    assert runtime.context_error == "context_unavailable"
    assert runtime.pipeline.context is None


def test_service_health_still_works_without_context(monkeypatch) -> None:
    client, _ = _client(monkeypatch, None)

    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200


class _QueueArtifactStore:
    def __init__(self) -> None:
        self.prepared = 0

    def ensure_storage(self) -> None:
        self.prepared += 1


class _StubPipeline:
    """Queue-drain stub: run succeeds without touching network or models."""

    def __init__(self) -> None:
        self.artifact_store = _QueueArtifactStore()
        self.manifest = {"version": "test"}
        self.ran: list[str] = []

    def run(self, request: InferenceRequest, stage_callback: Any = None) -> dict[str, Any]:
        self.ran.append(str(request.inference_id))
        return {
            "inference_id": str(request.inference_id),
            "status": "COMPLETED",
            "result": None,
        }


def test_queue_worker_reports_run_context_mismatch_as_safe_failed_job(
    tmp_path,
) -> None:
    """Spec: a context change between accept and run ends FAILED, safe message."""
    context = _context(tmp_path)
    pipeline = _pipeline(context)
    pipeline.artifact_store = _QueueArtifactStore()  # type: ignore[assignment]
    queue = InMemoryJobQueue(replace(get_settings(), redis_url=None))
    body = _inference_body(context)
    body["expected_context"]["fingerprint_sha256"] = "b" * 64  # type: ignore[index]
    request = InferenceRequest.model_validate(body)

    async def _run() -> dict[str, Any]:
        job_id = await queue.enqueue(request)
        await queue.start(pipeline)
        state: dict[str, Any] | None = None
        for _ in range(200):
            state = await queue.get(job_id)  # type: ignore[arg-type]
            if state is not None and state["status"] == "FAILED":
                break
            await asyncio.sleep(0.01)
        await queue.close()
        assert state is not None
        return state

    state = asyncio.run(_run())
    assert state["status"] == "FAILED"
    assert state["stage"] == "FAILED"
    assert state["message"] == "context_mismatch"
    assert state["result"] is None


class _FakeRedis:
    """Minimal async Redis stub driving the queue consumer deterministically."""

    def __init__(self, payloads: list[str]) -> None:
        self._payloads = list(payloads)
        self.states: dict[str, str] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.states[key] = value

    async def get(self, key: str) -> str | None:
        return self.states.get(key)

    async def rpush(self, *_: Any) -> None:
        return None

    async def brpop(self, _key: str, timeout: int = 1) -> tuple[str, str] | None:
        if self._payloads:
            return ("qa-queue", self._payloads.pop(0))
        await asyncio.sleep(0.01)
        return None

    async def close(self) -> None:
        return None


def test_redis_queue_isolates_invalid_payload_and_keeps_draining(
    tmp_path,
    monkeypatch,
) -> None:
    """REG-008: one malformed payload must not kill the consumer or drop jobs."""
    context = _context(tmp_path)
    valid = InferenceRequest.model_validate(_inference_body(context))
    # RedisJobQueue.enqueue serializes with model_dump_json (field names).
    valid_payload = valid.model_dump_json()
    fake = _FakeRedis(["{definitely-not-json", valid_payload])
    monkeypatch.setattr(
        "ml.service.queue.redis_asyncio.from_url", lambda *args, **kwargs: fake
    )
    settings = replace(get_settings(), redis_url="redis://qa.invalid:6379/0")
    queue = RedisJobQueue(settings)
    pipeline = _StubPipeline()

    async def _run() -> tuple[dict[str, Any], dict[str, Any] | None]:
        await queue.start(pipeline)
        state: dict[str, Any] | None = None
        for _ in range(200):
            state = await queue.get(valid.inference_id)  # type: ignore[arg-type]
            if state is not None and state.get("status") == "COMPLETED":
                break
            await asyncio.sleep(0.01)
        invalid = await queue.get(UUID(int=0))
        await queue.close()
        assert state is not None
        return state, invalid

    state, invalid = asyncio.run(_run())
    # The valid job queued behind the malformed one still completed: the
    # consumer kept draining instead of dying on the parse error.
    assert state["status"] == "COMPLETED"
    assert state["result"]["status"] == "COMPLETED"
    assert invalid is not None
    assert invalid["status"] == "FAILED"
    assert str(invalid["message"]).startswith("invalid job payload")
    assert json.loads(valid_payload)["inference_id"] == str(valid.inference_id)
