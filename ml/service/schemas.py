from __future__ import annotations

from enum import Enum
from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]


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
    Age: FiniteFloat
    Gender: FiniteFloat
    dioptre_1: FiniteFloat
    dioptre_2: FiniteFloat
    astigmatism: FiniteFloat
    Phakic_Pseudophakic: FiniteFloat = Field(alias="Phakic/Pseudophakic")
    Pneumatic: FiniteFloat
    Perkins: FiniteFloat
    Pachymetry: FiniteFloat
    Axial_Length: FiniteFloat
    VF_DM: FiniteFloat


class ExpectedContext(StrictModel):
    schema_version: str = Field(min_length=1)
    fingerprint_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class InferenceRequest(StrictModel):
    inference_id: UUID
    image_url: str
    eye_side: EyeSide
    clinical_features: ClinicalFeatures
    model_version: str | None = None
    expected_context: ExpectedContext | None = None


class ClinicalSnapshotPrepareRequest(StrictModel):
    clinical_features: ClinicalFeatures
    requested_model_version: str | None = Field(default=None, min_length=1)


class ClinicalSnapshotPrepareResponse(BaseModel):
    rawCanonical: dict[str, Any]
    normalizedPayload: dict[str, Any]
    schemaVersion: str
    modelVersions: dict[str, str]
    contextFingerprintSha256: str


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
