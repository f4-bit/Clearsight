from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
ort = pytest.importorskip("onnxruntime")
torch = pytest.importorskip("torch")

from torch import nn  # noqa: E402

from ml.config import get_settings  # noqa: E402
from ml.inference.classification import normalize_clinical_features  # noqa: E402
from ml.inference.onnx_serving import OnnxClassificationRunner  # noqa: E402

CLINICAL_FEATURES = (
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
CLASS_NAMES = ("Glaucoma", "Non_Glaucoma", "Suspicious_Glaucoma")
CLINICAL_MEAN = [
    60.723785,
    0.598466,
    0.669565,
    -1.022379,
    91.245522,
    0.657289,
    13.395907,
    4.432225,
    520.534546,
    23.133957,
    -1.46757,
]
CLINICAL_STD = [
    13.271913,
    0.490209,
    2.033101,
    0.81328,
    42.873653,
    0.474616,
    7.171593,
    7.700588,
    104.636459,
    3.359584,
    4.268064,
]


class _DummyBackbone(nn.Module):
    def __init__(self, in_channels: int = 5) -> None:
        super().__init__()
        self.conv_head = nn.Conv2d(in_channels, 8, kernel_size=3, padding=1)
        self.pool = nn.AdaptiveAvgPool2d(1)

    def forward(self, image):
        return self.pool(self.conv_head(image)).flatten(1)


class _DummyClassifier(nn.Module):
    def __init__(self, in_channels: int = 5) -> None:
        super().__init__()
        self.backbone = _DummyBackbone(in_channels)
        self.classifier = nn.Linear(8 + 1 + 11, len(CLASS_NAMES))

    def forward(self, image, cdr, clinical):
        features = self.backbone(image)
        return self.classifier(torch.cat([features, cdr, clinical], dim=1))


def _manifest() -> dict:
    return {
        "class_names": list(CLASS_NAMES),
        "clinical_features": list(CLINICAL_FEATURES),
        "clinical_mean": list(CLINICAL_MEAN),
        "clinical_std": list(CLINICAL_STD),
    }


def _settings():
    return replace(
        get_settings(),
        device="cpu",
        clinical_mean=list(CLINICAL_MEAN),
        clinical_std=list(CLINICAL_STD),
    )


@pytest.fixture()
def exported(tmp_path):
    torch.manual_seed(0)
    model = _DummyClassifier().eval()
    image = torch.randn(1, 5, 32, 32)
    cdr = torch.tensor([[0.4]])
    clinical = torch.zeros(1, 11)
    onnx_path = tmp_path / "dummy.onnx"
    torch.onnx.export(
        model,
        (image, cdr, clinical),
        str(onnx_path),
        input_names=["image", "cdr", "clinical"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes={
            "image": {0: "batch"},
            "cdr": {0: "batch"},
            "clinical": {0: "batch"},
            "logits": {0: "batch"},
        },
        dynamo=False,
    )
    return onnx_path, model, image, cdr


def test_onnx_runner_matches_pytorch_probabilities(exported) -> None:
    onnx_path, model, image, cdr = exported
    runner = OnnxClassificationRunner(
        {"dummy": onnx_path},
        _settings(),
        _manifest(),
    )
    features = {name: 0.0 for name in CLINICAL_FEATURES}

    predictions = runner.predict(image.numpy()[0], float(cdr.item()), features)

    normalized = normalize_clinical_features(
        features,
        CLINICAL_FEATURES,
        CLINICAL_MEAN,
        CLINICAL_STD,
    )
    with torch.inference_mode():
        logits = model(
            image,
            cdr,
            torch.from_numpy(normalized).unsqueeze(0),
        )
        expected = torch.softmax(logits, dim=1)[0].numpy()

    prediction = predictions["dummy"]
    ordered = np.asarray([prediction.probabilities[name] for name in CLASS_NAMES])

    assert set(prediction.probabilities) == set(CLASS_NAMES)
    assert prediction.predicted_class in CLASS_NAMES
    assert ordered.sum() == pytest.approx(1.0, abs=1e-4)
    assert np.allclose(ordered, expected, atol=1e-4)


def test_onnx_runner_requires_normalization_parameters(tmp_path) -> None:
    settings = replace(
        get_settings(),
        device="cpu",
        clinical_mean=None,
        clinical_std=None,
    )
    manifest = _manifest()
    manifest.pop("clinical_mean")
    manifest.pop("clinical_std")

    with pytest.raises(RuntimeError):
        OnnxClassificationRunner({"dummy": tmp_path / "missing.onnx"}, settings, manifest)
