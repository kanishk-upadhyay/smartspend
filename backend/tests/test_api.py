"""
SmartSpend backend test suite.

Architecture note:
  database.py runs DDL migrations at import time using whatever DATABASE_URL
  is set in the environment. The key is to set DATABASE_URL to a
  dedicated test file BEFORE any import of database/main, so all migrations
  run against the test DB. We then also override get_db via FastAPI's
  dependency injection so every request uses that same test session.

  The real ocr_engine singleton (main.ocr_engine) is replaced with a mock
  after import so the upload endpoint never calls a real API.

  Supabase env vars are cleared so no HTTP calls are made.

Run:
    cd backend && .venv/bin/python -m pytest tests/ -v
"""

import base64
import json
import os
import sys
import tempfile
import uuid

import pytest
from unittest.mock import MagicMock

# ── PATH ─────────────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# ── ENV — must be set BEFORE any import of database/main ─────────────────────
_test_db_file = os.path.join(tempfile.gettempdir(), f"smartspend_test_{uuid.uuid4().hex}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_test_db_file}"
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ZAI_API_KEY", "test-zai-key")
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)

# ── IMPORTS — after env is set ────────────────────────────────────────────────
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402 — triggers DDL migrations against test DB
import main       # noqa: E402
from main import app, get_db  # noqa: E402

