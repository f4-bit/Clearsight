from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel


class EyeSide(str, Enum):
    OD = "OD"
    OS = "OS"


class ImageCreate(BaseModel):
    consultation_id: UUID
    eye_side: EyeSide
    storage_path: str
    hash_md5: str | None = None


class ImageRead(BaseModel):
    id: UUID
    consultation_id: UUID
    eye_side: EyeSide
    storage_path: str
    hash_md5: str | None
    created_at: datetime
