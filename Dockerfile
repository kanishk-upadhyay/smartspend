# Portable container for the SmartSpend FastAPI backend.
# Works on Koyeb, Hugging Face Spaces, Fly.io, or any Docker host.
FROM python:3.11-slim

WORKDIR /app

# Install deps first for better layer caching
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code
COPY backend/ .

# Host injects $PORT (Koyeb=8000, HF Spaces set app_port: 8000 in the Space README).
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
