from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ml.inference.classification import normalize_clinical_features
from ml.models.registry import load_manifest

EXPECTED_MEAN = [
    60.723785,
    0.598466,
    0.669565,
    -1.022379,
    91.245522,
    0.657289,
    13.395907,
    4.432225,
    520.534546,
    23.133957,
    -1.46757,
]
EXPECTED_STD = [
    13.271913,
    0.490209,
    2.033101,
    0.81328,
    42.873653,
    0.474616,
    7.171593,
    7.700588,
    104.636459,
    3.359584,
    4.268064,
]


def _manifest() -> dict:
    return load_manifest(Path("ml/models/manifest.json"))


def test_manifest_exposes_eleven_finite_normalization_parameters() -> None:
    manifest = _manifest()
    clinical_features = manifest["clinical_features"]
    clinical_mean = manifest["clinical_mean"]
    clinical_std = manifest["clinical_std"]

    assert len(clinical_features) == 11
    assert len(clinical_mean) == 11
    assert len(clinical_std) == 11
    assert all(value is not None for value in clinical_mean)
    assert all(value is not None for value in clinical_std)
    assert np.all(np.isfinite(clinical_mean))
    assert np.all(np.isfinite(clinical_std))
    assert np.all(np.asarray(clinical_std) > 0)


def test_manifest_normalization_values_match_specification() -> None:
    manifest = _manifest()

    assert manifest["clinical_mean"] == pytest.approx(EXPECTED_MEAN, abs=1e-6)
    assert manifest["clinical_std"] == pytest.approx(EXPECTED_STD, abs=1e-6)


def test_normalization_is_zero_at_the_mean() -> None:
    manifest = _manifest()
    clinical_features = tuple(manifest["clinical_features"])
    features = {name: mean for name, mean in zip(clinical_features, EXPECTED_MEAN)}

    normalized = normalize_clinical_features(
        features,
        clinical_features,
        EXPECTED_MEAN,
        EXPECTED_STD,
    )

    assert normalized.shape == (11,)
    assert normalized.dtype == np.float32
    assert np.allclose(normalized, 0.0, atol=1e-5)


def test_normalization_scales_one_std_to_unity() -> None:
    manifest = _manifest()
    clinical_features = tuple(manifest["clinical_features"])
    shifted = [
        mean + std for mean, std in zip(EXPECTED_MEAN, EXPECTED_STD)
    ]
    features = dict(zip(clinical_features, shifted))

    normalized = normalize_clinical_features(
        features,
        clinical_features,
        EXPECTED_MEAN,
        EXPECTED_STD,
    )

    assert np.allclose(normalized, 1.0, atol=1e-4)


def test_normalization_rejects_schema_mismatch() -> None:
    manifest = _manifest()
    clinical_features = tuple(manifest["clinical_features"])
    features = {name: 0.0 for name in clinical_features}

    with pytest.raises(ValueError):
        normalize_clinical_features(
            features,
            clinical_features,
            EXPECTED_MEAN[:-1],
            EXPECTED_STD,
        )
