from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class CropContext:
    x_offset: int
    y_offset: int


def decode_image(payload: bytes, minimum_side: int) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("The image could not be decoded")
    height, width = image.shape[:2]
    if min(height, width) < minimum_side:
        raise ValueError(
            f"The image is too small: {width}x{height}, minimum side is {minimum_side}"
        )
    return image


def find_optic_disc_center(image: np.ndarray) -> tuple[int, int]:
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    luminance = lab[:, :, 0]
    shortest_side = min(image.shape[:2])
    kernel_size = min(151, shortest_side)
    if kernel_size % 2 == 0:
        kernel_size -= 1
    kernel_size = max(kernel_size, 3)
    blurred = cv2.GaussianBlur(luminance, (kernel_size, kernel_size), 0)
    _, _, _, location = cv2.minMaxLoc(blurred)
    return int(location[0]), int(location[1])


def crop_around_disc(image: np.ndarray, crop_size: int = 512) -> tuple[np.ndarray, CropContext]:
    height, width = image.shape[:2]
    center_x, center_y = find_optic_disc_center(image)
    half_crop = crop_size // 2
    x1 = center_x - half_crop
    y1 = center_y - half_crop
    x2 = center_x + half_crop
    y2 = center_y + half_crop
    pad_left = max(0, -x1)
    pad_top = max(0, -y1)
    pad_right = max(0, x2 - width)
    pad_bottom = max(0, y2 - height)
    if pad_left or pad_top or pad_right or pad_bottom:
        padded = cv2.copyMakeBorder(
            image,
            pad_top,
            pad_bottom,
            pad_left,
            pad_right,
            cv2.BORDER_CONSTANT,
            value=[0, 0, 0],
        )
    else:
        padded = image
    x1_padded = x1 + pad_left
    y1_padded = y1 + pad_top
    x2_padded = x2 + pad_left
    y2_padded = y2 + pad_top
    cropped = padded[y1_padded:y2_padded, x1_padded:x2_padded]
    if cropped.shape[0] != crop_size or cropped.shape[1] != crop_size:
        raise ValueError("The optic disc crop has an unexpected shape")
    lab = cv2.cvtColor(cropped, cv2.COLOR_BGR2LAB)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    cropped = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    return cropped, CropContext(x_offset=x1, y_offset=y1)


def apply_segmentation_preprocessing(image: np.ndarray, image_size: int = 512) -> np.ndarray:
    resized = cv2.resize(image, (image_size, image_size))
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    return enhanced.astype(np.float32)


def _enhance_channel(channel: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(channel)


def create_five_channel_image(image_bgr: np.ndarray) -> np.ndarray:
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    red, green, blue = cv2.split(image_rgb)
    red_enhanced = _enhance_channel(red)
    green_enhanced = _enhance_channel(green)
    return np.stack(
        [red, green, blue, red_enhanced, green_enhanced], axis=0
    ).astype(np.float32) / 255.0


def create_classifier_crop(
    original_image: np.ndarray,
    disc_points: np.ndarray,
    context: CropContext,
    final_size: int = 384,
    margin: int = 100,
    minimum_size: int = 600,
    maximum_size: int = 1000,
) -> np.ndarray:
    if disc_points is None or len(disc_points) < 3:
        raise ValueError("A disc contour is required for the classifier crop")
    points = np.asarray(disc_points, dtype=np.float32)
    points[:, 0] += context.x_offset
    points[:, 1] += context.y_offset
    x_min, x_max = points[:, 0].min(), points[:, 0].max()
    y_min, y_max = points[:, 1].min(), points[:, 1].max()
    center_x = (x_min + x_max) / 2
    center_y = (y_min + y_max) / 2
    disc_size = max(float(x_max - x_min), float(y_max - y_min))
    crop_size = int(np.clip(disc_size + 2 * margin, minimum_size, maximum_size))
    x1 = max(0, int(center_x - crop_size / 2))
    y1 = max(0, int(center_y - crop_size / 2))
    x2 = min(original_image.shape[1], int(center_x + crop_size / 2))
    y2 = min(original_image.shape[0], int(center_y + crop_size / 2))
    cropped = original_image[y1:y2, x1:x2]
    if cropped.size == 0:
        raise ValueError("The classifier crop is empty")
    resized = cv2.resize(
        cropped,
        (final_size, final_size),
        interpolation=cv2.INTER_AREA,
    )
    return create_five_channel_image(resized)
