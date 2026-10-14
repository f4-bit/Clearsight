from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from ml.config import Settings
from ml.inference.classification import (
    ClassifierPrediction,
    normalize_clinical_features,
)

_ONNX_TYPE_TO_NUMPY: dict[str, type[np.floating[Any]]] = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
}

_INPUT_ALIASES: dict[str, tuple[str, ...]] = {
    "image": ("image", "images", "input", "visual", "x"),
    "cdr": ("cdr", "cup_disc_ratio", "cdr_value"),
    "clinical": ("clinical", "clinical_features", "tabular", "features"),
}


def _numpy_dtype(onnx_type: str) -> type[np.floating[Any]]:
    return _ONNX_TYPE_TO_NUMPY.get(onnx_type, np.float32)


def _match_inputs(input_names: list[str]) -> dict[str, str]:
    lowered = {name.lower(): name for name in input_names}
    mapping: dict[str, str] = {}
    for role, aliases in _INPUT_ALIASES.items():
        for alias in aliases:
            if alias in lowered:
                mapping[role] = lowered[alias]
                break
    if len(mapping) == 3:
        return mapping
    if len(input_names) == 3:
        return {
            "image": input_names[0],
            "cdr": input_names[1],
            "clinical": input_names[2],
        }
    raise RuntimeError(
        "Could not map ONNX inputs to (image, cdr, clinical); "
        f"model exposes {input_names}"
    )


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits, axis=-1, keepdims=True)
    exponentials = np.exp(shifted)
    return exponentials / np.sum(exponentials, axis=-1, keepdims=True)


class OnnxClassificationRunner:
    """ONNX Runtime runner mirroring :class:`ClassificationRunner.predict`."""

    def __init__(
        self,
        model_paths: dict[str, Path],
        settings: Settings,
        manifest: dict[str, Any],
    ) -> None:
        try:
            import onnxruntime as ort
        except ImportError as error:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "onnxruntime is required for OnnxClassificationRunner"
            ) from error

        self.ort = ort
        self.class_names = tuple(manifest["class_names"])
        self.clinical_features = tuple(manifest["clinical_features"])
        clinical_mean = settings.clinical_mean or manifest.get("clinical_mean")
        clinical_std = settings.clinical_std or manifest.get("clinical_std")
        if not clinical_mean or not clinical_std:
            raise RuntimeError("clinical_mean and clinical_std are required")
        if len(clinical_mean) != len(self.clinical_features):
            raise RuntimeError("clinical_mean length does not match feature schema")
        if len(clinical_std) != len(self.clinical_features):
            raise RuntimeError("clinical_std length does not match feature schema")
        self.clinical_mean: list[float] = [float(value) for value in clinical_mean]
        self.clinical_std: list[float] = [float(value) for value in clinical_std]

        available = ort.get_available_providers()
        providers = ["CPUExecutionProvider"]
        if settings.device.startswith("cuda") and "CUDAExecutionProvider" in available:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]

        self.sessions: dict[str, Any] = {}
        self.input_names: dict[str, dict[str, str]] = {}
        self.input_types: dict[str, dict[str, type[np.floating[Any]]]] = {}
        for model_type, path in model_paths.items():
            session = ort.InferenceSession(str(path), providers=providers)
            self.sessions[model_type] = session
            names = [item.name for item in session.get_inputs()]
            self.input_names[model_type] = _match_inputs(names)
            self.input_types[model_type] = {
                item.name: _numpy_dtype(item.type) for item in session.get_inputs()
            }

    def _clinical_vector(self, features: dict[str, float]) -> np.ndarray:
        normalized = normalize_clinical_features(
            features,
            self.clinical_features,
            self.clinical_mean,
            self.clinical_std,
        )
        return normalized.reshape(1, -1)

    def _feed(
        self,
        model_type: str,
        image: np.ndarray,
        cdr: float,
        clinical: np.ndarray,
    ) -> dict[str, np.ndarray]:
        mapping = self.input_names[model_type]
        types = self.input_types[model_type]
        image_array = np.ascontiguousarray(image, dtype=np.float32)
        if image_array.ndim == 3:
            image_array = image_array[np.newaxis, ...]
        cdr_array = np.asarray([[float(cdr)]], dtype=np.float32)
        feed: dict[str, np.ndarray] = {}
        for role, payload in (
            ("image", image_array),
            ("cdr", cdr_array),
            ("clinical", clinical.astype(np.float32)),
        ):
            name = mapping[role]
            feed[name] = payload.astype(types.get(name, np.float32), copy=False)
        return feed

    def predict(
        self,
        image: np.ndarray,
        cdr: float,
        clinical_features: dict[str, float],
    ) -> dict[str, ClassifierPrediction]:
        clinical = self._clinical_vector(clinical_features)
        predictions: dict[str, ClassifierPrediction] = {}
        for model_type, session in self.sessions.items():
            feed = self._feed(model_type, image, cdr, clinical)
            outputs = session.run(None, feed)
            logits = np.asarray(outputs[0])
            if logits.ndim == 1:
                logits = logits[np.newaxis, ...]
            probabilities = _softmax(logits.astype(np.float64))[0]
            values = probabilities.astype(np.float64)
            class_index = int(np.argmax(values))
            predictions[model_type] = ClassifierPrediction(
                probabilities={
                    name: float(values[index])
                    for index, name in enumerate(self.class_names)
                },
                predicted_class=self.class_names[class_index],
                confidence=float(values[class_index]),
            )
        return predictions
