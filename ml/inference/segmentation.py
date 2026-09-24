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
        batch = np.expand_dims(image, axis=0)
        output = self.model.predict(batch, verbose=0)
        return np.asarray(output)
