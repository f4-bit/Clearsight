from __future__ import annotations

from pathlib import Path

import numpy as np

from ml.mlflow.registry import PromotionGate
from ml.training.retrain import (
    CLINICAL_FEATURE_NAMES,
    FeedbackSample,
    extract_gold_standard,
    prepare_dataset,
    retrain,
)


def _tracking_uri(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path.as_posix()}/mlflow.db"


def _sample(
    index: int,
    label: int,
    gold: bool,
    features: list[float] | None = None,
) -> FeedbackSample:
    return FeedbackSample(
        inference_id=f"i{index}",
        validated_class=label,
        is_gold_standard=gold,
        features=features,
    )


def test_extract_gold_standard_filters_regular_records() -> None:
    samples = [
        _sample(1, 0, True),
        _sample(2, 1, False),
        _sample(3, 1, True),
    ]

    gold = extract_gold_standard(samples)

    assert [sample.inference_id for sample in gold] == ["i1", "i3"]


def test_prepare_dataset_uses_gold_standard_only() -> None:
    samples = [
        _sample(1, 0, True, [0.0, 1.0]),
        _sample(2, 1, False, [9.0, 9.0]),
        _sample(3, 1, True, [1.0, 0.0]),
    ]

    features, targets = prepare_dataset(samples)

    assert features.shape == (2, 2)
    assert targets.tolist() == [0, 1]


def test_retrain_simulation_promotes_deterministically(tmp_path: Path) -> None:
    uri = _tracking_uri(tmp_path)

    result = retrain(simulate=True, seed=7, tracking_uri=uri, model_name="sim-model")

    assert result.train_samples == 400
    assert result.gold_standard_count == 400
    assert result.simulate is True
    assert result.meets_gate is True
    assert result.promoted is True
    assert result.registered_version == "1"
    assert result.production_model_uri


def test_retrain_filters_real_feedback_by_gold_standard(tmp_path: Path) -> None:
    uri = _tracking_uri(tmp_path)
    rng = np.random.default_rng(0)
    samples: list[FeedbackSample] = []
    for index in range(60):
        label = index % 2
        center = 0.0 if label == 0 else 1.6
        features = (center + rng.normal(0.0, 1.0, len(CLINICAL_FEATURE_NAMES))).tolist()
        samples.append(_sample(index, label, True, features))
    for index in range(20):
        samples.append(_sample(100 + index, 0, False, [0.0] * len(CLINICAL_FEATURE_NAMES)))

    result = retrain(samples, seed=3, tracking_uri=uri, model_name="real-model")

    assert result.gold_standard_count == 60
    assert result.train_samples == 60
    assert result.simulate is False


def test_retrain_below_gate_is_registered_but_not_promoted(tmp_path: Path) -> None:
    uri = _tracking_uri(tmp_path)

    result = retrain(
        simulate=True,
        seed=7,
        tracking_uri=uri,
        model_name="strict-model",
        gate=PromotionGate(min_roc_auc=0.999, min_f1_macro=0.999),
    )

    assert result.meets_gate is False
    assert result.promoted is False
    assert result.registered_version == "1"
    assert result.production_model_uri is None
