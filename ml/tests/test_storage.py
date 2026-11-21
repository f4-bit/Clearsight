from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import replace
from typing import Any

import pytest

from ml.config import Settings, get_settings
from ml.service import queue as queue_module
from ml.service.queue import InMemoryJobQueue, JobQueue, RedisJobQueue
from ml.service.storage import AzureBlobArtifactStore, MinioArtifactStore


def _settings(**overrides: Any) -> Settings:
    return replace(get_settings(), **overrides)


def _minio_store(
    client: Any,
    *,
    mask_bucket: str | None = "mask-bucket",
    overlay_bucket: str | None = "overlay-bucket",
) -> MinioArtifactStore:
    store = MinioArtifactStore.__new__(MinioArtifactStore)
    store.settings = _settings(
        mask_bucket=mask_bucket,
        overlay_bucket=overlay_bucket,
    )
    store.minio_required = True
    store.client = client
    return store


def _azure_store(
    client: Any,
    *,
    mask_bucket: str | None = "mask-bucket",
    overlay_bucket: str | None = "overlay-bucket",
) -> AzureBlobArtifactStore:
    store = AzureBlobArtifactStore.__new__(AzureBlobArtifactStore)
    store.settings = _settings(
        mask_bucket=mask_bucket,
        overlay_bucket=overlay_bucket,
    )
    store.client = client
    return store


class _FakeClientError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


@pytest.fixture
def fake_botocore(monkeypatch: pytest.MonkeyPatch) -> type[_FakeClientError]:
    botocore = types.ModuleType("botocore")
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = _FakeClientError
    botocore.exceptions = exceptions
    monkeypatch.setitem(sys.modules, "botocore", botocore)
    monkeypatch.setitem(sys.modules, "botocore.exceptions", exceptions)
    return _FakeClientError


class _FakeS3Client:
    def __init__(
        self,
        client_error: type[_FakeClientError],
        *,
        missing: set[str] | None = None,
        error_code: str = "404",
    ) -> None:
        self._client_error = client_error
        self.missing = missing or set()
        self.error_code = error_code
        self.headed: list[str] = []
        self.created: list[str] = []

    def head_bucket(self, *, Bucket: str) -> None:
        self.headed.append(Bucket)
        if Bucket in self.missing:
            raise self._client_error(self.error_code)

    def create_bucket(self, *, Bucket: str) -> None:
        self.created.append(Bucket)


def test_minio_ensure_storage_keeps_existing_buckets(
    fake_botocore: type[_FakeClientError],
) -> None:
    client = _FakeS3Client(fake_botocore)
    store = _minio_store(client)

    store.ensure_storage()

    assert client.headed == ["mask-bucket", "overlay-bucket"]
    assert client.created == []


def test_minio_ensure_storage_creates_missing_bucket(
    fake_botocore: type[_FakeClientError],
) -> None:
    client = _FakeS3Client(fake_botocore, missing={"overlay-bucket"})
    store = _minio_store(client)

    store.ensure_storage()

    assert client.headed == ["mask-bucket", "overlay-bucket"]
    assert client.created == ["overlay-bucket"]


def test_minio_ensure_storage_characterizes_non_404_head_error(
    fake_botocore: type[_FakeClientError],
) -> None:
    # Current ensure_buckets only creates on 404 and silently ignores other
    # head errors. This characterizes the existing behavior; it is not a
    # fail-closed guarantee and the debt is tracked separately.
    client = _FakeS3Client(fake_botocore, missing={"mask-bucket"}, error_code="403")
    store = _minio_store(client)

    store.ensure_storage()

    assert client.created == []


def test_minio_ensure_storage_delegates_to_ensure_buckets() -> None:
    store = _minio_store(object())
    calls: list[bool] = []
    store.ensure_buckets = lambda: calls.append(True)

    store.ensure_storage()

    assert calls == [True]


class _FakeContainerClient:
    def __init__(self, exists: bool = True, error: Exception | None = None) -> None:
        self.exists_result = exists
        self.error = error
        self.exists_calls = 0

    def exists(self) -> bool:
        self.exists_calls += 1
        if self.error is not None:
            raise self.error
        return self.exists_result


class _FakeBlobServiceClient:
    def __init__(self, containers: dict[str, _FakeContainerClient]) -> None:
        self.containers = containers
        self.requested: list[str] = []

    def get_container_client(self, container: str) -> _FakeContainerClient:
        self.requested.append(container)
        return self.containers[container]


def test_azure_ensure_storage_verifies_each_configured_container() -> None:
    mask = _FakeContainerClient()
    overlay = _FakeContainerClient()
    client = _FakeBlobServiceClient({"mask-bucket": mask, "overlay-bucket": overlay})
    store = _azure_store(client)

    store.ensure_storage()

    assert client.requested == ["mask-bucket", "overlay-bucket"]
    assert mask.exists_calls == 1
    assert overlay.exists_calls == 1