# ── TEST ENGINE — same file as database.py used so schema already exists ──────
test_engine = create_engine(
    f"sqlite:///{_test_db_file}",
    connect_args={"check_same_thread": False},
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

# ── MOCK OCR — patch the live singleton directly ──────────────────────────────
MOCK_EXTRACTED = {
    "vendor": "Test Cafe",
    "total_amount": 450.0,
    "raw_total_amount": 450.0,
    "date": "2024-05-01",
    "receipt_date": "2024-05-01",
    "currency": "INR",
    "source_currency": "INR",
    "detected_currencies": ["INR"],
    "currency_warning": None,
    "fx_rate_date": None,
    "item_warning": None,
    "items": [{"name": "Coffee", "amount": 200.0, "qty": 2}],
    "category": "Food",
}

mock_ocr = MagicMock()
mock_ocr.extract_data.return_value = MOCK_EXTRACTED
main.ocr_engine = mock_ocr

# ── SHARED CONSTANTS ──────────────────────────────────────────────────────────
# Guest ids must carry the "guest-" prefix — the backend now rejects any
# x-smartspend-guest-id without it (namespaces guests away from auth UUIDs).
GUEST_ID = "guest-test-abc123"
GUEST_HEADERS = {"x-smartspend-guest-id": GUEST_ID}

TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


# ── FIXTURES ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def client():
    """TestClient with DB dependency overridden to use the test engine."""
    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def reset_ocr_mock():
    mock_ocr.extract_data.return_value = MOCK_EXTRACTED
    mock_ocr.extract_data.side_effect = None
    yield


# ─────────────────────────────────────────────────────────────────────────────
# 1. Health check
# ─────────────────────────────────────────────────────────────────────────────

class TestHealth:
    def test_health_returns_200(self, client):
        r = client.get("/health")
        assert r.status_code == 200

    def test_health_message_contains_smartspend(self, client):
        assert "SmartSpend" in client.get("/health").json()["message"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Authentication
# ─────────────────────────────────────────────────────────────────────────────

class TestAuthentication:
    def test_no_credentials_returns_401_on_expenses(self, client):
        assert client.get("/expenses").status_code == 401

    def test_no_credentials_returns_401_on_settings(self, client):
        assert client.get("/account-settings").status_code == 401

    def test_guest_id_header_grants_access(self, client):
        assert client.get("/expenses", headers=GUEST_HEADERS).status_code == 200

    def test_different_guest_ids_are_isolated(self, client):
        a = {"x-smartspend-guest-id": "guest-iso-guest-a"}
        b = {"x-smartspend-guest-id": "guest-iso-guest-b"}
        client.post("/expenses", headers=a, json={
            "vendor": "Only For A", "total_amount": 100.0, "date": "2024-01-01"
        })
        vendors = [e["vendor"] for e in client.get("/expenses", headers=b).json()]
        assert "Only For A" not in vendors


# ─────────────────────────────────────────────────────────────────────────────
# 3. Expenses CRUD
# ─────────────────────────────────────────────────────────────────────────────

class TestExpensesCRUD:
    def test_list_empty_for_fresh_guest(self, client):
        h = {"x-smartspend-guest-id": "guest-fresh-999"}
        assert client.get("/expenses", headers=h).json() == []

    def test_create_returns_correct_fields(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "Starbucks", "total_amount": 320.0,
            "date": "2024-03-15", "category": "Food",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["vendor"] == "Starbucks"
        assert body["total_amount"] == 320.0
        assert body["category"] == "Food"
        assert "id" in body

    def test_created_expense_appears_in_list(self, client):
        h = {"x-smartspend-guest-id": "guest-list-g1"}
        client.post("/expenses", headers=h, json={
            "vendor": "Zomato", "total_amount": 599.0, "date": "2024-04-01"
        })
        vendors = [e["vendor"] for e in client.get("/expenses", headers=h).json()]
        assert "Zomato" in vendors

    def test_update_changes_vendor_and_amount(self, client):
        h = {"x-smartspend-guest-id": "guest-upd-g1"}
        eid = client.post("/expenses", headers=h, json={
            "vendor": "Old", "total_amount": 100.0, "date": "2024-01-01"
        }).json()["id"]
        r = client.put(f"/expenses/{eid}", headers=h, json={
            "vendor": "New", "total_amount": 250.0
        })
        assert r.status_code == 200
        assert r.json()["vendor"] == "New"
        assert r.json()["total_amount"] == 250.0

    def test_update_nonexistent_returns_404(self, client):
        assert client.put("/expenses/9999999", headers=GUEST_HEADERS,
                          json={"vendor": "X"}).status_code == 404

    def test_delete_removes_expense(self, client):
        h = {"x-smartspend-guest-id": "guest-del-g1"}
        eid = client.post("/expenses", headers=h, json={
            "vendor": "Gone", "total_amount": 50.0, "date": "2024-01-01"
        }).json()["id"]
        r = client.delete(f"/expenses/{eid}", headers=h)
        assert r.status_code == 200
        assert r.json()["deleted"] is True
        ids = [e["id"] for e in client.get("/expenses", headers=h).json()]
        assert eid not in ids

    def test_delete_nonexistent_returns_404(self, client):
        assert client.delete("/expenses/9999999", headers=GUEST_HEADERS).status_code == 404

    def test_cannot_delete_other_users_expense(self, client):
        owner = {"x-smartspend-guest-id": "guest-owner-x"}
        thief = {"x-smartspend-guest-id": "guest-thief-y"}
        eid = client.post("/expenses", headers=owner, json={
            "vendor": "Private", "total_amount": 100.0, "date": "2024-01-01"
        }).json()["id"]
        assert client.delete(f"/expenses/{eid}", headers=thief).status_code == 404

    def test_items_roundtrip(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "McDonald's", "total_amount": 199.0, "date": "2024-05-10",
            "items": [{"name": "Burger", "amount": 199.0, "qty": 1}],
        })
        items = r.json()["items"]
        assert len(items) == 1
        assert items[0]["name"] == "Burger"

    def test_default_category_is_general(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "Unknown", "total_amount": 10.0, "date": "2024-01-01"
        })
        assert r.json()["category"] == "General"

    def test_explicit_category_preserved(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "Uber", "total_amount": 250.0, "date": "2024-06-01",
            "category": "Transport"
        })
        assert r.json()["category"] == "Transport"

    def test_update_items_via_put(self, client):
        h = {"x-smartspend-guest-id": "guest-items-upd-g"}
        eid = client.post("/expenses", headers=h, json={
            "vendor": "Shop", "total_amount": 100.0, "date": "2024-01-01",
            "items": [{"name": "A", "amount": 100.0}]
        }).json()["id"]
        r = client.put(f"/expenses/{eid}", headers=h, json={
            "items": [{"name": "B", "amount": 50.0}, {"name": "C", "amount": 50.0}]
        })
        assert len(r.json()["items"]) == 2


