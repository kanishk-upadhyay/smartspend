import os
import json
import logging
import time
import threading
from collections import deque
from urllib.parse import quote, urlparse
from typing import Optional

import httpx
from fastapi import HTTPException, Request

from database import SessionLocal, AccountSettings
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
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or ""
SUPABASE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "receipts")
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
SUPABASE_AUTH_USER_URL = f"{SUPABASE_URL}/auth/v1/user" if SUPABASE_URL else ""
SUPABASE_ADMIN_USER_URL = f"{SUPABASE_URL}/auth/v1/admin/users" if SUPABASE_URL else ""

if bool(SUPABASE_URL) != bool(SUPABASE_KEY):
    raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must both be set together.")
if SUPABASE_URL and not os.getenv("DATABASE_URL"):
    logger.warning(
        "SUPABASE_URL is set without DATABASE_URL. Files are durable, but metadata will still use local SQLite."
    )


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
    if _is_remote_path(image_path):
        parsed = urlparse(image_path)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail="Invalid remote image_path")
        return
    if "/" in image_path:
        if ".." in image_path.split("/") or image_path.startswith("/"):
            raise HTTPException(status_code=400, detail="Invalid image_path")
        return
    _safe_upload_path(image_path)


def _normalize_image_path(stored: Optional[str]) -> Optional[str]:
    """Strip Supabase URL wrappers, leaving a canonical bucket object path or local filename."""
    if not stored:
        return None
    if SUPABASE_URL and stored.startswith(SUPABASE_URL + "/storage/v1/object/"):
        bare = stored.split("?", 1)[0]
        for prefix in (
            f"{SUPABASE_URL}/storage/v1/object/sign/{SUPABASE_BUCKET}/",
            f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}/",
            f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/",
        ):
            if bare.startswith(prefix):
                return bare[len(prefix):]
    return stored


_SIGNED_URL_TTL_SECONDS = 24 * 3600
_SIGNED_URL_REFRESH_BEFORE_SECONDS = 30 * 60
_SIGNED_URL_CACHE_MAX = 10000
_signed_url_cache: dict[str, tuple[str, float]] = {}


def _sign_supabase_object(object_path: str, expires_in: int = _SIGNED_URL_TTL_SECONDS) -> Optional[str]:
    if not (SUPABASE_URL and SUPABASE_KEY) or not object_path:
        return None

    now = time.time()
    cached = _signed_url_cache.get(object_path)
    if cached and cached[1] - now > _SIGNED_URL_REFRESH_BEFORE_SECONDS:
        return cached[0]

    target = f"{SUPABASE_URL}/storage/v1/object/sign/{SUPABASE_BUCKET}/{quote(object_path, safe='/')}"
    try:
        response = httpx.post(
            target,
            json={"expiresIn": expires_in},
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
            },
            timeout=10.0,
        )
    except httpx.RequestError:
        logger.warning("Could not reach Supabase to sign %s", object_path)
        return None
    if response.status_code >= 300:
        logger.warning("Sign URL failed (%s) for %s: %s", response.status_code, object_path, response.text)
        return None
    signed_path = (response.json() or {}).get("signedURL") or ""
    if not signed_path:
        return None
    full_url = f"{SUPABASE_URL}/storage/v1{signed_path}" if signed_path.startswith("/") else signed_path

    if len(_signed_url_cache) >= _SIGNED_URL_CACHE_MAX:
        _signed_url_cache.pop(next(iter(_signed_url_cache)), None)
    _signed_url_cache[object_path] = (full_url, now + expires_in)
    return full_url


def _displayable_image_path(stored: Optional[str]) -> Optional[str]:
    object_path = _normalize_image_path(stored)
    if not object_path:
        return None
    if "/" not in object_path:
        return object_path
    return _sign_supabase_object(object_path)


def _attach_items(expense):
    try:
        expense.items = json.loads(expense.items_json or "[]")
    except Exception:
        expense.items = []
    expense.image_path = _displayable_image_path(expense.image_path)
    return expense


def _normalize_theme(theme: Optional[str]) -> str:
    if theme in {"light", "dark", "system"}:
        return theme
    return "system"


def _normalize_categories(categories: Optional[list]) -> list[str]:
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


