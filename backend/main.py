import os
import sys

# Ensure backend directory is on sys.path so sub-modules (deps, routers, database, schemas)
# resolve cleanly whether executed as `uvicorn main:app` from backend/ or `uvicorn backend.main:app` from root.
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import deps
# Re-exported so existing tests (`from main import ...`) keep working after the
# split. These names live in deps now but stay importable from main.
from deps import (  # noqa: F401
    get_db,
    ocr_engine,
    _resolve_identity,
    _normalize_theme,
    _normalize_categories,
    _is_remote_path,
    ALLOWED_ORIGINS,
    UPLOAD_DIR,
    FRONTEND_DIST_DIR,
)
from routers import account, expenses, upload

app = FastAPI()

# CORS: the backend serves the frontend same-origin in production. This covers
# local dev (Vite) and any separately-hosted frontend via the ALLOWED_ORIGINS env.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/health")
def read_health():
    return {"message": "SmartSpend API is running"}


app.include_router(account.router)
app.include_router(expenses.router)
app.include_router(upload.router)


# The SPA catch-all MUST be registered AFTER every include_router above, or it
# would shadow the API routes.
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