# ─────────────────────────────────────────────────────────────────────────────
# 4. Upload endpoint
# ─────────────────────────────────────────────────────────────────────────────

class TestUpload:
    # /upload now requires an identity (the frontend already sends it), so every
    # call here passes GUEST_HEADERS.
    def test_requires_identity(self, client):
        r = client.post("/upload", json={
            "filename": "r.png", "data_base64": TINY_PNG_B64
        })
        assert r.status_code == 401

    def test_oversized_payload_returns_413(self, client):
        # Raw ~20MB > 15MB cap; rejected pre-decode on base64 length.
        big = base64.b64encode(b"x" * (20 * 1024 * 1024)).decode()
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "big.png", "data_base64": big
        })
        assert r.status_code == 413

    def test_png_returns_extracted_data(self, client):
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "receipt.png", "data_base64": TINY_PNG_B64
        })
        assert r.status_code == 200
        d = r.json()["extracted_data"]
        assert d["vendor"] == "Test Cafe"
        assert d["total_amount"] == 450.0
        assert d["category"] == "Food"

    def test_jpeg_accepted(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.jpg", "data_base64": TINY_PNG_B64
        }).status_code == 200

    def test_webp_accepted(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.webp", "data_base64": TINY_PNG_B64
        }).status_code == 200

    def test_pdf_accepted(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.pdf",
            "data_base64": base64.b64encode(b"%PDF-1.4 fake").decode()
        }).status_code == 200

    def test_response_contains_image_path(self, client):
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.png", "data_base64": TINY_PNG_B64
        })
        assert r.json()["image_path"] is not None

    def test_disallowed_extension_returns_400(self, client):
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "evil.exe", "data_base64": TINY_PNG_B64
        })
        assert r.status_code == 400
        assert "Unsupported file type" in r.json()["detail"]

    def test_no_extension_returns_400(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "noext", "data_base64": TINY_PNG_B64
        }).status_code == 400

    def test_invalid_base64_returns_400(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.png", "data_base64": "!!!bad!!!"
        }).status_code == 400

    def test_empty_file_returns_400(self, client):
        assert client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.png",
            "data_base64": base64.b64encode(b"").decode()
        }).status_code == 400

    def test_ocr_failure_returns_502(self, client):
        from gemini_extractor import ReceiptExtractionError
        mock_ocr.extract_data.side_effect = ReceiptExtractionError("OCR failed")
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "bad.png", "data_base64": TINY_PNG_B64
        })
        assert r.status_code == 502
        assert "OCR" in r.json()["detail"]

    def test_upload_returns_items_from_ocr(self, client):
        r = client.post("/upload", headers=GUEST_HEADERS, json={
            "filename": "r.png", "data_base64": TINY_PNG_B64
        })
        items = r.json()["extracted_data"]["items"]
        assert items[0]["name"] == "Coffee"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Account settings
# ─────────────────────────────────────────────────────────────────────────────

class TestAccountSettings:
    H = {"x-smartspend-guest-id": "guest-settings-g1"}

    def test_first_call_creates_defaults(self, client):
        r = client.get("/account-settings", headers=self.H)
        assert r.status_code == 200
        assert r.json()["currency"] == "INR"
        assert r.json()["theme"] in {"light", "dark", "system"}

    def test_update_currency(self, client):
        r = client.put("/account-settings", headers=self.H, json={"currency": "USD"})
        assert r.json()["currency"] == "USD"

    def test_update_theme_light(self, client):
        assert client.put("/account-settings", headers=self.H,
                          json={"theme": "light"}).json()["theme"] == "light"

    def test_update_theme_dark(self, client):
        assert client.put("/account-settings", headers=self.H,
                          json={"theme": "dark"}).json()["theme"] == "dark"

    def test_update_theme_system(self, client):
        assert client.put("/account-settings", headers=self.H,
                          json={"theme": "system"}).json()["theme"] == "system"

    def test_invalid_theme_falls_back_to_system(self, client):
        assert client.put("/account-settings", headers=self.H,
                          json={"theme": "rainbow"}).json()["theme"] == "system"

    def test_update_display_name(self, client):
        r = client.put("/account-settings", headers=self.H,
                       json={"display_name": "Kanishk"})
        assert r.json()["display_name"] == "Kanishk"

    def test_update_custom_categories(self, client):
        cats = ["Dining", "Subscriptions"]
        r = client.put("/account-settings", headers=self.H,
                       json={"custom_categories": cats})
        assert r.json()["custom_categories"] == cats

    def test_duplicate_categories_removed(self, client):
        h = {"x-smartspend-guest-id": "guest-dedup-g2"}
        r = client.put("/account-settings", headers=h,
                       json={"custom_categories": ["Food", "Food", "Travel"]})
        cats = r.json()["custom_categories"]
        assert cats.count("Food") == 1

    def test_response_includes_owner_id(self, client):
        assert "owner_id" in client.get("/account-settings", headers=self.H).json()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Security
