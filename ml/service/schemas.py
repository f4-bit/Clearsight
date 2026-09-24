from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EyeSide(str, Enum):
    OD = "OD"
    OS = "OS"


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    DOWNLOADING = "DOWNLOADING"
    LOCALIZING = "LOCALIZING"
    SEGMENTING = "SEGMENTING"
    CLASSIFYING = "CLASSIFYING"
    COMPLETED = "COMPLETED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    FAILED = "FAILED"


class ClinicalFeatures(StrictModel):
    Age: float
    Gender: float
    dioptre_1: float
    dioptre_2: float
    astigmatism: float
    Phakic_Pseudophakic: float = Field(alias="Phakic/Pseudophakic")
    Pneumatic: float
    Perkins: float
    Pachymetry: float
    Axial_Length: float
    VF_DM: float


class InferenceRequest(StrictModel):
    inference_id: UUID
    image_url: str
    eye_side: EyeSide
    clinical_features: ClinicalFeatures
    model_version: str | None = None


class JobAccepted(BaseModel):
    inference_id: UUID
    job_id: UUID
    status: JobStatus


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


class JobResponse(BaseModel):
    inference_id: UUID
    job_id: UUID
    status: JobStatus
    stage: str
    message: str | None = None
    result: InferenceResult | None = None
