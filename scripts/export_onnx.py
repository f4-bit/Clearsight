#!/usr/bin/env python
"""Export trained multimodal Clearsight classifiers to ONNX FP16."""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

from ml.inference.spatial_classifier import SpatialClassifier
from ml.models.architecture import create_model, model_state_dict

DEFAULT_OPSET = 17


def _load_checkpoint(checkpoint_path: Path, model_type: str, in_channels: int) -> torch.nn.Module:
    model = create_model(model_type, in_channels=in_channels)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    model.load_state_dict(model_state_dict(checkpoint), strict=True)
    return model.eval()


def _convert_to_fp16(onnx_path: Path) -> Path:
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16
    from onnxruntime.transformers.onnx_model import OnnxModel

    model = onnx.load(str(onnx_path))
    # Logits are both a public output and the input to the attribution head.
    # Keep internal consumers on the FP16 side of the output cast.
    model_fp16 = convert_float_to_float16(model, keep_io_types=True)
    OnnxModel(model_fp16).topological_sort()
    onnx.checker.check_model(model_fp16)
    onnx.save(model_fp16, str(onnx_path))
    return onnx_path


def export_to_onnx(
    model_type: str,
    checkpoint_path: Path,
    output_path: Path,
    in_channels: int = 5,
    image_size: int = 384,
    opset: int = DEFAULT_OPSET,
    fp16: bool = True,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    model = _load_checkpoint(checkpoint_path, model_type, in_channels)
    spatial = model_type in ("efficientnet_b3", "resnet50")
    outputs = ["logits", "class_activation_maps"] if spatial else ["logits"]

    image = torch.randn(1, in_channels, image_size, image_size)
    cdr = torch.zeros(1, 1, dtype=torch.float32)
    clinical = torch.zeros(1, 11, dtype=torch.float32)

    torch.onnx.export(
        SpatialClassifier(model).eval() if spatial else model,
        (image, cdr, clinical),
        str(output_path),
        input_names=["image", "cdr", "clinical"],
        output_names=outputs,
        opset_version=opset,
        dynamo=False,
        dynamic_axes={
            "image": {0: "batch"},
            "cdr": {0: "batch"},
            "clinical": {0: "batch"},
            **{name: {0: "batch"} for name in outputs},
        },
        do_constant_folding=True,
    )

    if fp16:
        _convert_to_fp16(output_path)
    return output_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a Clearsight classifier checkpoint to ONNX FP16.",
    )
    parser.add_argument(
        "--model-type",
        required=True,
        choices=["resnet50", "efficientnet_b3", "swin_tiny"],
        help="Classifier architecture to export.",
    )
    parser.add_argument(
        "--checkpoint",
        required=True,
        type=Path,
        help="Path to the PyTorch checkpoint (.pth).",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Destination ONNX file path.",
    )
    parser.add_argument("--in-channels", type=int, default=5)
    parser.add_argument("--image-size", type=int, default=384)
    parser.add_argument("--opset", type=int, default=DEFAULT_OPSET)
    parser.add_argument(
        "--fp32",
        action="store_true",
        help="Skip FP16 conversion and keep full FP32 weights.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    destination = export_to_onnx(
        model_type=args.model_type,
        checkpoint_path=args.checkpoint,
        output_path=args.output,
        in_channels=args.in_channels,
        image_size=args.image_size,
        opset=args.opset,
        fp16=not args.fp32,
    )
    print(f"Exported {args.model_type} to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
