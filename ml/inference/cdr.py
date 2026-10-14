from __future__ import annotations

import cv2
import numpy as np


def calculate_area_cdr(mask: np.ndarray) -> float | None:
    disc = np.uint8((mask == 1) | (mask == 2))
    cup = np.uint8(mask == 2)
    disc_contours, _ = cv2.findContours(
        disc, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cup_contours, _ = cv2.findContours(
        cup, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not disc_contours or not cup_contours:
        return None
    disc_contour = max(disc_contours, key=cv2.contourArea)
    cup_contour = max(cup_contours, key=cv2.contourArea)
    disc_area = float(cv2.contourArea(disc_contour))
    cup_area = float(cv2.contourArea(cup_contour))
    if disc_area <= 0:
        return None
    return float(np.clip(np.sqrt(cup_area / disc_area), 0.0, 1.0))


def calculate_vertical_cdr(mask: np.ndarray) -> float | None:
    disc = np.uint8((mask == 1) | (mask == 2))
    cup = np.uint8(mask == 2)
    disc_contours, _ = cv2.findContours(
        disc, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cup_contours, _ = cv2.findContours(
        cup, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not disc_contours or not cup_contours:
        return None
    disc_height = max(
        cv2.boundingRect(contour)[3] for contour in disc_contours
    )
    cup_height = max(cv2.boundingRect(contour)[3] for contour in cup_contours)
    if disc_height <= 0:
        return None
    return float(np.clip(cup_height / disc_height, 0.0, 1.0))
