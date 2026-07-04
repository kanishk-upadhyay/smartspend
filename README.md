---
title: SmartSpend API
emoji: 🧾
colorFrom: green
colorTo: indigo
sdk: docker
app_port: 8000
pinned: false
---

# SmartSpend

Receipt-scanning expense tracker. FastAPI backend (Gemini + Z.AI OCR; Supabase
Postgres / Auth / Storage) with a React + Vite frontend.

- **Backend** — `backend/`, containerised via the root `Dockerfile`. Runs on
  Hugging Face Spaces, Koyeb, Fly.io, or any Docker host.
- **Frontend** — `frontend/`, static build deployed to Cloudflare Pages.

The YAML front-matter above configures Hugging Face Spaces (Docker SDK, port 8000);
it is ignored by other hosts.
