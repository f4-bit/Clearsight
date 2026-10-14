"""Consultation ORM model linking patients, doctors and clinical feedback."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from backend.app.models.clinical_feedback import ClinicalFeedback

CONSULTATION_STATUSES = ("PENDIENTE", "EN_PROCESO", "COMPLETADA", "FALLIDA")


class Consultation(TimestampMixin, Base):
    """A single ophthalmology consultation requested by a doctor."""

    __tablename__ = "consultations"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), nullable=False, index=True
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="PENDIENTE", index=True
    )

    feedback: Mapped[list[ClinicalFeedback]] = relationship(
        back_populates="consultation",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:
        return f"Consultation(id={self.id!r}, status={self.status!r})"
