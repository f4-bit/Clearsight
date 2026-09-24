from __future__ import annotations

from types import SimpleNamespace

from ml.inference.ensemble import combine_predictions


def test_ensemble_averages_probabilities_and_renormalizes_weights() -> None:
    predictions = {
        "resnet50": SimpleNamespace(
            probabilities={
                "Glaucoma": 0.8,
                "Non_Glaucoma": 0.1,
                "Suspicious_Glaucoma": 0.1,
            }
        ),
        "efficientnet_b3": SimpleNamespace(
            probabilities={
                "Glaucoma": 0.4,
                "Non_Glaucoma": 0.5,
                "Suspicious_Glaucoma": 0.1,
            }
        ),
    }

    label, confidence, probabilities = combine_predictions(
        predictions,
        {"resnet50": 3, "efficientnet_b3": 1},
        ("Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma"),
    )

    assert label == "Glaucoma"
    assert abs(confidence - 0.7) < 1e-9
    assert abs(probabilities["Glaucoma"] - 0.7) < 1e-9
    assert abs(probabilities["Non_Glaucoma"] - 0.2) < 1e-9
    assert abs(probabilities["Suspicious_Glaucoma"] - 0.1) < 1e-9
