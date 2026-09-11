from uuid import uuid4

from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Settings
from server.vision import Detector
from tests.conftest import NoHands


def test_auth_recovery_upload_and_raw_not_public(tmp_path, receipt_bytes, monkeypatch):
    monkeypatch.setattr("server.app.run_ocr", lambda *args: None)
    app = create_app(
        Settings(tmp_path, "test-pairing-key"), lambda path: Detector(path, hands=NoHands())
    )
    headers = {"Authorization": "Bearer test-pairing-key"}
    with TestClient(app) as client:
        assert client.get("/api/captures").status_code == 401
        key = str(uuid4())
        result = client.post(f"/api/captures/{key}", content=receipt_bytes, headers=headers)
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "accepted"
        assert (
            client.post(f"/api/captures/{key}", content=receipt_bytes, headers=headers).status_code
            == 200
        )
        assert client.get("/api/captures", headers=headers).json()["count"] == 1
        assert client.get(f"/api/files/{key}/raw").status_code == 401
        assert client.get(f"/api/files/{key}/raw", headers=headers).content == receipt_bytes
        assert client.get(f"/captures/raw/{key}.jpg").status_code == 404
        assert client.post("/api/control/nonsense", headers=headers).status_code == 409


def test_detector_failure_blocks_capture(tmp_path):
    def broken(_):
        raise RuntimeError("model missing")

    with TestClient(create_app(Settings(tmp_path, "key"), broken)) as client:
        headers = {"Authorization": "Bearer key"}
        assert not client.get("/health").json()["detectorReady"]
        assert client.post("/api/control/start", headers=headers).status_code == 503