# ─────────────────────────────────────────────────────────────────────────────

class TestSecurity:
    def test_path_traversal_rejected(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "E", "total_amount": 1.0, "date": "2024-01-01",
            "image_path": "../../etc/passwd",
        })
        assert r.status_code == 400

    def test_absolute_path_rejected(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "E", "total_amount": 1.0, "date": "2024-01-01",
            "image_path": "/etc/passwd",
        })
        assert r.status_code == 400

    def test_https_image_path_accepted(self, client):
        r = client.post("/expenses", headers=GUEST_HEADERS, json={
            "vendor": "Valid", "total_amount": 10.0, "date": "2024-01-01",
            "image_path": "https://example.com/receipt.png",
        })
        assert r.status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# 7. Unit tests — pure helper functions
# ─────────────────────────────────────────────────────────────────────────────

class TestHelpers:
    def test_normalize_theme_valid(self):
        from main import _normalize_theme
        assert _normalize_theme("light") == "light"
        assert _normalize_theme("dark") == "dark"
        assert _normalize_theme("system") == "system"

    def test_normalize_theme_invalid(self):
        from main import _normalize_theme
        assert _normalize_theme("purple") == "system"
        assert _normalize_theme(None) == "system"
        assert _normalize_theme("") == "system"

    def test_normalize_categories_deduplicates(self):
        from main import _normalize_categories
        result = _normalize_categories(["Food", "Food", "Travel"])
        assert result.count("Food") == 1

    def test_normalize_categories_strips_whitespace(self):
        from main import _normalize_categories
        assert "Food" in _normalize_categories(["  Food  "])

    def test_normalize_categories_empty(self):
        from main import _normalize_categories
        assert _normalize_categories([]) == []
        assert _normalize_categories(None) == []

    def test_is_remote_path(self):
        from main import _is_remote_path
        assert _is_remote_path("https://x.com/f.jpg") is True
        assert _is_remote_path("http://x.com/f.jpg") is True
        assert _is_remote_path("local.jpg") is False
        assert _is_remote_path("") is False


# ─────────────────────────────────────────────────────────────────────────────
# 8. OCR fallback unit tests
# ─────────────────────────────────────────────────────────────────────────────

class TestOCRFallback:
    def test_receipt_extraction_error_is_runtime_error(self):
        from gemini_extractor import ReceiptExtractionError
        assert isinstance(ReceiptExtractionError("test"), RuntimeError)

    def test_gemini_extractor_importable(self):
        from gemini_extractor import GeminiExtractor, ReceiptData
        assert GeminiExtractor and ReceiptData

    def test_zai_extractor_importable(self):
        pytest.importorskip("zai", reason="zai-sdk not installed")
        from zai_extractor import ZaiExtractor
        assert ZaiExtractor

    def test_falls_back_to_zai_when_gemini_fails(self):
        from unittest.mock import patch, MagicMock
        from gemini_extractor import ReceiptExtractionError
        mock_g = MagicMock()
        mock_g.extract.side_effect = ReceiptExtractionError("down")
        mock_z = MagicMock()
        mock_z.extract.return_value = "zai_result"
        with patch("ocr_utils.GeminiExtractor", return_value=mock_g), \
             patch("ocr_utils._try_build_zai_extractor", return_value=mock_z):
            from ocr_utils import OCRProcessor
            assert OCRProcessor()._extract("f.jpg") == "zai_result"

    def test_raises_when_both_fail(self):
        from unittest.mock import patch, MagicMock
        from gemini_extractor import ReceiptExtractionError
        mock_g = MagicMock()
        mock_g.extract.side_effect = ReceiptExtractionError("g down")
        mock_z = MagicMock()
        mock_z.extract.side_effect = ReceiptExtractionError("z down")
        with patch("ocr_utils.GeminiExtractor", return_value=mock_g), \
             patch("ocr_utils._try_build_zai_extractor", return_value=mock_z):
            from ocr_utils import OCRProcessor
            with pytest.raises(ReceiptExtractionError):
                OCRProcessor()._extract("f.jpg")

    def test_gemini_only_mode_works(self):
        from unittest.mock import patch, MagicMock
        mock_g = MagicMock()
        mock_g.extract.return_value = "gemini_ok"
        with patch("ocr_utils.GeminiExtractor", return_value=mock_g), \
             patch("ocr_utils._try_build_zai_extractor", return_value=None):
            from ocr_utils import OCRProcessor
            assert OCRProcessor()._extract("f.jpg") == "gemini_ok"


