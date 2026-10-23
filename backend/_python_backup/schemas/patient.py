from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from backend.app.schemas.clinical import ClinicalFeatures


class PatientCreate(BaseModel):
    external_code: str | None = None
    age: int | None = None
    gender: str | None = None
    clinical_history_flags: dict[str, Any] = Field(default_factory=dict)
    clinical_data: ClinicalFeatures | None = None


class PatientRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    external_code: str | None
    age: int | None
    gender: str | None
    clinical_history_flags: dict[str, Any]
    clinical_data: ClinicalFeatures | None
    created_at: datetime
