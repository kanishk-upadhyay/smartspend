import base64
import os
import sys
import tempfile
import uuid
from unittest.mock import MagicMock

import pytest

# ── PATH & ENV SETUP ──────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
_test_db_file = os.path.join(tempfile.gettempdir(), f"smartspend_gaps_test_{uuid.uuid4().hex}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_test_db_file}"
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ZAI_API_KEY", "test-zai-key")
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)

from fastapi.testclient import TestClient

import deps
from database import Base, engine
from main import app

USER_1 = {"x-smartspend-guest-id": "guest-gap-user-1"}
USER_2 = {"x-smartspend-guest-id": "guest-gap-user-2"}
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
TINY_PNG_B64 = base64.b64encode(TINY_PNG).decode("ascii")


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=engine)
    yield
    try:
        os.remove(_test_db_file)
    except OSError:
        pass


@pytest.fixture
def client():
    # Replace real OCR engine with mock
    mock_ocr = MagicMock()
    mock_ocr.extract_receipt_data.return_value = {
        "vendor": "Test Merchant",
        "total_amount": 100.0,
        "raw_total_amount": 100.0,
        "date": "2026-11-15",
        "currency": "INR",
        "source_currency": "INR",
        "category": "Food",
        "items": [{"name": "Item 1", "amount": 100.0}],
    }
    deps.ocr_engine = mock_ocr
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────────────
# Gaps in Cross-User Isolation & Security
# ─────────────────────────────────────────────────────────────────────────────


class TestSecurityGaps:
    def test_cannot_update_other_users_expense(self, client):
        """User 2 must not be able to modify User 1's expense via PUT."""
        exp = client.post(
            "/expenses",
            headers=USER_1,
            json={"vendor": "Private Bill", "total_amount": 999.0, "date": "2026-11-15"},
        ).json()

        # User 2 tries to update User 1's expense
        put_res = client.put(
            f"/expenses/{exp['id']}",
            headers=USER_2,
            json={"vendor": "Tampered Merchant", "total_amount": 1.0},
        )
        assert put_res.status_code == 404

        # Verify expense was not altered
        original = client.get("/expenses", headers=USER_1).json()
        assert original[0]["vendor"] == "Private Bill"
        assert original[0]["total_amount"] == 999.0

    def test_cannot_access_or_modify_other_users_account_settings(self, client):
        """Account settings must remain completely isolated between guests."""
        client.put("/account-settings", headers=USER_1, json={"display_name": "Alice"})
        client.put("/account-settings", headers=USER_2, json={"display_name": "Bob"})

        res_1 = client.get("/account-settings", headers=USER_1).json()
        res_2 = client.get("/account-settings", headers=USER_2).json()
        assert res_1["display_name"] == "Alice"
        assert res_2["display_name"] == "Bob"

    def test_invalid_image_path_rejected_on_create(self, client):
        """Reject path traversal or invalid schemes on image_path."""
        r = client.post(
            "/expenses",
            headers=USER_1,
            json={"vendor": "Bad Path", "total_amount": 10.0, "date": "2026-11-15", "image_path": "../etc/passwd"},
        )
        assert r.status_code == 400

    def test_ftp_scheme_image_path_rejected(self, client):
        r = client.post(
            "/expenses",
            headers=USER_1,
            json={
                "vendor": "Bad Scheme",
                "total_amount": 10.0,
                "date": "2026-11-15",
                "image_path": "ftp://example.com/test.png",
            },
        )
        assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# Gaps in Upload & S3 Storage Error Handling
# ─────────────────────────────────────────────────────────────────────────────


class TestUploadAndStorageGaps:
    def test_upload_corrupt_base64_returns_400(self, client):
        r = client.post(
            "/upload",
            headers=USER_1,
            json={"filename": "test.png", "data_base64": "!!!NOT_VALID_BASE64!!!"},
        )
        assert r.status_code == 400
        assert "invalid upload payload" in r.json()["detail"].lower()

    def test_upload_empty_filename_rejected(self, client):
        r = client.post(
            "/upload",
            headers=USER_1,
            json={"filename": "", "data_base64": TINY_PNG_B64},
        )
        assert r.status_code == 400

    def test_upload_disallowed_file_extension_rejected(self, client):
        r = client.post(
            "/upload",
            headers=USER_1,
            json={"filename": "script.exe", "data_base64": TINY_PNG_B64},
        )
        assert r.status_code == 400
        assert "unsupported file type" in r.json()["detail"].lower()

    def test_upload_s3_storage_failure_returns_502(self, client, monkeypatch):
        """When S3 put_object raises an exception, endpoint returns 502 Bad Gateway."""
        mock_s3 = MagicMock()
        mock_s3.put_object.side_effect = Exception("S3 Connection refused")
        monkeypatch.setattr("deps.get_s3_client", lambda: mock_s3)
        monkeypatch.setattr("deps.S3_ENDPOINT_URL", "https://s3.neon.tech")
        monkeypatch.setattr("deps.S3_ACCESS_KEY_ID", "key")
        monkeypatch.setattr("routers.upload.S3_ENDPOINT_URL", "https://s3.neon.tech")
        monkeypatch.setattr("routers.upload.S3_ACCESS_KEY_ID", "key")

        r = client.post(
            "/upload",
            headers=USER_1,
            json={"filename": "test.png", "data_base64": TINY_PNG_B64},
        )
        assert r.status_code == 502
        assert "could not upload" in r.json()["detail"].lower()

    def test_s3_url_normalization_handles_s3_prefixes(self, monkeypatch):
        """_normalize_image_path extracts canonical object key from full S3 URL."""
        monkeypatch.setattr("deps.S3_ENDPOINT_URL", "https://s3.neon.tech")
        from deps import _normalize_image_path

        s3_url = f"https://s3.neon.tech/{deps.STORAGE_BUCKET}/receipts/my_scan_123.jpg"
        assert _normalize_image_path(s3_url) == "receipts/my_scan_123.jpg"
        assert _normalize_image_path("receipts/local.png") == "receipts/local.png"
        assert _normalize_image_path(None) is None


# ─────────────────────────────────────────────────────────────────────────────
# Gaps in Rate Limiting & Currency Edge Cases
# ─────────────────────────────────────────────────────────────────────────────


class TestRateLimitingAndCurrencyGaps:
    def test_rate_limit_burst_protection(self, client, monkeypatch):
        """Exceeding upload rate limit returns 429 Too Many Requests."""
        monkeypatch.setattr("deps.UPLOAD_RATE_LIMIT", 2)
        h = {"x-smartspend-guest-id": "guest-rate-limited-user"}

        # Request 1: OK
        r1 = client.post("/upload", headers=h, json={"filename": "1.png", "data_base64": TINY_PNG_B64})
        assert r1.status_code == 200

        # Request 2: OK
        r2 = client.post("/upload", headers=h, json={"filename": "2.png", "data_base64": TINY_PNG_B64})
        assert r2.status_code == 200

        # Request 3: Exceeds limit -> 429
        r3 = client.post("/upload", headers=h, json={"filename": "3.png", "data_base64": TINY_PNG_B64})
        assert r3.status_code == 429
        assert "too many uploads" in r3.json()["detail"].lower()

    def test_reconvert_empty_ledger_succeeds(self, client):
        """Reconverting when the user has zero expenses succeeds cleanly."""
        h = {"x-smartspend-guest-id": "guest-empty-reconvert"}
        r = client.post("/expenses/reconvert", headers=h)
        assert r.status_code == 200
        assert r.json()["reconverted"] == 0
