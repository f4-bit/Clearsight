from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import torch

from ml.config import Settings
from ml.inference.spatial_classifier import SpatialClassifier

CLASS_NAMES = ("Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma")

CLINICAL_EPSILON = 1e-8


@dataclass(frozen=True)
class ResolvedClinicalParameters:
    """Effective normalization parameters captured from the loaded runner.

    ``mean_source``/``std_source`` describe where the whole vector came from
    (the current settings semantics are all-or-nothing: an override supplies
    the complete list, otherwise the manifest is used). The values are copied
    so later mutation of ``Settings`` or the manifest cannot change a runner.
    """

    feature_names: tuple[str, ...]
    mean: tuple[float, ...]
    std: tuple[float, ...]
    mean_source: str
    std_source: str


def resolve_clinical_parameters(
    settings: Settings,
    manifest: dict[str, Any],
) -> ResolvedClinicalParameters:
    """Resolve the same parameters both classifier backends use in predict."""

    feature_names = tuple(manifest["clinical_features"])
    mean_source = "env" if settings.clinical_mean else "manifest"
    std_source = "env" if settings.clinical_std else "manifest"
    clinical_mean = settings.clinical_mean or manifest.get("clinical_mean")
    clinical_std = settings.clinical_std or manifest.get("clinical_std")
    if not clinical_mean or not clinical_std:
        raise RuntimeError("clinical_mean and clinical_std are required")
    if len(clinical_mean) != len(feature_names):
        raise RuntimeError("clinical_mean length does not match feature schema")
    if len(clinical_std) != len(feature_names):
        raise RuntimeError("clinical_std length does not match feature schema")
    return ResolvedClinicalParameters(
        feature_names=feature_names,
        mean=tuple(float(value) for value in clinical_mean),
        std=tuple(float(value) for value in clinical_std),
        mean_source=mean_source,
        std_source=std_source,
    )


def normalize_clinical_features(
    features: dict[str, float],
    clinical_features: Sequence[str],
    clinical_mean: Sequence[float],
    clinical_std: Sequence[float],
) -> np.ndarray:
    if len(clinical_mean) != len(clinical_features):
        raise ValueError("clinical_mean length does not match feature schema")
    if len(clinical_std) != len(clinical_features):
        raise ValueError("clinical_std length does not match feature schema")
    values = np.asarray(
        [float(features[name]) for name in clinical_features],
        dtype=np.float32,
    )
    mean = np.asarray(clinical_mean, dtype=np.float32)
    std = np.asarray(clinical_std, dtype=np.float32)
    return ((values - mean) / (std + CLINICAL_EPSILON)).astype(np.float32)


@dataclass(frozen=True)
class ClassifierPrediction:
    probabilities: dict[str, float]
    predicted_class: str
    confidence: float
    activation_maps: np.ndarray | None = None


class ClassificationEngine(Protocol):
    """Structural interface shared by the PyTorch and ONNX classification runners."""

    @property
    def resolved_parameters(self) -> ResolvedClinicalParameters: ...

    def predict(
        self,
        image: np.ndarray,
        cdr: float,
        clinical_features: dict[str, float],
    ) -> dict[str, ClassifierPrediction]: ...


class ClassificationRunner:
    def __init__(
        self,
        model_paths: dict[str, Path],
        settings: Settings,
        manifest: dict[str, Any],
    ) -> None:
        if settings.device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("PyTorch did not detect a CUDA GPU")
        self.device = torch.device(settings.device)
        self.class_names = tuple(manifest["class_names"])
        self.parameters = resolve_clinical_parameters(settings, manifest)
        self.clinical_features = self.parameters.feature_names
        self.clinical_mean = self.parameters.mean
        self.clinical_std = self.parameters.std
        self.models: dict[str, torch.nn.Module] = {}
        from ml.models.architecture import create_model, model_state_dict

        for model_type, path in model_paths.items():
            model = create_model(model_type)
            checkpoint = torch.load(
                path,
                map_location=self.device,
                weights_only=True,
            )
            model.load_state_dict(model_state_dict(checkpoint), strict=True)
            self.models[model_type] = model.to(self.device).eval()

    @property
    def resolved_parameters(self) -> ResolvedClinicalParameters:
        return self.parameters

    def _clinical_vector(self, features: dict[str, float]) -> torch.Tensor:
        normalized = normalize_clinical_features(
            features,
            self.clinical_features,
            self.clinical_mean,
            self.clinical_std,
        )
        return torch.from_numpy(normalized).unsqueeze(0).to(self.device)

    def predict(
        self,
        image: np.ndarray,
        cdr: float,
        clinical_features: dict[str, float],
    ) -> dict[str, ClassifierPrediction]:
        image_tensor = torch.from_numpy(image).unsqueeze(0).to(self.device)
        cdr_tensor = torch.tensor([[float(cdr)]], dtype=torch.float32, device=self.device)
        clinical_tensor = self._clinical_vector(clinical_features)
        predictions: dict[str, ClassifierPrediction] = {}
        with torch.inference_mode():
            for model_type, model in self.models.items():
                if model_type in ("resnet50", "efficientnet_b3"):
                    logits, maps = SpatialClassifier(model)(image_tensor, cdr_tensor, clinical_tensor)
                else:
                    logits = model(image_tensor, cdr_tensor, clinical_tensor)
                    maps = None
                probabilities = torch.softmax(logits, dim=1)[0]
                values = probabilities.detach().cpu().numpy()
                class_index = int(np.argmax(values))
                predictions[model_type] = ClassifierPrediction(
                    probabilities={
                        name: float(values[index])
                        for index, name in enumerate(self.class_names)
                    },
                    predicted_class=self.class_names[class_index],
                    confidence=float(values[class_index]),
                    activation_maps=maps[0].cpu().numpy() if maps is not None else None,
                )
        return predictions

    def explain(self, image, cdr, clinical_features, class_index):
        """Real Grad-CAM via gradient hooks on the last conv layer (gradcam.py)."""
        from ml.inference.gradcam import TARGET_LAYERS, generate_gradcam
        image_tensor = torch.from_numpy(image).unsqueeze(0).to(self.device)
        cdr_tensor = torch.tensor([[float(cdr)]], dtype=torch.float32, device=self.device)
        clinical_tensor = self._clinical_vector(clinical_features)
        cams = {}
        for model_type, model in self.models.items():
            target = TARGET_LAYERS.get(model_type) or TARGET_LAYERS.get("resnet")
            cams[model_type] = generate_gradcam(
                model, image_tensor, cdr_tensor, clinical_tensor, class_index,
                target_layer=target,
            )
        return cams
