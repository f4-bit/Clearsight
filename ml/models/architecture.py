from typing import Any

import timm
import torch
from torch import nn


class GlaucomaClassifierBase(nn.Module):
    def __init__(
        self,
        visual_dim: int,
        num_classes: int = 3,
        clinical_dim: int = 11,
        cdr_dim: int = 1,
    ) -> None:
        super().__init__()
        self.visual_dim = visual_dim
        self.clinical_dim = clinical_dim
        self.cdr_dim = cdr_dim
        self.num_classes = num_classes
        total_dim = visual_dim + clinical_dim + cdr_dim
        layers: list[nn.Module] = []
        previous_dim = total_dim
        fusion_dims = (256, 128)
        for hidden_dim in fusion_dims:
            layers.extend(
                [
                    nn.Linear(previous_dim, hidden_dim),
                    nn.LayerNorm(hidden_dim),
                    nn.GELU(),
                    nn.Dropout(0.3),
                ]
            )
            previous_dim = hidden_dim
        layers.append(nn.Linear(previous_dim, num_classes))
        self.classifier = nn.Sequential(*layers)

    def forward(
        self,
        image: torch.Tensor,
        cdr: torch.Tensor,
        clinical: torch.Tensor,
    ) -> torch.Tensor:
        visual_features = self.extract_visual_features(image)
        combined = torch.cat([visual_features, cdr, clinical], dim=1)
        return self.classifier(combined)

    def extract_visual_features(self, image: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError


class SwinGlaucomaClassifier(GlaucomaClassifierBase):
    def __init__(
        self,
        num_classes: int = 3,
        clinical_dim: int = 11,
        cdr_dim: int = 1,
        model_name: str = "swin_tiny_patch4_window7_224",
        in_channels: int = 5,
    ) -> None:
        backbone = timm.create_model(
            model_name,
            pretrained=False,
            num_classes=0,
            global_pool="avg",
        )
        super().__init__(
            visual_dim=backbone.num_features,
            num_classes=num_classes,
            clinical_dim=clinical_dim,
            cdr_dim=cdr_dim,
        )
        self.backbone = backbone
        if in_channels != 3:
            self._adapt_input_channels(in_channels)

    def _adapt_input_channels(self, in_channels: int) -> None:
        original_conv = self.backbone.patch_embed.proj
        new_conv = nn.Conv2d(
            in_channels,
            original_conv.out_channels,
            kernel_size=original_conv.kernel_size,
            stride=original_conv.stride,
            padding=original_conv.padding,
            bias=original_conv.bias is not None,
        )
        with torch.no_grad():
            new_conv.weight[:, :3] = original_conv.weight
            if in_channels > 3:
                average = original_conv.weight.mean(dim=1, keepdim=True)
                new_conv.weight[:, 3:] = average.repeat(1, in_channels - 3, 1, 1)
            if original_conv.bias is not None:
                new_conv.bias = original_conv.bias
        self.backbone.patch_embed.proj = new_conv

    def extract_visual_features(self, image: torch.Tensor) -> torch.Tensor:
        if image.shape[-1] != 224:
            image = torch.nn.functional.interpolate(
                image,
                size=(224, 224),
                mode="bilinear",
                align_corners=False,
            )
        return self.backbone(image)


class ResNetGlaucomaClassifier(GlaucomaClassifierBase):
    def __init__(
        self,
        num_classes: int = 3,
        clinical_dim: int = 11,
        cdr_dim: int = 1,
        model_name: str = "resnet50",
        in_channels: int = 5,
    ) -> None:
        backbone = timm.create_model(
            model_name,
            pretrained=False,
            num_classes=0,
            global_pool="avg",
        )
        super().__init__(
            visual_dim=backbone.num_features,
            num_classes=num_classes,
            clinical_dim=clinical_dim,
            cdr_dim=cdr_dim,
        )
        self.backbone = backbone
        if in_channels != 3:
            self._adapt_input_channels(in_channels)

    def _adapt_input_channels(self, in_channels: int) -> None:
        original_conv = self.backbone.conv1
        new_conv = nn.Conv2d(
            in_channels,
            original_conv.out_channels,
            kernel_size=original_conv.kernel_size,
            stride=original_conv.stride,
            padding=original_conv.padding,
            bias=original_conv.bias is not None,
        )
        with torch.no_grad():
            new_conv.weight[:, :3] = original_conv.weight
            if in_channels > 3:
                average = original_conv.weight.mean(dim=1, keepdim=True)
                new_conv.weight[:, 3:] = average.repeat(1, in_channels - 3, 1, 1)
            if original_conv.bias is not None:
                new_conv.bias = original_conv.bias
        self.backbone.conv1 = new_conv

    def extract_visual_features(self, image: torch.Tensor) -> torch.Tensor:
        return self.backbone(image)


class EfficientNetGlaucomaClassifier(GlaucomaClassifierBase):
    def __init__(
        self,
        num_classes: int = 3,
        clinical_dim: int = 11,
        cdr_dim: int = 1,
        model_name: str = "efficientnet_b3",
        in_channels: int = 5,
    ) -> None:
        backbone = timm.create_model(
            model_name,
            pretrained=False,
            num_classes=0,
            global_pool="avg",
        )
        super().__init__(
            visual_dim=backbone.num_features,
            num_classes=num_classes,
            clinical_dim=clinical_dim,
            cdr_dim=cdr_dim,
        )
        self.backbone = backbone
        if in_channels != 3:
            self._adapt_input_channels(in_channels)

    def _adapt_input_channels(self, in_channels: int) -> None:
        original_conv = self.backbone.conv_stem
        new_conv = nn.Conv2d(
            in_channels,
            original_conv.out_channels,
            kernel_size=original_conv.kernel_size,
            stride=original_conv.stride,
            padding=original_conv.padding,
            bias=original_conv.bias is not None,
        )
        with torch.no_grad():
            new_conv.weight[:, :3] = original_conv.weight
            if in_channels > 3:
                average = original_conv.weight.mean(dim=1, keepdim=True)
                new_conv.weight[:, 3:] = average.repeat(1, in_channels - 3, 1, 1)
            if original_conv.bias is not None:
                new_conv.bias = original_conv.bias
        self.backbone.conv_stem = new_conv

    def extract_visual_features(self, image: torch.Tensor) -> torch.Tensor:
        return self.backbone(image)


def create_model(model_type: str, num_classes: int = 3, in_channels: int = 5) -> nn.Module:
    if model_type == "resnet50":
        return ResNetGlaucomaClassifier(
            num_classes=num_classes,
            clinical_dim=11,
            in_channels=in_channels,
        )
    if model_type == "efficientnet_b3":
        return EfficientNetGlaucomaClassifier(
            num_classes=num_classes,
            clinical_dim=11,
            in_channels=in_channels,
        )
    if model_type == "swin_tiny":
        return SwinGlaucomaClassifier(
            num_classes=num_classes,
            clinical_dim=11,
            in_channels=in_channels,
        )
    raise ValueError(f"Unknown model type: {model_type}")


def model_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
        return checkpoint["model_state_dict"]
    if isinstance(checkpoint, dict):
        return checkpoint
    raise ValueError("Checkpoint does not contain a state dictionary")