# ─────────────────────────────────────────────────────────────────────────────
# 9. Expense ordering
# ─────────────────────────────────────────────────────────────────────────────

class TestExpenseOrdering:
    """GET /expenses must return rows in insertion order (ORDER BY id ASC)."""

    def test_insertion_order_preserved(self, client):
        headers = {"x-smartspend-guest-id": "guest-order-guest-001"}
        for vendor in ("Alpha", "Beta", "Gamma"):
            client.post("/expenses", headers=headers, json={
                "vendor": vendor, "total_amount": 1.0, "date": "2024-01-01",
            })
        r = client.get("/expenses", headers=headers)
        assert [e["vendor"] for e in r.json()] == ["Alpha", "Beta", "Gamma"]

    def test_newly_created_expense_appears_last(self, client):
        headers = {"x-smartspend-guest-id": "guest-order-guest-002"}
        client.post("/expenses", headers=headers, json={
            "vendor": "First", "total_amount": 1.0, "date": "2024-01-01",
        })
        client.post("/expenses", headers=headers, json={
            "vendor": "Second", "total_amount": 1.0, "date": "2024-12-31",
        })
        expenses = client.get("/expenses", headers=headers).json()
        assert expenses[0]["vendor"] == "First"
        assert expenses[-1]["vendor"] == "Second"


# ─────────────────────────────────────────────────────────────────────────────
# 10. Image-path deduplication
# ─────────────────────────────────────────────────────────────────────────────

class TestExpenseDeduplication:
    """POST /expenses with a duplicate image_path returns the existing row."""

    def test_same_image_path_returns_existing_expense(self, client):
        headers = {"x-smartspend-guest-id": "guest-dedup-guest-001"}
        image_path = f"dedup_{uuid.uuid4().hex}.jpg"
        payload = {"vendor": "Original", "total_amount": 100.0, "date": "2024-01-01",
                   "image_path": image_path}
        r1 = client.post("/expenses", headers=headers, json=payload)
        r2 = client.post("/expenses", headers=headers, json={**payload, "vendor": "Duplicate"})
        assert r1.json()["id"] == r2.json()["id"]
        assert r2.json()["vendor"] == "Original"

    def test_different_image_paths_create_separate_rows(self, client):
        headers = {"x-smartspend-guest-id": "guest-dedup-guest-002"}
        r1 = client.post("/expenses", headers=headers, json={
            "vendor": "A", "total_amount": 1.0, "date": "2024-01-01",
            "image_path": f"dedup_a_{uuid.uuid4().hex}.jpg",
        })
        r2 = client.post("/expenses", headers=headers, json={
            "vendor": "B", "total_amount": 1.0, "date": "2024-01-01",
            "image_path": f"dedup_b_{uuid.uuid4().hex}.jpg",
        })
        assert r1.json()["id"] != r2.json()["id"]

    def test_no_image_path_allows_multiple_identical_expenses(self, client):
        headers = {"x-smartspend-guest-id": "guest-dedup-guest-003"}
        payload = {"vendor": "Coffee", "total_amount": 50.0, "date": "2024-01-01"}
        r1 = client.post("/expenses", headers=headers, json=payload)
        r2 = client.post("/expenses", headers=headers, json=payload)
        assert r1.json()["id"] != r2.json()["id"]



