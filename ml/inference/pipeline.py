from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any
from uuid import UUID

import cv2
import httpx
import numpy as np

from ml.config import Settings
from ml.inference.cdr import calculate_area_cdr, calculate_vertical_cdr
from ml.inference.classification import ClassificationEngine, ClassifierPrediction
from ml.inference.ensemble import combine_predictions
from ml.inference.localization import (
    SEGMENTATION_CLAHE_CLIP_LIMIT,
    SEGMENTATION_CLAHE_TILE_GRID,
    apply_segmentation_preprocessing,
    create_classifier_crop,
    crop_around_disc,
    decode_image,
)
from ml.inference.postprocessing import (
    clean_segmentation,
    create_overlay,
    encode_mask,
    segmentation_quality,
)
from ml.inference.segmentation import SegmentationRunner
from ml.inference.url_policy import host_is_allowed, validate_signed_image_url
from ml.service.context import RuntimeContext, verify_expected_context
from ml.service.schemas import InferenceRequest, JobStatus
from ml.service.storage import ArtifactStore

__all__ = ["InferencePipeline", "host_is_allowed"]


class InferencePipeline:
    def __init__(
        self,
        settings: Settings,
        segmentation: SegmentationRunner,
        classification: ClassificationEngine,
        artifact_store: ArtifactStore,
        manifest: dict[str, Any],
        context: RuntimeContext | None = None,
    ) -> None:
        self.settings = settings
        self.segmentation = segmentation
        self.classification = classification
        self.artifact_store = artifact_store
        self.manifest = manifest
        self.context = context

    def _download_image(self, url: str) -> bytes:
        validated = validate_signed_image_url(
            url,
            allowed_signed_url_hosts=self.settings.allowed_signed_url_hosts,
            allow_http_signed_urls=self.settings.allow_http_signed_urls,
        )
        try:
            with httpx.Client(
                follow_redirects=False,
                timeout=self.settings.request_timeout_seconds,
            ) as client:
                with client.stream("GET", validated.url) as response:
                    if response.status_code != 200:
                        raise ValueError(
                            f"Image download failed with HTTP {response.status_code}"
                        )
                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            declared_length = int(content_length)
                        except ValueError as error:
                            raise ValueError("image_download_failed") from error
                        if declared_length < 0:
                            raise ValueError("image_download_failed")
                        if declared_length > self.settings.max_image_bytes:
                            raise ValueError(
                                "The image exceeds the maximum allowed size"
                            )
                    chunks: list[bytes] = []
                    received = 0
                    for chunk in response.iter_bytes():
                        received += len(chunk)
                        if received > self.settings.max_image_bytes:
                            raise ValueError("The image exceeds the maximum allowed size")
                        chunks.append(chunk)
                    return b"".join(chunks)
        except (httpx.HTTPError, httpx.InvalidURL) as error:
            raise ValueError("image_download_failed") from error

    def _artifacts(
        self,
        inference_id: UUID,
        mask: np.ndarray,
        overlay: bytes,
    ) -> dict[str, str]:
        mask_key = f"{inference_id}/mask.png"
        overlay_key = f"{inference_id}/overlay.png"
        mask_path = self.artifact_store.upload_bytes(
            self.settings.mask_bucket,
            mask_key,
            encode_mask(mask),
            "image/png",
        )
        overlay_path = self.artifact_store.upload_bytes(
            self.settings.overlay_bucket,
            overlay_key,
            overlay,
            "image/png",
        )
        return {
            "mask": mask_path or mask_key,
            "overlay": overlay_path or overlay_key,
        }

    def _gradcam_artifacts(
        self,
        inference_id: UUID,
        classifier_input: np.ndarray,
        predictions: dict[str, ClassifierPrediction],
        class_index: int,
    ) -> dict[str, str]:
        size = (classifier_input.shape[2], classifier_input.shape[1])
        maps = []
        for name, prediction in predictions.items():
            activation = getattr(prediction, "activation_maps", None)
            if (activation is None or activation.ndim != 3 or class_index >= activation.shape[0]
                    or min(activation.shape[1:]) < 1):
                return {}  # Older or incompatible graphs may only provide usable logits.
            signed = activation[class_index].astype(np.float32)
            maps.append(self.manifest["ensemble"][name] * cv2.resize(signed, size))
        heat = np.maximum(np.sum(maps, axis=0), 0)
        if not np.isfinite(heat).all() or heat.max() <= heat.min():
            return {}
        heat = (heat - heat.min()) / (heat.max() - heat.min())
        colors = cv2.applyColorMap(np.uint8(heat * 255), cv2.COLORMAP_JET)
        rgb = np.uint8(np.rint(classifier_input[:3].transpose(1, 2, 0) * 255))
        base = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        refs = {}
        for key, pixels in (("gradcam_base", base), ("gradcam", colors)):
            ok, data = cv2.imencode(".png", pixels)
            if not ok:
                return {}
            ref = self._optional_overlay(inference_id, key, data.tobytes())
            if not ref:
                return {}
            refs[key] = ref
        return refs

    def _optional_overlay(self, inference_id: UUID, key: str, data: bytes) -> str | None:
        try:
            return self.artifact_store.upload_bytes(
                self.settings.overlay_bucket, f"{inference_id}/{key}.png", data, "image/png",
            )
        except Exception:
            # Provider SDKs raise different errors. Ancillary downloads must not
            # invalidate a classification or replace its segmentation evidence.
            logging.getLogger(__name__).warning("Optional overlay unavailable: %s", key)
            return None

    def _model_versions(self) -> dict[str, str]:
        artifacts = self.manifest["artifacts"]
        return {
            name: f"{entry['repository']}@{entry['revision']}"
            for name, entry in artifacts.items()
        }

    def _verify_pinned_context(self, request: InferenceRequest) -> None:
        expected = request.expected_context
        if expected is None:
            return
        verify_expected_context(
            self.context,
            schema_version=expected.schema_version,
            fingerprint_sha256=expected.fingerprint_sha256,
        )

    def run(
        self,
        request: InferenceRequest,
        stage_callback: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        # Verify before download; a pinned request must never run against a
        # context that differs from the one captured when the snapshot was made.
        self._verify_pinned_context(request)
        started = time.perf_counter()
        callback = stage_callback or (lambda _: None)
        callback(JobStatus.DOWNLOADING.value)
        payload = self._download_image(request.image_url)
        image = decode_image(payload, self.settings.min_image_side)
        callback(JobStatus.LOCALIZING.value)
        segmentation_settings = self.manifest["segmentation"]
        clahe_clip_limit = segmentation_settings.get(
            "clahe_clip_limit",
            SEGMENTATION_CLAHE_CLIP_LIMIT,
        )
        clahe_tile_grid = segmentation_settings.get(
            "clahe_tile_grid",
            SEGMENTATION_CLAHE_TILE_GRID,
        )
        crop, crop_context = crop_around_disc(
            image,
            segmentation_settings["image_size"],
            clahe_clip_limit=clahe_clip_limit,
            clahe_tile_grid=clahe_tile_grid,
        )
        callback(JobStatus.SEGMENTING.value)
        segmentation_input = apply_segmentation_preprocessing(
            crop,
            segmentation_settings["image_size"],
            clahe_clip_limit=clahe_clip_limit,
            clahe_tile_grid=clahe_tile_grid,
        )
        probabilities = self.segmentation.predict(segmentation_input)
        segmentation = clean_segmentation(
            probabilities,
            self.manifest["segmentation"]["disc_threshold"],
            self.manifest["segmentation"]["cup_threshold"],
        )
        quality = segmentation_quality(segmentation)
        artifacts = self._artifacts(
            request.inference_id,
            segmentation.mask,
            create_overlay(crop, segmentation.mask),
        )
        # Display the actual luminance-enhanced input used by segmentation.
        enhanced = cv2.cvtColor(segmentation_input.astype(np.uint8), cv2.COLOR_RGB2BGR)
        clahe = self._optional_overlay(
            request.inference_id, "clahe", create_overlay(enhanced, segmentation.mask),
        )
        if clahe:
            artifacts["clahe"] = clahe
        cdr = calculate_area_cdr(segmentation.mask)
        cdr_vertical = calculate_vertical_cdr(segmentation.mask)
        base_result: dict[str, Any] = {
            "inference_id": str(request.inference_id),
            "eye_side": request.eye_side,
            "label": None,
            "confidence": None,
            "probabilities": {},
            "model_predictions": {},
            "cdr": cdr,
            "cdr_vertical": cdr_vertical,
            "quality": quality,
            "artifacts": artifacts,
            "model_versions": self._model_versions(),
            "elapsed_seconds": time.perf_counter() - started,
        }
        if quality["review_required"] or cdr is None or segmentation.disc_contour is None:
            base_result["status"] = JobStatus.REVIEW_REQUIRED.value
            return base_result
        # Revalidate immediately before the model receives clinical inputs.
        self._verify_pinned_context(request)
        callback(JobStatus.CLASSIFYING.value)
        classifier_input = create_classifier_crop(
            image,
            segmentation.disc_contour,
            crop_context,
            final_size=self.manifest["segmentation"]["classifier_crop_size"],
            margin=self.manifest["segmentation"]["crop_margin"],
            minimum_size=self.manifest["segmentation"]["classifier_crop_min"],
            maximum_size=self.manifest["segmentation"]["classifier_crop_max"],
        )
        clinical = request.clinical_features.model_dump(by_alias=True)
        model_predictions = self.classification.predict(
            classifier_input,
            float(cdr),
            clinical,
        )
        class_names = tuple(self.manifest["class_names"])
        label, confidence, probabilities_result = combine_predictions(
            model_predictions,
            self.manifest["ensemble"],
            class_names,
        )
        artifacts.update(self._gradcam_artifacts(
            request.inference_id, classifier_input, model_predictions, class_names.index(label),
        ))
        base_result.update(
            {
                "label": label,
                "confidence": confidence,
                "probabilities": probabilities_result,
                "model_predictions": {
                    name: {
                        "probabilities": prediction.probabilities,
                        "predicted_class": prediction.predicted_class,
                        "confidence": prediction.confidence,
                    }
                    for name, prediction in model_predictions.items()
                },
                "status": JobStatus.COMPLETED.value,
                "elapsed_seconds": time.perf_counter() - started,
            }
        )
        return base_result
