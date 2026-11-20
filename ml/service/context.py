from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import numpy as np

from ml.inference.classification import (
    CLINICAL_EPSILON,
    ResolvedClinicalParameters,
    normalize_clinical_features,
)
from ml.inference.localization import (
    CLASSIFIER_CLAHE_CLIP_LIMIT,
    CLASSIFIER_CLAHE_TILE_GRID,
    LOCALIZATION_GAUSSIAN_KERNEL_MAX,
    SEGMENTATION_CLAHE_CLIP_LIMIT,
    SEGMENTATION_CLAHE_TILE_GRID,
)

NORMALIZATION_SCHEMA_VERSION = "ml-zscore-f32-v1"
NORMALIZATION_DTYPE = "float32"
SUPPORTED_BACKENDS = ("pytorch", "onnx")
ARTIFACT_NAMES = ("segmentation", "efficientnet_b3", "resnet50")
FLOAT32_MAX = float(np.finfo(np.float32).max)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class ClinicalContextError(RuntimeError):
    """The runtime context cannot be verified; callers must fail closed."""


class InvalidClinicalInputError(RuntimeError):
    """The request is finite but not representable by the float32 algorithm."""


class RequestedModelVersionError(ValueError):
    """The requested model version does not match the loaded runtime."""


class ContextMismatchError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("context_mismatch")


class ContextUnavailableError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("context_unavailable")


@dataclass(frozen=True)
class RuntimeContext:
    schema_version: str
    fingerprint_sha256: str
    manifest_version: str
    backend: str
    ordered_feature_names: tuple[str, ...]
    clinical_mean: tuple[float, ...]
    clinical_std: tuple[float, ...]
    dtype: str
    epsilon: float
    model_versions: Mapping[str, str]
    preprocessing: Mapping[str, Any]
    descriptor: Mapping[str, Any]
    canonical_json: str


@dataclass(frozen=True)
class PreparedClinicalSnapshot:
    raw_canonical: Mapping[str, Any]
    normalized_payload: Mapping[str, Any]
    schema_version: str
    model_versions: Mapping[str, str]
    context_fingerprint_sha256: str


def build_runtime_context(
    *,
    manifest: Mapping[str, Any],
    backend: str,
    parameters: ResolvedClinicalParameters,
    artifact_paths: Mapping[str, Path],
) -> RuntimeContext:
    """Capture an immutable descriptor from the binaries and runner parameters.

    Paths are used only to read bytes for hashing; they are never included in
    the descriptor, the fingerprint or an HTTP response.
    """

    _validate_backend(backend)
    manifest_version = _require_text(manifest, "version")
    class_names = _require_text_list(manifest, "class_names")
    ensemble = _require_numeric_mapping(manifest, "ensemble")
    feature_names, mean, std = _validate_parameters(parameters)
    artifacts, binaries = _artifact_descriptor(
        manifest,
        backend=backend,
        artifact_paths=artifact_paths,
    )
    preprocessing = _preprocessing_descriptor(manifest)
    model_versions = {
        "manifest": manifest_version,
        "backend": backend,
        **{
            name: f"{artifacts[name]['repository']}@{artifacts[name]['revision']}"
            for name in ARTIFACT_NAMES
        },
    }
    descriptor = {
        "schema_version": NORMALIZATION_SCHEMA_VERSION,
        "model": {
            "manifest_version": manifest_version,
            "backend": backend,
            "class_names": list(class_names),
            "ensemble": ensemble,
            "artifacts": artifacts,
            "binaries": binaries,
        },
        "normalization": {
            "algorithm": "zscore",
            "dtype": NORMALIZATION_DTYPE,
            "epsilon": CLINICAL_EPSILON,
            "ordered_feature_names": list(feature_names),
            "mean": [
                {"value": value, "source": parameters.mean_source}
                for value in mean
            ],
            "std": [
                {"value": value, "source": parameters.std_source}
                for value in std
            ],
        },
        "preprocessing": preprocessing,
    }
    canonical_json = _canonical_json(descriptor)
    fingerprint = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return RuntimeContext(
        schema_version=NORMALIZATION_SCHEMA_VERSION,
        fingerprint_sha256=fingerprint,
        manifest_version=manifest_version,
        backend=backend,
        ordered_feature_names=feature_names,
        clinical_mean=mean,
        clinical_std=std,
        dtype=NORMALIZATION_DTYPE,
        epsilon=CLINICAL_EPSILON,
        model_versions=_freeze(model_versions),
        preprocessing=_freeze(preprocessing),
        descriptor=_freeze(descriptor),
        canonical_json=canonical_json,
    )


