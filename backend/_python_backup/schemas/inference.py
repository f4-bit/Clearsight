from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from backend.app.schemas.clinical import ClinicalFeatures
from backend.app.schemas.image import EyeSide


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    DOWNLOADING = "DOWNLOADING"
    LOCALIZING = "LOCALIZING"
    SEGMENTING = "SEGMENTING"
    CLASSIFYING = "CLASSIFYING"
    COMPLETED = "COMPLETED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    FAILED = "FAILED"


class InferenceCreate(BaseModel):
    inference_id: UUID
    image_url: str
    eye_side: EyeSide
    clinical_features: ClinicalFeatures
    model_version: str | None = None


class ModelPrediction(BaseModel):
    probabilities: dict[str, float]
    predicted_class: str
    confidence: float


class InferenceResult(BaseModel):
    inference_id: UUID
    eye_side: EyeSide
    label: str | None
    confidence: float | None
    probabilities: dict[str, float]
    model_predictions: dict[str, ModelPrediction]
    cdr: float | None
    cdr_vertical: float | None
    quality: dict[str, Any]
    artifacts: dict[str, str]
    model_versions: dict[str, str]
    elapsed_seconds: float


class JobAccepted(BaseModel):
    inference_id: UUID
    job_id: UUID
    status: JobStatus


class JobResponse(BaseModel):
    inference_id: UUID
    job_id: UUID
    status: JobStatus
    stage: str
    message: str | None = None
    result: InferenceResult | None = None
