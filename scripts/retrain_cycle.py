#!/usr/bin/env python
"""Extract validated feedback and trigger the MLOps batch retraining cycle.

The CLI reads gold-standard clinical feedback from a CSV export or generates a
deterministic synthetic dataset (``--simulate``) and runs the retraining
pipeline, logging metrics to MLflow and gating promotion to Production.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.mlflow.registry import (  # noqa: E402
    DEFAULT_REGISTERED_MODEL_NAME,
    PromotionGate,
)
from ml.training.retrain import (  # noqa: E402
    CLINICAL_FEATURE_NAMES,
    FeedbackSample,
    retrain,
)

_TRUTHY = {"1", "true", "t", "yes", "y", "si", "sí"}

_DATABASE_FEEDBACK_QUERY = """
SELECT
    cf.inference_id AS inference_id,
    cf.validated_class AS validated_class,
    cf.predicted_class AS predicted_class,
    cf.doctor_id AS doctor_id,
    cf.agreement AS agreement,
    cf.is_gold_standard AS is_gold_standard,
    cf.clinical_data AS feedback_clinical_data,
    c.clinical_data AS consultation_clinical_data
FROM clinical_feedback AS cf
JOIN consultations AS c ON c.id = cf.consultation_id
WHERE cf.is_gold_standard = TRUE
"""


@dataclass(frozen=True)
class CsvFeedbackSource:
    """Load clinical feedback samples from a CSV export."""

    path: Path

    def load(self) -> list[FeedbackSample]:
        return load_samples_from_csv(self.path)


class DatabaseFeedbackSource:
    """Load gold-standard clinical feedback directly from the SQL database.

    The source queries ``clinical_feedback`` rows flagged as gold standard and
    joins the owning consultation so the clinical feature vector needed by the
    retraining pipeline can be reconstructed from the ``clinical_data`` JSONB
    column.
    """

    def __init__(self, database_url: str, *, engine: Any | None = None) -> None:
        if not database_url and engine is None:
            raise ValueError("A database URL is required for DatabaseFeedbackSource")
        self.database_url = database_url
        self._engine = engine

    def _resolve_engine(self) -> Any:
        if self._engine is not None:
            return self._engine
        try:
            from sqlalchemy import create_engine
        except ImportError as error:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "SQLAlchemy is required to query feedback from a database"
            ) from error
        return create_engine(self.database_url)

    def load(self) -> list[FeedbackSample]:
        try:
            from sqlalchemy import text
        except ImportError as error:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "SQLAlchemy is required to query feedback from a database"
            ) from error
        engine = self._resolve_engine()
        with engine.connect() as connection:
            rows = connection.execute(
                text(_DATABASE_FEEDBACK_QUERY)
            ).mappings().all()
        return [self._to_sample(row) for row in rows]

    @staticmethod
    def _to_sample(row: Mapping[str, Any]) -> FeedbackSample:
        clinical = row.get("feedback_clinical_data") or row.get("consultation_clinical_data")
        if isinstance(clinical, str):
            clinical = json.loads(clinical)
        features: list[float] | None = None
        if isinstance(clinical, Mapping) and clinical:
            ordered = [clinical.get(name) for name in CLINICAL_FEATURE_NAMES]
            if any(value is not None for value in ordered):
                features = [
                    0.0 if value is None else float(value) for value in ordered
                ]
        validated = row.get("validated_class")
        if validated is None:
            raise ValueError("clinical_feedback row is missing validated_class")
        predicted = row.get("predicted_class")
        agreement = row.get("agreement")
        doctor = row.get("doctor_id")
        return FeedbackSample(
            inference_id=str(row.get("inference_id", "")),
            validated_class=int(validated),
            is_gold_standard=bool(row.get("is_gold_standard")),
            features=features,
            predicted_class=int(predicted) if predicted is not None else None,
            doctor_id=str(doctor) if doctor is not None else None,
            agreement=bool(agreement) if agreement is not None else None,
        )


def _to_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in _TRUTHY


def _parse_features(row: dict[str, str]) -> list[float] | None:
    raw = row.get("features")
    if raw:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("The 'features' column must be a JSON list")
        return [float(item) for item in parsed]

    ordered = [row.get(name) for name in CLINICAL_FEATURE_NAMES]
    if all(value not in (None, "") for value in ordered):
        return [float(value) for value in ordered if value is not None]

    indexed: list[float] = []
    index = 0
    while f"feature_{index}" in row:
        indexed.append(float(row[f"feature_{index}"]))
        index += 1
    return indexed or None


def load_samples_from_csv(path: Path) -> list[FeedbackSample]:
    """Parse a feedback CSV export into :class:`FeedbackSample` objects."""

    samples: list[FeedbackSample] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            validated = row.get("validated_class")
            if not validated:
                continue
            predicted = row.get("predicted_class")
            agreement_value = row.get("agreement")
            samples.append(
                FeedbackSample(
                    inference_id=str(row.get("inference_id", "")),
                    validated_class=int(validated),
                    is_gold_standard=_to_bool(row.get("is_gold_standard", "")),
                    features=_parse_features(row),
                    predicted_class=int(predicted) if predicted else None,
                    doctor_id=row.get("doctor_id") or None,
                    agreement=_to_bool(agreement_value) if agreement_value else None,
                )
            )
    return samples


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the Clearsight clinical feedback retraining cycle.",
    )
    parser.add_argument(
        "--samples",
        type=Path,
        default=None,
        help="CSV export of clinical feedback. Enables simulation when omitted.",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="SQLAlchemy URL pointing at the clinical database (gold-standard ETL).",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Use the deterministic synthetic dataset instead of real feedback.",
    )
    parser.add_argument("--tracking-uri", default=None)
    parser.add_argument("--model-name", default=DEFAULT_REGISTERED_MODEL_NAME)
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--min-roc-auc", type=float, default=0.85)
    parser.add_argument("--min-f1-macro", type=float, default=0.80)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--n-simulated", type=int, default=400)
    parser.add_argument("--no-register", action="store_true")
    parser.add_argument("--no-promote", action="store_true")
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Emit the retraining result as JSON.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.database_url:
        source: CsvFeedbackSource | DatabaseFeedbackSource | None = DatabaseFeedbackSource(
            args.database_url
        )
    elif args.samples is not None:
        source = CsvFeedbackSource(args.samples)
    else:
        source = None
    simulate = args.simulate or source is None

    result = retrain(
        source=source,
        simulate=simulate,
        seed=args.seed,
        gate=PromotionGate(
            min_roc_auc=args.min_roc_auc,
            min_f1_macro=args.min_f1_macro,
        ),
        model_name=args.model_name,
        run_name=args.run_name,
        tracking_uri=args.tracking_uri,
        register=not args.no_register,
        promote=not args.no_promote,
        n_simulated=args.n_simulated,
    )

    payload = asdict(result)
    if args.as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(
            f"run={result.run_id} gold={result.gold_standard_count} "
            f"roc_auc={result.metrics['roc_auc']:.4f} "
            f"f1_macro={result.metrics['f1_macro']:.4f} "
            f"promoted={result.promoted} version={result.registered_version}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
