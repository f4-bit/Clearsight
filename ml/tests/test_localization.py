from __future__ import annotations

import numpy as np

from ml.inference.localization import (
    create_five_channel_image,
    crop_around_disc,
    find_optic_disc_center,
)


def test_optic_disc_crop_uses_brightest_region() -> None:
    image = np.zeros((700, 700, 3), dtype=np.uint8)
    image[280:420, 300:440] = 240

    center_x, center_y = find_optic_disc_center(image)
    crop, context = crop_around_disc(image, 512)

    assert abs(center_x - 370) <= 10
    assert abs(center_y - 350) <= 10
    assert crop.shape == (512, 512, 3)
    assert context.x_offset == center_x - 256
    assert context.y_offset == center_y - 256


def test_five_channel_image_shape_and_range() -> None:
    image = np.full((100, 120, 3), 127, dtype=np.uint8)

    tensor = create_five_channel_image(image)

    assert tensor.shape == (5, 100, 120)
    assert tensor.dtype == np.float32
    assert 0.0 <= float(tensor.min()) <= float(tensor.max()) <= 1.0
