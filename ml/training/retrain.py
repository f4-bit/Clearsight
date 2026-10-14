"""Continuous retraining pipeline and clinical feedback ETL.

The pipeline ingests doctor-validated feedback, keeps only the records flagged
as gold standard (``is_gold_standard == true``), prepares the tabular clinical
dataset, evaluates a candidate classifier and gates its promotion to the MLflow
Model Registry.

A deterministic simulation mode (``simulate=True``) runs the full evaluation,
logging and registration flow without loading any heavy deep-learning weights,
which keeps the unit tests fast and reproducible.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import numpy as np

from ml.mlflow.registry import (
    DEFAULT_PROMOTION_GATE,
    DEFAULT_REGISTERED_MODEL_NAME,
    PRODUCTION_STAGE,
    STAGING_STAGE,
    PromotionGate,
    get_production_model_uri,
    log_training_run,
    meets_promotion_gate,
    promote_model,
    register_candidate_model,
)

CLINICAL_FEATURE_NAMES: tuple[str, ...] = (
    "Age",
    "Gender",
    "dioptre_1",
    "dioptre_2",
    "astigmatism",
    "Phakic/Pseudophakic",
    "Pneumatic",
    "Perkins",
    "Pachymetry",
    "Axial_Length",
    "VF_DM",
)

MIN_TRAINING_SAMPLES = 2
_LOCK = threading.Lock()


@dataclass(frozen=True)
class FeedbackSample:
    """A single doctor-validated inference used as retraining feedback."""

    inference_id: str
    validated_class: int
    is_gold_standard: bool = False
    features: Sequence[float] | None = None
    predicted_class: int | None = None
    doctor_id: str | None = None
    agreement: bool | None = None


@runtime_checkable
class FeedbackSource(Protocol):
    """Abstraction over the origin of clinical feedback samples."""

    def load(self) -> Iterable[FeedbackSample]:
        """Return the available feedback samples."""


@dataclass(frozen=True)
class RetrainResult:
    """Outcome of a retraining cycle."""

    run_id: str
    gold_standard_count: int
    train_samples: int
    metrics: dict[str, float]
    meets_gate: bool
    registered_version: str | None
    promoted: bool
    production_model_uri: str | None
    simulate: bool


@dataclass(frozen=True)
class _LogisticModel:
    weights: np.ndarray
    bias: float
    mean: np.ndarray
    scale: np.ndarray

    def predict_proba(self, features: np.ndarray) -> np.ndarray:
        standardized = (np.asarray(features, dtype=np.float64) - self.mean) / self.scale
        scores = _sigmoid(standardized @ self.weights + self.bias)
        return np.column_stack([1.0 - scores, scores])


def extract_gold_standard(samples: Iterable[FeedbackSample]) -> list[FeedbackSample]:
    """Return only the samples with ``is_gold_standard == true``."""

    return [sample for sample in samples if sample.is_gold_standard]


def prepare_dataset(
    samples: Iterable[FeedbackSample],
) -> tuple[np.ndarray, np.ndarray]:
    """Build ``(features, labels)`` arrays from gold-standard feedback only."""

    rows: list[list[float]] = []
    labels: list[int] = []
    for sample in extract_gold_standard(samples):
        if sample.features is None:
            continue
        rows.append([float(value) for value in sample.features])
        labels.append(int(sample.validated_class))
    if not rows:
        raise ValueError(
            "No gold-standard feedback samples with clinical features were provided"
        )
    features = np.asarray(rows, dtype=np.float64)
    targets = np.asarray(labels, dtype=np.int64)
    return features, targets


def retrain(
    samples: Sequence[FeedbackSample] | None = None,
    *,
    source: FeedbackSource | None = None,
    simulate: bool = False,
    seed: int = 42,
    gate: PromotionGate | None = None,
    model_name: str = DEFAULT_REGISTERED_MODEL_NAME,
    run_name: str | None = None,
    tracking_uri: str | None = None,
    register: bool = True,
    promote: bool = True,
    n_simulated: int = 400,
) -> RetrainResult:
    """Execute a retraining cycle end to end.

    When ``simulate`` is ``True`` a deterministic synthetic gold-standard
    dataset is generated and no external data source is required. Otherwise the
    samples are gathered from ``samples`` or ``source`` and filtered by gold
    standard before training.
    """

    active_gate = gate or DEFAULT_PROMOTION_GATE

    if simulate:
        features, targets = _simulate_dataset(seed, n_simulated)
        gold_count = int(targets.shape[0])
    else:
        collected = list(samples) if samples is not None else _collect(source)
        gold_count = len(extract_gold_standard(collected))
        features, targets = prepare_dataset(collected)
        if targets.shape[0] < MIN_TRAINING_SAMPLES or np.unique(targets).size < 2:
            raise ValueError(
                "Retraining requires at least two gold-standard samples and two classes"
            )

    metrics = _evaluate(features, targets, seed=seed)
    resolved_run_name = run_name or _default_run_name(simulate, seed)
    params: dict[str, Any] = {
        "gold_standard_samples": gold_count,
        "feature_count": int(features.shape[1]),
        "simulate": simulate,
        "seed": seed,
        "min_roc_auc": active_gate.min_roc_auc,
        "min_f1_macro": active_gate.min_f1_macro,
    }

    with _LOCK:
        run_id = log_training_run(
            run_name=resolved_run_name,
            params=params,
            metrics=metrics,
            tracking_uri=tracking_uri,
        )
        registered_version: str | None = None
        promoted = False
        if register:
            registered_version = register_candidate_model(
                run_id,
                model_name=model_name,
                tracking_uri=tracking_uri,
            )
            if promote and meets_promotion_gate(metrics, active_gate):
                promote_model(
                    model_name=model_name,
                    version=registered_version,
                    stage=STAGING_STAGE,
                    tracking_uri=tracking_uri,
                    metrics=metrics,
                    gate=active_gate,
                )
                promote_model(
                    model_name=model_name,
                    version=registered_version,
                    stage=PRODUCTION_STAGE,
                    tracking_uri=tracking_uri,
                    metrics=metrics,
                    gate=active_gate,
                )
                promoted = True

    production_uri = (
        get_production_model_uri(model_name, tracking_uri=tracking_uri)
        if promoted
        else None
    )
    return RetrainResult(
        run_id=run_id,
        gold_standard_count=gold_count,
        train_samples=int(targets.shape[0]),
        metrics=metrics,
        meets_gate=meets_promotion_gate(metrics, active_gate),
        registered_version=registered_version,
        promoted=promoted,
        production_model_uri=production_uri,
        simulate=simulate,
    )


def _collect(source: FeedbackSource | None) -> list[FeedbackSample]:
    if source is None:
        return []
    return list(source.load())


def _default_run_name(simulate: bool, seed: int) -> str:
    mode = "simulation" if simulate else "clinical"
    return f"retrain-{mode}-seed{seed}"


def _simulate_dataset(seed: int, n_samples: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    n_features = len(CLINICAL_FEATURE_NAMES)
    n_positive = n_samples // 2
    targets = np.concatenate(
        [np.zeros(n_samples - n_positive, dtype=np.int64), np.ones(n_positive, dtype=np.int64)]
    )
    centers = np.zeros((2, n_features), dtype=np.float64)
    centers[1] = 1.0
    features = centers[targets] + rng.normal(0.0, 1.6, size=(n_samples, n_features))
    return features, targets


def _evaluate(
    features: np.ndarray, targets: np.ndarray, *, seed: int
) -> dict[str, float]:
    rng = np.random.default_rng(seed + 1)
    n_samples = int(targets.shape[0])
    indices = rng.permutation(n_samples)
    split = max(1, int(n_samples * 0.8))
    train_index = indices[:split]
    validation_index = indices[split:]
    if validation_index.size == 0:
        validation_index = train_index

    model = _fit_logistic(features[train_index], targets[train_index], seed=seed)
    scores = model.predict_proba(features[validation_index])[:, 1]
    y_true = targets[validation_index]
    y_pred = (scores >= 0.5).astype(np.int64)

    return {
        "roc_auc": _roc_auc(y_true, scores),
        "f1_macro": _f1_macro(y_true, y_pred),
        "sensitivity": _sensitivity(y_true, y_pred),
        "specificity": _specificity(y_true, y_pred),
        "val_loss": _log_loss(y_true, scores),
    }


def _fit_logistic(
    features: np.ndarray,
    targets: np.ndarray,
    *,
    epochs: int = 500,
    learning_rate: float = 0.1,
    l2: float = 1e-3,
    seed: int = 42,
) -> _LogisticModel:
    rng = np.random.default_rng(seed)
    x = np.asarray(features, dtype=np.float64)
    y = np.asarray(targets, dtype=np.float64)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale == 0.0] = 1.0
    standardized = (x - mean) / scale
    n_samples, n_features = standardized.shape
    weights = rng.normal(0.0, 0.01, size=n_features)
    bias = 0.0
    for _ in range(epochs):
        error = _sigmoid(standardized @ weights + bias) - y
        gradient_w = (standardized.T @ error) / n_samples + l2 * weights
        gradient_b = float(error.mean())
        weights -= learning_rate * gradient_w
        bias -= learning_rate * gradient_b
    return _LogisticModel(weights=weights, bias=bias, mean=mean, scale=scale)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -60.0, 60.0)))


def _roc_auc(y_true: np.ndarray, scores: np.ndarray) -> float:
    y_true = np.asarray(y_true)
    scores = np.asarray(scores, dtype=np.float64)
    positives = scores[y_true == 1]
    negatives = scores[y_true == 0]
    if positives.size == 0 or negatives.size == 0:
        return 0.0

    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(scores.shape[0], dtype=np.float64)
    ranks[order] = np.arange(1, scores.shape[0] + 1, dtype=np.float64)
    sorted_scores = scores[order]
    index = 0
    while index < sorted_scores.shape[0]:
        end = index
        while (
            end + 1 < sorted_scores.shape[0]
            and sorted_scores[end + 1] == sorted_scores[index]
        ):
            end += 1
        if end > index:
            average_rank = (index + end + 2) / 2.0
            ranks[order[index : end + 1]] = average_rank
        index = end + 1

    pos_rank_sum = float(ranks[y_true == 1].sum())
    n_pos = float(positives.size)
    n_neg = float(negatives.size)
    return (pos_rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def _f1_macro(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    labels = np.unique(np.concatenate([np.asarray(y_true), np.asarray(y_pred)]))
    scores: list[float] = []
    for label in labels:
        true_positive = np.sum((y_true == label) & (y_pred == label))
        false_positive = np.sum((y_true != label) & (y_pred == label))
        false_negative = np.sum((y_true == label) & (y_pred != label))
        denominator = 2 * true_positive + false_positive + false_negative
        scores.append(0.0 if denominator == 0 else (2.0 * true_positive) / denominator)
    return float(np.mean(scores)) if scores else 0.0


def _sensitivity(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    true_positive = np.sum((y_true == 1) & (y_pred == 1))
    false_negative = np.sum((y_true == 1) & (y_pred == 0))
    denominator = true_positive + false_negative
    return float(true_positive / denominator) if denominator else 0.0


def _specificity(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    true_negative = np.sum((y_true == 0) & (y_pred == 0))
    false_positive = np.sum((y_true == 0) & (y_pred == 1))
    denominator = true_negative + false_positive
    return float(true_negative / denominator) if denominator else 0.0


def _log_loss(y_true: np.ndarray, scores: np.ndarray) -> float:
    epsilon = 1e-12
    probabilities = np.clip(np.asarray(scores, dtype=np.float64), epsilon, 1.0 - epsilon)
    targets = np.asarray(y_true, dtype=np.float64)
    return float(
        -np.mean(
            targets * np.log(probabilities) + (1.0 - targets) * np.log(1.0 - probabilities)
        )
    )
