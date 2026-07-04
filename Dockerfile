# Portable container for the SmartSpend FastAPI backend.
# Works on Koyeb, Hugging Face Spaces, Fly.io, or any Docker host.
FROM python:3.11.9-slim

# Create a non-root user to run the app (defense in depth)
RUN useradd --create-home --uid 10001 appuser

WORKDIR /app

# Install deps first for better layer caching
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code, owned by the non-root user
COPY --chown=appuser:appuser backend/ .

USER appuser

# Host injects $PORT (Koyeb=8000, HF Spaces: set app_port: 8000 in the Space README).
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
