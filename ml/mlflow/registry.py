"""MLflow experiment tracking and Model Registry integration for Clearsight.

The module exposes a compact facade over MLflow focused on the clinical
retraining workflow: logging training parameters and clinical metrics,
registering candidate models and promoting them through the Model Registry
lifecycle (``Staging`` -> ``Production``) once the promotion gate passes.

When neither the MLflow tracking server nor the ``mlflow`` package are
available the facade transparently falls back to a local SQLite registry so the
retraining pipeline and the unit tests keep working fully offline.
"""

from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

DEFAULT_TRACKING_URI = "sqlite:///mlflow.db"
DEFAULT_EXPERIMENT_NAME = "clearsight-glaucoma"
DEFAULT_REGISTERED_MODEL_NAME = "clearsight-glaucoma-multimodal"
STAGING_STAGE = "Staging"
PRODUCTION_STAGE = "Production"
ARCHIVED_STAGE = "Archived"

TRACKED_METRICS: tuple[str, ...] = (
    "roc_auc",
    "f1_macro",
    "sensitivity",
    "specificity",
    "val_loss",
)

_MIN_ROC_AUC = 0.85
_MIN_F1_MACRO = 0.80


class PromotionGateError(RuntimeError):
    """Raised when a candidate model fails the promotion gate."""


@dataclass(frozen=True)
class PromotionGate:
    """Thresholds a candidate model must satisfy to be promoted."""

    min_roc_auc: float = _MIN_ROC_AUC
    min_f1_macro: float = _MIN_F1_MACRO


DEFAULT_PROMOTION_GATE = PromotionGate()


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    experiment: str
    run_name: str
    params: dict[str, Any]
    metrics: dict[str, float]
    artifacts: tuple[str, ...]


@dataclass(frozen=True)
class ModelVersion:
    model_name: str
    version: int
    run_id: str
    model_uri: str
    stage: str


def meets_promotion_gate(
    metrics: Mapping[str, float],
    gate: PromotionGate | None = None,
) -> bool:
    """Return ``True`` when ``metrics`` satisfies the promotion thresholds.

    Both ``roc_auc`` and ``f1_macro`` must be present and greater than or equal
    to the configured minimums.
    """

    active_gate = gate or DEFAULT_PROMOTION_GATE
    roc_auc = metrics.get("roc_auc")
    f1_macro = metrics.get("f1_macro")
    if roc_auc is None or f1_macro is None:
        return False
    return (
        float(roc_auc) >= active_gate.min_roc_auc
        and float(f1_macro) >= active_gate.min_f1_macro
    )


def resolve_tracking_uri(tracking_uri: str | None = None) -> str:
    """Resolve the tracking URI, falling back to a local SQLite store.

    The explicit argument takes precedence, then ``MLFLOW_TRACKING_URI``, then
    :data:`DEFAULT_TRACKING_URI`. Remote HTTP(S) URIs that are unreachable are
    replaced by the local fallback.
    """

    candidate = (
        tracking_uri or os.getenv("MLFLOW_TRACKING_URI") or DEFAULT_TRACKING_URI
    )
    if candidate.startswith(("http://", "https://")) and not _http_reachable(candidate):
        return DEFAULT_TRACKING_URI
    return candidate


def _http_reachable(uri: str) -> bool:
    health_url = uri.rstrip("/") + "/health"
    try:
        with urllib.request.urlopen(health_url, timeout=1.0) as response:
            return 200 <= int(response.status) < 500
    except Exception:
        return False


def _sqlite_path(uri: str) -> Path:
    for prefix in ("sqlite:///", "sqlite://"):
        if uri.startswith(prefix):
            return Path(uri[len(prefix) :])
    return Path("mlflow.db")


@lru_cache(maxsize=1)
def _mlflow_module() -> Any | None:
    try:
        import mlflow
    except Exception:
        return None
    return mlflow


