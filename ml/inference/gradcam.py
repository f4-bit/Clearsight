from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np
import torch
from torch import nn

# Final convolutional feature-extraction layer keyed by architecture family or
# concrete ``timm`` model name. Production classifiers are named e.g.
# ``ResNetGlaucomaClassifier`` / ``EfficientNetGlaucomaClassifier``, so the
# family aliases (``resnet``, ``efficientnet``) are matched against the
# lower-cased class name in addition to the exact model-name keys.
TARGET_LAYERS: dict[str, str] = {
    # ResNet family (``resnet18``/``34``/``50``/``101``/``152`` → ``layer4``).
    "resnet": "backbone.layer4[-1]",
    "resnet18": "backbone.layer4[-1]",
    "resnet34": "backbone.layer4[-1]",
    "resnet50": "backbone.layer4[-1]",
    "resnet101": "backbone.layer4[-1]",
    "resnet152": "backbone.layer4[-1]",
    # EfficientNet family (all variants expose a final ``conv_head``).
    "efficientnet": "backbone.conv_head",
    "efficientnet_b0": "backbone.conv_head",
    "efficientnet_b1": "backbone.conv_head",
    "efficientnet_b2": "backbone.conv_head",
    "efficientnet_b3": "backbone.conv_head",
    "efficientnet_b4": "backbone.conv_head",
    "efficientnet_b5": "backbone.conv_head",
    "efficientnet_b6": "backbone.conv_head",
    "efficientnet_b7": "backbone.conv_head",
}

DEFAULT_COLORMAP = cv2.COLORMAP_JET


class GradCamError(RuntimeError):
    """Raised when a Grad-CAM activation map cannot be produced."""


def _as_batch(tensor: torch.Tensor, dimensions: int, name: str) -> torch.Tensor:
    if tensor.dim() == dimensions - 1:
        return tensor.unsqueeze(0)
    if tensor.dim() == dimensions:
        return tensor
    raise GradCamError(
        f"{name} must have {dimensions - 1} or {dimensions} dimensions, "
        f"got shape {tuple(tensor.shape)}"
    )


def resolve_target_layer(
    model: nn.Module,
    target_layer: str | nn.Module,
) -> nn.Module:
    if isinstance(target_layer, nn.Module):
        return target_layer
    module: object = model
    normalized = target_layer.replace("[", ".[")
    for part in normalized.split("."):
        if not part:
            continue
        if part.startswith("[") and part.endswith("]"):
            index = int(part[1:-1])
            module = module[index]  # type: ignore[index]
        else:
            if not hasattr(module, part):
                raise GradCamError(
                    f"Target layer '{target_layer}' is not present on the model"
                )
            module = getattr(module, part)
    if not isinstance(module, nn.Module):
        raise GradCamError(f"Target layer '{target_layer}' is not an nn.Module")
    return module


def default_target_layer(model: nn.Module) -> str:
    name = type(model).__name__.lower()
    for architecture, path in TARGET_LAYERS.items():
        if architecture in name:
            return path
    raise GradCamError(
        "Could not infer a default Grad-CAM target layer for "
        f"{type(model).__name__}; pass target_layer explicitly"
    )


def _normalize_heatmap(cam: np.ndarray) -> np.ndarray:
    cam = np.maximum(cam, 0.0)
    minimum = float(cam.min())
    maximum = float(cam.max())
    if maximum - minimum > 1e-12:
        cam = (cam - minimum) / (maximum - minimum)
    else:
        cam = np.zeros_like(cam)
    return cam.astype(np.float32)


def generate_gradcam(
    model: nn.Module,
    image: torch.Tensor,
    cdr: torch.Tensor | float,
    clinical: torch.Tensor,
    target_class: int,
    target_layer: str | nn.Module | None = None,
) -> np.ndarray:
    """Return a normalized [0, 1] Grad-CAM heatmap for ``target_class``."""
    layer = resolve_target_layer(
        model,
        target_layer if target_layer is not None else default_target_layer(model),
    )
    image_batch = _as_batch(image, 4, "image")
    clinical_batch = _as_batch(clinical, 2, "clinical")
    if isinstance(cdr, torch.Tensor):
        cdr_batch = _as_batch(cdr, 2, "cdr")
    else:
        cdr_batch = torch.tensor([[float(cdr)]], dtype=torch.float32)

    activations: dict[str, torch.Tensor] = {}
    gradients: dict[str, torch.Tensor] = {}

    def forward_hook(_module: nn.Module, _inputs: tuple, output: torch.Tensor) -> None:
        activations["value"] = output

    def backward_hook(
        _module: nn.Module,
        _grad_input: tuple,
        grad_output: tuple,
    ) -> None:
        gradients["value"] = grad_output[0]

    forward_handle = layer.register_forward_hook(forward_hook)
    backward_handle = layer.register_full_backward_hook(backward_hook)
    was_training = model.training
    model.eval()
    try:
        model.zero_grad(set_to_none=True)
        logits = model(image_batch, cdr_batch, clinical_batch)
        num_classes = logits.shape[1]
        if not -num_classes <= target_class < num_classes:
            raise GradCamError(
                f"target_class {target_class} is out of range for {num_classes} classes"
            )
        score = logits[0, target_class]
        score.backward()
    finally:
        forward_handle.remove()
        backward_handle.remove()
        if was_training:
            model.train()

    if "value" not in activations or "value" not in gradients:
        raise GradCamError("Grad-CAM hooks did not capture activations or gradients")

    activation = activations["value"].detach()
    gradient = gradients["value"].detach()
    weights = gradient.mean(dim=(2, 3), keepdim=True)
    cam = torch.relu((weights * activation).sum(dim=1))[0]
    cam_numpy = cam.cpu().numpy()
    heatmap = _normalize_heatmap(cam_numpy)

    height, width = int(image_batch.shape[2]), int(image_batch.shape[3])
    if heatmap.shape != (height, width):
        heatmap = cv2.resize(
            heatmap,
            (width, height),
            interpolation=cv2.INTER_LINEAR,
        )
    return np.clip(heatmap, 0.0, 1.0).astype(np.float32)


