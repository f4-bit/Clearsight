from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from typing import Any
from uuid import UUID

from redis import asyncio as redis_asyncio

from ml.config import Settings
from ml.inference.pipeline import InferencePipeline
from ml.service.schemas import InferenceRequest, JobStatus


def request_to_dict(request: InferenceRequest) -> dict[str, Any]:
    return json.loads(request.model_dump_json())


def request_from_dict(payload: dict[str, Any]) -> InferenceRequest:
    return InferenceRequest.model_validate(payload)


class JobQueue(ABC):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state_prefix = f"{settings.queue_name}:state"
        self.queue_key = settings.queue_name

    @abstractmethod
    async def enqueue(self, request: InferenceRequest) -> UUID:
        raise NotImplementedError

    @abstractmethod
    async def get(self, job_id: UUID) -> dict[str, Any] | None:
        raise NotImplementedError

    @abstractmethod
    async def start(self, pipeline: InferencePipeline) -> None:
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        raise NotImplementedError


class InMemoryJobQueue(JobQueue):
    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.pending: asyncio.Queue[InferenceRequest] = asyncio.Queue()
        self.states: dict[str, dict[str, Any]] = {}
        self.worker_task: asyncio.Task[None] | None = None

    def _state(self, request: InferenceRequest) -> dict[str, Any]:
        return {
            "inference_id": request.inference_id,
            "job_id": request.inference_id,
            "status": JobStatus.QUEUED.value,
            "stage": JobStatus.QUEUED.value,
            "message": None,
            "result": None,
        }

    async def enqueue(self, request: InferenceRequest) -> UUID:
        self.states[str(request.inference_id)] = self._state(request)
        await self.pending.put(request)
        return request.inference_id

    async def get(self, job_id: UUID) -> dict[str, Any] | None:
        return self.states.get(str(job_id))

    async def start(self, pipeline: InferencePipeline) -> None:
        self.worker_task = asyncio.create_task(self._worker(pipeline))

    async def close(self) -> None:
        if self.worker_task is not None:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)

    async def _worker(self, pipeline: InferencePipeline) -> None:
        while True:
            request = await self.pending.get()
            state = self.states[str(request.inference_id)]
            try:
                result = await asyncio.to_thread(
                    pipeline.run,
                    request,
                    lambda stage: state.update(
                        {"stage": stage, "status": stage}
                    ),
                )
                state.update(
                    {
                        "stage": result["status"],
                        "status": result["status"],
                        "result": result,
                    }
                )
            except Exception as error:
                state.update(
                    {
                        "status": JobStatus.FAILED.value,
                        "stage": JobStatus.FAILED.value,
                        "message": str(error),
                    }
                )
            finally:
                self.pending.task_done()


class RedisJobQueue(JobQueue):
    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.redis = redis_asyncio.from_url(
            settings.redis_url or "",
            decode_responses=True,
        )
        self.worker_task: asyncio.Task[None] | None = None

    def _state_key(self, job_id: UUID) -> str:
        return f"{self.state_prefix}:{job_id}"

    async def enqueue(self, request: InferenceRequest) -> UUID:
        state = {
            "inference_id": str(request.inference_id),
            "job_id": str(request.inference_id),
            "status": JobStatus.QUEUED.value,
            "stage": JobStatus.QUEUED.value,
            "message": None,
            "result": None,
        }
        await self.redis.set(
            self._state_key(request.inference_id),
            json.dumps(state),
            ex=86400,
        )
        await self.redis.rpush(self.queue_key, request.model_dump_json())
        return request.inference_id

    async def get(self, job_id: UUID) -> dict[str, Any] | None:
        payload = await self.redis.get(self._state_key(job_id))
        return json.loads(payload) if payload else None

    async def start(self, pipeline: InferencePipeline) -> None:
        self.worker_task = asyncio.create_task(self._worker(pipeline))

    async def close(self) -> None:
        if self.worker_task is not None:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)
        await self.redis.close()

    async def _update_state(self, job_id: UUID, **updates: Any) -> None:
        key = self._state_key(job_id)
        payload = await self.redis.get(key)
        state = (
            json.loads(payload)
            if payload
            else {"inference_id": str(job_id), "job_id": str(job_id)}
        )
        state.update(updates)
        await self.redis.set(key, json.dumps(state), ex=86400)

    async def _worker(self, pipeline: InferencePipeline) -> None:
        while True:
            item = await self.redis.brpop(self.queue_key, timeout=1)
            if item is None:
                continue
            _, payload = item
            request = request_from_dict(json.loads(payload))

            loop = asyncio.get_running_loop()

            def stage_callback(stage: str) -> None:
                asyncio.run_coroutine_threadsafe(
                    self._update_state(
                        request.inference_id,
                        status=stage,
                        stage=stage,
                    ),
                    loop,
                )

            try:
                result = await asyncio.to_thread(
                    pipeline.run,
                    request,
                    stage_callback,
                )
                await self._update_state(
                    request.inference_id,
                    status=result["status"],
                    stage=result["status"],
                    result=result,
                )
            except Exception as error:
                await self._update_state(
                    request.inference_id,
                    status=JobStatus.FAILED.value,
                    stage=JobStatus.FAILED.value,
                    message=str(error),
                )


def create_job_queue(settings: Settings) -> JobQueue:
    if settings.redis_url:
        return RedisJobQueue(settings)
    return InMemoryJobQueue(settings)