class _LocalRegistry:
    """Minimal SQLite-backed stand-in for the MLflow tracking + registry API."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self._db_path))
        connection.row_factory = sqlite3.Row
        return connection

    def _init_schema(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    experiment TEXT NOT NULL,
                    run_name TEXT NOT NULL,
                    params TEXT NOT NULL,
                    metrics TEXT NOT NULL,
                    artifacts TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_versions (
                    model_name TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    run_id TEXT NOT NULL,
                    model_uri TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    PRIMARY KEY (model_name, version)
                );
                """
            )

    def log_run(
        self,
        experiment: str,
        run_name: str,
        params: Mapping[str, Any],
        metrics: Mapping[str, float],
        artifacts: Sequence[str],
    ) -> RunRecord:
        run_id = uuid.uuid4().hex
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO runs "
                "(run_id, experiment, run_name, params, metrics, artifacts) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    experiment,
                    run_name,
                    json.dumps(dict(params), sort_keys=True),
                    json.dumps(dict(metrics), sort_keys=True),
                    json.dumps(list(artifacts)),
                ),
            )
        return RunRecord(
            run_id=run_id,
            experiment=experiment,
            run_name=run_name,
            params=dict(params),
            metrics={key: float(value) for key, value in metrics.items()},
            artifacts=tuple(artifacts),
        )

    def get_run(self, run_id: str) -> RunRecord:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown run_id: {run_id}")
        return RunRecord(
            run_id=row["run_id"],
            experiment=row["experiment"],
            run_name=row["run_name"],
            params=json.loads(row["params"]),
            metrics={key: float(value) for key, value in json.loads(row["metrics"]).items()},
            artifacts=tuple(json.loads(row["artifacts"])),
        )

    def register_model(self, model_name: str, run_id: str, model_uri: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS latest "
                "FROM model_versions WHERE model_name = ?",
                (model_name,),
            ).fetchone()
            version = int(row["latest"]) + 1
            connection.execute(
                "INSERT INTO model_versions "
                "(model_name, version, run_id, model_uri, stage) "
                "VALUES (?, ?, ?, ?, ?)",
                (model_name, version, run_id, model_uri, "None"),
            )
        return version

    def latest_version(self, model_name: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS latest "
                "FROM model_versions WHERE model_name = ?",
                (model_name,),
            ).fetchone()
        version = int(row["latest"])
        if version == 0:
            raise KeyError(f"No registered versions for model: {model_name}")
        return version

    def transition_stage(self, model_name: str, version: int, stage: str) -> None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM model_versions WHERE model_name = ? AND version = ?",
                (model_name, version),
            ).fetchone()
            if row is None:
                raise KeyError(f"Unknown model version: {model_name} v{version}")
            connection.execute(
                "UPDATE model_versions SET stage = ? WHERE model_name = ? AND version = ?",
                (stage, model_name, version),
            )

    def get_stage_version(self, model_name: str, stage: str) -> ModelVersion | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM model_versions "
                "WHERE model_name = ? AND stage = ? "
                "ORDER BY version DESC LIMIT 1",
                (model_name, stage),
            ).fetchone()
        if row is None:
            return None
        return _model_version_from_row(row)

    def get_version_metrics(self, model_name: str, version: int) -> dict[str, float]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT runs.metrics AS metrics FROM model_versions "
                "JOIN runs ON runs.run_id = model_versions.run_id "
                "WHERE model_versions.model_name = ? AND model_versions.version = ?",
                (model_name, version),
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown model version: {model_name} v{version}")
        return {key: float(value) for key, value in json.loads(row["metrics"]).items()}


def _model_version_from_row(row: sqlite3.Row) -> ModelVersion:
    return ModelVersion(
        model_name=row["model_name"],
        version=int(row["version"]),
        run_id=row["run_id"],
        model_uri=row["model_uri"],
        stage=row["stage"],
    )


def _local_registry(tracking_uri: str | None = None) -> _LocalRegistry:
    resolved = resolve_tracking_uri(tracking_uri)
    return _LocalRegistry(_sqlite_path(resolved))


def log_training_run(
    run_name: str,
    params: Mapping[str, Any] | None = None,
    metrics: Mapping[str, float] | None = None,
    artifacts: Sequence[str | Path] | None = None,
    *,
    experiment_name: str = DEFAULT_EXPERIMENT_NAME,
    tracking_uri: str | None = None,
) -> str:
    """Log a training run and return its ``run_id``.

    All entries of :data:`TRACKED_METRICS` are recorded when provided. The run
    is always persisted to the local fallback registry, and mirrored to MLflow
    when a tracking server is reachable.
    """

    resolved = resolve_tracking_uri(tracking_uri)
    clean_params = {key: value for key, value in (params or {}).items()}
    clean_metrics = {key: float(value) for key, value in (metrics or {}).items()}
    artifact_paths = [str(artifact) for artifact in (artifacts or [])]

    record = _LocalRegistry(_sqlite_path(resolved)).log_run(
        experiment=experiment_name,
        run_name=run_name,
        params=clean_params,
        metrics=clean_metrics,
        artifacts=artifact_paths,
    )
    _mirror_run(
        resolved,
        experiment_name=experiment_name,
        run_name=run_name,
        params=clean_params,
        metrics=clean_metrics,
        artifacts=artifact_paths,
    )
    return record.run_id


