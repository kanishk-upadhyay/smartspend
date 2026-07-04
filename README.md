# SmartSpend

A receipt-scanning expense tracker. Upload a photo or PDF of a receipt and it pulls
out the vendor, total, date, line items, and currency automatically, sorts the
expense into a category, and charts your spending over time.

Extraction runs on a vision model (Google Gemini) with a second model
(Z.AI GLM-4.6V) as an automatic fallback, so scanning keeps working even when the
primary model is rate-limited or unavailable.

## Features

- **Automatic receipt extraction** — vendor, total, date, per-line-item breakdown,
  and a category suggestion from an image or PDF. Works on printed and handwritten
  receipts.
- **Dual OCR with fallback** — Gemini first, Z.AI second if it fails. A validation
  step flags receipts where the line items don't sum to the stated total.
- **Multi-currency** — captures the receipt's original currency and converts to a
  base currency, with the original amount viewable per receipt.
- **Batch upload** — drop several receipts at once and confirm them one at a time.
- **Analytics** — spend by category, daily trend, top merchants, and largest receipts.
- **Expense management** — edit, delete with undo, search, filter, and CSV export.
- **Accounts** — email sign-in with per-user data isolation.

## Tech stack

- **Backend** — FastAPI, SQLAlchemy, PostgreSQL, Google Gemini and Z.AI SDKs
- **Frontend** — React 19, TypeScript, Vite, Recharts, Framer Motion, Tailwind CSS
- **Services** — Supabase for Postgres, authentication, and file storage

## Architecture

The backend is a FastAPI service handling OCR, expense CRUD, and analytics. Receipt
images are stored in Supabase Storage and served via signed URLs; expense metadata
lives in Postgres. Requests are authenticated with Supabase-issued JWTs. The frontend
is a single-page React app built with Vite and served by the backend.

```
frontend/                 React + Vite single-page app
backend/
  main.py                 API routes: upload, expenses, account, analytics
  ocr_utils.py            OCR orchestration (Gemini, then Z.AI fallback)
  gemini_extractor.py     primary extractor
  zai_extractor.py        fallback extractor
  database.py             SQLAlchemy models and schema setup
```

## Running locally

**Backend**

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

export GEMINI_API_KEY=your-key        # ZAI_API_KEY is optional (fallback OCR)
export DATABASE_URL=postgresql+psycopg://...   # omit to use a local SQLite file
export SUPABASE_URL=... SUPABASE_KEY=...        # for image storage + auth

uvicorn main:app --reload
```

**Frontend**

```bash
cd frontend
npm install
cat > .env.local <<EOF
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
EOF
npm run dev
```

With no `DATABASE_URL` set, the backend falls back to a local SQLite file, so you can
run it without provisioning a database.

## License

MIT — see [LICENSE](LICENSE).
