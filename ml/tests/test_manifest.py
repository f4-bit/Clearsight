from __future__ import annotations

from pathlib import Path

from ml.models.registry import load_manifest


def test_manifest_contains_three_production_artifacts() -> None:
    manifest = load_manifest(Path("ml/models/manifest.json"))

    assert manifest["version"]
    assert set(manifest["artifacts"]) == {
        "segmentation",
        "efficientnet_b3",
        "resnet50",
    }
    assert len(manifest["clinical_features"]) == 11
    assert manifest["segmentation"]["disc_threshold"] == 0.4
    assert manifest["segmentation"]["cup_threshold"] == 0.33
