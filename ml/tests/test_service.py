from fastapi.testclient import TestClient

from ml.service.main import create_app


def test_health_endpoints_work_without_model_startup() -> None:
    client = TestClient(create_app(initialize_runtime=False))

    live_response = client.get("/health/live")
    ready_response = client.get("/health/ready")

    assert live_response.status_code == 200
    assert live_response.json() == {"status": "ok"}
    assert ready_response.status_code == 503
    assert ready_response.json() == {"status": "not_ready"}
