from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from scripts.retrain_cycle import DatabaseFeedbackSource

import ml.service.main as service_main
from ml.config import get_settings
from ml.inference.pipeline import host_is_allowed


class _FakeRunner:
    def __init__(self, *args, **kwargs) -> None:
        self.args = args
        self.kwargs = kwargs


def _patch_runtime(monkeypatch, tmp_path: Path, recorded: dict[str, bool]) -> None:
    manifest = {"artifacts": {}, "version": "test"}
    monkeypatch.setattr(service_main, "load_manifest", lambda _: manifest)
    monkeypatch.setattr(service_main, "artifact_spec", lambda manifest, name: name)
    monkeypatch.setattr(
        service_main, "ensure_artifact", lambda spec, cache: tmp_path / f"{spec}.onnx"
    )
    monkeypatch.setattr(service_main, "SegmentationRunner", _FakeRunner)
    monkeypatch.setattr(service_main, "MinioArtifactStore", lambda settings: object())
    monkeypatch.setattr(service_main, "create_job_queue", lambda settings: object())

    def _pytorch(*args, **kwargs):
        recorded["pytorch"] = True
        return _FakeRunner(*args, **kwargs)

    def _onnx(*args, **kwargs):
        recorded["onnx"] = True
        return _FakeRunner(*args, **kwargs)

    monkeypatch.setattr(service_main, "ClassificationRunner", _pytorch)
    monkeypatch.setattr(service_main, "OnnxClassificationRunner", _onnx)


def test_build_runtime_selects_onnx_backend(monkeypatch, tmp_path: Path) -> None:
    recorded: dict[str, bool] = {}
    _patch_runtime(monkeypatch, tmp_path, recorded)

    settings = replace(get_settings(), inference_backend="onnx", device="cpu")
    runtime = service_main.build_runtime(settings)

    assert recorded == {"onnx": True}
    assert runtime.pipeline.classification is not None


def test_build_runtime_defaults_to_pytorch_backend(monkeypatch, tmp_path: Path) -> None:
    recorded: dict[str, bool] = {}
    _patch_runtime(monkeypatch, tmp_path, recorded)

    settings = replace(get_settings(), inference_backend="pytorch", device="cpu")
    service_main.build_runtime(settings)

    assert recorded == {"pytorch": True}


def test_host_is_allowed_supports_azure_blob_wildcard() -> None:
    patterns = ("minio:9000", "*.blob.core.windows.net")

    assert host_is_allowed(
        "clearsight.blob.core.windows.net",
        "clearsight.blob.core.windows.net",
        patterns,
    )
    assert host_is_allowed("minio", "minio:9000", patterns)
    assert not host_is_allowed("evil.example.com", "evil.example.com", patterns)
    assert not host_is_allowed("blob.core.windows.net", "blob.core.windows.net", patterns)


def test_database_feedback_source_loads_gold_standard_rows() -> None:
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text
    from sqlalchemy.pool import StaticPool

    engine = sqlalchemy.create_engine(
        "sqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE consultations ("
                "id VARCHAR PRIMARY KEY, clinical_data TEXT)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE clinical_feedback ("
                "inference_id VARCHAR, consultation_id VARCHAR, doctor_id VARCHAR, "
                "validated_class INTEGER, predicted_class INTEGER, agreement BOOLEAN, "
                "is_gold_standard BOOLEAN, clinical_data TEXT)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO consultations (id, clinical_data) VALUES "
                "('c1', :json)"
            ),
            {"json": None},
        )
        connection.execute(
            text(
                "INSERT INTO clinical_feedback "
                "(inference_id, consultation_id, doctor_id, validated_class, "
                "predicted_class, agreement, is_gold_standard, clinical_data) "
                "VALUES ('i1', 'c1', 'd1', 2, 1, 0, 1, :json)"
            ),
            {"json": '{"Age": 60.0, "Gender": 1.0}'},
        )
        connection.execute(
            text(
                "INSERT INTO clinical_feedback "
                "(inference_id, consultation_id, doctor_id, validated_class, "
                "predicted_class, agreement, is_gold_standard, clinical_data) "
                "VALUES ('i2', 'c1', 'd2', 0, 0, 1, 0, :json)"
            ),
            {"json": '{"Age": 40.0}'},
        )

    source = DatabaseFeedbackSource("sqlite://", engine=engine)
    samples = source.load()

    assert len(samples) == 1
    gold = samples[0]
    assert gold.inference_id == "i1"
    assert gold.validated_class == 2
    assert gold.is_gold_standard is True
    assert gold.features is not None
    assert gold.features[0] == 60.0
