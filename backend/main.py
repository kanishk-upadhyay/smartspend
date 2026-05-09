import os
import json
import mimetypes
import logging
from uuid import uuid4
from urllib.parse import quote, urlparse
from dotenv import load_dotenv

load_dotenv()

import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import shutil
from sqlalchemy.exc import IntegrityError
from database import SessionLocal, Expense
from ocr_utils import ocr_engine
from gemini_extractor import ReceiptExtractionError
from pydantic import BaseModel
from typing import List, Optional

ALLOWED_UPLOAD_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".pdf", ".heic", ".heif"}
logger = logging.getLogger("smartspend.api")
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)

app = FastAPI()

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
UPLOAD_DIR_ABS = os.path.abspath(UPLOAD_DIR)
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST_DIR = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend", "dist"))
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or ""
SUPABASE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "receipts")
SUPABASE_PUBLIC_PREFIX = (
    f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}" if SUPABASE_URL else ""
)

if bool(SUPABASE_URL) != bool(SUPABASE_KEY):
    raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must both be set together.")
if SUPABASE_URL and not os.getenv("DATABASE_URL"):
    logger.warning(
        "SUPABASE_URL is set without DATABASE_URL. Files are durable, but metadata will still use local SQLite."
    )


def _attach_items(expense):
    try:
        expense.items = json.loads(expense.items_json or "[]")
    except Exception:
        expense.items = []
    return expense


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
    _safe_upload_path(image_path)


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

    return f"{SUPABASE_PUBLIC_PREFIX}/{object_name}"


def _delete_supabase_object(image_path: str) -> None:
    if not (SUPABASE_URL and SUPABASE_KEY and SUPABASE_PUBLIC_PREFIX):
        return
    if not image_path.startswith(SUPABASE_PUBLIC_PREFIX + "/"):
        return

    object_name = image_path[len(SUPABASE_PUBLIC_PREFIX) + 1 :]
    if not object_name:
        return

    target = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{quote(object_name, safe='/')}"
    response = httpx.delete(
        target,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
        timeout=30.0,
    )
    if response.status_code >= 300 and response.status_code != 404:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase delete failed ({response.status_code}): {response.text}",
        )


# Pydantic models
class ExpenseBase(BaseModel):
    vendor: str
    total_amount: float
    date: str
    category: str = "General"
    currency: str = "INR"
    source_currency: str = "INR"
    raw_total_amount: Optional[float] = None
    receipt_date: Optional[str] = None
    fx_rate_date: Optional[str] = None
    currency_warning: Optional[str] = None
    item_warning: Optional[str] = None
    items: Optional[list] = None
    image_path: Optional[str] = None

class ExpenseResponse(ExpenseBase):
    id: int
    class Config:
        from_attributes = True

class ExpenseUpdate(BaseModel):
    vendor: Optional[str] = None
    total_amount: Optional[float] = None
    date: Optional[str] = None
    category: Optional[str] = None
    currency: Optional[str] = None
    source_currency: Optional[str] = None
    raw_total_amount: Optional[float] = None
    receipt_date: Optional[str] = None
    fx_rate_date: Optional[str] = None
    currency_warning: Optional[str] = None
    item_warning: Optional[str] = None
    items: Optional[list] = None
    image_path: Optional[str] = None

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

@app.get("/health")
def read_health():
    return {"message": "SmartSpend API is running"}

@app.get("/expenses", response_model=List[ExpenseResponse])
def list_expenses():
    db = SessionLocal()
    expenses = db.query(Expense).all()
    for expense in expenses:
        _attach_items(expense)
    db.close()
    return expenses

