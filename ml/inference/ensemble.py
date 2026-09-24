from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def combine_predictions(
    predictions: Mapping[str, Any],
    weights: Mapping[str, float],
    class_names: tuple[str, ...],
) -> tuple[str, float, dict[str, float]]:
    normalized_weights = {
        model_name: float(weight) for model_name, weight in weights.items()
    }
    weight_sum = sum(normalized_weights.values())
    if weight_sum <= 0:
        raise ValueError("Ensemble weights must sum to a positive value")
    normalized_weights = {
        model_name: weight / weight_sum
        for model_name, weight in normalized_weights.items()
    }
    probabilities = {
        class_name: sum(
            normalized_weights[model_name] * prediction.probabilities[class_name]
            for model_name, prediction in predictions.items()
        )
        for class_name in class_names
    }
    probabilities_sum = sum(probabilities.values())
    if probabilities_sum <= 0:
        raise ValueError("Ensemble produced invalid probabilities")
    class_name = max(probabilities.items(), key=lambda item: item[1])[0]
    return class_name, float(probabilities[class_name]), probabilities