def register_candidate_model(
    run_id: str,
    *,
    model_name: str = DEFAULT_REGISTERED_MODEL_NAME,
    model_uri: str | None = None,
    tracking_uri: str | None = None,
) -> str:
    """Register a candidate model for ``run_id`` and return its version."""

    resolved = resolve_tracking_uri(tracking_uri)
    registry = _LocalRegistry(_sqlite_path(resolved))
    registry.get_run(run_id)
    uri = model_uri or f"runs:/{run_id}/model"
    version = registry.register_model(model_name, run_id, uri)
    _mirror_register(resolved, run_id=run_id, model_name=model_name, model_uri=uri)
    return str(version)


def promote_model(
    *,
    model_name: str = DEFAULT_REGISTERED_MODEL_NAME,
    version: str | int | None = None,
    stage: str = STAGING_STAGE,
    tracking_uri: str | None = None,
    metrics: Mapping[str, float] | None = None,
    gate: PromotionGate | None = None,
) -> str:
    """Transition a model version to ``stage`` if it passes the gate."""

    resolved = resolve_tracking_uri(tracking_uri)
    registry = _LocalRegistry(_sqlite_path(resolved))
    resolved_version = (
        int(version) if version is not None else registry.latest_version(model_name)
    )
    evaluated = (
        {key: float(value) for key, value in metrics.items()}
        if metrics is not None
        else registry.get_version_metrics(model_name, resolved_version)
    )
    if not meets_promotion_gate(evaluated, gate):
        raise PromotionGateError(
            f"Model {model_name} v{resolved_version} does not meet the promotion gate "
            f"(roc_auc={evaluated.get('roc_auc')}, f1_macro={evaluated.get('f1_macro')})"
        )
    registry.transition_stage(model_name, resolved_version, stage)
    _mirror_transition(
        resolved, model_name=model_name, version=resolved_version, stage=stage
    )
    return str(resolved_version)


def get_production_model_uri(
    model_name: str = DEFAULT_REGISTERED_MODEL_NAME,
    *,
    tracking_uri: str | None = None,
) -> str | None:
    """Return the artifact URI of the current Production model, if any."""

    resolved = resolve_tracking_uri(tracking_uri)
    production = _LocalRegistry(_sqlite_path(resolved)).get_stage_version(
        model_name, PRODUCTION_STAGE
    )
    if production is None:
        return None
    return production.model_uri


def _mirror_run(
    tracking_uri: str,
    *,
    experiment_name: str,
    run_name: str,
    params: Mapping[str, Any],
    metrics: Mapping[str, float],
    artifacts: Sequence[str],
) -> None:
    mlflow = _mlflow_module()
    if mlflow is None:
        return
    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment(experiment_name)
        with mlflow.start_run(run_name=run_name):
            if params:
                mlflow.log_params({key: str(value) for key, value in params.items()})
            if metrics:
                mlflow.log_metrics({key: float(value) for key, value in metrics.items()})
            for artifact in artifacts:
                artifact_path = Path(artifact)
                if artifact_path.exists():
                    mlflow.log_artifact(str(artifact_path))
    except Exception:
        return


def _mirror_register(
    tracking_uri: str,
    *,
    run_id: str,
    model_name: str,
    model_uri: str,
) -> None:
    mlflow = _mlflow_module()
    if mlflow is None:
        return
    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.register_model(model_uri=model_uri, name=model_name)
    except Exception:
        return


def _mirror_transition(
    tracking_uri: str,
    *,
    model_name: str,
    version: int,
    stage: str,
) -> None:
    mlflow = _mlflow_module()
    if mlflow is None:
        return
    try:
        client = mlflow.tracking.MlflowClient(tracking_uri=tracking_uri)
        client.transition_model_version_stage(
            name=model_name, version=str(version), stage=stage
        )
    except Exception:
        return
