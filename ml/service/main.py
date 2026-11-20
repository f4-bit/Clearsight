from __future__ import annotations

import asyncio
import copy
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ml.config import Settings, get_settings
from ml.inference.classification import ClassificationEngine, ClassificationRunner
from ml.inference.onnx_serving import OnnxClassificationRunner
from ml.inference.pipeline import InferencePipeline
from ml.inference.segmentation import SegmentationRunner
from ml.inference.url_policy import SignedImageUrlError, validate_signed_image_url
from ml.models.registry import artifact_spec, ensure_artifact, load_manifest
from ml.service.context import (
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
from ml.service.metrics import metrics_response
from ml.service.queue import create_job_queue
from ml.service.schemas import (
    ClinicalSnapshotPrepareRequest,
    ClinicalSnapshotPrepareResponse,
    InferenceRequest,
    JobAccepted,
    JobResponse,
    JobStatus,
)
from ml.service.storage import create_artifact_store


@dataclass
class Runtime:
    pipeline: InferencePipeline
    queue: Any
    context: RuntimeContext | None = None
    context_error: str | None = None
    settings: Settings | None = None


def build_runtime(settings: Settings) -> Runtime:
    # The pipeline, both classifier runners and the context descriptor must
    # share one immutable snapshot of the manifest; never re-read the file.
    manifest = copy.deepcopy(load_manifest(settings.model_manifest_path))
    cache = settings.model_cache_dir
    segmentation_path = ensure_artifact(
        artifact_spec(manifest, "segmentation"),
        cache,
    )
    onnx_efficientnet = cache / "efficientnet_b3.fp16.onnx"
    onnx_resnet = cache / "resnet50.fp16.onnx"
    if (
        settings.inference_backend == "onnx"
        and onnx_efficientnet.exists()
        and onnx_resnet.exists()
    ):
        efficientnet_path = onnx_efficientnet
        resnet_path = onnx_resnet
    else:
        efficientnet_path = ensure_artifact(
            artifact_spec(manifest, "efficientnet_b3"),
            cache,
        )
        resnet_path = ensure_artifact(
            artifact_spec(manifest, "resnet50"),
            cache,
        )
    segmentation = SegmentationRunner(segmentation_path, settings.device)
    model_paths = {"efficientnet_b3": efficientnet_path, "resnet50": resnet_path}
    classification: ClassificationEngine
    if settings.inference_backend == "onnx":
        classification = OnnxClassificationRunner(model_paths, settings, manifest)
    else:
        classification = ClassificationRunner(model_paths, settings, manifest)

    context: RuntimeContext | None = None
    context_error: str | None = None
    try:
        parameters = getattr(classification, "resolved_parameters", None)
        if parameters is None:
            raise ClinicalContextError("the loaded runner has no normalization context")
        context = build_runtime_context(
            manifest=manifest,
            backend=(
                "onnx"
                if isinstance(classification, OnnxClassificationRunner)
                else "pytorch"
            ),
            parameters=parameters,
            artifact_paths={
                "segmentation": segmentation_path,
                "efficientnet_b3": efficientnet_path,
                "resnet50": resnet_path,
            },
        )
    except (ClinicalContextError, OSError):
        # A context that cannot be verified must not make legacy unpinned
        # routes unstartable. Prepare and every pinned request fail closed 503.
        context_error = "context_unavailable"

    pipeline = InferencePipeline(
        settings=settings,
        segmentation=segmentation,
        classification=classification,
        artifact_store=create_artifact_store(settings),
        manifest=manifest,
        context=context,
    )
    return Runtime(
        pipeline=pipeline,
        queue=create_job_queue(settings),
        context=context,
        context_error=context_error,
        settings=settings,
    )


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

    def current_settings() -> Settings:
        runtime = getattr(application.state, "runtime", None)
        if runtime is not None and runtime.settings is not None:
            return runtime.settings
        return get_settings()

    async def require_service_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> None:
        settings = current_settings()
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

    # Keep compatibility with existing clients that send valid JSON without a
    # Content-Type header, while still rejecting multipart bodies as 422.
    inference_router = APIRouter(strict_content_type=False)

    @inference_router.post(
        "/v1/inferences",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[Depends(require_service_token)],
    )
    async def create_inference(request: InferenceRequest) -> JobAccepted:
        runtime = current_runtime()
        settings = current_settings()
        try:
            validate_signed_image_url(
                request.image_url,
                allowed_signed_url_hosts=settings.allowed_signed_url_hosts,
                allow_http_signed_urls=settings.allow_http_signed_urls,
            )
        except SignedImageUrlError as error:
            raise HTTPException(status_code=422, detail=error.code) from error
        if request.expected_context is not None:
            try:
                verify_expected_context(
                    runtime.context,
                    schema_version=request.expected_context.schema_version,
                    fingerprint_sha256=request.expected_context.fingerprint_sha256,
                )
            except ContextUnavailableError as error:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=str(error),
                ) from error
            except ContextMismatchError as error:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=str(error),
                ) from error
        job_id = await runtime.queue.enqueue(request)
        return JobAccepted(
            inference_id=request.inference_id,
            job_id=job_id,
            status=JobStatus.QUEUED,
        )

    @application.post(
        "/v1/clinical-snapshots/prepare",
        response_model=ClinicalSnapshotPrepareResponse,
        dependencies=[Depends(require_service_token)],
    )
    async def prepare_snapshot(
        request: ClinicalSnapshotPrepareRequest,
    ) -> ClinicalSnapshotPrepareResponse:
        runtime = current_runtime()
        if runtime.context is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="context_unavailable",
            )
        try:
            prepared = prepare_clinical_snapshot(
                runtime.context,
                request.clinical_features.model_dump(by_alias=True),
                request.requested_model_version,
            )
        except RequestedModelVersionError as error:
            raise HTTPException(
                status_code=422,
                detail="requested_model_version_mismatch",
            ) from error
        except InvalidClinicalInputError as error:
            raise HTTPException(
                status_code=422,
                detail="invalid_clinical_features",
            ) from error
        except ClinicalContextError as error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="context_unavailable",
            ) from error
        return ClinicalSnapshotPrepareResponse(
            rawCanonical=dict(prepared.raw_canonical),
            normalizedPayload=dict(prepared.normalized_payload),
            schemaVersion=prepared.schema_version,
            modelVersions=dict(prepared.model_versions),
            contextFingerprintSha256=prepared.context_fingerprint_sha256,
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
            "device": current_settings().device,
            "model_version": runtime.pipeline.manifest["version"],
        }

    @application.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        content, content_type = metrics_response()
        return Response(content=content, media_type=content_type)

    application.include_router(inference_router)
    return application


app = create_app()