def _auth_headers(auth_header: str) -> dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": auth_header,
    }


# Validated bearer tokens are cached briefly so a burst of requests from one
# page load doesn't fire a Supabase round-trip apiece.
_AUTH_CACHE: dict[str, tuple[float, str, dict]] = {}
_AUTH_CACHE_TTL = 60.0
_AUTH_CACHE_MAX = 1024

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


def _resolve_identity(request: Request) -> tuple[str, str, Optional[dict]]:
    auth_header = request.headers.get("authorization", "").strip()
    guest_id = request.headers.get("x-smartspend-guest-id", "").strip()

    if auth_header and SUPABASE_URL and SUPABASE_KEY:
        now = time.time()
        cached = _AUTH_CACHE.get(auth_header)
        if cached is not None and now - cached[0] < _AUTH_CACHE_TTL:
            return cached[1], "auth", cached[2]
        try:
            response = httpx.get(
                SUPABASE_AUTH_USER_URL,
                headers=_auth_headers(auth_header),
                timeout=10.0,
            )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail="Could not validate Supabase session.") from exc
        if response.status_code == 200:
            user = response.json()
            user_id = user.get("id")
            if user_id:
                if len(_AUTH_CACHE) >= _AUTH_CACHE_MAX:
                    _AUTH_CACHE.pop(next(iter(_AUTH_CACHE)), None)
                _AUTH_CACHE[auth_header] = (now, user_id, user)
                return user_id, "auth", user
        _AUTH_CACHE.pop(auth_header, None)
        raise HTTPException(status_code=401, detail="Invalid or expired session.")

    if guest_id:
        # Namespacing invariant: legitimate guest ids always carry the "guest-"
        # prefix (frontend generates `guest-${uuid}`). Enforcing it keeps the
        # guest owner_id namespace disjoint from auth UUIDs, so a guest header
        # can never address auth-owned data.
        if not guest_id.startswith("guest-"):
            raise HTTPException(status_code=401, detail="Invalid guest session.")
        return guest_id, "guest", None

    raise HTTPException(status_code=401, detail="Sign in or provide a guest session.")


def _sync_supabase_user_metadata(user_id: str, settings: "AccountSettings") -> None:
    if not (SUPABASE_ADMIN_USER_URL and SUPABASE_KEY):
        return

    # Only mirror profile/preferences into user_metadata. Deliberately NOT the
    # auth `email`: it's a display/contact field here and pushing it to the auth
    # record would silently change the user's login email (and skip re-verification).
    payload = {
        "user_metadata": {
            "display_name": settings.display_name,
            "avatar_url": settings.avatar_url,
            "currency": settings.currency,
            "theme": settings.theme,
            "custom_categories": json.loads(settings.custom_categories_json or "[]"),
        },
    }
    try:
        response = httpx.put(
            f"{SUPABASE_ADMIN_USER_URL}/{user_id}",
            json=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
            },
            timeout=10.0,
        )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Could not update Supabase account metadata.") from exc

    if response.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase account update failed ({response.status_code}): {response.text}",
        )


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


def _upload_to_supabase(local_path: str, object_name: str, content_type: str) -> str:
    if not (SUPABASE_URL and SUPABASE_KEY):
        raise HTTPException(
            status_code=500,
            detail="Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_KEY.",
        )

    target = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{quote(object_name, safe='/')}"
    try:
        with open(local_path, "rb") as payload:
            response = httpx.post(
                target,
                content=payload.read(),
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
                timeout=30.0,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach Supabase Storage. Check SUPABASE_URL and network egress.",
        ) from exc

    if response.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase upload failed ({response.status_code}): {response.text}",
        )

    return object_name


def _delete_supabase_object(image_path: str) -> None:
    if not (SUPABASE_URL and SUPABASE_KEY):
        return
    object_name = _normalize_image_path(image_path)
    if not object_name or "/" not in object_name:
        return

    target = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{quote(object_name, safe='/')}"
    try:
        response = httpx.delete(
            target,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
            },
            timeout=30.0,
        )
    except httpx.RequestError:
        logger.warning("Could not reach Supabase to delete %s", object_name)
        return
    if response.status_code >= 300 and response.status_code != 404:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase delete failed ({response.status_code}): {response.text}",
        )
