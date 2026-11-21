from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from scripts import test_azure_e2e as e2e

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "scripts" / "deploy_azure.ps1"
TEARDOWN_SCRIPT = ROOT / "scripts" / "teardown_azure.ps1"
E2E_SCRIPT = ROOT / "scripts" / "test_azure_e2e.py"
AZ_STUB = Path(__file__).with_name("azure_az_stub.py").resolve()

SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"
RUN_ID = "run123"
RESOURCE_GROUP = "clearsight-run123"


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
    assert TEARDOWN_SCRIPT.is_file()
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


# ---------------------------------------------------------------------------
# Offline PowerShell harness (stateful `az` stub, no Azure calls).
# ---------------------------------------------------------------------------


def _powershell_binary() -> str | None:
    return shutil.which("pwsh") or shutil.which("powershell")


requires_powershell = pytest.mark.skipif(
    _powershell_binary() is None, reason="PowerShell is not installed"
)


def _quote_ps(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _stub_environment(tmp_path: Path, scenario: dict[str, object] | None = None) -> dict[str, str]:
    scenario_path = tmp_path / "az-scenario.json"
    scenario_path.write_text(json.dumps(scenario or {}), encoding="utf-8")

    wrapper = tmp_path / "az-stub.ps1"
    wrapper.write_text(
        "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AzArgs)\n"
        f"& {_quote_ps(sys.executable)} {_quote_ps(AZ_STUB)} @AzArgs\n"
        "exit $LASTEXITCODE\n",
        encoding="utf-8-sig",
    )

    env = os.environ.copy()
    env.update(
        {
            "CLEARSIGHT_AZ_EXE": str(wrapper),
            "CLEARSIGHT_AZ_STUB_LOG": str(tmp_path / "az-calls.jsonl"),
            "CLEARSIGHT_AZ_STUB_STATE": str(tmp_path / "az-state.json"),
            "CLEARSIGHT_AZ_STUB_SCENARIO": str(scenario_path),
            "PYTHONUTF8": "1",
        }
    )
    return env


def _run_powershell(
    script: Path,
    args: list[str],
    env: dict[str, str],
    timeout: int = 180,
) -> subprocess.CompletedProcess[str]:
    shell = _powershell_binary()
    assert shell is not None
    command = [shell, "-NoProfile", "-NonInteractive"]
    if os.name == "nt":
        command += ["-ExecutionPolicy", "Bypass"]
    command += ["-File", str(script), *args]
    return subprocess.run(
        command,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _run_powershell_command(
    command: str,
    env: dict[str, str],
    timeout: int = 180,
) -> subprocess.CompletedProcess[str]:
    shell = _powershell_binary()
    assert shell is not None
    invocation = [shell, "-NoProfile", "-NonInteractive"]
    if os.name == "nt":
        invocation += ["-ExecutionPolicy", "Bypass"]
    invocation += ["-Command", command]
    return subprocess.run(
        invocation,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _read_log(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _mutation_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    verbs = {"create", "update", "delete", "build", "upload", "start"}
    return [entry for entry in entries if verbs.intersection(entry.get("args", []))]


def _deploy_args(tmp_path: Path, **overrides: str | None) -> list[str]:
    values: dict[str, str | None] = {
        "SubscriptionId": SUBSCRIPTION,
        "ResourceGroup": RESOURCE_GROUP,
        "Location": "eastus2",
        "Scope": f"rg:{RESOURCE_GROUP}",
        "BudgetUsd": "20",
        "DurationHours": "4",
        "RunId": RUN_ID,
        "Owner": "dev",
        "ImageSha": "deadbeefcafe",
        "ManifestRoot": str(tmp_path / "artifacts"),
    }
    values.update(overrides)
    args: list[str] = []
    for key, value in values.items():
        if value is None:
            continue
        args.extend([f"-{key}", str(value)])
    return args


def _manifest_path(tmp_path: Path) -> Path:
    return tmp_path / "artifacts" / RUN_ID / "manifest.json"


def _args_start(entry: dict[str, object], prefix: list[str]) -> bool:
    args = entry.get("args", [])
    return isinstance(args, list) and args[: len(prefix)] == prefix


def _tags_from_entry(entry: dict[str, object]) -> dict[str, str]:
    args = entry.get("args", [])
    assert isinstance(args, list)
    assert "--tags" in args, args
    index = args.index("--tags") + 1
    tags: dict[str, str] = {}
    while index < len(args):
        token = args[index]
        if token.startswith("-"):
            break
        if "=" in token:
            key, value = token.split("=", 1)
            tags[key] = value
        index += 1
    return tags


def _write_manifest(tmp_path: Path, manifest: dict[str, object]) -> Path:
    path = _manifest_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


TAGGED_CREATES = [
    ["group", "create"],
    ["storage", "account", "create"],
    ["acr", "create"],
    ["postgres", "flexible-server", "create"],
    ["containerapp", "env", "create"],
    ["containerapp", "job", "create"],
    ["containerapp", "create"],
]


@requires_powershell
@pytest.mark.parametrize("script", [DEPLOY_SCRIPT, TEARDOWN_SCRIPT])
def test_powershell_scripts_have_no_syntax_errors(script: Path) -> None:
    shell = _powershell_binary()
    assert shell is not None
    escaped = str(script).replace("'", "''")
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
        "clearsight-$resourceToken",
        '"Standard_LRS"',
        '"Standard_B1ms"',
        '"Basic"',
        "ML_INFERENCE_BACKEND=onnx",
        "STORAGE_PROVIDER=azure",
        "AZURE_STORAGE_ACCOUNT_URL",
        "AZURE_STORAGE_ACCOUNT_NAME",
        "AZURE_STORAGE_ACCOUNT_KEY",
        "MINIO_BUCKET_RAW",
        "MINIO_BUCKET_GRADCAM",
        "MINIO_BUCKET_MASK",
        "MINIO_BUCKET_OVERLAY",
        "MINIO_BUCKET_PDF",
        "ML_SERVICE_URL",
        "raw-retinas",
        "gradcam-overlays",
        "segmentation-masks",
        "segmentation-overlays",
        "clinical-reports",
        "models",
        "prisma:deploy",
        "admin:bootstrap",
        '"containerapp", "create"',
        '"containerapp", "job", "create"',
        "manifest.json",
        "--tags",
    ]:
        assert token in content, f"Expected token '{token}' in deploy_azure.ps1"

    for forbidden in [".env.azure", "docker/init.sql", "psycopg2", "prisma:seed"]:
        assert forbidden not in content, f"Unexpected token '{forbidden}' in deploy_azure.ps1"


def test_teardown_script_requires_manifest_and_ownership() -> None:
    content = TEARDOWN_SCRIPT.read_text(encoding="utf-8")
    for token in [
        "ManifestPath",
        "runId",
        "untagged",
        "foreign",
        "group",
        "delete",
        "--no-wait",
        "group",
        "exists",
        "include-deleted",
        "repository",
        "list",
        "publicIPAddresses",
        "pending",
    ]:
        assert token in content, f"Expected token '{token}' in teardown_azure.ps1"
    assert ".env.azure" not in content


@requires_powershell
def test_deploy_without_parameters_exits_1_before_az(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    result = _run_powershell(DEPLOY_SCRIPT, [], env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "BLOQUEO" in result.stdout
    assert _read_log(tmp_path / "az-calls.jsonl") == []


@requires_powershell
def test_deploy_plan_mode_does_not_mutate(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    result = _run_powershell(DEPLOY_SCRIPT, _deploy_args(tmp_path), env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _read_log(tmp_path / "az-calls.jsonl") == []

    manifest = json.loads(_manifest_path(tmp_path).read_text(encoding="utf-8"))
    assert manifest["mode"] == "plan"
    assert manifest["runId"] == RUN_ID
    assert manifest["tags"]["runId"] == RUN_ID
    assert manifest["tags"]["project"] == "clearsight"
    assert set(manifest["images"]) == {
        "backend",
        "migrate",
        "worker",
        "frontend",
        "ml-service",
    }


@requires_powershell
def test_deploy_apply_tags_every_create_and_records_images(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    for prefix in TAGGED_CREATES:
        matching = [entry for entry in entries if _args_start(entry, prefix)]
        assert matching, f"missing create {prefix}"

    for entry in entries:
        if any(_args_start(entry, prefix) for prefix in TAGGED_CREATES):
            tags = _tags_from_entry(entry)
            assert set(tags) == {"project", "runId", "owner", "expiresAt", "managedBy"}, entry
            assert tags["runId"] == RUN_ID
            assert tags["project"] == "clearsight"
            assert tags["owner"] == "dev"

    builds = [entry for entry in entries if _args_start(entry, ["acr", "build"])]
    assert len(builds) == 5
    built_images = {entry["args"][entry["args"].index("--image") + 1] for entry in builds}
    assert built_images == {
        "clearsight-backend:deadbeefcafe",
        "clearsight-migrate:deadbeefcafe",
        "clearsight-worker:deadbeefcafe",
        "clearsight-frontend:deadbeefcafe",
        "clearsight-ml-service:deadbeefcafe",
    }

    manifest = json.loads(_manifest_path(tmp_path).read_text(encoding="utf-8"))
    assert manifest["mode"] == "apply"
    for image in manifest["images"].values():
        assert image["digest"].startswith("sha256:"), image

    types = {resource["type"] for resource in manifest["resources"]}
    expected_types = {
        "storage",
        "acr",
        "postgres",
        "containerapp.env",
        "containerapp.job",
        "containerapp",
    }
    assert expected_types <= types
    assert any(entry for entry in entries if _args_start(entry, ["group", "delete"]))
    assert manifest["cleanup"]["status"] == "completed"


@requires_powershell
def test_deploy_manifest_and_output_do_not_contain_secrets(tmp_path: Path) -> None:
    canaries = {
        "canary_storage_key": "CANARY_STORAGE_KEY_0123456789",
        "canary_acr_password": "CANARY_ACR_PASSWORD_0123456789",
        "canary_redis_key": "CANARY_REDIS_KEY_0123456789",
    }
    env = _stub_environment(tmp_path, canaries)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    manifest_text = _manifest_path(tmp_path).read_text(encoding="utf-8")
    output = result.stdout + result.stderr
    for canary in canaries.values():
        assert canary not in manifest_text
        assert canary not in output

    lowered = manifest_text.lower()
    assert '"password"' not in lowered
    assert '"secret"' not in lowered
    assert "secretref" not in lowered


@requires_powershell
def test_deploy_gate_blocks_context_mismatch(tmp_path: Path) -> None:
    env = _stub_environment(
        tmp_path, {"subscription_id": "99999999-9999-9999-9999-999999999999"}
    )
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "GATE" in result.stdout + result.stderr
    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == []


@requires_powershell
def test_deploy_gate_blocks_unregistered_provider(tmp_path: Path) -> None:
    env = _stub_environment(
        tmp_path, {"providers": {"Microsoft.App": "NotRegistered"}}
    )
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "GATE" in result.stdout + result.stderr
    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == []


@requires_powershell
def test_deploy_gate_blocks_disabled_subscription(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path, {"state": "Disabled"})
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "GATE" in result.stdout + result.stderr
    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == []


@requires_powershell
def test_deploy_apply_failure_runs_cleanup_in_finally(tmp_path: Path) -> None:
    env = _stub_environment(
        tmp_path, {"fail_commands": ["containerapp job create"]}
    )
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    deletes = [entry for entry in entries if _args_start(entry, ["group", "delete"])]
    assert deletes, "finally cleanup did not delete the run resource group"

    manifest = json.loads(_manifest_path(tmp_path).read_text(encoding="utf-8"))
    assert manifest["cleanup"]["status"] == "completed"


@requires_powershell
def test_deploy_keep_for_debug_skips_cleanup(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload", "-KeepForDebug"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert not [entry for entry in entries if _args_start(entry, ["group", "delete"])]

    manifest = json.loads(_manifest_path(tmp_path).read_text(encoding="utf-8"))
    assert manifest["cleanup"]["status"] == "skipped-keep-for-debug"


def _teardown_manifest(tmp_path: Path, run_id: str = RUN_ID) -> dict[str, object]:
    storage_id = (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}"
        "/providers/Microsoft.Storage/storageAccounts/clearsightrun123"
    )
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "tags": {"runId": run_id},
        "resourceGroup": {
            "name": RESOURCE_GROUP,
            "id": f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}",
            "createdByRun": False,
            "tags": {"runId": run_id},
        },
        "resources": [
            {
                "type": "storage",
                "name": "clearsightrun123",
                "id": storage_id,
                "tags": {"runId": run_id},
            }
        ],
        "cleanup": {"status": "not-started", "residuals": []},
    }


@requires_powershell
@pytest.mark.parametrize(
    "live_tags",
    [{}, {"runId": "another-run"}],
    ids=["untagged", "foreign-run"],
)
def test_teardown_refuses_resources_without_run_tag(
    tmp_path: Path, live_tags: dict[str, str]
) -> None:
    manifest = _teardown_manifest(tmp_path)
    manifest_path = _write_manifest(tmp_path, manifest)
    storage_id = manifest["resources"][0]["id"]  # type: ignore[index]
    env = _stub_environment(tmp_path, {"id_tags": {storage_id: live_tags}})

    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 1, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert not [entry for entry in entries if _args_start(entry, ["storage", "account", "delete"])]

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "pending"
    assert updated["cleanup"]["pending"]


@requires_powershell
def test_teardown_deletes_owned_resources(tmp_path: Path) -> None:
    manifest = _teardown_manifest(tmp_path)
    manifest_path = _write_manifest(tmp_path, manifest)
    storage_id = manifest["resources"][0]["id"]  # type: ignore[index]
    env = _stub_environment(tmp_path, {"id_tags": {storage_id: {"runId": RUN_ID}}})

    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert [entry for entry in entries if _args_start(entry, ["storage", "account", "delete"])]

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "completed"


@requires_powershell
def test_teardown_uses_group_delete_only_for_run_created_group(tmp_path: Path) -> None:
    manifest = _teardown_manifest(tmp_path)
    manifest["resourceGroup"]["createdByRun"] = True  # type: ignore[index]
    manifest_path = _write_manifest(tmp_path, manifest)
    env = _stub_environment(
        tmp_path,
        {
            "pre_existing": [RESOURCE_GROUP],
            "existing_tags": {RESOURCE_GROUP: {"runId": RUN_ID}},
        },
    )

    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    deletes = [entry for entry in entries if _args_start(entry, ["group", "delete"])]
    assert deletes
    assert "--no-wait" in deletes[0]["args"]


def test_deploy_script_does_not_reference_env_azure_or_psycopg2() -> None:
    content = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    assert ".env.azure" not in content
    assert "EnvOutputPath" not in content
    assert "psycopg2" not in content
    assert "prisma:seed" not in content
    assert "prisma:deploy" in content
    assert "admin:bootstrap" in content


# ---------------------------------------------------------------------------
# Independent QA 8.1/8.2/8.3 gap tests (mutation-strong assertions).
# ---------------------------------------------------------------------------


def _walk_keys(obj: object) -> list[str]:
    keys: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            keys.append(str(key))
            keys.extend(_walk_keys(value))
    elif isinstance(obj, list):
        for item in obj:
            keys.extend(_walk_keys(item))
    return keys


_SECRET_NAME_RE = re.compile(
    r"password|passwd|secret|apikey|api[_-]?key|token|connection|credential", re.IGNORECASE
)


def _option_values(entry: dict[str, object], option: str) -> list[str]:
    args = entry.get("args", [])
    assert isinstance(args, list)
    if option not in args:
        return []
    index = args.index(option) + 1
    values: list[str] = []
    while index < len(args) and not str(args[index]).startswith("-"):
        values.append(str(args[index]))
        index += 1
    return values


def _entry_with_name(
    entries: list[dict[str, object]], prefix: list[str], name: str
) -> dict[str, object]:
    for entry in entries:
        if _args_start(entry, prefix) and _option_values(entry, "--name") == [name]:
            return entry
    raise AssertionError(f"no az call {prefix} for '{name}'")


def _delete_prefixes(entries: list[dict[str, object]]) -> list[list[str]]:
    prefixes: list[list[str]] = []
    for entry in entries:
        args = entry.get("args", [])
        assert isinstance(args, list)
        if "delete" in args:
            prefixes.append(args[: args.index("delete") + 1])
    return prefixes


def _mk_resource(type_: str, name: str, run_id: str = RUN_ID) -> dict[str, object]:
    suffixes = {
        "storage": f"Microsoft.Storage/storageAccounts/{name}",
        "acr": f"Microsoft.ContainerRegistry/registries/{name}",
        "postgres": f"Microsoft.DBforPostgreSQL/flexibleServers/{name}",
        "redis": f"Microsoft.Cache/Redis/{name}",
        "containerapp.env": f"Microsoft.App/managedEnvironments/{name}",
        "containerapp.job": f"Microsoft.App/jobs/{name}",
        "containerapp": f"Microsoft.App/containerApps/{name}",
    }
    resource_id = (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}"
        f"/providers/{suffixes[type_]}"
    )
    return {
        "type": type_,
        "name": name,
        "id": resource_id,
        "tags": {"runId": run_id},
    }


def _write_teardown_manifest(
    tmp_path: Path,
    resources: list[dict[str, object]],
    *,
    created_by_run: bool = False,
    run_id: str = RUN_ID,
) -> Path:
    manifest = {
        "schemaVersion": 1,
        "runId": run_id,
        "tags": {"runId": run_id},
        "resourceGroup": {
            "name": RESOURCE_GROUP,
            "id": f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}",
            "createdByRun": created_by_run,
            "tags": {"runId": run_id},
        },
        "resources": resources,
        "cleanup": {"status": "not-started", "residuals": []},
    }
    return _write_manifest(tmp_path, manifest)


@requires_powershell
def test_deploy_apply_manifest_never_exposes_secret_names_or_connection_strings(
    tmp_path: Path,
) -> None:
    canaries = {
        "canary_storage_key": "CANARY_STORAGE_KEY_QA_0123456789",
        "canary_acr_password": "CANARY_ACR_PASSWORD_QA_0123456789",
        "canary_redis_key": "CANARY_REDIS_KEY_QA_0123456789",
    }
    env = _stub_environment(tmp_path, canaries)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    manifest_text = _manifest_path(tmp_path).read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    output = result.stdout + result.stderr

    for key in _walk_keys(manifest):
        assert not _SECRET_NAME_RE.search(key), f"secret-like key in manifest: {key}"
    for forbidden in ("postgresql://", "rediss://", ".env.azure", "EnvOutputPath"):
        assert forbidden.lower() not in manifest_text.lower(), forbidden
        assert forbidden.lower() not in output.lower(), forbidden
    assert "secretref" not in manifest_text.lower()
    for canary in canaries.values():
        assert canary not in manifest_text
        assert canary not in output
    assert '"password"' not in manifest_text.lower()
    assert '"connectionstring"' not in manifest_text.lower()


@requires_powershell
@pytest.mark.parametrize(
    ("field", "value", "expected_word"),
    [
        ("BudgetUsd", "0", "presupuesto"),
        ("BudgetUsd", "-5", "presupuesto"),
        ("BudgetUsd", "abc", "presupuesto"),
        ("BudgetUsd", "NaN", "presupuesto"),
        ("BudgetUsd", "Infinity", "presupuesto"),
        ("BudgetUsd", "1e309", "presupuesto"),
        ("DurationHours", "0", "duraci"),
        ("DurationHours", "-5", "duraci"),
        ("DurationHours", "abc", "duraci"),
        ("DurationHours", "NaN", "duraci"),
        ("DurationHours", "Infinity", "duraci"),
        ("DurationHours", "1e308", "duraci"),
    ],
)
def test_deploy_gate_blocks_invalid_budget_or_duration(
    tmp_path: Path, field: str, value: str, expected_word: str
) -> None:
    env = _stub_environment(tmp_path)
    result = _run_powershell(DEPLOY_SCRIPT, _deploy_args(tmp_path, **{field: value}), env)
    assert result.returncode == 1, result.stdout + result.stderr
    output = result.stdout + result.stderr
    assert "BLOQUEO" in output, output
    assert expected_word in output, output
    assert _read_log(tmp_path / "az-calls.jsonl") == []
    assert not _manifest_path(tmp_path).exists()


@requires_powershell
@pytest.mark.parametrize(
    "missing",
    [
        "SubscriptionId",
        "ResourceGroup",
        "Location",
        "Scope",
        "BudgetUsd",
        "DurationHours",
        "RunId",
        "Owner",
    ],
)
def test_deploy_gate_blocks_each_missing_mandatory_decision(
    tmp_path: Path, missing: str
) -> None:
    env = _stub_environment(tmp_path)
    result = _run_powershell(DEPLOY_SCRIPT, _deploy_args(tmp_path, **{missing: None}), env)
    assert result.returncode == 1, result.stdout + result.stderr
    output = result.stdout + result.stderr
    assert "BLOQUEO" in output, output
    assert "faltan decisiones obligatorias" in output, output
    assert missing in output, output
    assert _read_log(tmp_path / "az-calls.jsonl") == []
    assert not _manifest_path(tmp_path).exists()


@requires_powershell
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("BudgetUsd", None),
        ("BudgetUsd", " "),
        ("BudgetUsd", "-Infinity"),
        ("DurationHours", None),
        ("DurationHours", " "),
        ("DurationHours", "-Infinity"),
    ],
    ids=[
        "BudgetUsd-missing",
        "BudgetUsd-blank",
        "BudgetUsd-negative-Infinity",
        "DurationHours-missing",
        "DurationHours-blank",
        "DurationHours-negative-Infinity",
    ],
)
def test_deploy_gate_blocks_missing_blank_or_negative_infinity(
    tmp_path: Path, field: str, value: str | None
) -> None:
    env = _stub_environment(tmp_path)
    result = _run_powershell(DEPLOY_SCRIPT, _deploy_args(tmp_path, **{field: value}), env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "BLOQUEO" in result.stdout + result.stderr
    assert _read_log(tmp_path / "az-calls.jsonl") == []
    assert not _manifest_path(tmp_path).exists()


@requires_powershell
def test_deploy_apply_with_unconfirmed_budget_creates_nothing(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path, BudgetUsd="NaN") + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "BLOQUEO" in result.stdout + result.stderr
    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == [], entries


@requires_powershell
def test_teardown_never_deletes_untagged_or_foreign_resources_listed_in_manifest(
    tmp_path: Path,
) -> None:
    storage = _mk_resource("storage", "clearsightrun123")
    redis = _mk_resource("redis", "clearsight-run123-redis")
    manifest_path = _write_teardown_manifest(
        tmp_path, [storage, redis], created_by_run=True
    )
    env = _stub_environment(
        tmp_path,
        {
            "pre_existing": [RESOURCE_GROUP],
            "existing_tags": {RESOURCE_GROUP: {"runId": "another-run"}},
            "id_tags": {
                storage["id"]: {},
                redis["id"]: {"runId": "another-run"},
            },
        },
    )
    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 1, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == [], entries
    assert not _delete_prefixes(entries)

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "pending"
    reasons = {item["reason"] for item in updated["cleanup"]["pending"]}
    assert reasons == {"group-not-owned", "untagged", "foreign-run"}, reasons


@requires_powershell
def test_teardown_deletes_resources_in_reverse_creation_order(tmp_path: Path) -> None:
    resources = [
        _mk_resource("storage", "clearsightrun123"),
        _mk_resource("acr", "clearsightrun123"),
        _mk_resource("postgres", "clearsight-run123-pg"),
        _mk_resource("redis", "clearsight-run123-redis"),
        _mk_resource("containerapp.env", "clearsight-run123-env"),
        _mk_resource("containerapp.job", "clearsight-run123-migrate"),
        _mk_resource("containerapp", "clearsight-run123-ml"),
    ]
    manifest_path = _write_teardown_manifest(tmp_path, resources)
    env = _stub_environment(
        tmp_path, {"id_tags": {resource["id"]: {"runId": RUN_ID} for resource in resources}}
    )
    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _delete_prefixes(entries) == [
        ["containerapp", "delete"],
        ["containerapp", "job", "delete"],
        ["containerapp", "env", "delete"],
        ["redis", "delete"],
        ["postgres", "flexible-server", "delete"],
        ["acr", "delete"],
        ["storage", "account", "delete"],
    ]
    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "completed"


@requires_powershell
def test_teardown_group_delete_timeout_reports_residual_and_fails(tmp_path: Path) -> None:
    storage = _mk_resource("storage", "clearsightrun123")
    manifest_path = _write_teardown_manifest(tmp_path, [storage], created_by_run=True)
    env = _stub_environment(
        tmp_path,
        {
            "pre_existing": [RESOURCE_GROUP],
            "existing_tags": {RESOURCE_GROUP: {"runId": RUN_ID}},
            "group_delete_ignored": True,
        },
    )
    result = _run_powershell(
        TEARDOWN_SCRIPT,
        ["-ManifestPath", str(manifest_path), "-TimeoutSeconds", "2", "-PollIntervalSeconds", "1"],
        env,
    )
    assert result.returncode == 1, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    group_deletes = [entry for entry in entries if _args_start(entry, ["group", "delete"])]
    assert group_deletes and "--no-wait" in group_deletes[0]["args"]

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "pending"
    residual_reasons = {item["reason"] for item in updated["cleanup"]["residuals"]}
    assert "group-still-present" in residual_reasons, residual_reasons


@requires_powershell
def test_deploy_apply_uses_run_prefix_and_runtime_env_contract(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    manifest = json.loads(_manifest_path(tmp_path).read_text(encoding="utf-8"))
    assert manifest["prefix"] == "clearsight-run123"
    assert manifest["budgetUsd"] == 20.0
    assert manifest["durationHours"] == 4.0

    created = datetime.fromisoformat(manifest["createdAt"].replace("Z", "+00:00"))
    expires = datetime.fromisoformat(manifest["expiresAt"].replace("Z", "+00:00"))
    assert expires - created == timedelta(hours=4)
    assert manifest["tags"]["expiresAt"] == manifest["expiresAt"]

    for prefix in TAGGED_CREATES:
        for entry in entries:
            if not _args_start(entry, prefix):
                continue
            name = _option_values(entry, "--name")[0]
            if prefix[0] == "group":
                assert RUN_ID in name, name
            elif prefix[0] in ("storage", "acr"):
                assert name.startswith("clearsight"), name
            else:
                assert name.startswith("clearsight-run123"), name

    backend = _entry_with_name(entries, ["containerapp", "create"], "clearsight-run123-backend")
    backend_env = _option_values(backend, "--env-vars")
    for assignment in [
        "STORAGE_PROVIDER=azure",
        "AZURE_STORAGE_ACCOUNT_URL=https://clearsightrun123.blob.core.windows.net",
        "AZURE_STORAGE_ACCOUNT_NAME=clearsightrun123",
        "AZURE_STORAGE_ACCOUNT_KEY=secretref:azure-storage-key",
        "MINIO_BUCKET_RAW=raw-retinas",
        "MINIO_BUCKET_GRADCAM=gradcam-overlays",
        "MINIO_BUCKET_MASK=segmentation-masks",
        "MINIO_BUCKET_OVERLAY=segmentation-overlays",
        "MINIO_BUCKET_PDF=clinical-reports",
        "DATABASE_URL=secretref:database-url",
    ]:
        assert assignment in backend_env, assignment
    assert any(item.startswith("ML_SERVICE_URL=https://") for item in backend_env)
    assert not any(item.startswith("REDIS_URL=") for item in backend_env)
    assert not any("redis" in item for item in _option_values(backend, "--secrets"))

    worker = _entry_with_name(entries, ["containerapp", "create"], "clearsight-run123-worker")
    worker_env = _option_values(worker, "--env-vars")
    assert not any(item.startswith("REDIS_URL=") for item in worker_env)
    assert not any("redis" in item for item in _option_values(worker, "--secrets"))

    ml_app = _entry_with_name(entries, ["containerapp", "create"], "clearsight-run123-ml")
    assert "ML_INFERENCE_BACKEND=onnx" in _option_values(ml_app, "--env-vars")

    migrate = _entry_with_name(
        entries, ["containerapp", "job", "create"], "clearsight-run123-migrate"
    )
    assert _option_values(migrate, "--image") == ["clearsight-migrate:deadbeefcafe"]
    assert "DATABASE_URL=secretref:database-url" in _option_values(migrate, "--env-vars")

    assert any(
        _args_start(entry, ["storage", "container", "create"])
        and _option_values(entry, "--name") == ["clinical-reports"]
        for entry in entries
    )
    purposes = {resource.get("purpose") for resource in manifest["resources"]}
    assert "prisma:deploy" in purposes
    assert manifest["jobs"]["migrate"] == "succeeded"


@requires_powershell
def test_deploy_backend_sets_auth_public_origin_without_secretref(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    backend_name = f"{RESOURCE_GROUP}-backend"
    updates = [
        entry
        for entry in entries
        if _args_start(entry, ["containerapp", "update"])
        and _option_values(entry, "--name") == [backend_name]
    ]
    assert updates, "backend AUTH_PUBLIC_ORIGIN update not found"

    update = updates[-1]
    env_values = _option_values(update, "--set-env-vars")
    auth_values = [
        value for value in env_values if value.startswith("AUTH_PUBLIC_ORIGIN=")
    ]
    assert len(auth_values) == 1, env_values

    auth_origin = auth_values[0].split("=", 1)[1]
    assert auth_origin.startswith(f"https://{backend_name}.")
    assert auth_origin.endswith(".azurecontainerapps.io")
    assert "secretref:" not in auth_origin

    secrets = _option_values(update, "--secrets")
    assert not any("AUTH_PUBLIC_ORIGIN" in value for value in secrets)

    manifest_text = _manifest_path(tmp_path).read_text(encoding="utf-8")
    assert "AUTH_PUBLIC_ORIGIN" not in manifest_text


@requires_powershell
def test_deploy_does_not_provision_redis(tmp_path: Path) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert not [entry for entry in entries if _args_start(entry, ["redis"])]

    containerapp_creates = [
        entry for entry in entries if _args_start(entry, ["containerapp", "create"])
    ]
    assert containerapp_creates, "expected container app creates"
    for entry in containerapp_creates:
        assert _option_values(entry, "--image") != ["redis:7-alpine"], entry
        assert _option_values(entry, "--transport") != ["tcp"], entry
    assert not any(
        _option_values(entry, "--name") == ["clearsight-run123-redis"]
        for entry in containerapp_creates
    )


@requires_powershell
def test_deploy_manifest_marks_group_created_by_run_and_teardown_deletes_it(
    tmp_path: Path,
) -> None:
    env = _stub_environment(tmp_path)
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload", "-KeepForDebug"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 0, result.stdout + result.stderr

    manifest_path = _manifest_path(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["resourceGroup"]["createdByRun"] is True

    teardown = _run_powershell(
        TEARDOWN_SCRIPT,
        [
            "-ManifestPath",
            str(manifest_path),
            "-TimeoutSeconds",
            "2",
            "-PollIntervalSeconds",
            "1",
        ],
        env,
    )
    assert teardown.returncode == 0, teardown.stdout + teardown.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    group_deletes = [entry for entry in entries if _args_start(entry, ["group", "delete"])]
    assert group_deletes, "teardown did not group-delete the run resource group"
    assert "--no-wait" in group_deletes[0]["args"]

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert updated["cleanup"]["status"] == "completed"


@requires_powershell
def test_deploy_bootstrap_job_runs_admin_bootstrap_without_seed(tmp_path: Path) -> None:
    canary = "BootstrapQaCanary1!x"
    env = _stub_environment(tmp_path)
    values = {
        "SubscriptionId": SUBSCRIPTION,
        "ResourceGroup": RESOURCE_GROUP,
        "Location": "eastus2",
        "Scope": f"rg:{RESOURCE_GROUP}",
        "BudgetUsd": "20",
        "DurationHours": "4",
        "RunId": RUN_ID,
        "Owner": "dev",
        "ImageSha": "deadbeefcafe",
        "ManifestRoot": str(tmp_path / "artifacts"),
        "BootstrapAdminEmail": "qa-bootstrap@example.test",
    }
    parts = [f"-{key} '{value}'" for key, value in values.items()]
    parts += [
        "-Apply",
        "-SkipModelUpload",
        f"-BootstrapAdminPassword (ConvertTo-SecureString '{canary}' -AsPlainText -Force)",
    ]
    command = f"& '{DEPLOY_SCRIPT}' " + " ".join(parts)
    result = _run_powershell_command(command, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    bootstrap = _entry_with_name(
        entries, ["containerapp", "job", "create"], "clearsight-run123-bootstrap"
    )
    assert _option_values(bootstrap, "--command") == ["npm", "run", "admin:bootstrap"]
    assert "seed" not in " ".join(bootstrap["args"]).lower()

    manifest_text = _manifest_path(tmp_path).read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    assert manifest["jobs"]["bootstrap"] == "succeeded"
    assert canary not in result.stdout + result.stderr
    assert canary not in manifest_text


@requires_powershell
def test_deploy_uses_workload_profiles_for_env_and_all_apps_jobs(tmp_path: Path) -> None:
    canary = "WorkloadProfileCanary1!x"
    env = _stub_environment(tmp_path)
    values = {
        "SubscriptionId": SUBSCRIPTION,
        "ResourceGroup": RESOURCE_GROUP,
        "Location": "eastus2",
        "Scope": f"rg:{RESOURCE_GROUP}",
        "BudgetUsd": "20",
        "DurationHours": "4",
        "RunId": RUN_ID,
        "Owner": "dev",
        "ImageSha": "deadbeefcafe",
        "ManifestRoot": str(tmp_path / "artifacts"),
        "BootstrapAdminEmail": "qa-workload@example.test",
    }
    parts = [f"-{key} '{value}'" for key, value in values.items()]
    parts += [
        "-Apply",
        "-SkipModelUpload",
        f"-BootstrapAdminPassword (ConvertTo-SecureString '{canary}' -AsPlainText -Force)",
    ]
    command = f"& '{DEPLOY_SCRIPT}' " + " ".join(parts)
    result = _run_powershell_command(command, env)
    assert result.returncode == 0, result.stdout + result.stderr

    entries = _read_log(tmp_path / "az-calls.jsonl")
    env_create = _entry_with_name(
        entries, ["containerapp", "env", "create"], "clearsight-run123-env"
    )
    assert "--enable-workload-profiles" in env_create["args"]

    profile_creates = [
        (["containerapp", "create"], "clearsight-run123-ml"),
        (["containerapp", "create"], "clearsight-run123-backend"),
        (["containerapp", "create"], "clearsight-run123-worker"),
        (["containerapp", "create"], "clearsight-run123-frontend"),
        (["containerapp", "job", "create"], "clearsight-run123-migrate"),
        (["containerapp", "job", "create"], "clearsight-run123-bootstrap"),
    ]
    for prefix, name in profile_creates:
        entry = _entry_with_name(entries, prefix, name)
        assert _option_values(entry, "--workload-profile-name") == ["Consumption"], name

    assert any(
        _args_start(entry, ["containerapp", "env", "show"])
        and _option_values(entry, "--query") == ["properties.workloadProfiles"]
        for entry in entries
    )


@requires_powershell
@pytest.mark.parametrize(
    "live_tags",
    [{}, {"runId": "another-run"}],
    ids=["untagged", "foreign-run"],
)
def test_deploy_refuses_preexisting_resource_group_of_another_run(
    tmp_path: Path, live_tags: dict[str, str]
) -> None:
    rg_id = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}"
    env = _stub_environment(
        tmp_path,
        {"pre_existing": [RESOURCE_GROUP], "id_tags": {rg_id: live_tags}},
    )
    args = _deploy_args(tmp_path) + ["-Apply", "-SkipModelUpload"]
    result = _run_powershell(DEPLOY_SCRIPT, args, env)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "no se reutiliza ni se borra" in result.stdout + result.stderr
    entries = _read_log(tmp_path / "az-calls.jsonl")
    assert _mutation_entries(entries) == [], entries
