import json
import logging
import os
import threading
import time
from collections import deque
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from fastapi import HTTPException, Request

from database import AccountSettings, SessionLocal
from ocr_utils import ocr_engine  # noqa: F401 — re-exported singleton, patched in tests
from schemas import AccountSettingsResponse

ALLOWED_UPLOAD_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".pdf", ".heic", ".heif"}
EXT_TO_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".heic": "image/heic",
    ".heif": "image/heif",
}
logger = logging.getLogger("smartspend.api")
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
UPLOAD_DIR_ABS = os.path.abspath(UPLOAD_DIR)
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST_DIR = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend", "dist"))

# S3 / Neon Object Storage configuration
S3_ENDPOINT_URL = (os.getenv("AWS_ENDPOINT_URL_S3") or "").rstrip("/")
S3_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID") or ""
S3_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY") or ""
S3_REGION = os.getenv("AWS_REGION", "ap-southeast-1")
STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "receipts")

_s3_client = None


def get_s3_client():
    global _s3_client
    if not (S3_ENDPOINT_URL and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        return None
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT_URL,
            aws_access_key_id=S3_ACCESS_KEY_ID,
            aws_secret_access_key=S3_SECRET_ACCESS_KEY,
            region_name=S3_REGION,
            config=Config(s3={"addressing_style": "path"}),
        )
    return _s3_client


ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _safe_upload_path(filename: str) -> str:
    """Resolve a filename to an absolute path inside UPLOAD_DIR, or raise.

    Filenames stored in the DB are UUID-generated, so any value not pointing
    inside UPLOAD_DIR is either tampered with or left over from an older row.
    """
    candidate = os.path.abspath(os.path.join(UPLOAD_DIR_ABS, filename))
    if not candidate.startswith(UPLOAD_DIR_ABS + os.sep):
        raise HTTPException(status_code=400, detail="Invalid image_path")
    return candidate


def _is_remote_path(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def _validate_image_path(image_path: str) -> None:
    if "://" in image_path:
        parsed = urlparse(image_path)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail="Invalid remote image_path")
        return
    if "/" in image_path:
        if ".." in image_path.split("/") or image_path.startswith("/"):
            raise HTTPException(status_code=400, detail="Invalid image_path")
        return
    _safe_upload_path(image_path)


def _normalize_image_path(stored: str | None) -> str | None:
    """Strip storage URL wrappers, leaving a canonical bucket object path or local filename."""
    if not stored:
        return None
    if S3_ENDPOINT_URL:
        prefix = f"{S3_ENDPOINT_URL}/{STORAGE_BUCKET}/"
        if stored.startswith(prefix):
            return stored[len(prefix) :]
    return stored


def _displayable_image_path(stored: str | None) -> str | None:
    object_path = _normalize_image_path(stored)
    if not object_path:
        return None
    if _is_remote_path(object_path):
        return object_path

    s3 = get_s3_client()
    if s3:
        # Since receipts bucket is public_read on Neon, we serve directly:
        return f"{S3_ENDPOINT_URL}/{STORAGE_BUCKET}/{object_path}"

    return object_path


def _attach_items(expense):
    try:
        expense.items = json.loads(expense.items_json or "[]")
    except Exception:
        expense.items = []
    try:
        expense.split_data = (
            json.loads(expense.split_data_json or "{}") if getattr(expense, "split_data_json", None) else None
        )
    except Exception:
        expense.split_data = None
    expense.image_path = _displayable_image_path(expense.image_path)
    return expense


def _normalize_theme(theme: str | None) -> str:
    if theme in {"light", "dark", "system"}:
        return theme
    return "system"


def _normalize_categories(categories: list | None) -> list[str]:
    if not categories:
        return []
    seen = set()
    normalized: list[str] = []
    for value in categories:
        category = str(value).strip()
        if not category or category in seen:
            continue
        seen.add(category)
        normalized.append(category)
    return normalized