# ─────────────────────────────────────────────────────────────────────────────
# 11. Optional expense fields
# ─────────────────────────────────────────────────────────────────────────────

class TestExpenseFields:
    """The full set of optional FX / receipt fields roundtrips cleanly."""

    HEADERS = {"x-smartspend-guest-id": "guest-fields-guest-001"}

    def test_fx_fields_stored_and_retrieved(self, client):
        r = client.post("/expenses", headers=self.HEADERS, json={
            "vendor": "FX Receipt", "total_amount": 1500.0, "date": "2024-03-01",
            "currency": "INR", "source_currency": "USD", "raw_total_amount": 18.0,
            "receipt_date": "2024-03-01", "fx_rate_date": "2024-03-01",
            "currency_warning": "Converted from USD at 83.33",
        })
        body = r.json()
        assert body["source_currency"] == "USD"
        assert body["raw_total_amount"] == 18.0
        assert body["fx_rate_date"] == "2024-03-01"
        assert body["currency_warning"] == "Converted from USD at 83.33"

    def test_currency_warning_cleared_via_put(self, client):
        r1 = client.post("/expenses", headers=self.HEADERS, json={
            "vendor": "Warn", "total_amount": 100.0, "date": "2024-01-01",
            "currency_warning": "Needs review",
        })
        r2 = client.put(f"/expenses/{r1.json()['id']}", headers=self.HEADERS,
                        json={"currency_warning": None})
        assert r2.json()["currency_warning"] is None

    def test_expense_without_items_returns_empty_list(self, client):
        r = client.post("/expenses", headers=self.HEADERS, json={
            "vendor": "No Items", "total_amount": 50.0, "date": "2024-01-01",
        })
        assert r.json()["items"] == []

    def test_items_cleared_via_put(self, client):
        r1 = client.post("/expenses", headers=self.HEADERS, json={
            "vendor": "Has Items", "total_amount": 50.0, "date": "2024-01-01",
            "items": [{"name": "Widget", "amount": 50.0}],
        })
        r2 = client.put(f"/expenses/{r1.json()['id']}", headers=self.HEADERS, json={"items": []})
        assert r2.json()["items"] == []

    def test_items_replaced_via_put(self, client):
        r1 = client.post("/expenses", headers=self.HEADERS, json={
            "vendor": "Replace", "total_amount": 50.0, "date": "2024-01-01",
            "items": [{"name": "Old", "amount": 50.0}],
        })
        r2 = client.put(f"/expenses/{r1.json()['id']}", headers=self.HEADERS, json={
            "items": [{"name": "New A", "amount": 20.0}, {"name": "New B", "amount": 30.0}],
        })
        names = [i["name"] for i in r2.json()["items"]]
        assert names == ["New A", "New B"]


# ─────────────────────────────────────────────────────────────────────────────
# 12. Account settings — edge cases
# ─────────────────────────────────────────────────────────────────────────────

class TestAccountSettingsEdgeCases:

    def test_partial_updates_do_not_reset_other_fields(self, client):
        headers = {"x-smartspend-guest-id": "guest-settings-acc-001"}
        client.put("/account-settings", headers=headers, json={"currency": "USD"})
        client.put("/account-settings", headers=headers, json={"theme": "dark"})
        body = client.get("/account-settings", headers=headers).json()
        assert body["currency"] == "USD"
        assert body["theme"] == "dark"

    def test_empty_custom_categories_clears_list(self, client):
        headers = {"x-smartspend-guest-id": "guest-settings-acc-002"}
        client.put("/account-settings", headers=headers, json={"custom_categories": ["Dining"]})
        r = client.put("/account-settings", headers=headers, json={"custom_categories": []})
        assert r.json()["custom_categories"] == []

    def test_blank_strings_in_categories_are_filtered(self, client):
        headers = {"x-smartspend-guest-id": "guest-settings-acc-003"}
        r = client.put("/account-settings", headers=headers, json={
            "custom_categories": ["Valid", "  ", "", "Also Valid"],
        })
        cats = r.json()["custom_categories"]
        assert "" not in cats and "  " not in cats
        assert "Valid" in cats and "Also Valid" in cats

    def test_empty_string_currency_does_not_overwrite_existing(self, client):
        headers = {"x-smartspend-guest-id": "guest-settings-acc-004"}
        client.put("/account-settings", headers=headers, json={"currency": "EUR"})
        r = client.put("/account-settings", headers=headers, json={"currency": ""})
        assert r.json()["currency"] == "EUR"

    def test_display_name_and_email_roundtrip(self, client):
        headers = {"x-smartspend-guest-id": "guest-settings-acc-005"}
        r = client.put("/account-settings", headers=headers, json={
            "display_name": "Kanishk", "email": "kanishk@example.com",
        })
        assert r.json()["display_name"] == "Kanishk"
        assert r.json()["email"] == "kanishk@example.com"


