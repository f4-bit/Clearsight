from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download


@dataclass(frozen=True)
class ArtifactSpec:
    repository: str
    revision: str
    filename: str
    sha256: str

    @property
    def local_name(self) -> str:
        return f"{self.repository.replace('/', '__')}__{self.filename}"


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as manifest_file:
        return json.load(manifest_file)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for block in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_artifact(spec: ArtifactSpec, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / spec.local_name
    if destination.exists() and _sha256(destination) == spec.sha256:
        return destination
    downloaded = Path(
        hf_hub_download(
            repo_id=spec.repository,
            filename=spec.filename,
            revision=spec.revision,
            local_dir=str(cache_dir),
        )
    )
    if downloaded != destination:
        downloaded.replace(destination)
    actual = _sha256(destination)
    if actual != spec.sha256:
        destination.unlink(missing_ok=True)
        raise ValueError(
            f"Checksum mismatch for {spec.repository}/{spec.filename}: {actual}"
        )
    return destination


def artifact_spec(manifest: dict[str, Any], name: str) -> ArtifactSpec:
    entry = manifest["artifacts"][name]
    return ArtifactSpec(
        repository=entry["repository"],
        revision=entry["revision"],
        filename=entry["filename"],
        sha256=entry["sha256"],
    )
