from __future__ import annotations

from pathlib import Path

import pytest

from ml.mlflow.registry import (
    PRODUCTION_STAGE,
    PromotionGate,
    PromotionGateError,
    get_production_model_uri,
    log_training_run,
    meets_promotion_gate,
    promote_model,
    register_candidate_model,
)

GOOD_METRICS = {
    "roc_auc": 0.91,
    "f1_macro": 0.88,
    "sensitivity": 0.90,
    "specificity": 0.85,
    "val_loss": 0.21,
}


def _tracking_uri(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path.as_posix()}/mlflow.db"


def test_meets_promotion_gate_thresholds() -> None:
    assert meets_promotion_gate({"roc_auc": 0.85, "f1_macro": 0.80})
    assert not meets_promotion_gate({"roc_auc": 0.84, "f1_macro": 0.90})
    assert not meets_promotion_gate({"roc_auc": 0.90, "f1_macro": 0.79})
    assert not meets_promotion_gate({"roc_auc": 0.90})
    assert meets_promotion_gate(
        {"roc_auc": 0.95, "f1_macro": 0.95}, PromotionGate(0.9, 0.9)
    )


def test_log_register_promote_and_lookup(tmp_path: Path) -> None:
    uri = _tracking_uri(tmp_path)

    run_id = log_training_run(run_name="unit-run", metrics=GOOD_METRICS, tracking_uri=uri)
    assert run_id

    version = register_candidate_model(run_id, model_name="unit-model", tracking_uri=uri)
    assert version == "1"

    promoted = promote_model(
        model_name="unit-model",
        version=version,
        stage=PRODUCTION_STAGE,
        tracking_uri=uri,
    )
    assert promoted == "1"
    assert get_production_model_uri("unit-model", tracking_uri=uri) == f"runs:/{run_id}/model"


def test_promotion_gate_blocks_low_metrics(tmp_path: Path) -> None:
    uri = _tracking_uri(tmp_path)

    run_id = log_training_run(
        run_name="weak-run",
        metrics={"roc_auc": 0.70, "f1_macro": 0.60},
        tracking_uri=uri,
    )
    version = register_candidate_model(run_id, model_name="weak-model", tracking_uri=uri)

    with pytest.raises(PromotionGateError):
        promote_model(model_name="weak-model", version=version, tracking_uri=uri)

    assert get_production_model_uri("weak-model", tracking_uri=uri) is None