# ─────────────────────────────────────────────────────────────────────────────
# 13. FX rate cache
# ─────────────────────────────────────────────────────────────────────────────

class TestFXRateCache:
    """Unit tests for OCRProcessor.get_historical_rate — no real HTTP calls."""

    @staticmethod
    def _make_processor():
        from unittest.mock import patch, MagicMock
        from ocr_utils import OCRProcessor
        with patch("ocr_utils.GeminiExtractor", return_value=MagicMock()), \
             patch("ocr_utils._try_build_zai_extractor", return_value=None):
            return OCRProcessor()

    def test_same_currency_returns_rate_of_one(self):
        rate, date, err = self._make_processor().get_historical_rate("INR", "INR", "2024-01-01")
        assert rate == 1.0 and err is None

    def test_missing_date_returns_error_without_network(self):
        rate, _, err = self._make_processor().get_historical_rate("USD", "INR", None)
        assert rate is None and "date" in err.lower()

    def test_failed_lookup_is_not_cached(self):
        import urllib.error
        from unittest.mock import patch
        proc = self._make_processor()
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.URLError("network down")):
            rate, _, _ = proc.get_historical_rate("USD", "INR", "2024-06-01")
        assert rate is None
        assert ("USD", "INR", "2024-06-01") not in proc._fx_cache

    def test_cached_rate_returned_without_network(self):
        proc = self._make_processor()
        proc._fx_cache[("EUR", "INR", "2024-01-01")] = (90.0, "2024-01-01")
        rate, _, err = proc.get_historical_rate("EUR", "INR", "2024-01-01")
        assert rate == 90.0 and err is None

    def test_cache_hit_skips_urlopen(self):
        from unittest.mock import patch
        proc = self._make_processor()
        proc._fx_cache[("GBP", "INR", "2024-01-01")] = (107.0, "2024-01-01")
        with patch("urllib.request.urlopen") as mock_open:
            rate, _, _ = proc.get_historical_rate("GBP", "INR", "2024-01-01")
        mock_open.assert_not_called()
        assert rate == 107.0


# ─────────────────────────────────────────────────────────────────────────────
# 14. Guest account migration
# ─────────────────────────────────────────────────────────────────────────────

