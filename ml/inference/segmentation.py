from __future__ import annotations

import os
from pathlib import Path

import numpy as np


class SegmentationRunner:
    def __init__(self, model_path: Path, device: str) -> None:
        os.environ.setdefault("SM_FRAMEWORK", "tf.keras")
        import tensorflow as tf

        self.device = device
        if device.startswith("cuda"):
            gpus = tf.config.list_physical_devices("GPU")
            if not gpus:
                raise RuntimeError("TensorFlow did not detect a CUDA GPU")
            for gpu in gpus:
                tf.config.experimental.set_memory_growth(gpu, True)
        self.model = tf.keras.models.load_model(str(model_path), compile=False)

    def predict(self, image: np.ndarray) -> np.ndarray:
        array = np.asarray(image, dtype=np.float32)
        # The FPN was trained on [0, 1] inputs (see ML.md); feeding [0, 255] made
        # it label background/cup and never the optic disc.
        if array.size and float(array.max()) > 1.5:
            array = array / 255.0
        batch = np.expand_dims(array, axis=0)
        output = self.model.predict(batch, verbose=0)
        return np.asarray(output)
