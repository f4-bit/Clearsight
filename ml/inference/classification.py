from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch

from ml.config import Settings

CLASS_NAMES = ("Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma")


@dataclass(frozen=True)
class ClassifierPrediction:
    probabilities: dict[str, float]
    predicted_class: str
    confidence: float


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
        self.clinical_features = tuple(manifest["clinical_features"])
        self.clinical_mean = settings.clinical_mean or manifest.get("clinical_mean")
        self.clinical_std = settings.clinical_std or manifest.get("clinical_std")
        if not self.clinical_mean or not self.clinical_std:
            raise RuntimeError("clinical_mean and clinical_std are required")
        if len(self.clinical_mean) != len(self.clinical_features):
            raise RuntimeError("clinical_mean length does not match feature schema")
        if len(self.clinical_std) != len(self.clinical_features):
            raise RuntimeError("clinical_std length does not match feature schema")
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

    def _clinical_vector(self, features: dict[str, float]) -> torch.Tensor:
        values = np.asarray(
            [float(features[name]) for name in self.clinical_features],
            dtype=np.float32,
        )
        mean = np.asarray(self.clinical_mean, dtype=np.float32)
        std = np.asarray(self.clinical_std, dtype=np.float32)
        normalized = (values - mean) / (std + 1e-8)
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
                probabilities = torch.softmax(
                    model(image_tensor, cdr_tensor, clinical_tensor), dim=1
                )[0]
                values = probabilities.detach().cpu().numpy()
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