def _to_uint8_image(image: np.ndarray) -> np.ndarray:
    array = np.asarray(image)
    if array.dtype != np.uint8:
        working = array.astype(np.float32)
        if working.max() <= 1.0 + 1e-6:
            working = working * 255.0
        array = np.clip(working, 0, 255).astype(np.uint8)
    if array.ndim == 2:
        array = cv2.cvtColor(array, cv2.COLOR_GRAY2BGR)
    if array.ndim != 3 or array.shape[2] not in (3, 4):
        raise GradCamError(f"Unsupported image shape for overlay: {array.shape}")
    if array.shape[2] == 4:
        array = cv2.cvtColor(array, cv2.COLOR_BGRA2BGR)
    return np.ascontiguousarray(array)


def overlay_heatmap(
    image: np.ndarray,
    heatmap: np.ndarray,
    alpha: float = 0.5,
    colormap: int = DEFAULT_COLORMAP,
) -> bytes:
    """Blend a Grad-CAM heatmap over an image and return PNG bytes."""
    base = _to_uint8_image(image)
    height, width = base.shape[:2]
    normalized = _normalize_heatmap(np.asarray(heatmap, dtype=np.float32))
    if normalized.shape != (height, width):
        normalized = cv2.resize(
            normalized,
            (width, height),
            interpolation=cv2.INTER_LINEAR,
        )
    heatmap_uint8 = np.ascontiguousarray((normalized * 255.0).astype(np.uint8))
    color = cv2.applyColorMap(heatmap_uint8, colormap)
    clipped_alpha = float(np.clip(alpha, 0.0, 1.0))
    blended = cv2.addWeighted(color, clipped_alpha, base, 1.0 - clipped_alpha, 0.0)
    success, encoded = cv2.imencode(".png", blended)
    if not success:
        raise GradCamError("The Grad-CAM overlay could not be encoded as PNG")
    return encoded.tobytes()


def generate_gradcam_overlay(
    model: nn.Module,
    image: torch.Tensor,
    cdr: torch.Tensor | float,
    clinical: torch.Tensor,
    target_class: int,
    target_layer: str | nn.Module | None = None,
    alpha: float = 0.5,
    colormap: int = DEFAULT_COLORMAP,
) -> tuple[np.ndarray, bytes]:
    """Convenience wrapper returning ``(heatmap, png_overlay_bytes)``."""
    heatmap = generate_gradcam(
        model,
        image,
        cdr,
        clinical,
        target_class,
        target_layer,
    )
    backdrop = image.detach().cpu().numpy()
    if backdrop.ndim == 4:
        backdrop = backdrop[0]
    if backdrop.shape[0] in (1, 3) and backdrop.shape[0] < backdrop.shape[-1]:
        backdrop = np.transpose(backdrop, (1, 2, 0))
    if backdrop.shape[-1] > 3:
        backdrop = backdrop[..., :3]
    overlay = overlay_heatmap(backdrop, heatmap, alpha=alpha, colormap=colormap)
    return heatmap, overlay


class GradCamGenerator:
    """Stateful wrapper that caches the target layer for repeated calls."""

    def __init__(
        self,
        model: nn.Module,
        target_layer: str | nn.Module | Sequence[int] | None = None,
    ) -> None:
        self.model = model
        if isinstance(target_layer, Sequence) and not isinstance(target_layer, str):
            target_layer = ".".join(str(part) for part in target_layer)
        self.target_layer = target_layer or default_target_layer(model)

    def generate(
        self,
        image: torch.Tensor,
        cdr: torch.Tensor | float,
        clinical: torch.Tensor,
        target_class: int,
    ) -> np.ndarray:
        return generate_gradcam(
            self.model,
            image,
            cdr,
            clinical,
            target_class,
            self.target_layer,
        )

    def overlay(
        self,
        image: torch.Tensor,
        cdr: torch.Tensor | float,
        clinical: torch.Tensor,
        target_class: int,
        alpha: float = 0.5,
    ) -> tuple[np.ndarray, bytes]:
        return generate_gradcam_overlay(
            self.model,
            image,
            cdr,
            clinical,
            target_class,
            self.target_layer,
            alpha=alpha,
        )
