from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from scripts import test_azure_e2e as e2e

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "scripts" / "deploy_azure.ps1"
E2E_SCRIPT = ROOT / "scripts" / "test_azure_e2e.py"


def _valid_job() -> dict[str, object]:
    return {
        "status": "COMPLETED",
        "result": {
            "cdr": 0.42,
            "probabilities": {
                "Glaucoma": 0.7,
                "Non_Glaucoma": 0.2,
                "Suspicious_Glaucoma": 0.1,
            },
            "label": "Glaucoma",
            "confidence": 0.7,
            "model_predictions": {"efficientnet_b3": {"confidence": 0.7}},
            "artifacts": {"mask": "inference/mask.png", "overlay": "inference/overlay.png"},
        },
    }


def test_e2e_scripts_exist() -> None:
    assert DEPLOY_SCRIPT.is_file()
    assert E2E_SCRIPT.is_file()


def test_e2e_cli_parses_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLEARSIGHT_API_BASE_URL", raising=False)
    args = e2e.parse_args([])
    assert args.base_url == "http://localhost:8000"
    assert args.eye_side == "OD"
    assert args.allow_review is False
    assert args.timeout == pytest.approx(300.0)


def test_e2e_cli_overrides() -> None:
    args = e2e.parse_args(
        [
            "--base-url",
            "https://clearsight.example.net/",
            "--api-token",
            "secret",
            "--image-url",
            "https://acct.blob.core.windows.net/raw/retina.png",
            "--eye-side",
            "OS",
            "--allow-review",
            "--json",
        ]
    )
    assert args.base_url == "https://clearsight.example.net/"
    assert args.api_token == "secret"
    assert args.eye_side == "OS"
    assert args.allow_review is True
    assert args.as_json is True


def test_build_clinical_features_matches_manifest() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    features = e2e.build_clinical_features(manifest)
    assert set(features) == set(manifest["clinical_features"])
    assert len(features) == 11
    assert "Phakic/Pseudophakic" in features


def test_build_inference_request_shape() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    payload = e2e.build_inference_request(
        "https://acct.blob.core.windows.net/raw/retina.png",
        manifest,
        inference_id="00000000-0000-0000-0000-000000000001",
        eye_side="OD",
    )
    assert payload["inference_id"] == "00000000-0000-0000-0000-000000000001"
    assert payload["eye_side"] == "OD"
    assert payload["image_url"].startswith("https://")
    assert len(payload["clinical_features"]) == 11


def test_validate_result_accepts_valid_payload() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    assert e2e.validate_result(_valid_job(), manifest) == []


def test_validate_result_accepts_label_and_predicted_class() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)

    real_contract = _valid_job()
    assert "label" in real_contract["result"]  # type: ignore[operator]
    assert e2e.validate_result(real_contract, manifest) == []

    legacy = _valid_job()
    result = legacy["result"]
    result["predicted_class"] = result.pop("label")  # type: ignore[union-attr]
    assert e2e.validate_result(legacy, manifest) == []


def test_validate_result_flags_missing_label() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    job = _valid_job()
    del job["result"]["label"]  # type: ignore[index]
    problems = e2e.validate_result(job, manifest)
    assert any("label / predicted_class" in problem for problem in problems)


def test_validate_result_flags_bad_probabilities() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    job = _valid_job()
    job["result"]["probabilities"] = {"Glaucoma": 0.9}  # type: ignore[index]
    problems = e2e.validate_result(job, manifest)
    assert any("do not match" in problem for problem in problems)
    assert any("sum to 1.0" in problem for problem in problems)


def test_validate_result_flags_missing_result() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    problems = e2e.validate_result({"status": "COMPLETED"}, manifest)
    assert problems and "missing the inference result" in problems[0]


def test_validate_result_failed_status() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    problems = e2e.validate_result(
        {"status": "FAILED", "message": "download error"},
        manifest,
    )
    assert problems == ["Inference failed: download error"]


def test_validate_result_review_required_requires_flag() -> None:
    manifest = e2e.load_manifest(e2e.DEFAULT_MANIFEST_PATH)
    job = {"status": "REVIEW_REQUIRED", "result": {"cdr": 0.5}}
    assert e2e.validate_result(job, manifest)
    assert e2e.validate_result(job, manifest, allow_review=True) == []


def test_generate_synthetic_retinal_image_is_png() -> None:
    pytest.importorskip("cv2")
    pytest.importorskip("numpy")
    import cv2
    import numpy as np

    payload = e2e.generate_synthetic_retinal_image(size=512)
    assert payload[:8] == b"\x89PNG\r\n\x1a\n"
    decoded = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None
    assert decoded.shape[0] == 512 and decoded.shape[1] == 512


def _powershell_binary() -> str | None:
    return shutil.which("pwsh") or shutil.which("powershell")


@pytest.mark.skipif(_powershell_binary() is None, reason="PowerShell is not installed")
def test_deploy_script_has_no_syntax_errors() -> None:
    shell = _powershell_binary()
    assert shell is not None
    escaped = str(DEPLOY_SCRIPT).replace("'", "''")
    command = (
        "$errors = $null; "
        f"[System.Management.Automation.Language.Parser]::ParseFile('{escaped}', "
        "[ref]$null, [ref]$errors) | Out-Null; "
        "if ($errors.Count -gt 0) { "
        "$errors | ForEach-Object { Write-Output $_.Message }; exit 1 } "
        "exit 0"
    )
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_deploy_script_declares_required_resources() -> None:
    content = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    for token in [
        "rg-clearsight-eastus2",
        "eastus2",
        '"Standard_LRS"',
        '"Standard_B1ms"',
        '"Basic"',
        "ML_INFERENCE_BACKEND=onnx",
        "docker/init.sql",
        ".env.azure",
        "raw-retinas",
        "segmentation-masks",
        "segmentation-overlays",
        "gradcam-overlays",
        "models",
        '"postgres", "flexible-server", "execute"',
        '"containerapp", "create"',
    ]:
        assert token in content, f"Expected token '{token}' in deploy_azure.ps1"
