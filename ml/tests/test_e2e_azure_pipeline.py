"""Contract tests for ``scripts/e2e_azure_pipeline.ps1`` (task 7.4).

The PowerShell driver is executed against a stateful local HTTP stub. No Azure
resource, ``az`` command, Docker daemon, real backend, real store or real ML
service is involved. The stub records the exact request sequence so the test can
assert the clinical flow, the durable Idempotency-Key, the negative-auth check,
the signed-URL downloads and the safe failure behaviour.

The driver itself never writes secrets to disk; the test asserts the same by
checking the generated ``summary.json`` and the captured stdout/stderr for
password, token and signed-URL canaries.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "e2e_azure_pipeline.ps1"

ADMIN_EMAIL = "azure-admin@clearsight.test"
DOCTOR_EMAIL = "azure-doctor@clearsight.test"
ADMIN_PASSWORD = "AzureAdminPass123!"
DOCTOR_PASSWORD = "AzureDoctorPass456!"
ADMIN_TOKEN = "ADMIN_ACCESS_TOKEN_CANARY_0123456789"
DOCTOR_TOKEN = "DOCTOR_ACCESS_TOKEN_CANARY_0123456789"
SIGNED_URL_CANARY = "CANARY_SIGNED_URL_SAS_0123456789"

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class PipelineStub:
    """Stateful HTTP stub for the Azure E2E driver (loopback only)."""

    def __init__(self, scenario: dict[str, object] | None = None) -> None:
        self.scenario: dict[str, object] = dict(scenario or {})
        self.requests: list[dict[str, object]] = []
        self.lock = threading.Lock()
        self.poll_counts: dict[str, int] = {}
        self.ids: dict[str, str] = {}
        self.feedback: dict[str, object] | None = None
        stub = self

        class Handler(BaseHTTPRequestHandler):
            # One request per connection avoids PowerShell's abrupt keep-alive
            # reset producing noisy server-side tracebacks.
            protocol_version = "HTTP/1.0"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

            def do_GET(self) -> None:  # noqa: N802 - stdlib naming
                stub.handle(self, "GET")

            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                stub.handle(self, "POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> PipelineStub:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    # -- transport ---------------------------------------------------------
    def handle(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        parsed = urlsplit(handler.path)
        length = int(handler.headers.get("Content-Length") or 0)
        body = handler.rfile.read(length) if length else b""
        with self.lock:
            self.requests.append(
                {
                    "method": method,
                    "path": parsed.path,
                    "query": parsed.query,
                    "headers": {
                        key.lower(): value for key, value in handler.headers.items()
                    },
                    "body": body,
                }
            )
        self.dispatch(handler, method, parsed.path, parsed.query, body)

    def dispatch(
        self,
        handler: BaseHTTPRequestHandler,
        method: str,
        path: str,
        query: str,
        body: bytes,
    ) -> None:
        if path == "/auth/login" and method == "POST":
            self.login(handler, body)
            return
        if path == "/admin/users" and method == "POST":
            self.require_admin(handler)
            self.ids["doctor"] = str(uuid.uuid4())
            self.json(handler, 201, {"id": self.ids["doctor"]})
            return
        if path == "/patients" and method == "POST":
            self.require_doctor(handler)
            self.ids["patient"] = str(uuid.uuid4())
            self.json(handler, 201, {"id": self.ids["patient"]})
            return
        if path == "/consultations" and method == "POST":
            self.require_doctor(handler)
            self.ids["consultation"] = str(uuid.uuid4())
            self.json(handler, 201, {"id": self.ids["consultation"]})
            return
        if path.startswith("/consultations/") and path.endswith("/required-executions") and method == "POST":
            self.require_doctor(handler)
            assert json.loads(body)["executionIds"] == [self.ids["inference"]]
            self.json(handler, 200, {"id": self.ids["consultation"]})
            return
        if path.startswith("/consultations/") and path.endswith("/images") and method == "POST":
            self.require_doctor(handler)
            self.ids["image"] = str(uuid.uuid4())
            self.json(
                handler,
                201,
                {
                    "id": self.ids["image"],
                    "eyeSide": "OD",
                    "storagePath": "raw-retinas/2026/11/image.jpg",
                    "hashMd5": "0" * 32,
                },
            )
            return
        if path == "/inferences" and method == "POST":
            self.require_doctor(handler)
            if self.scenario.get("fail_create_inference"):
                self.json(
                    handler,
                    500,
                    {"error": "InternalServerError", "message": "boom", "statusCode": 500},
                )
                return
            self.ids["inference"] = str(uuid.uuid4())
            self.json(
                handler,
                202,
                {
                    "inferenceId": self.ids["inference"],
                    "jobId": self.ids["inference"],
                    "status": "QUEUED",
                },
            )
            return
        if path.startswith("/inferences/") and method == "GET":
            self.inference_route(handler, path)
            return
        if path == "/feedback" and method == "POST":
            self.feedback_route(handler, body)
            return
        if path == "/export/gold-standard" and method == "GET":
            self.export_route(handler)
            return
        if path.startswith("/download/") and method == "GET":
            self.download_route(handler, path.rsplit("/", 1)[-1])
            return
        self.json(handler, 404, {"error": "NotFound", "message": "not found", "statusCode": 404})

    # -- handlers ----------------------------------------------------------
    def login(self, handler: BaseHTTPRequestHandler, body: bytes) -> None:
        payload = json.loads(body or b"{}")
        email = str(payload.get("email", ""))
        token = ADMIN_TOKEN if email == ADMIN_EMAIL else DOCTOR_TOKEN
        if email not in (ADMIN_EMAIL, DOCTOR_EMAIL):
            self.json(
                handler,
                401,
                {"error": "Unauthorized", "message": "Invalid credentials", "statusCode": 401},
            )
            return
        self.json(
            handler,
            200,
            {
                "accessToken": token,
                "tokenType": "bearer",
                "expiresIn": "15m",
                "user": {
                    "id": str(uuid.uuid4()),
                    "email": email,
                    "role": "ADMIN" if email == ADMIN_EMAIL else "OFTALMOLOGO",
                },
            },
        )

    def inference_route(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        parts = [part for part in path.split("/") if part]
        if len(parts) == 2:
            self.inference_status(handler, parts[1])
            return
        if len(parts) == 3 and parts[2] == "artifacts":
            self.artifacts_route(handler)
            return
        if len(parts) == 3 and parts[2] == "reports":
            self.reports_route(handler, parts[1])
            return
        if len(parts) == 5 and parts[2] == "artifacts" and parts[4] == "url":
            self.artifact_url_route(handler, parts[1], parts[3])
            return
        if len(parts) == 5 and parts[2] == "reports" and parts[4] == "url":
            self.report_url_route(handler, parts[1], parts[3])
            return
        self.json(handler, 404, {"error": "NotFound", "message": "not found", "statusCode": 404})

    def inference_status(self, handler: BaseHTTPRequestHandler, inference_id: str) -> None:
        authorization = handler.headers.get("Authorization")
        if authorization is None:
            status = int(self.scenario.get("negative_auth_status", 401))
            self.json(
                handler,
                status,
                {"error": "Unauthorized", "message": "missing bearer", "statusCode": status},
            )
            return
        if authorization != f"Bearer {DOCTOR_TOKEN}":
            self.json(
                handler,
                401,
                {"error": "Unauthorized", "message": "bad session", "statusCode": 401},
            )
            return

        count = self.poll_counts.get(inference_id, 0) + 1
        self.poll_counts[inference_id] = count
        status = str(self.scenario.get("inference_status", "COMPLETED"))

        if status == "FAILED":
            self.json(
                handler,
                200,
                {
                    "id": inference_id,
                    "status": "FAILED",
                    "delivery": {
                        "resultStatus": "FAILED",
                        "evidenceStatus": "FAILED",
                        "pdfStatus": "FAILED",
                        "complete": False,
                        "reviewRequired": False,
                        "failed": True,
                        "deliveryTerminal": True,
                    },
                    "pollingStop": "FAILED",
                },
            )
            return

        if count == 1 and not self.scenario.get("skip_queued"):
            self.json(
                handler,
                200,
                {
                    "id": inference_id,
                    "status": "QUEUED",
                    "predictedClass": None,
                    "confidence": None,
                    "delivery": {
                        "resultStatus": "PENDING",
                        "evidenceStatus": "PENDING",
                        "pdfStatus": "PENDING",
                        "complete": False,
                        "reviewRequired": False,
                        "failed": False,
                        "deliveryTerminal": False,
                    },
                    "pollingStop": "CONTINUE",
                },
                headers={"Retry-After": str(self.scenario.get("retry_after", "0"))},
            )
            return

        if status == "REVIEW_REQUIRED":
            delivery = {
                "resultStatus": "AVAILABLE",
                "evidenceStatus": "AVAILABLE",
                "pdfStatus": "AVAILABLE",
                "complete": False,
                "reviewRequired": True,
                "failed": False,
                "deliveryTerminal": True,
            }
            polling_stop = "ACTION_REQUIRED"
        else:
            delivery = {
                "resultStatus": "AVAILABLE",
                "evidenceStatus": "AVAILABLE",
                "pdfStatus": "AVAILABLE",
                "complete": True,
                "reviewRequired": False,
                "failed": False,
                "deliveryTerminal": True,
            }
            polling_stop = "COMPLETE"

        self.json(
            handler,
            200,
            {
                "id": inference_id,
                "status": status,
                "predictedClass": 2,
                "confidence": 0.87,
                "probabilities": {
                    "Glaucoma": 0.1,
                    "Non_Glaucoma": 0.03,
                    "Suspicious_Glaucoma": 0.87,
                },
                "delivery": delivery,
                "pollingStop": polling_stop,
            },
        )

    def artifacts_route(self, handler: BaseHTTPRequestHandler) -> None:
        if not self.require_doctor(handler):
            return
        status = int(self.scenario.get("artifacts_status", 200))
        if status != 200:
            self.json(
                handler,
                status,
                {"error": "service_unavailable", "message": "store", "statusCode": status},
            )
            return
        statuses = self.scenario.get("artifact_statuses") or {
            "mask": "AVAILABLE",
            "overlay": "AVAILABLE",
            "pdf": "AVAILABLE",
        }
        labels = dict(statuses)
        items = []
        for artifact_type, artifact_status in labels.items():
            items.append(
                {
                    "artifactId": str(uuid.uuid4()),
                    "version": 1,
                    "reference": {
                        "artifactType": artifact_type,
                        "status": artifact_status,
                        "storageId": "azure-blob-default",
                        "bucketOrContainer": "clinical-reports"
                        if artifact_type == "pdf"
                        else "segmentation-masks",
                        "key": f"case/{artifact_type}",
                        "contentType": "application/pdf"
                        if artifact_type == "pdf"
                        else "image/png",
                        "sizeBytes": 128,
                        "checksumSha256": "a" * 64
                        if artifact_status == "AVAILABLE"
                        else None,
                        "failureCode": "STORE_MISSING"
                        if artifact_status == "FAILED"
                        else None,
                        "retryable": False,
                        "updatedAt": "2026-11-21T00:00:00.000Z",
                    },
                }
            )
        self.json(
            handler,
            200,
            {"items": items, "total": len(items), "limit": 20, "offset": 0},
        )

    def reports_route(self, handler: BaseHTTPRequestHandler, inference_id: str) -> None:
        if not self.require_doctor(handler):
            return
        status = int(self.scenario.get("reports_status", 200))
        if status != 200:
            self.json(
                handler,
                status,
                {"error": "service_unavailable", "message": "store", "statusCode": status},
            )
            return
        report_status = str(self.scenario.get("report_status", "AVAILABLE"))
        if report_status == "MISSING":
            self.json(handler, 200, [])
            return
        self.json(
            handler,
            200,
            [
                {
                    "reportId": str(uuid.uuid4()),
                    "inferenceId": inference_id,
                    "version": 1,
                    "status": report_status,
                    "immutable": report_status == "AVAILABLE",
                    "createdAt": "2026-11-21T00:00:00.000Z",
                    "availableAt": "2026-11-21T00:00:01.000Z"
                    if report_status == "AVAILABLE"
                    else None,
                    "failureCode": "RENDER_FAILED"
                    if report_status == "FAILED"
                    else None,
                }
            ],
        )

    def artifact_url_route(
        self,
        handler: BaseHTTPRequestHandler,
        inference_id: str,
        artifact_type: str,
    ) -> None:
        if not self.require_doctor(handler):
            return
        url = f"{self.base_url}/download/{artifact_type}?sig={SIGNED_URL_CANARY}"
        content_type = "application/pdf" if artifact_type == "pdf" else "image/png"
        self.json(
            handler,
            200,
            {
                "artifactType": artifact_type,
                "status": "AVAILABLE",
                "url": url,
                "expiresInSeconds": 3600,
                "contentType": content_type,
                "reportVersion": None,
            },
        )

    def report_url_route(
        self,
        handler: BaseHTTPRequestHandler,
        inference_id: str,
        version: str,
    ) -> None:
        if not self.require_doctor(handler):
            return
        url = f"{self.base_url}/download/pdf?sig={SIGNED_URL_CANARY}"
        self.json(
            handler,
            200,
            {
                "artifactType": "pdf",
                "status": "AVAILABLE",
                "url": url,
                "expiresInSeconds": 3600,
                "contentType": "application/pdf",
                "reportVersion": int(version),
            },
        )

    def feedback_route(self, handler: BaseHTTPRequestHandler, body: bytes) -> None:
        if not self.require_doctor(handler):
            return
        payload = json.loads(body or b"{}")
        self.feedback = payload
        validated = payload.get("validated_class")
        self.json(
            handler,
            200,
            {
                "id": str(uuid.uuid4()),
                "consultation_id": payload["consultation_id"],
                "inference_id": payload["inference_id"],
                "doctor_id": str(uuid.uuid4()),
                "validated_class": validated,
                "predicted_class": validated,
                "confidence": 0.87,
                "agreement": True,
                "doctor_notes": payload.get("doctor_notes"),
                "is_gold_standard": bool(payload.get("is_gold_standard", False)),
                "created_at": "2026-11-21T00:00:00.000Z",
                "updated_at": "2026-11-21T00:00:00.000Z",
            },
        )

    def export_route(self, handler: BaseHTTPRequestHandler) -> None:
        if not self.require_admin(handler):
            return
        status = int(self.scenario.get("export_status", 403))
        if status == 200:
            self.json(
                handler,
                200,
                {
                    "count": 1,
                    "has_more": False,
                    "generated_at": "2026-11-21T00:00:00.000Z",
                    "items": [{"inference_id": self.ids.get("inference", "")}],
                },
            )
            return
        self.json(
            handler,
            status,
            {"error": "Forbidden", "message": "Forbidden", "statusCode": status},
        )

    def download_route(self, handler: BaseHTTPRequestHandler, kind: str) -> None:
        if kind == "mask" or kind == "overlay":
            payload = self.scenario.get("png_payload") or (
                b"\x89PNG\r\n\x1a\n" + b"0" * 32
            )
            self.raw(handler, 200, bytes(payload), "image/png")
            return
        if kind == "pdf":
            payload = self.scenario.get("pdf_payload") or b"%PDF-1.7\n%clearsight\n"
            self.raw(handler, 200, bytes(payload), "application/pdf")
            return
        self.json(handler, 404, {"error": "NotFound", "message": "not found", "statusCode": 404})

    # -- helpers -----------------------------------------------------------
    def require_doctor(self, handler: BaseHTTPRequestHandler) -> bool:
        if handler.headers.get("Authorization") == f"Bearer {DOCTOR_TOKEN}":
            return True
        self.json(
            handler,
            401,
            {"error": "Unauthorized", "message": "bad session", "statusCode": 401},
        )
        return False

    def require_admin(self, handler: BaseHTTPRequestHandler) -> bool:
        if handler.headers.get("Authorization") == f"Bearer {ADMIN_TOKEN}":
            return True
        self.json(
            handler,
            401,
            {"error": "Unauthorized", "message": "bad session", "statusCode": 401},
        )
        return False

    def json(
        self,
        handler: BaseHTTPRequestHandler,
        status: int,
        payload: object,
        headers: dict[str, str] | None = None,
    ) -> None:
        data = json.dumps(payload).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(data)

    def raw(
        self,
        handler: BaseHTTPRequestHandler,
        status: int,
        payload: bytes,
        content_type: str,
    ) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)


# ---------------------------------------------------------------------------
# subprocess helpers
# ---------------------------------------------------------------------------
def _powershell_binary() -> str | None:
    return shutil.which("pwsh") or shutil.which("powershell")


requires_powershell = pytest.mark.skipif(
    _powershell_binary() is None, reason="PowerShell is not installed"
)


def _ps_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _run_command(command: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    shell = _powershell_binary()
    assert shell is not None
    invocation = [shell, "-NoProfile", "-NonInteractive"]
    if os.name == "nt":
        invocation += ["-ExecutionPolicy", "Bypass"]
    # A script invoked with `&` sets $LASTEXITCODE; the host must forward it so
    # the Python test observes the driver's safe exit code (not PowerShell's 1).
    invocation += ["-Command", f"{command}; exit $LASTEXITCODE"]
    return subprocess.run(
        invocation,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _run_script(
    base_url: str,
    out_dir: Path,
    *,
    admin_password: str = ADMIN_PASSWORD,
    doctor_password: str = DOCTOR_PASSWORD,
    image_path: Path | None = None,
    timeout_seconds: int = 15,
    existing_doctor: bool = False,
) -> subprocess.CompletedProcess[str]:
    parts = [
        f"& {_ps_quote(SCRIPT)}",
        "-BackendBaseUrl",
        _ps_quote(base_url),
        "-DoctorEmail",
        _ps_quote(DOCTOR_EMAIL),
        "-DoctorPassword",
        f"(ConvertTo-SecureString {_ps_quote(doctor_password)} -AsPlainText -Force)",
        "-OutDir",
        _ps_quote(out_dir),
        "-TimeoutSeconds",
        str(timeout_seconds),
        "-PollIntervalSeconds",
        "0",
        "-RequestTimeoutSeconds",
        "15",
    ]
    if existing_doctor:
        parts.append("-ExistingDoctor")
    else:
        parts.extend([
            "-AdminEmail", _ps_quote(ADMIN_EMAIL),
            "-AdminPassword",
            f"(ConvertTo-SecureString {_ps_quote(admin_password)} -AsPlainText -Force)",
        ])
    if image_path is not None:
        parts.extend(["-ImagePath", _ps_quote(image_path)])
    return _run_command(" ".join(parts))


def _summary(out_dir: Path) -> dict[str, object]:
    return json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))


def _combined(result: subprocess.CompletedProcess[str]) -> str:
    return result.stdout + result.stderr


def _first_index(
    stub: PipelineStub,
    method: str,
    path_prefix: str,
    *,
    start: int = 0,
) -> int:
    for index, request in enumerate(stub.requests):
        if index < start:
            continue
        if request["method"] == method and str(request["path"]).startswith(path_prefix):
            return index
    raise AssertionError(f"missing request {method} {path_prefix}")


def _json_body(request: dict[str, object]) -> dict[str, object]:
    body = request["body"]
    if not isinstance(body, bytes) or not body:
        return {}
    return json.loads(body.decode("utf-8"))


def _headers(request: dict[str, object]) -> dict[str, str]:
    headers = request["headers"]
    assert isinstance(headers, dict)
    return {str(key): str(value) for key, value in headers.items()}


# ---------------------------------------------------------------------------
# static contract
# ---------------------------------------------------------------------------
def test_script_exists() -> None:
    assert SCRIPT.is_file()


@requires_powershell
def test_script_parses_without_errors() -> None:
    shell = _powershell_binary()
    assert shell is not None
    escaped = str(SCRIPT).replace("'", "''")
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


def test_script_declares_the_pipeline_contract() -> None:
    content = SCRIPT.read_text(encoding="utf-8")
    for token in [
        "[securestring]$AdminPassword",
        "[securestring]$DoctorPassword",
        "[string]$BackendBaseUrl",
        "[string]$OutDir",
        "[string]$ImagePath",
        "/auth/login",
        "/admin/users",
        "/patients",
        "/consultations",
        "/images",
        "/inferences",
        "Idempotency-Key",
        "Retry-After",
        "/artifacts",
        "/reports",
        "/artifacts/mask/url",
        "/artifacts/overlay/url",
        "/reports/$reportVersion/url",
        "/feedback",
        "/export/gold-standard",
        "New-MultipartBody",
        "Assert-PngMagic",
        "Assert-PdfMagic",
        "summary.json",
        "BLOQUEO",
    ]:
        assert token in content, f"missing token {token!r}"

    for forbidden in [
        "Invoke-AzCli",
        "Invoke-Cleanup",
        ".env.azure",
        "docker ",
        "Set-Content",
        "Out-File",
    ]:
        assert forbidden not in content, f"forbidden token {forbidden!r}"
    assert "teardown_azure.ps1 -ManifestPath" not in content

    assert "[System.IO.File]::WriteAllText" in content
    assert content.count("WriteAllText") == 1


# ---------------------------------------------------------------------------
# full flow
# ---------------------------------------------------------------------------
@requires_powershell
def test_full_flow_against_http_stub(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub() as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 0, _combined(result)

        # 1. Negative auth is the first request and carries no Bearer.
        first = stub.requests[0]
        assert first["method"] == "GET"
        assert str(first["path"]).startswith("/inferences/")
        assert "authorization" not in _headers(first)

        admin_login = _first_index(stub, "POST", "/auth/login")
        create_doctor = _first_index(stub, "POST", "/admin/users")
        doctor_login = _first_index(stub, "POST", "/auth/login", start=admin_login + 1)
        patient = _first_index(stub, "POST", "/patients")
        consultation = _first_index(stub, "POST", "/consultations")
        upload = _first_index(
            stub,
            "POST",
            f"/consultations/{stub.ids['consultation']}/images",
        )
        inference = _first_index(stub, "POST", "/inferences")
        artifacts = _first_index(
            stub,
            "GET",
            f"/inferences/{stub.ids['inference']}/artifacts",
        )
        reports = _first_index(
            stub,
            "GET",
            f"/inferences/{stub.ids['inference']}/reports",
        )
        mask_url = _first_index(
            stub,
            "GET",
            f"/inferences/{stub.ids['inference']}/artifacts/mask/url",
        )
        overlay_url = _first_index(
            stub,
            "GET",
            f"/inferences/{stub.ids['inference']}/artifacts/overlay/url",
        )
        report_url = _first_index(
            stub,
            "GET",
            f"/inferences/{stub.ids['inference']}/reports/1/url",
        )
        receive_mask = _first_index(stub, "GET", "/download/mask")
        receive_overlay = _first_index(stub, "GET", "/download/overlay")
        receive_pdf = _first_index(stub, "GET", "/download/pdf")
        feedback = _first_index(stub, "POST", "/feedback")
        export = _first_index(stub, "GET", "/export/gold-standard")

        assert (
            admin_login
            < create_doctor
            < doctor_login
            < patient
            < consultation
            < upload
            < inference
            < artifacts
            < reports
            < mask_url
            < overlay_url
            < report_url
            < receive_mask
            < receive_overlay
            < receive_pdf
            < feedback
            < export
        )

        # 2. Credential endpoints use the configured origin.
        login_request = stub.requests[admin_login]
        assert _headers(login_request)["origin"] == stub.base_url
        assert _json_body(login_request)["email"] == ADMIN_EMAIL
        assert _json_body(login_request)["password"] == ADMIN_PASSWORD

        # 3. The administrator provisions an ophthalmologist.
        doctor_request = stub.requests[create_doctor]
        assert _headers(doctor_request)["authorization"] == f"Bearer {ADMIN_TOKEN}"
        doctor_body = _json_body(doctor_request)
        assert doctor_body["role"] == "OFTALMOLOGO"
        assert doctor_body["email"] == DOCTOR_EMAIL
        assert doctor_body["password"] == DOCTOR_PASSWORD
        assert str(doctor_body["fullName"]).strip()

        # 4. Clinical resources are linked by the IDs returned by the stub.
        assert _headers(stub.requests[doctor_login])["origin"] == stub.base_url
        assert _json_body(stub.requests[doctor_login])["email"] == DOCTOR_EMAIL
        assert _json_body(stub.requests[patient])["externalCode"]
        assert _json_body(stub.requests[consultation])["patientId"] == stub.ids["patient"]
        upload_request = stub.requests[upload]
        assert _headers(upload_request)["authorization"] == f"Bearer {DOCTOR_TOKEN}"
        upload_body = upload_request["body"]
        assert isinstance(upload_body, bytes)
        assert b'name="eyeSide"' in upload_body
        assert b"OD" in upload_body
        assert b'name="file"' in upload_body

        # 5. Inference contract: durable Idempotency-Key, 11 finite features.
        inference_request = stub.requests[inference]
        headers = _headers(inference_request)
        assert headers["authorization"] == f"Bearer {DOCTOR_TOKEN}"
        assert UUID_RE.match(headers["idempotency-key"])
        inference_body = _json_body(inference_request)
        assert inference_body["imageId"] == stub.ids["image"]
        assert inference_body["eyeSide"] == "OD"
        assert inference_body["modelVersion"] is None
        features = inference_body["clinicalFeatures"]
        assert isinstance(features, dict)
        assert len(features) == 11
        assert all(
            isinstance(value, int | float) and math.isfinite(float(value))
            for value in features.values()
        )

        # 6. Polling happened more than once (QUEUED then terminal).
        polls = [
            request
            for request in stub.requests
            if request["method"] == "GET"
            and request["path"] == f"/inferences/{stub.ids['inference']}"
        ]
        assert len(polls) >= 2
        assert all(
            _headers(request)["authorization"] == f"Bearer {DOCTOR_TOKEN}"
            for request in polls
        )

        # 7. Artifact/report URLs use an explicit version and are signed.
        for index in (mask_url, overlay_url):
            request = stub.requests[index]
            query = parse_qs(str(request["query"]))
            assert query.get("version") == ["1"]
        for index in (receive_mask, receive_overlay, receive_pdf):
            request = stub.requests[index]
            assert SIGNED_URL_CANARY in str(request["query"])

        # 8. Feedback follows the downloaded evidence.
        assert stub.feedback is not None
        assert stub.feedback["consultation_id"] == stub.ids["consultation"]
        assert stub.feedback["inference_id"] == stub.ids["inference"]
        assert stub.feedback["validated_class"] == 2
        assert stub.feedback["is_gold_standard"] is True

        # 9. Summary and logs never expose credentials, tokens or signed URLs.
        summary = _summary(out_dir)
        assert summary["result"] == "PASSED"
        assert summary["exitCode"] == 0
        assert summary["ids"]["patientId"] == stub.ids["patient"]
        assert summary["ids"]["consultationId"] == stub.ids["consultation"]
        assert summary["ids"]["imageId"] == stub.ids["image"]
        assert summary["ids"]["inferenceId"] == stub.ids["inference"]
        assert summary["checks"]["negativeAuth401"] is True
        assert summary["checks"]["terminalStatus"] == "COMPLETED"
        assert summary["checks"]["deliveryComplete"] is True
        assert summary["checks"]["exportStatus"] == "SKIPPED_NO_GRANT"
        assert summary["artifacts"]["mask"] == "AVAILABLE"
        assert summary["artifacts"]["overlay"] == "AVAILABLE"
        assert summary["artifacts"]["pdf"] == "AVAILABLE"
        assert [step["name"] for step in summary["steps"]][:3] == [
            "negative-auth",
            "login-admin",
            "create-doctor",
        ]

        summary_text = json.dumps(summary)
        output = _combined(result)
        for secret in (
            ADMIN_PASSWORD,
            DOCTOR_PASSWORD,
            ADMIN_TOKEN,
            DOCTOR_TOKEN,
        ):
            assert secret not in summary_text
            assert secret not in output
        assert SIGNED_URL_CANARY not in summary_text
        assert SIGNED_URL_CANARY not in output
        assert "sig=" not in summary_text
        assert "Bearer " not in summary_text
        assert "Bearer " not in output


@requires_powershell
def test_existing_doctor_does_not_provision_an_account_or_write_feedback(tmp_path: Path) -> None:
    with PipelineStub() as stub:
        result = _run_script(stub.base_url, tmp_path, existing_doctor=True)
        assert result.returncode == 0, _combined(result)
        paths = [request["path"] for request in stub.requests]
        assert paths.count("/auth/login") == 1
        assert "/admin/users" not in paths
        assert "/feedback" not in paths
        assert "/export/gold-standard" not in paths
        assert paths.count(f"/consultations/{stub.ids['consultation']}/required-executions") == 1
        assert _summary(tmp_path)["checks"]["deliveryComplete"] is True


@requires_powershell
def test_review_required_is_accepted_and_verified(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"inference_status": "REVIEW_REQUIRED"}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 0, _combined(result)
        assert stub.feedback is not None
        assert stub.feedback["validated_class"] == 2
    summary = _summary(out_dir)
    assert summary["result"] == "PASSED"
    assert summary["checks"]["terminalStatus"] == "REVIEW_REQUIRED"
    assert summary["checks"]["deliveryComplete"] is False
    assert summary["artifacts"]["mask"] == "AVAILABLE"
    assert summary["artifacts"]["overlay"] == "AVAILABLE"
    assert summary["artifacts"]["pdf"] == "AVAILABLE"


# ---------------------------------------------------------------------------
# failure behaviour
# ---------------------------------------------------------------------------
@requires_powershell
def test_terminal_failed_inference_fails_explicitly(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"inference_status": "FAILED"}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 4, _combined(result)
        assert stub.feedback is None
        assert not [
            request
            for request in stub.requests
            if str(request["path"]).startswith("/download/")
        ]
    summary = _summary(out_dir)
    assert summary["error"]["step"] == "poll-inference"
    assert "FAILED" in summary["error"]["message"]


@requires_powershell
def test_negative_auth_must_return_401(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"negative_auth_status": 200}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 2, _combined(result)
        assert not [
            request for request in stub.requests if request["path"] == "/auth/login"
        ]
    summary = _summary(out_dir)
    assert summary["result"] == "FAILED"
    assert summary["error"]["step"] == "negative-auth"
    assert "401" in summary["error"]["message"]


@requires_powershell
def test_inference_http_failure_stops_before_polling(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"fail_create_inference": True}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 3, _combined(result)
        assert stub.feedback is None
        assert not [
            request
            for request in stub.requests
            if request["method"] == "GET"
            and str(request["path"]).startswith("/inferences/")
            and "authorization" in _headers(request)
        ]
    summary = _summary(out_dir)
    assert summary["result"] == "FAILED"
    assert summary["error"]["step"] == "create-inference"
    assert "500" in summary["error"]["message"]
    assert "Bearer " not in _combined(result)


@requires_powershell
def test_missing_artifact_fails_explicitly(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    scenario = {
        "artifact_statuses": {
            "mask": "FAILED",
            "overlay": "AVAILABLE",
            "pdf": "AVAILABLE",
        }
    }
    with PipelineStub(scenario) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 4, _combined(result)
        assert not [
            request
            for request in stub.requests
            if str(request["path"]).startswith("/download/")
        ]
    summary = _summary(out_dir)
    assert summary["error"]["step"] == "artifacts"
    assert "mask" in summary["error"]["message"]
    assert "AVAILABLE" in summary["error"]["message"]


@requires_powershell
def test_missing_store_fails_explicitly(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"artifacts_status": 503}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 4, _combined(result)
    summary = _summary(out_dir)
    assert summary["error"]["step"] == "artifacts"
    assert "unavailable" in summary["error"]["message"]


@requires_powershell
def test_missing_pdf_report_fails_explicitly(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"report_status": "FAILED"}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 4, _combined(result)
        assert not [
            request
            for request in stub.requests
            if request["path"].endswith("/url")
        ]
    summary = _summary(out_dir)
    assert summary["error"]["step"] == "reports"
    assert "PDF" in summary["error"]["message"]


@requires_powershell
def test_pdf_content_is_validated(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with PipelineStub({"pdf_payload": b"THIS-IS-NOT-A-PDF"}) as stub:
        result = _run_script(stub.base_url, out_dir)
        assert result.returncode == 4, _combined(result)
    summary = _summary(out_dir)
    assert summary["error"]["step"] == "downloads"
    assert "not a PDF" in summary["error"]["message"]


@requires_powershell
def test_missing_parameters_exit_before_http(tmp_path: Path) -> None:
    with PipelineStub() as stub:
        command = (
            f"& {_ps_quote(SCRIPT)} "
            f"-BackendBaseUrl {_ps_quote(stub.base_url)} "
            f"-OutDir {_ps_quote(tmp_path / 'missing')}"
        )
        result = _run_command(command)
        assert result.returncode == 1, _combined(result)
        assert "BLOQUEO" in _combined(result)
        assert stub.requests == []


@requires_powershell
def test_short_password_exits_before_http(tmp_path: Path) -> None:
    with PipelineStub() as stub:
        command = (
            f"& {_ps_quote(SCRIPT)} "
            f"-BackendBaseUrl {_ps_quote(stub.base_url)} "
            f"-AdminEmail {_ps_quote(ADMIN_EMAIL)} "
            "-AdminPassword (ConvertTo-SecureString 'short' -AsPlainText -Force) "
            f"-DoctorEmail {_ps_quote(DOCTOR_EMAIL)} "
            f"-DoctorPassword (ConvertTo-SecureString {_ps_quote(DOCTOR_PASSWORD)} "
            "-AsPlainText -Force) "
            f"-OutDir {_ps_quote(tmp_path / 'short')}"
        )
        result = _run_command(command)
        assert result.returncode == 1, _combined(result)
        assert "BLOQUEO" in _combined(result)
        assert stub.requests == []