def test_azure_ensure_storage_fails_when_container_is_missing() -> None:
    mask = _FakeContainerClient(exists=False)
    overlay = _FakeContainerClient()
    client = _FakeBlobServiceClient({"mask-bucket": mask, "overlay-bucket": overlay})
    store = _azure_store(client)

    with pytest.raises(RuntimeError) as error:
        store.ensure_storage()

    assert str(error.value) == (
        "Azure Blob container is not available: mask-bucket"
    )
    assert overlay.exists_calls == 0


def test_azure_ensure_storage_propagates_sdk_errors() -> None:
    mask = _FakeContainerClient()
    overlay = _FakeContainerClient(error=RuntimeError("forbidden"))
    client = _FakeBlobServiceClient({"mask-bucket": mask, "overlay-bucket": overlay})
    store = _azure_store(client)

    with pytest.raises(RuntimeError, match="forbidden"):
        store.ensure_storage()

    assert client.requested == ["mask-bucket", "overlay-bucket"]


def test_azure_ensure_storage_skips_unconfigured_containers() -> None:
    client = _FakeBlobServiceClient({})
    store = _azure_store(client, mask_bucket=None, overlay_bucket=None)

    store.ensure_storage()

    assert client.requested == []


@pytest.mark.parametrize("store_factory", [_minio_store, _azure_store])
def test_credentialless_store_ensure_storage_is_noop(
    store_factory: Any,
) -> None:
    store = store_factory(None)

    store.ensure_storage()


class _NeutralArtifactStore:
    def __init__(self) -> None:
        self.prepared = 0

    def ensure_storage(self) -> None:
        self.prepared += 1

    def upload_bytes(self, *args: Any, **kwargs: Any) -> None:
        return None


class _FailingArtifactStore(_NeutralArtifactStore):
    def ensure_storage(self) -> None:
        raise RuntimeError("container unavailable")


class _StubPipeline:
    def __init__(self, artifact_store: Any) -> None:
        self.artifact_store = artifact_store


class _FakeAsyncRedis:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


async def _blocked_worker(self: Any, pipeline: Any) -> None:
    await asyncio.Event().wait()


def _make_queue(
    kind: str,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> JobQueue:
    if kind == "redis":
        fake_redis = _FakeAsyncRedis()
        monkeypatch.setattr(
            queue_module.redis_asyncio,
            "from_url",
            lambda *args, **kwargs: fake_redis,
        )
        queue: JobQueue = RedisJobQueue(settings)
    else:
        queue = InMemoryJobQueue(settings)
    monkeypatch.setattr(type(queue), "_worker", _blocked_worker)
    return queue


async def _start_and_close(queue: JobQueue, store: _NeutralArtifactStore) -> None:
    await queue.start(_StubPipeline(store))
    assert store.prepared == 1
    assert queue.worker_task is not None
    await queue.close()


async def _start_expect_failure(
    queue: JobQueue,
    store: _NeutralArtifactStore,
) -> None:
    with pytest.raises(RuntimeError, match="container unavailable"):
        await queue.start(_StubPipeline(store))
    assert queue.worker_task is None
    await queue.close()


async def _start_provider_queue(queue: JobQueue, store: Any) -> None:
    await queue.start(_StubPipeline(store))
    assert queue.worker_task is not None
    await queue.close()


def test_memory_queue_start_succeeds_with_azure_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mask = _FakeContainerClient()
    overlay = _FakeContainerClient()
    client = _FakeBlobServiceClient({"mask-bucket": mask, "overlay-bucket": overlay})
    store = _azure_store(client)
    queue = _make_queue("memory", _settings(redis_url=None), monkeypatch)

    asyncio.run(_start_provider_queue(queue, store))

    assert client.requested == ["mask-bucket", "overlay-bucket"]


def test_memory_queue_start_succeeds_with_minio_store(
    monkeypatch: pytest.MonkeyPatch,
    fake_botocore: type[_FakeClientError],
) -> None:
    client = _FakeS3Client(fake_botocore)
    store = _minio_store(client)
    queue = _make_queue("memory", _settings(redis_url=None), monkeypatch)

    asyncio.run(_start_provider_queue(queue, store))

    assert client.headed == ["mask-bucket", "overlay-bucket"]


@pytest.mark.parametrize("queue_kind", ["memory", "redis"])
def test_queue_start_calls_neutral_ensure_storage(
    monkeypatch: pytest.MonkeyPatch,
    queue_kind: str,
) -> None:
    settings = _settings(
        redis_url="redis://localhost:6379/0" if queue_kind == "redis" else None,
    )
    queue = _make_queue(queue_kind, settings, monkeypatch)
    store = _NeutralArtifactStore()
    assert not hasattr(store, "ensure_buckets")

    asyncio.run(_start_and_close(queue, store))

    fake_redis = getattr(queue, "redis", None)
    if fake_redis is not None:
        assert fake_redis.closed is True


@pytest.mark.parametrize("queue_kind", ["memory", "redis"])
def test_queue_start_propagates_storage_failure_without_worker(
    monkeypatch: pytest.MonkeyPatch,
    queue_kind: str,
) -> None:
    settings = _settings(
        redis_url="redis://localhost:6379/0" if queue_kind == "redis" else None,
    )
    queue = _make_queue(queue_kind, settings, monkeypatch)

    asyncio.run(_start_expect_failure(queue, _FailingArtifactStore()))
