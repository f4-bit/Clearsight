from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ml.inference.cdr import calculate_area_cdr


@dataclass(frozen=True)
class SegmentationOutput:
    mask: np.ndarray
    disc_contour: np.ndarray | None
    cup_contour: np.ndarray | None
    probabilities: np.ndarray


def _largest_contour(binary: np.ndarray) -> np.ndarray | None:
    contours, _ = cv2.findContours(
        binary,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    if not contours:
        return None
    return max(contours, key=cv2.contourArea)


def clean_segmentation(
    probabilities: np.ndarray,
    disc_threshold: float = 0.40,
    cup_threshold: float = 0.33,
) -> SegmentationOutput:
    prediction = np.asarray(probabilities)
    if prediction.ndim == 4:
        prediction = prediction[0]
    if prediction.ndim != 3 or prediction.shape[-1] < 3:
        raise ValueError(f"Unexpected segmentation output shape: {prediction.shape}")
    classes = np.zeros(prediction.shape[:2], dtype=np.uint8)
    classes[prediction[:, :, 1] > disc_threshold] = 1
    classes[prediction[:, :, 2] > cup_threshold] = 2
    disc_contour = _largest_contour(np.uint8((classes == 1) | (classes == 2)))
    cup_contour = _largest_contour(np.uint8(classes == 2))
    cleaned = np.zeros_like(classes)
    if disc_contour is not None:
        cv2.drawContours(cleaned, [disc_contour], -1, 1, thickness=cv2.FILLED)
    if cup_contour is not None:
        cv2.drawContours(cleaned, [cup_contour], -1, 2, thickness=cv2.FILLED)
    return SegmentationOutput(
        mask=cleaned,
        disc_contour=disc_contour,
        cup_contour=cup_contour,
        probabilities=prediction,
    )


def segmentation_quality(output: SegmentationOutput) -> dict[str, object]:
    cdr = calculate_area_cdr(output.mask)
    disc_area = 0.0
    if output.disc_contour is not None:
        disc_area = float(cv2.contourArea(output.disc_contour))
    cup_area = 0.0
    if output.cup_contour is not None:
        cup_area = float(cv2.contourArea(output.cup_contour))
    quality: dict[str, object] = {
        "disc_detected": output.disc_contour is not None,
        "cup_detected": output.cup_contour is not None,
        "disc_area": disc_area,
        "cup_area": cup_area,
        "cdr_is_finite": cdr is not None,
        "cdr_in_range": cdr is None or 0.0 <= cdr <= 1.0,
        "cup_area_not_larger_than_disc": cup_area <= disc_area or disc_area == 0,
    }
    quality["review_required"] = bool(
        not quality["disc_detected"]
        or not quality["cup_detected"]
        or not quality["cdr_is_finite"]
        or not quality["cdr_in_range"]
        or not quality["cup_area_not_larger_than_disc"]
    )
    return quality


def encode_mask(mask: np.ndarray) -> bytes:
    success, encoded = cv2.imencode(".png", mask)
    if not success:
        raise ValueError("The segmentation mask could not be encoded")
    return encoded.tobytes()


def create_overlay(image_bgr: np.ndarray, mask: np.ndarray) -> bytes:
    overlay = image_bgr.copy()
    disc = np.uint8((mask == 1) | (mask == 2))
    cup = np.uint8(mask == 2)
    disc_contours, _ = cv2.findContours(
        disc, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cup_contours, _ = cv2.findContours(
        cup, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cv2.drawContours(overlay, disc_contours, -1, (0, 255, 0), 2)
    cv2.drawContours(overlay, cup_contours, -1, (0, 0, 255), 2)
    success, encoded = cv2.imencode(".png", overlay)
    if not success:
        raise ValueError("The segmentation overlay could not be encoded")
    return encoded.tobytes()
