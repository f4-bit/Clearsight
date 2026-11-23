"""Class logits and signed Grad-CAM contributions on the classifier's own crop."""

import math

import torch
from torch import nn


class SpatialClassifier(nn.Module):
    """Export the existing average-pooled CNN and the derivative of its fusion head."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self, image: torch.Tensor, cdr: torch.Tensor, clinical: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        spatial = self.model.backbone.forward_features(image)
        pooled = self.model.backbone.forward_head(spatial)
        value = torch.cat((pooled, cdr, clinical), dim=1)
        inputs = []
        for layer in self.model.classifier:
            inputs.append(value)
            value = layer(value)
        logits = value
        prob = logits.softmax(dim=1)
        # Each row is the derivative of one class probability with respect
        # to all logits. Carry all three through the small fusion MLP.
        identity = torch.eye(self.model.num_classes, device=prob.device, dtype=prob.dtype)
        jac = prob.unsqueeze(2) * (identity - prob.unsqueeze(1))
        for layer, value in reversed(list(zip(self.model.classifier, inputs))):
            if isinstance(layer, nn.Linear):
                jac = torch.matmul(jac, layer.weight)
            elif isinstance(layer, nn.GELU):
                slope = 0.5 * (1 + torch.erf(value / math.sqrt(2))) + (
                    value * torch.exp(-0.5 * value.square()) / math.sqrt(2 * math.pi)
                )
                jac = jac * slope.unsqueeze(1)
            elif isinstance(layer, nn.LayerNorm):
                centered = value - value.mean(dim=-1, keepdim=True)
                inv_std = torch.rsqrt(centered.square().mean(dim=-1, keepdim=True) + layer.eps)
                normalized = (centered * inv_std).unsqueeze(1)
                scaled = jac * layer.weight
                jac = inv_std.unsqueeze(1) * (
                    scaled - scaled.mean(dim=-1, keepdim=True)
                    - normalized * (normalized * scaled).mean(dim=-1, keepdim=True)
                )
            elif not isinstance(layer, nn.Dropout):
                raise ValueError("Unsupported layer in Grad-CAM fusion head")
        batch, channels, height, width = spatial.shape
        cams = torch.matmul(jac[:, :, :channels], spatial.flatten(2)) / (height * width)
        return logits, cams.reshape(batch, self.model.num_classes, height, width)
