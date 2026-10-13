"""Clinical feedback ORM model used by the MLOps retraining ETL."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from backend.app.models.consultation import Consultation


class ClinicalFeedback(TimestampMixin, Base):
    """Doctor-validated ground truth for a model inference.

    Only rows with ``is_gold_standard = True`` are eligible for the continuous
    retraining pipeline.
    """

    __tablename__ = "clinical_feedback"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    consultation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("consultations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    inference_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), nullable=False, index=True
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), nullable=False, index=True
    )
    predicted_class: Mapped[int | None] = mapped_column(Integer, nullable=True)
    validated_class: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    agreement: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    doctor_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_gold_standard: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )

    consultation: Mapped[Consultation] = relationship(back_populates="feedback")

    def __repr__(self) -> str:
        return (
            f"ClinicalFeedback(id={self.id!r}, validated_class={self.validated_class!r}, "
            f"is_gold_standard={self.is_gold_standard!r})"
        )
