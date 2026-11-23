"""Populate the Docker build context with the pinned PyTorch model artifacts."""

from pathlib import Path

from ml.models.registry import artifact_spec, ensure_artifact, load_manifest


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = load_manifest(root / "ml" / "models" / "manifest.json")
    cache = root / "models_cache"
    for name in ("segmentation", *manifest["ensemble"]):
        path = ensure_artifact(artifact_spec(manifest, name), cache)
        print(f"{name}: SHA-256 verified ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
