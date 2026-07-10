import os
import base64
from uuid import uuid4

from fastapi import APIRouter, Request, HTTPException, Depends
from sqlalchemy.orm import Session

from database import AccountSettings
from gemini_extractor import ReceiptExtractionError
from schemas import UploadRequest
import deps
from deps import (
    get_db,
    logger,
    ALLOWED_UPLOAD_EXTS,
    EXT_TO_MIME,
    MAX_UPLOAD_BYTES,
    SUPABASE_URL,
    SUPABASE_KEY,
    _check_upload_rate,
    _safe_upload_path,
    _upload_to_supabase,
    _displayable_image_path,
)

router = APIRouter()


@router.post("/upload")
async def upload_receipt(request: Request, payload: UploadRequest, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    _check_upload_rate(owner_id)

    settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    base_currency = (settings.currency if settings and settings.currency else "INR")

    original_name = payload.filename or ""
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in ALLOWED_UPLOAD_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type {ext or '<none>'}. Allowed: {', '.join(sorted(ALLOWED_UPLOAD_EXTS))}.",
        )

    # Reject oversized payloads before decoding (base64 is ~1.37x the raw size).
    if len(payload.data_base64) > int(MAX_UPLOAD_BYTES * 1.4):
        raise HTTPException(status_code=413, detail="Upload too large")

    saved_name = f"{uuid4().hex}{ext}"
    file_path = _safe_upload_path(saved_name)
    try:
        raw_bytes = base64.b64decode(payload.data_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid upload payload") from exc

    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Empty upload payload")

    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Upload too large")

    with open(file_path, "wb") as buffer:
        buffer.write(raw_bytes)

    try:
        extracted_data = deps.ocr_engine.extract_data(file_path, base_currency=base_currency)
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
        content_type = EXT_TO_MIME.get(ext, "application/octet-stream")
        object_name = f"receipts/{saved_name}"
        try:
            image_path = _upload_to_supabase(file_path, object_name, content_type)
        finally:
            if os.path.isfile(file_path):
                os.remove(file_path)

    return {
        "filename": original_name,
        "image_path": _displayable_image_path(image_path) or image_path,
        "message": "File uploaded and processed successfully",
        "extracted_data": extracted_data,
    }
