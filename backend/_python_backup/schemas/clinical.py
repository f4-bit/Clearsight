from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ClinicalFeatures(BaseModel):
    model_config = ConfigDict(extra="forbid")

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
