#!/usr/bin/env python
"""Benchmark PyTorch eager inference against ONNX Runtime for classifiers."""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.models.architecture import create_model, model_state_dict  # noqa: E402

MIN_ITERATIONS = 20


def _load_model(model_type: str, checkpoint_path: Path, in_channels: int) -> torch.nn.Module:
    model = create_model(model_type, in_channels=in_channels)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    model.load_state_dict(model_state_dict(checkpoint), strict=True)
    return model.eval()


def _summarize(timings: list[float]) -> dict[str, float]:
    ordered = sorted(timings)
    p95_index = max(0, int(round(0.95 * (len(ordered) - 1))))
    return {
        "mean_ms": statistics.fmean(timings) * 1000.0,
        "median_ms": statistics.median(timings) * 1000.0,
        "p95_ms": ordered[p95_index] * 1000.0,
        "min_ms": ordered[0] * 1000.0,
        "max_ms": ordered[-1] * 1000.0,
    }


def _benchmark_pytorch(
    model: torch.nn.Module,
    image: torch.Tensor,
    cdr: torch.Tensor,
    clinical: torch.Tensor,
    iterations: int,
    warmup: int,
) -> dict[str, float]:
    with torch.inference_mode():
        for _ in range(warmup):
            model(image, cdr, clinical)
        timings: list[float] = []
        for _ in range(iterations):
            start = time.perf_counter()
            model(image, cdr, clinical)
            timings.append(time.perf_counter() - start)
    return _summarize(timings)


def _benchmark_onnx(
    onnx_path: Path,
    image: np.ndarray,
    cdr: np.ndarray,
    clinical: np.ndarray,
    iterations: int,
    warmup: int,
) -> dict[str, float]:
    import onnxruntime as ort

    providers = ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in ort.get_available_providers():
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    session = ort.InferenceSession(str(onnx_path), providers=providers)
    names = [item.name for item in session.get_inputs()]
    feed = {names[0]: image, names[1]: cdr, names[2]: clinical}
    for _ in range(warmup):
        session.run(None, feed)
    timings: list[float] = []
    for _ in range(iterations):
        start = time.perf_counter()
        session.run(None, feed)
        timings.append(time.perf_counter() - start)
    return _summarize(timings)


def _print_report(name: str, metrics: dict[str, float]) -> None:
    print(
        f"{name:>10} | mean {metrics['mean_ms']:8.2f} ms | "
        f"median {metrics['median_ms']:8.2f} ms | "
        f"p95 {metrics['p95_ms']:8.2f} ms"
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare PyTorch eager and ONNX Runtime inference latency.",
    )
    parser.add_argument(
        "--model-type",
        required=True,
        choices=["resnet50", "efficientnet_b3", "swin_tiny"],
    )
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument(
        "--onnx",
        type=Path,
        default=None,
        help="Pre-exported ONNX file. Export in-memory when omitted.",
    )
    parser.add_argument("--in-channels", type=int, default=5)
    parser.add_argument("--image-size", type=int, default=384)
    parser.add_argument("--iterations", type=int, default=MIN_ITERATIONS)
    parser.add_argument("--warmup", type=int, default=5)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    iterations = max(args.iterations, MIN_ITERATIONS)
    model = _load_model(args.model_type, args.checkpoint, args.in_channels)

    image = torch.randn(1, args.in_channels, args.image_size, args.image_size)
    cdr = torch.tensor([[0.4]], dtype=torch.float32)
    clinical = torch.zeros(1, 11, dtype=torch.float32)

    pytorch_metrics = _benchmark_pytorch(
        model, image, cdr, clinical, iterations, args.warmup
    )
    _print_report("pytorch", pytorch_metrics)

    onnx_path = args.onnx
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if onnx_path is None:
        from scripts.export_onnx import export_to_onnx

        temporary = tempfile.TemporaryDirectory()
        onnx_path = Path(temporary.name) / f"{args.model_type}.fp16.onnx"
        export_to_onnx(
            model_type=args.model_type,
            checkpoint_path=args.checkpoint,
            output_path=onnx_path,
            in_channels=args.in_channels,
            image_size=args.image_size,
        )

    onnx_metrics = _benchmark_onnx(
        onnx_path,
        image.numpy(),
        cdr.numpy(),
        clinical.numpy(),
        iterations,
        args.warmup,
    )
    _print_report("onnx", onnx_metrics)

    speedup = pytorch_metrics["mean_ms"] / max(onnx_metrics["mean_ms"], 1e-9)
    print(f"ONNX mean speedup vs PyTorch eager: {speedup:.2f}x")

    if temporary is not None:
        temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
