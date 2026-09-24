from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ml.config import Settings, get_settings
from ml.inference.classification import ClassificationRunner
from ml.inference.pipeline import InferencePipeline
from ml.inference.segmentation import SegmentationRunner
from ml.models.registry import artifact_spec, ensure_artifact, load_manifest
from ml.service.metrics import metrics_response
from ml.service.queue import create_job_queue
from ml.service.schemas import (
    InferenceRequest,
    JobAccepted,
    JobResponse,
    JobStatus,
)
from ml.service.storage import MinioArtifactStore


@dataclass
class Runtime:
    pipeline: InferencePipeline
    queue: Any


def build_runtime(settings: Settings) -> Runtime:
    manifest = load_manifest(settings.model_manifest_path)
    cache = settings.model_cache_dir
    segmentation_path = ensure_artifact(
        artifact_spec(manifest, "segmentation"),
        cache,
    )
    efficientnet_path = ensure_artifact(
        artifact_spec(manifest, "efficientnet_b3"),
        cache,
    )
    resnet_path = ensure_artifact(
        artifact_spec(manifest, "resnet50"),
        cache,
    )
    segmentation = SegmentationRunner(segmentation_path, settings.device)
    classification = ClassificationRunner(
        {"efficientnet_b3": efficientnet_path, "resnet50": resnet_path},
        settings,
        manifest,
    )
    pipeline = InferencePipeline(
        settings=settings,
        segmentation=segmentation,
        classification=classification,
        artifact_store=MinioArtifactStore(settings),
        manifest=manifest,
    )
    return Runtime(pipeline=pipeline, queue=create_job_queue(settings))


def create_app(initialize_runtime: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if initialize_runtime:
            settings = get_settings()
            try:
                runtime = await asyncio.to_thread(build_runtime, settings)
                await runtime.queue.start(runtime.pipeline)
                application.state.runtime = runtime
            except Exception as error:
                application.state.runtime_error = str(error)
        yield
        shutdown_runtime = getattr(application.state, "runtime", None)
        if shutdown_runtime is not None:
            await shutdown_runtime.queue.close()

    application = FastAPI(
        title="Clearsight ML Inference Service",
        version="0.1.0",
        lifespan=lifespan,
    )
    bearer = HTTPBearer(auto_error=False)

    async def require_service_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> None:
        settings = get_settings()
        if not settings.api_token:
            return
        if credentials is None or not hmac.compare_digest(
            credentials.credentials,
            settings.api_token,
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid service token",
            )

    def current_runtime() -> Runtime:
        runtime = getattr(application.state, "runtime", None)
        if runtime is None:
            error = getattr(application.state, "runtime_error", "runtime unavailable")
            raise HTTPException(status_code=503, detail=error)
        return runtime

    @application.post(
        "/v1/inferences",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[Depends(require_service_token)],
    )
    async def create_inference(request: InferenceRequest) -> JobAccepted:
        runtime = current_runtime()
        job_id = await runtime.queue.enqueue(request)
        return JobAccepted(
            inference_id=request.inference_id,
            job_id=job_id,
            status=JobStatus.QUEUED,
        )

    @application.get(
        "/v1/inferences/{job_id}",
        response_model=JobResponse,
        dependencies=[Depends(require_service_token)],
    )
    async def get_inference(job_id: UUID) -> JobResponse:
        runtime = current_runtime()
        state = await runtime.queue.get(job_id)
        if state is None:
            raise HTTPException(status_code=404, detail="Inference not found")
        return JobResponse.model_validate(state)

    @application.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/health/ready", response_model=None)
    async def ready() -> Response | dict[str, Any]:
        runtime = getattr(application.state, "runtime", None)
        if runtime is None:
            return Response(
                content='{"status":"not_ready"}',
                status_code=503,
                media_type="application/json",
            )
        return {
            "status": "ready",
            "device": get_settings().device,
            "model_version": runtime.pipeline.manifest["version"],
        }

    @application.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        content, content_type = metrics_response()
        return Response(content=content, media_type=content_type)

    return application


app = create_app()