class TestGuestMigration:
    """Tests for POST /account-migrate-guest.

    Supabase is disabled in tests so _resolve_identity always returns a guest
    identity.  Auth flows are exercised by patching main._resolve_identity.
    """

    @staticmethod
    def _auth(user_id: str):
        from unittest.mock import patch
        return patch(
            "main._resolve_identity",
            return_value=(user_id, "auth", {"id": user_id, "email": f"{user_id}@test.com",
                                            "user_metadata": {}}),
        )

    def test_requires_auth_identity(self, client):
        # Without Supabase, _resolve_identity always returns guest identity.
        # Mock it to return a guest-typed identity whose user_id differs from
        # the x-smartspend-guest-id header so we bypass the same-id 400 and
        # hit the identity_type != "auth" guard that produces 401.
        from unittest.mock import patch
        with patch("main._resolve_identity",
                   return_value=("some-different-user", "guest", None)):
            r = client.post("/account-migrate-guest",
                            headers={"x-smartspend-guest-id": "guest-some-guest"})
        assert r.status_code == 401

    def test_requires_guest_id_header(self, client):
        with self._auth("auth-no-guest-header"):
            r = client.post("/account-migrate-guest", headers={})
        assert r.status_code == 400
        assert "Guest id" in r.json()["detail"]

    def test_rejects_matching_owner_and_guest_ids(self, client):
        # guest-prefixed so it clears the guest-namespace check and reaches the
        # same-id guard we're actually exercising here.
        same_id = f"guest-same-{uuid.uuid4().hex}"
        with self._auth(same_id):
            r = client.post("/account-migrate-guest",
                            headers={"x-smartspend-guest-id": same_id})
        assert r.status_code == 400

    def test_expenses_transferred_to_auth_user(self, client):
        guest_id = f"guest-mg-{uuid.uuid4().hex}"
        auth_id = f"mg-auth-{uuid.uuid4().hex}"
        guest_headers = {"x-smartspend-guest-id": guest_id}

        for i in range(3):
            client.post("/expenses", headers=guest_headers, json={
                "vendor": f"Guest Shop {i}", "total_amount": float(i + 1) * 100,
                "date": "2024-01-01",
            })

        with self._auth(auth_id):
            assert client.post("/account-migrate-guest",
                               headers={"x-smartspend-guest-id": guest_id}).status_code == 200
            vendors = [e["vendor"] for e in client.get("/expenses").json()]

        assert all(f"Guest Shop {i}" in vendors for i in range(3))

    def test_guest_list_empty_after_migration(self, client):
        guest_id = f"guest-mg-{uuid.uuid4().hex}"
        auth_id = f"mg-auth-{uuid.uuid4().hex}"
        guest_headers = {"x-smartspend-guest-id": guest_id}

        client.post("/expenses", headers=guest_headers, json={
            "vendor": "Migrated", "total_amount": 100.0, "date": "2024-01-01",
        })
        with self._auth(auth_id):
            client.post("/account-migrate-guest", headers={"x-smartspend-guest-id": guest_id})

        assert client.get("/expenses", headers=guest_headers).json() == []

    def test_guest_settings_copied_to_auth(self, client):
        guest_id = f"guest-mg-{uuid.uuid4().hex}"
        auth_id = f"mg-auth-{uuid.uuid4().hex}"
        guest_headers = {"x-smartspend-guest-id": guest_id}

        client.put("/account-settings", headers=guest_headers,
                   json={"currency": "JPY", "display_name": "Pre-login User"})

        with self._auth(auth_id):
            body = client.post("/account-migrate-guest",
                               headers={"x-smartspend-guest-id": guest_id}).json()

        assert body["currency"] == "JPY"
        assert body["display_name"] == "Pre-login User"

    def test_existing_auth_settings_not_overwritten(self, client):
        guest_id = f"guest-mg-{uuid.uuid4().hex}"
        auth_id = f"mg-auth-{uuid.uuid4().hex}"
        guest_headers = {"x-smartspend-guest-id": guest_id}

        client.put("/account-settings", headers=guest_headers, json={"currency": "EUR"})

        with self._auth(auth_id):
            client.put("/account-settings", json={"currency": "GBP", "display_name": "Auth User"})
            body = client.post("/account-migrate-guest",
                               headers={"x-smartspend-guest-id": guest_id}).json()

        assert body["currency"] == "GBP"
        assert body["display_name"] == "Auth User"

    def test_migration_succeeds_with_no_prior_guest_settings(self, client):
        guest_id = f"guest-mg-{uuid.uuid4().hex}"
        auth_id = f"mg-auth-{uuid.uuid4().hex}"
        guest_headers = {"x-smartspend-guest-id": guest_id}

        client.post("/expenses", headers=guest_headers, json={
            "vendor": "Settings-free Shop", "total_amount": 50.0, "date": "2024-01-01",
        })

        with self._auth(auth_id):
            assert client.post("/account-migrate-guest",
                               headers={"x-smartspend-guest-id": guest_id}).status_code == 200
            vendors = [e["vendor"] for e in client.get("/expenses").json()]

        assert "Settings-free Shop" in vendors