def prepare_clinical_snapshot(
    context: RuntimeContext,
    clinical_features: Mapping[str, float],
    requested_model_version: str | None = None,
) -> PreparedClinicalSnapshot:
    if (
        requested_model_version is not None
        and requested_model_version != context.manifest_version
    ):
        raise RequestedModelVersionError(
            "requested_model_version does not match the loaded runtime"
        )

    feature_names = context.ordered_feature_names
    expected_names = set(feature_names)
    received_names = set(clinical_features.keys())
    if received_names != expected_names:
        raise ClinicalContextError(
            "clinical_features keys do not match the runtime feature schema"
        )

    raw_features: dict[str, float] = {}
    for name in feature_names:
        value = clinical_features[name]
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ClinicalContextError("clinical_features must contain finite numbers")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ClinicalContextError("clinical_features must contain finite numbers")
        if not _float32_is_finite(numeric):
            raise InvalidClinicalInputError()
        raw_features[name] = numeric

    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        normalized = normalize_clinical_features(
            raw_features,
            feature_names,
            context.clinical_mean,
            context.clinical_std,
        )
    values = [float(value) for value in normalized]
    if any(not math.isfinite(value) for value in values):
        raise InvalidClinicalInputError()

    return PreparedClinicalSnapshot(
        raw_canonical={"clinicalFeatures": raw_features},
        normalized_payload={
            "orderedFeatureNames": list(feature_names),
            "dtype": context.dtype,
            "values": values,
            "descriptor": _thaw(context.descriptor),
            "canonicalJson": context.canonical_json,
            "contextFingerprintSha256": context.fingerprint_sha256,
        },
        schema_version=context.schema_version,
        model_versions=context.model_versions,
        context_fingerprint_sha256=context.fingerprint_sha256,
    )


def verify_expected_context(
    context: RuntimeContext | None,
    *,
    schema_version: str,
    fingerprint_sha256: str,
) -> None:
    if context is None:
        raise ContextUnavailableError()
    if (
        schema_version != context.schema_version
        or fingerprint_sha256 != context.fingerprint_sha256
    ):
        raise ContextMismatchError()


def _float32_is_finite(value: float) -> bool:
    with np.errstate(over="ignore", invalid="ignore"):
        return bool(np.isfinite(np.float32(value)))


def _validate_backend(backend: str) -> None:
    if backend not in SUPPORTED_BACKENDS:
        raise ClinicalContextError("unsupported inference backend")


def _validate_parameters(
    parameters: ResolvedClinicalParameters,
) -> tuple[tuple[str, ...], tuple[float, ...], tuple[float, ...]]:
    names = tuple(parameters.feature_names)
    mean = tuple(float(value) for value in parameters.mean)
    std = tuple(float(value) for value in parameters.std)
    if len(names) != 11 or len(set(names)) != 11:
        raise ClinicalContextError("the runtime feature schema must have 11 unique names")
    if len(mean) != 11 or len(std) != 11:
        raise ClinicalContextError("normalization parameters must have 11 values")
    if any(not isinstance(name, str) or not name for name in names):
        raise ClinicalContextError("feature names must be non-empty strings")
    if any(not _float32_is_finite(value) for value in mean):
        raise ClinicalContextError(
            "normalization mean must be finite and representable as float32"
        )
    if any(not _float32_is_finite(value) or value <= 0 for value in std):
        raise ClinicalContextError(
            "normalization std must be finite, positive and representable as float32"
        )
    if parameters.mean_source not in {"env", "manifest"}:
        raise ClinicalContextError("unsupported normalization mean source")
    if parameters.std_source not in {"env", "manifest"}:
        raise ClinicalContextError("unsupported normalization std source")
    return names, mean, std


