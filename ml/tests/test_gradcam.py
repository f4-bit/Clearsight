from __future__ import annotations

import numpy as np
import pytest
import torch
from torch import nn

from ml.inference.gradcam import (
    TARGET_LAYERS,
    GradCamError,
    default_target_layer,
    generate_gradcam,
    generate_gradcam_overlay,
    overlay_heatmap,
    resolve_target_layer,
)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class _DummyBackbone(nn.Module):
    def __init__(self, in_channels: int = 5) -> None:
        super().__init__()
        self.conv_head = nn.Conv2d(in_channels, 8, kernel_size=3, padding=1)
        self.layer4 = nn.Sequential(
            nn.Conv2d(8, 8, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(8, 8, kernel_size=3, padding=1),
        )
        self.pool = nn.AdaptiveAvgPool2d(1)

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        features = self.conv_head(image)
        features = self.layer4(features)
        return self.pool(features).flatten(1)


class _DummyClassifier(nn.Module):
    def __init__(self, in_channels: int = 5) -> None:
        super().__init__()
        self.backbone = _DummyBackbone(in_channels)
        self.classifier = nn.Linear(8 + 1 + 11, 3)

    def forward(
        self,
        image: torch.Tensor,
        cdr: torch.Tensor,
        clinical: torch.Tensor,
    ) -> torch.Tensor:
        features = self.backbone(image)
        return self.classifier(torch.cat([features, cdr, clinical], dim=1))


@pytest.fixture()
def dummy_inputs() -> tuple[_DummyClassifier, torch.Tensor, torch.Tensor, torch.Tensor]:
    torch.manual_seed(0)
    model = _DummyClassifier().eval()
    image = torch.randn(1, 5, 32, 32)
    cdr = torch.tensor([[0.4]])
    clinical = torch.randn(1, 11)
    return model, image, cdr, clinical


def test_resolve_target_layer_supports_indexing() -> None:
    model = _DummyClassifier()

    layer = resolve_target_layer(model, "backbone.layer4[-1]")

    assert layer is model.backbone.layer4[-1]


def test_generate_gradcam_returns_normalized_heatmap(dummy_inputs) -> None:
    model, image, cdr, clinical = dummy_inputs

    heatmap = generate_gradcam(
        model,
        image,
        cdr,
        clinical,
        target_class=1,
        target_layer="backbone.layer4[-1]",
    )

    assert heatmap.shape == (32, 32)
    assert heatmap.dtype == np.float32
    assert 0.0 <= float(heatmap.min())
    assert float(heatmap.max()) <= 1.0
    assert float(heatmap.max()) > 0.0


def test_generate_gradcam_rejects_out_of_range_class(dummy_inputs) -> None:
    model, image, cdr, clinical = dummy_inputs

    with pytest.raises(GradCamError):
        generate_gradcam(
            model,
            image,
            cdr,
            clinical,
            target_class=9,
            target_layer="backbone.layer4[-1]",
        )


def test_overlay_heatmap_encodes_png_bytes(dummy_inputs) -> None:
    model, image, cdr, clinical = dummy_inputs
    heatmap = generate_gradcam(
        model,
        image,
        cdr,
        clinical,
        target_class=2,
        target_layer="backbone.layer4[-1]",
    )
    backdrop = np.random.default_rng(0).integers(
        0, 255, size=(32, 32, 3), dtype=np.uint8
    )

    payload = overlay_heatmap(backdrop, heatmap)

    assert payload.startswith(PNG_MAGIC)
    assert len(payload) > len(PNG_MAGIC)


def test_generate_gradcam_overlay_returns_pair(dummy_inputs) -> None:
    model, image, cdr, clinical = dummy_inputs

    heatmap, payload = generate_gradcam_overlay(
        model,
        image,
        cdr,
        clinical,
        target_class=0,
        target_layer="backbone.conv_head",
    )

    assert heatmap.shape == (32, 32)
    assert payload.startswith(PNG_MAGIC)


@pytest.fixture(scope="module")
def production_models() -> dict[str, nn.Module]:
    from ml.models.architecture import (
        EfficientNetGlaucomaClassifier,
        ResNetGlaucomaClassifier,
    )

    torch.manual_seed(0)
    return {
        "resnet50": ResNetGlaucomaClassifier(
            num_classes=3,
            clinical_dim=11,
            in_channels=3,
        ).eval(),
        "efficientnet_b3": EfficientNetGlaucomaClassifier(
            num_classes=3,
            clinical_dim=11,
            in_channels=3,
        ).eval(),
    }


def test_default_target_layer_resolves_production_architectures(
    production_models: dict[str, nn.Module],
) -> None:
    assert (
        default_target_layer(production_models["resnet50"])
        == "backbone.layer4[-1]"
    )
    assert (
        default_target_layer(production_models["efficientnet_b3"])
        == "backbone.conv_head"
    )


@pytest.mark.parametrize(
    ("architecture", "expected"),
    [
        ("resnet", "backbone.layer4[-1]"),
        ("resnet18", "backbone.layer4[-1]"),
        ("resnet50", "backbone.layer4[-1]"),
        ("resnet101", "backbone.layer4[-1]"),
        ("efficientnet", "backbone.conv_head"),
        ("efficientnet_b0", "backbone.conv_head"),
        ("efficientnet_b3", "backbone.conv_head"),
        ("efficientnet_b7", "backbone.conv_head"),
    ],
)
def test_default_target_layer_supports_architecture_name_keys(
    architecture: str, expected: str
) -> None:
    assert TARGET_LAYERS[architecture] == expected

    model_cls = type(architecture, (nn.Module,), {})
    assert default_target_layer(model_cls()) == expected


def test_generate_gradcam_and_overlay_on_real_models(
    production_models: dict[str, nn.Module],
) -> None:
    torch.manual_seed(0)
    image = torch.randn(1, 3, 64, 64)
    cdr = torch.tensor([[0.4]])
    clinical = torch.randn(1, 11)

    for model in production_models.values():
        heatmap, payload = generate_gradcam_overlay(
            model,
            image,
            cdr,
            clinical,
            target_class=1,
        )

        assert heatmap.shape == (64, 64)
        assert heatmap.dtype == np.float32
        assert 0.0 <= float(heatmap.min())
        assert float(heatmap.max()) <= 1.0
        assert payload.startswith(PNG_MAGIC)
