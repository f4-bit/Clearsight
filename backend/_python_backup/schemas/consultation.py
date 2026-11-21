"""Pydantic schemas for consultations and clinical feedback payloads."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

CLASS_MIN = 0
CLASS_MAX = 2


class ConsultationCreate(BaseModel):
    """Payload to open a new consultation."""

    patient_id: uuid.UUID
    doctor_id: uuid.UUID
    status: str = Field(default="PENDIENTE", max_length=32)


class ConsultationRead(BaseModel):
    """Consultation representation returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    patient_id: uuid.UUID
    doctor_id: uuid.UUID
    status: str
    created_at: datetime


class FeedbackCreate(BaseModel):
    """Doctor-validated feedback for a single inference."""

    consultation_id: uuid.UUID
    inference_id: uuid.UUID
    doctor_id: uuid.UUID
    validated_class: int = Field(ge=CLASS_MIN, le=CLASS_MAX)
    predicted_class: int | None = Field(default=None, ge=CLASS_MIN, le=CLASS_MAX)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    agreement: bool | None = None
    doctor_notes: str | None = None
    is_gold_standard: bool = False


class FeedbackRead(BaseModel):
    """Clinical feedback representation returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    consultation_id: uuid.UUID
    inference_id: uuid.UUID
    doctor_id: uuid.UUID
    validated_class: int
    predicted_class: int | None
    confidence: float | None
    agreement: bool | None
    doctor_notes: str | None
    is_gold_standard: bool
    created_at: datetime


class GoldStandardBatch(BaseModel):
    """Batch of gold-standard feedback ready for the retraining ETL."""

    items: list[FeedbackRead] = Field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.items)