def _artifact_descriptor(
    manifest: Mapping[str, Any],
    *,
    backend: str,
    artifact_paths: Mapping[str, Path],
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    manifest_artifacts = manifest.get("artifacts")
    if not isinstance(manifest_artifacts, Mapping):
        raise ClinicalContextError("manifest artifacts are required")

    artifacts: dict[str, dict[str, str]] = {}
    binaries: dict[str, dict[str, str]] = {}
    for name in ARTIFACT_NAMES:
        entry = manifest_artifacts.get(name)
        if not isinstance(entry, Mapping):
            raise ClinicalContextError(f"manifest artifact {name} is required")
        repository = _require_text(entry, "repository")
        revision = _require_text(entry, "revision")
        filename = _require_text(entry, "filename")
        manifest_sha = _require_text(entry, "sha256").lower()
        if not _SHA256_PATTERN.fullmatch(manifest_sha):
            raise ClinicalContextError(f"manifest artifact {name} has an invalid sha256")

        path = artifact_paths.get(name)
        if path is None or not path.is_file():
            raise ClinicalContextError(f"artifact binary {name} is not available")
        actual_sha = _sha256_file(path)
        if (name == "segmentation" or backend == "pytorch") and actual_sha != manifest_sha:
            raise ClinicalContextError(f"artifact binary {name} does not match the manifest")

        artifacts[name] = {
            "repository": repository,
            "revision": revision,
            "filename": filename,
            "sha256": manifest_sha,
        }
        binaries[name] = {
            "filename": path.name,
            "sha256": actual_sha,
        }
    return artifacts, binaries


def _preprocessing_descriptor(manifest: Mapping[str, Any]) -> dict[str, Any]:
    segmentation = manifest.get("segmentation")
    if not isinstance(segmentation, Mapping):
        raise ClinicalContextError("manifest segmentation settings are required")

    image_size = _require_positive_int(segmentation, "image_size")
    disc_threshold = _require_finite_float(segmentation, "disc_threshold")
    cup_threshold = _require_finite_float(segmentation, "cup_threshold")
    crop_margin = _require_nonnegative_int(segmentation, "crop_margin")
    classifier_crop_size = _require_positive_int(segmentation, "classifier_crop_size")
    classifier_crop_min = _require_positive_int(segmentation, "classifier_crop_min")
    classifier_crop_max = _require_positive_int(segmentation, "classifier_crop_max")
    if classifier_crop_min > classifier_crop_max:
        raise ClinicalContextError("classifier crop minimum exceeds maximum")
    clahe_clip_limit = _optional_finite_float(
        segmentation,
        "clahe_clip_limit",
        SEGMENTATION_CLAHE_CLIP_LIMIT,
    )
    clahe_tile_grid = _optional_positive_int(
        segmentation,
        "clahe_tile_grid",
        SEGMENTATION_CLAHE_TILE_GRID,
    )
    return {
        "localization": {
            "gaussian_kernel_max": LOCALIZATION_GAUSSIAN_KERNEL_MAX,
        },
        "segmentation": {
            "image_size": image_size,
            "disc_threshold": disc_threshold,
            "cup_threshold": cup_threshold,
            "clahe_clip_limit": clahe_clip_limit,
            "clahe_tile_grid": clahe_tile_grid,
        },
        "crop": {
            "crop_margin": crop_margin,
            "classifier_crop_size": classifier_crop_size,
            "classifier_crop_min": classifier_crop_min,
            "classifier_crop_max": classifier_crop_max,
        },
        "classifier": {
            "five_channel": True,
            "clahe_clip_limit": CLASSIFIER_CLAHE_CLIP_LIMIT,
            "clahe_tile_grid": CLASSIFIER_CLAHE_TILE_GRID,
        },
    }


def _require_text_list(mapping: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = mapping.get(key)
    if not isinstance(value, list | tuple) or not value:
        raise ClinicalContextError(f"manifest field {key} must be a non-empty list")
    items = tuple(value)
    if any(not isinstance(item, str) or not item.strip() for item in items):
        raise ClinicalContextError(f"manifest field {key} must contain non-empty strings")
    return items


def _require_numeric_mapping(
    mapping: Mapping[str, Any],
    key: str,
) -> dict[str, float]:
    value = mapping.get(key)
    if not isinstance(value, Mapping) or not value:
        raise ClinicalContextError(f"manifest field {key} must be a non-empty object")
    result: dict[str, float] = {}
    for name, weight in value.items():
        if not isinstance(name, str) or not name.strip():
            raise ClinicalContextError(f"manifest field {key} has an invalid key")
        if isinstance(weight, bool) or not isinstance(weight, int | float):
            raise ClinicalContextError(f"manifest field {key} must contain finite numbers")
        numeric = float(weight)
        if not math.isfinite(numeric):
            raise ClinicalContextError(f"manifest field {key} must contain finite numbers")
        result[name] = numeric
    return result


def _require_text(mapping: Mapping[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ClinicalContextError(f"manifest field {key} must be a non-empty string")
    return value


def _require_finite_float(mapping: Mapping[str, Any], key: str) -> float:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ClinicalContextError(f"manifest field {key} must be a finite number")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ClinicalContextError(f"manifest field {key} must be a finite number")
    return numeric


def _optional_finite_float(
    mapping: Mapping[str, Any],
    key: str,
    default: float,
) -> float:
    if key not in mapping:
        return default
    return _require_finite_float(mapping, key)


def _require_positive_int(mapping: Mapping[str, Any], key: str) -> int:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ClinicalContextError(f"manifest field {key} must be a positive integer")
    return value


def _optional_positive_int(
    mapping: Mapping[str, Any],
    key: str,
    default: int,
) -> int:
    if key not in mapping:
        return default
    return _require_positive_int(mapping, key)


def _require_nonnegative_int(mapping: Mapping[str, Any], key: str) -> int:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ClinicalContextError(
            f"manifest field {key} must be a non-negative integer"
        )
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        for block in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ClinicalContextError("the runtime descriptor is not canonical JSON") from error


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, (list | tuple)):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value
