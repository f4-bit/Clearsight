import cv2
import numpy as np

from ml.inference.postprocessing import (
    SegmentationOutput,
    clean_segmentation,
    encode_mask,
    segmentation_foreground,
    segmentation_quality,
)


def test_foreground_drops_black_border_and_keeps_center():
    image = np.zeros((512, 512, 3), dtype=np.uint8)
    image[100:400, 100:400] = 120
    foreground = segmentation_foreground(image)
    assert foreground.shape == (512, 512)
    assert foreground[250, 250]
    assert not foreground[0, 0]
    assert not foreground[-1, -1]


def test_clean_segmentation_gates_predictions_outside_valid_region():
    probabilities = np.zeros((64, 64, 3), dtype=np.float32)
    probabilities[:, :, 0] = 0.9
    probabilities[:, 56:, 2] = 0.9  # cup on the right border strip
    valid = np.zeros((64, 64), dtype=bool)
    valid[:, :56] = True
    gated = clean_segmentation(probabilities, valid_region=valid)
    assert not gated.mask.any()
    ungated = clean_segmentation(probabilities)
    assert (ungated.mask == 2).any()


def test_encode_mask_is_a_colored_readable_image():
    mask = np.zeros((64, 64), dtype=np.uint8)
    mask[10:30, 10:30] = 1
    mask[20:30, 20:30] = 2
    decoded = cv2.imdecode(np.frombuffer(encode_mask(mask), np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == (64, 64, 3)
    assert tuple(int(v) for v in decoded[12, 12]) == (0, 255, 0)  # BGR green disc
    assert tuple(int(v) for v in decoded[25, 25]) == (0, 0, 255)  # BGR red cup


def test_quality_flags_border_disc_and_degenerate_cdr():
    contour = np.array([[[0, 0]], [[30, 0]], [[30, 30]], [[0, 30]]], dtype=np.int32)
    mask = np.zeros((512, 512), dtype=np.uint8)
    mask[0:30, 0:30] = 2
    output = SegmentationOutput(mask=mask, disc_contour=contour, cup_contour=contour, probabilities=np.zeros((512, 512, 3)))
    quality = segmentation_quality(output, image_shape=(512, 512))
    assert quality["disc_touches_border"] is True
    assert quality["cdr_degenerate"] is True
    assert quality["review_required"] is True

def test_quality_flags_cup_outside_disc():
    disc = np.array([[[100, 100]], [[200, 100]], [[200, 200]], [[100, 200]]], dtype=np.int32)
    cup = np.array([[[300, 300]], [[350, 300]], [[350, 350]], [[300, 350]]], dtype=np.int32)
    mask = np.zeros((512, 512), dtype=np.uint8)
    cv2.drawContours(mask, [disc], -1, 1, thickness=cv2.FILLED)
    cv2.drawContours(mask, [cup], -1, 2, thickness=cv2.FILLED)
    output = SegmentationOutput(mask=mask, disc_contour=disc, cup_contour=cup, probabilities=np.zeros((512, 512, 3)))
    quality = segmentation_quality(output, image_shape=(512, 512))
    assert quality["cup_inside_disc"] is False
    assert quality["review_required"] is True