# /upload guards: cap request size and rate-limit per identity. The endpoint
# decodes arbitrary base64 to disk and calls paid OCR, so it must require an
# identity and bound both disk and cost.
MAX_UPLOAD_MB = float(os.getenv("MAX_UPLOAD_MB", "15"))
MAX_UPLOAD_BYTES = int(MAX_UPLOAD_MB * 1024 * 1024)
UPLOAD_RATE_LIMIT = int(os.getenv("UPLOAD_RATE_LIMIT", "30"))  # per rolling 60s
_UPLOAD_RATE_WINDOW = 60.0
_upload_rate_hits: dict[str, deque] = {}
_upload_rate_lock = threading.Lock()


def _check_upload_rate(owner_id: str) -> None:
    now = time.time()
    with _upload_rate_lock:
        hits = _upload_rate_hits.get(owner_id)
        if hits is None:
            hits = deque()
            _upload_rate_hits[owner_id] = hits
        while hits and now - hits[0] > _UPLOAD_RATE_WINDOW:
            hits.popleft()
        if len(hits) >= UPLOAD_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many uploads, slow down.")
        hits.append(now)


def _resolve_identity(request: Request) -> tuple[str, str, dict | None]:
    auth_header = request.headers.get("authorization", "").strip()
    guest_id = request.headers.get("x-smartspend-guest-id", "").strip()
    user_email = request.headers.get("x-smartspend-user-email", "").strip() or None
    user_name = request.headers.get("x-smartspend-user-name", "").strip() or None

    if auth_header:
        token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else auth_header
        if not token:
            raise HTTPException(status_code=401, detail="Invalid authorization token.")
        user_id = (
            token.split("__")[0]
            if (token.startswith("user_") or token.startswith("auth-") or token.startswith("user-"))
            else f"user_{token[:24]}"
        )
        user = {
            "id": user_id,
            "email": user_email,
            "user_metadata": {
                "display_name": user_name,
            }
            if user_name
            else {},
        }
        return user_id, "auth", user

    if guest_id:
        # Namespacing invariant: legitimate guest ids always carry the "guest-"
        # prefix (frontend generates `guest-${uuid}`). Enforcing it keeps the
        # guest owner_id namespace disjoint from auth UUIDs, so a guest header
        # can never address auth-owned data.
        if not guest_id.startswith("guest-"):
            raise HTTPException(status_code=401, detail="Invalid guest session.")
        return guest_id, "guest", None

    raise HTTPException(status_code=401, detail="Sign in or provide a guest session.")


# Legacy NULL-owner rows are never auto-claimed on request. Any backfill of
# pre-auth rows must be a one-off offline admin script keyed to a known owner.


def _settings_payload(settings: AccountSettings) -> "AccountSettingsResponse":
    try:
        categories = json.loads(settings.custom_categories_json or "[]")
    except Exception:
        categories = []
    return AccountSettingsResponse(
        id=settings.id,
        owner_id=settings.owner_id,
        display_name=settings.display_name,
        email=settings.email,
        avatar_url=settings.avatar_url,
        currency=settings.currency or "INR",
        theme=settings.theme or "system",
        custom_categories=categories,
    )


def _upload_to_storage(local_path: str, object_name: str, content_type: str) -> str:
    s3 = get_s3_client()
    if s3:
        try:
            with open(local_path, "rb") as payload:
                s3.put_object(
                    Bucket=STORAGE_BUCKET,
                    Key=object_name,
                    Body=payload,
                    ContentType=content_type,
                )
            return object_name
        except Exception as exc:
            logger.exception("Failed to upload %s to Neon Object Storage", object_name)
            raise HTTPException(
                status_code=502,
                detail="Could not upload file to object storage.",
            ) from exc

    return object_name


_upload_to_supabase = _upload_to_storage


def _delete_storage_object(image_path: str) -> None:
    s3 = get_s3_client()
    if s3:
        object_name = _normalize_image_path(image_path)
        if not object_name:
            return
        try:
            s3.delete_object(Bucket=STORAGE_BUCKET, Key=object_name)
            return
        except Exception as exc:
            logger.warning("Could not delete %s from object storage: %s", object_name, exc)
            return


_delete_supabase_object = _delete_storage_object
