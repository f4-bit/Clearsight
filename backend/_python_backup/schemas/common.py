from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: str
    message: str
    status_code: int


class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: datetime
