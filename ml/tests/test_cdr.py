from __future__ import annotations

import cv2
import numpy as np

from ml.inference.cdr import calculate_area_cdr, calculate_vertical_cdr


def test_area_cdr_uses_disc_union_and_cup_area() -> None:
    mask = np.zeros((200, 200), dtype=np.uint8)
    cv2.ellipse(mask, (100, 100), (80, 60), 0, 0, 360, 1, -1)
    cv2.ellipse(mask, (100, 100), (40, 30), 0, 0, 360, 2, -1)

    cdr = calculate_area_cdr(mask)
    vertical_cdr = calculate_vertical_cdr(mask)

    assert cdr is not None
    assert vertical_cdr is not None
    assert 0.45 < cdr < 0.55
    assert 0.45 < vertical_cdr < 0.55


def test_cdr_returns_none_without_cup() -> None:
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[20:80, 20:80] = 1

    assert calculate_area_cdr(mask) is None
    assert calculate_vertical_cdr(mask) is None