@app.post("/expenses", response_model=ExpenseResponse)
def create_expense(expense: ExpenseBase):
    db = SessionLocal()
    if expense.image_path:
        _validate_image_path(expense.image_path)
        existing = db.query(Expense).filter(Expense.image_path == expense.image_path).first()
        if existing is not None:
            _attach_items(existing)
            db.close()
            return existing

    payload = expense.dict(exclude={"items"})
    db_expense = Expense(**payload)
    db_expense.items_json = json.dumps(expense.items or [])
    db.add(db_expense)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if expense.image_path:
            existing = db.query(Expense).filter(Expense.image_path == expense.image_path).first()
            if existing is not None:
                _attach_items(existing)
                db.close()
                return existing
        db.close()
        raise
    db.refresh(db_expense)
    _attach_items(db_expense)
    db.close()
    return db_expense

@app.put("/expenses/{expense_id}", response_model=ExpenseResponse)
def update_expense(expense_id: int, expense: ExpenseUpdate):
    db = SessionLocal()
    db_expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if db_expense is None:
        db.close()
        raise HTTPException(status_code=404, detail="Expense not found")

    update_data = expense.dict(exclude_unset=True, exclude={"items"})
    if "image_path" in update_data and update_data["image_path"]:
        _validate_image_path(update_data["image_path"])
    for key, value in update_data.items():
        setattr(db_expense, key, value)

    if expense.items is not None:
        db_expense.items_json = json.dumps(expense.items)

    db.commit()
    db.refresh(db_expense)
    _attach_items(db_expense)
    db.close()
    return db_expense

@app.delete("/expenses/{expense_id}")
def delete_expense(expense_id: int):
    db = SessionLocal()
    db_expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if db_expense is None:
        db.close()
        raise HTTPException(status_code=404, detail="Expense not found")
    image_path = db_expense.image_path
    if image_path:
        if _is_remote_path(image_path):
            _delete_supabase_object(image_path)
        else:
            try:
                full_path = _safe_upload_path(image_path)
                if os.path.isfile(full_path):
                    os.remove(full_path)
            except HTTPException:
                pass
    db.delete(db_expense)
    db.commit()
    db.close()
    return {"id": expense_id, "deleted": True}

@app.post("/upload")
async def upload_receipt(file: UploadFile = File(...)):
    original_name = file.filename or ""
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in ALLOWED_UPLOAD_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type {ext or '<none>'}. Allowed: {', '.join(sorted(ALLOWED_UPLOAD_EXTS))}.",
        )

    saved_name = f"{uuid4().hex}{ext}"
    file_path = _safe_upload_path(saved_name)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        extracted_data = ocr_engine.extract_data(file_path)
    except ReceiptExtractionError as exc:
        if os.path.isfile(file_path):
            os.remove(file_path)
        logger.warning("OCR extraction failed for %s: %s", saved_name, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        if os.path.isfile(file_path):
            os.remove(file_path)
        logger.exception("Unexpected upload OCR failure for %s", saved_name)
        raise HTTPException(
            status_code=500,
            detail="Upload processing failed unexpectedly. Check deployment logs.",
        ) from exc

    image_path = saved_name
    if SUPABASE_URL and SUPABASE_KEY:
        content_type = file.content_type or mimetypes.guess_type(saved_name)[0] or "application/octet-stream"
        object_name = f"receipts/{saved_name}"
        try:
            image_path = _upload_to_supabase(file_path, object_name, content_type)
        finally:
            if os.path.isfile(file_path):
                os.remove(file_path)

    return {
        "filename": original_name,
        "image_path": image_path,
        "message": "File uploaded and processed successfully",
        "extracted_data": extracted_data,
    }


@app.get("/{full_path:path}")
def serve_frontend(full_path: str):
    if not os.path.isdir(FRONTEND_DIST_DIR):
        raise HTTPException(status_code=404, detail="Frontend build not found")

    requested_path = os.path.abspath(os.path.join(FRONTEND_DIST_DIR, full_path))
    if requested_path != FRONTEND_DIST_DIR and not requested_path.startswith(FRONTEND_DIST_DIR + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")

    if full_path and os.path.isfile(requested_path):
        return FileResponse(requested_path)

    index_path = os.path.join(FRONTEND_DIST_DIR, "index.html")
    if os.path.isfile(index_path):
        return FileResponse(index_path)

    raise HTTPException(status_code=404, detail="Frontend build not found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
