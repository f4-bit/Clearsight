from __future__ import annotations

import csv
import json
from pathlib import Path

from scripts.retrain_cycle import load_samples_from_csv, main


def _tracking_uri(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path.as_posix()}/mlflow.db"


def test_cli_simulation_emits_json(tmp_path: Path, capsys) -> None:
    code = main(
        [
            "--simulate",
            "--json",
            "--tracking-uri",
            _tracking_uri(tmp_path),
            "--seed",
            "11",
            "--model-name",
            "cli-model",
        ]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["simulate"] is True
    assert payload["train_samples"] > 0
    assert "roc_auc" in payload["metrics"]
    assert "f1_macro" in payload["metrics"]


def test_cli_defaults_to_simulation_without_samples(tmp_path: Path, capsys) -> None:
    code = main(["--tracking-uri", _tracking_uri(tmp_path), "--seed", "5"])

    assert code == 0
    assert "run=" in capsys.readouterr().out


def test_load_samples_from_csv_parses_gold_standard(tmp_path: Path) -> None:
    csv_path = tmp_path / "feedback.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["inference_id", "validated_class", "is_gold_standard", "features"])
        writer.writerow(["a", "0", "true", "[0.1, 0.2]"])
        writer.writerow(["b", "1", "false", "[0.3, 0.4]"])

    samples = load_samples_from_csv(csv_path)

    assert len(samples) == 2
    assert samples[0].is_gold_standard is True
    assert samples[0].features == [0.1, 0.2]
    assert samples[1].is_gold_standard is False


def test_cli_runs_csv_feedback_cycle(tmp_path: Path, capsys) -> None:
    csv_path = tmp_path / "feedback.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "inference_id",
                "validated_class",
                "is_gold_standard",
                "feature_0",
                "feature_1",
            ]
        )
        for index in range(40):
            label = index % 2
            writer.writerow([f"s{index}", str(label), "true", str(label), str(label)])
        for index in range(10):
            writer.writerow([f"n{index}", "0", "false", "0", "0"])

    code = main(
        [
            "--samples",
            str(csv_path),
            "--json",
            "--tracking-uri",
            _tracking_uri(tmp_path),
            "--seed",
            "2",
            "--model-name",
            "csv-model",
        ]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["gold_standard_count"] == 40
    assert payload["train_samples"] == 40
