from __future__ import annotations

from dataclasses import replace
from typing import Any

from fastapi.testclient import TestClient

import ml.service.main as service_main
from ml.config import get_settings
from ml.service.main import create_app
from ml.service.queue import InMemoryJobQueue


class _LifespanArtifactStore:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.prepared = 0

    def ensure_storage(self) -> None:
        if self.fail:
            raise RuntimeError("Azure Blob container is not available: mask-bucket")
        self.prepared += 1


class _LifespanPipeline:
    def __init__(self, artifact_store: _LifespanArtifactStore) -> None:
        self.artifact_store = artifact_store
        self.manifest = {"version": "test"}


def _patch_lifespan(
    monkeypatch,
    store: _LifespanArtifactStore,
    queues: dict[str, Any],
) -> None:
    settings = replace(get_settings(), device="cpu", redis_url=None)

    def _build_runtime(_: Any) -> service_main.Runtime:
        queue = InMemoryJobQueue(settings)
        queues["queue"] = queue
        return service_main.Runtime(
            pipeline=_LifespanPipeline(store),
            queue=queue,
        )

    monkeypatch.setattr(service_main, "build_runtime", _build_runtime)
    monkeypatch.setattr(service_main, "get_settings", lambda: settings)


def test_health_endpoints_work_without_model_startup() -> None:
    client = TestClient(create_app(initialize_runtime=False))

    live_response = client.get("/health/live")
    ready_response = client.get("/health/ready")

    assert live_response.status_code == 200
    assert live_response.json() == {"status": "ok"}
    assert ready_response.status_code == 503
    assert ready_response.json() == {"status": "not_ready"}


def test_lifespan_ready_after_storage_preparation(monkeypatch) -> None:
    store = _LifespanArtifactStore()
    queues: dict[str, Any] = {}
    _patch_lifespan(monkeypatch, store, queues)

    with TestClient(create_app()) as client:
        ready_response = client.get("/health/ready")

    assert ready_response.status_code == 200
    assert ready_response.json()["status"] == "ready"
    assert store.prepared == 1
    assert queues["queue"].states == {}
    assert queues["queue"].pending.empty()


def test_lifespan_not_ready_when_storage_preparation_fails(monkeypatch) -> None:
    store = _LifespanArtifactStore(fail=True)
    queues: dict[str, Any] = {}
    _patch_lifespan(monkeypatch, store, queues)

    with TestClient(create_app()) as client:
        ready_response = client.get("/health/ready")
        runtime_error = client.app.state.runtime_error

    assert ready_response.status_code == 503
    assert ready_response.json() == {"status": "not_ready"}
    assert runtime_error == "Azure Blob container is not available: mask-bucket"
    assert queues["queue"].worker_task is None
    assert queues["queue"].states == {}
    assert queues["queue"].pending.empty()
