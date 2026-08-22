# SmartSpend — code learnings

## Architecture: split is clean, but module-qualified imports are footguns

`main.py` was split into `deps.py` + `routers/` to keep `main.py` lean.
`deps.py` re-exports the OCR singleton (`ocr_engine`) and identity resolver
(`_resolve_identity`). Routers import them *module-qualified* (`deps.ocr_engine`,
`deps._resolve_identity`), not `from deps import`.

**Why this matters for tests**: tests mock `deps.ocr_engine`, not `main.ocr_engine`.
If a router did `from deps import ocr_engine`, the mock wouldn't take effect because
Python's import binding is local — the router would keep a reference to the original.
Module-qualified lookup (`deps.ocr_engine`) is a mutable attribute access, so
reassigning `deps.ocr_engine = mock` patches *every consumer*.

Same split pattern in `main.py`: it re-exports from `deps` with `# noqa: F401`
so existing tests that did `from main import get_db, ocr_engine` keep working.

## Database: DDL-at-import-time with idempotent migrations

`database.py` runs `Base.metadata.create_all()` and then migration ALTER TABLE
statements at *import time* (module scope). It uses `exec_driver_sql` (raw SQL
through SQLAlchemy's driver connection) so it can `DROP INDEX`, `CREATE UNIQUE INDEX`,
and `PRAGMA table_info` without ORM overhead.

**SQLite migrations**: `PRAGMA table_info(expenses)` to check columns, then
`ALTER TABLE ADD COLUMN IF NOT EXISTS` — except SQLite doesn't support `IF NOT EXISTS`
for columns, so the pattern is: read columns → check membership → ALTER if absent.

**Postgres migrations**: can use `ALTER TABLE ADD COLUMN IF NOT EXISTS` natively.

**Key learnings**:
- Dedup + unique index creation must be owner-scoped, not global, or cross-owner
  image_path collisions cause 500s the per-owner recovery can't resolve.
- Transaction poolers (Supabase port 6543) break SQLAlchemy prepared statements.
  Use the session pooler (port 5432) with `pool_pre_ping` + `pool_recycle=300`.
- URL scheme normalization: `postgres://` → `postgresql+psycopg://` so a plain
  `psycopg[binary]` dep works without psycopg2 installed.

## Identity: guest-auth split via namespace prefix

Two auth modes share all routes. `_resolve_identity()` checks:
1. `Authorization: Bearer <supabase-jwt>` → auth user
2. `x-smartspend-guest-id: guest-<uuid>` → guest session

**Crucial**: guest ids MUST start with `"guest-"`. This keeps the `owner_id`
namespace disjoint from auth UUIDs, so a guest header can never address auth-owned
data and vice versa. Enforced at both resolution and migration.

Migration endpoint (`/account-migrate-guest`) requires:
- Valid auth session (identity_type == "auth")
- Guest id header with "guest-" prefix
- Guest and auth owner_ids differ
Only guest-owned rows are migrated, never another auth user's data.

## OCR: layered fallback with shared data models

`GeminiExtractor` and `ZaiExtractor` share `ReceiptData` Pydantic model + `PROMPT`
from `gemini_extractor.py`. Z.AI appends a schema suffix because it can't do
native response_schema binding.

**Key differences**:
- Gemini: `response_schema=ReceiptData` for guaranteed structured output
- Z.AI: `response_format={"type": "json_object"}` + prompt-embedded schema,
  output parsed via `json.loads()` → `ReceiptData(**payload)`

`OCRProcessor._extract()` tries Gemini first, catches `ReceiptExtractionError`,
and falls back to Z.AI. Both backends raise the same exception type so the caller
never sees library-specific errors.

**Z.AI SDK quirk**: images must be base64 data URLs, not raw bytes (unlike Gemini
which accepts `types.Part.from_bytes()`). The Z.AI SDK is OpenAI-compatible.

## Currency conversion: CDN-backed with defensive caching

FX rates come from `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest`.
`get_historical_rate()`:
- Caches *only successful* lookups (keyed by source+target+date) so a transient
  CDN failure never poisons the cache with a stale/wrong rate.
- Walks up to 8 days backward from the receipt date if the exact date's rate
  isn't available (weekends/holidays).
- Cache max: 512 entries, LRU-evicted one entry at a time.
- Defensive: unparseable dates return `(None, None, warning)` instead of crashing.

**Reconvert endpoint** (`POST /expenses/reconvert`):
- Reads preferred currency from `AccountSettings`.
- Must sanitize `raw_date` before passing to `get_historical_rate` — the literal
  string `"Unknown"` (from OCR failures) is valid ISO8601-adjacent but would crash
  `datetime.fromisoformat()`. `"Unknown"` → `None` → "date missing" tuple.
- Per-item raw_amount is the source of truth for item conversion; falls back to
  `item.amount` if raw_amount is absent.
- Failed rows get a `currency_warning` string but are NOT rolled back with the
  batch — `db.commit()` still persists the successful ones.

## Upload: base64 over multipart

All uploads go through `/upload` as JSON with `data_base64` field, not multipart
form data. This was a deliberate change (commit `bba7616`):

**Why**: simpler frontend (no FormData juggling), works with standard axios config
that already carries auth headers, and the JSON body can carry metadata alongside
the binary data.

**Safety checks**:
- Pre-decode size check: `len(payload.data_base64) > MAX_UPLOAD_BYTES * 1.4`
  (base64 is ~1.37x raw size) avoids decoding an oversized payload.
- Post-decode: `len(raw_bytes) > MAX_UPLOAD_BYTES`.
- `base64.b64decode(validate=True)` rejects malformed base64.
- File extension whitelist: `.jpg/.jpeg/.png/.webp/.pdf/.heic/.heif`.

**Supabase integration**: file is saved locally first, uploaded to Supabase Storage
via `_upload_to_supabase()`, then *always* the local copy is removed (even on
failure — the exception handler cleans up).

## Rate limiting

Per-owner rate limit: rolling 60-second window tracked via a deque of timestamps.
Implemented in `_check_upload_rate()` — not a middleware, called explicitly in
upload + reconvert endpoints. Simple, no Redis dependency.

## Frontend patterns

### Component architecture
- Single `App.tsx` component (no router library — view state managed via
  `setCurrentView()` with inline rendering)
- Custom hooks for each domain: `useAuth`, `useExpenses`, `useReceiptQueue`,
  `useAccountSettings`, `useTheme`, `useToasts`
- `useRequestConfig` computes axios headers from auth session or guest id

### Virtual list
`WindowVirtualList` uses `@tanstack/react-virtual` with `useWindowVirtualizer`
(window-scroll mode, not container-scroll) so the app keeps a single document
scroll. Includes `ResizeObserver` to track offset changes when filters expand.

### Chart sizing
`ChartFrame` component measures its own box with `ResizeObserver` and passes
concrete pixel dimensions as a render-prop. Avoids `<ResponsiveContainer>` which
logs about width(-1) sentinel on first render.

### Theme
Theme state lives in `useTheme` hook, persisted to localStorage via
`THEME_STORAGE_KEY`. Applies CSS class on `<html>` for Tailwind dark mode.
Chart colors are OKLCH values baked into the hook (not CSS variables), toggled
between light/dark palettes based on theme preference + `matchMedia`.

Pattern: `useTheme` handles *reading/writing* preference; `applyThemePreference`
in `lib/theme.ts` handles the actual DOM mutation. Separation keeps the hook
testable without DOM.

### Storage resilience
Every `localStorage` access is wrapped in try/catch — private browsing, quota
limits, or Safari's ITP can all throw. Degrade silently.

### Auth state resets
`resetClientState` is a ref-wrapped callback composed from `reset()` methods of
data hooks (useExpenses, useReceiptQueue). This breaks a circular dependency:
`useAuth` needs to call it on sign-out, but the data hooks need the session from
`useAuth`. The ref pattern lets `useAuth` invoke the current reset without
depending on identity.

### Guest session
`guest-${crypto.randomUUID()}` stored in localStorage under
`smartspend:guest-session`. Created eagerly on mount. The `"guest-"` prefix is
verified server-side.

## Testing patterns

`test_api.py` uses `TestClient` with SQLite tempfile + dependency override.

**Critical ordering**:
1. Set `DATABASE_URL` env var to a tempfile BEFORE any imports
2. Clear SUPABASE env vars so no HTTP calls escape
3. Import the app modules (triggers DDL migrations against the test DB)
4. Override `get_db` with a test session bound to the same file
5. Mock `deps.ocr_engine` (not `main.ocr_engine` — see module-qualified note)

**Mock `get_historical_rate` for reconvert tests**: use `side_effect` function
that simulates real contract (None date → failure, valid date → rate) to prove
the endpoint sanitizes dates before passing them.

**Guest isolation test**: creates expenses under two guest IDs, verifies one
can't see the other's data.

## PITFALLS (things that broke and why)

### 1. Supabase transaction pooler breaks SQLAlchemy
The Transaction Pooler (port 6543) doesn't support prepared statements — SQLAlchemy
silently fails. Fix: use Session Pooler (port 5432) + `pool_pre_ping` +
`pool_recycle=300`.

### 2. Auth email changes via Admin API
Writing `email` to Supabase's `user_metadata` via Admin API silently changes the
user's login email (skipping verification). Fix: only mirror display/profile
fields, never the email field.

### 3. Undated receipts crash batch reconvert
OCR extracts `date: "Unknown"` for unreadable dates. `datetime.fromisoformat("Unknown")`
raises `ValueError`. Fix: sanitize `raw_date` before passing — anything non-parseable
→ None → graceful per-row failure.

### 4. Global image_path index causes cross-owner collisions
Original: `UNIQUE INDEX ON expenses(image_path)`. Two different users scanning the
same receipt crashes one write. Fix: owner-scoped unique index
`ON expenses(owner_id, image_path)`.

### 5. `from deps import` breaks mock patching
If a router does `from deps import ocr_engine`, reassigning `deps.ocr_engine = mock`
doesn't work — the router's local binding is unchanged. Fix: always use
`deps.ocr_engine` (module-qualified access) in router code.

### 6. Z.AI SDK image format
Z.AI rejects raw image bytes — must be base64 data URL. Gemini accepts both.
This difference is abstracted inside each extractor class.

### 7. Recharts `<ResponsiveContainer>` width=-1 on first render
`ResponsiveContainer` can't measure its own parent before layout. Fix:
`ChartFrame` wrapper with `ResizeObserver` that only renders children after
concrete dimensions are available.

### 8. HEIC/HEIF unsupported in browser `<img>` tags
Browsers can't preview HEIC images. Fix: detect HEIC/HEIF by extension + MIME
type and skip them with a toast message guiding the user to convert.

### 9. `save()` race between OCR and expense creation
Concurrent quick saves fire twice. Fix: `saveLockRef` (a ref, not state) guards
the entry point. State-only guards (`isSaving`) have a stale-closure window in
React 18 concurrent rendering.

### 10. Supabase sign-up with enumeration protection
When Supabase's "Protect email enumeration" is on, duplicate sign-up returns a
user object with empty `identities[]` instead of an error. Fix: check
`data.user.identities?.length === 0` after sign-up and route to sign-in.

### 11. SQLite vs Postgres migration divergence
Migration syntax differs per dialect:
- SQLite: `PRAGMA table_info` → Python membership check → `ALTER TABLE`
- Postgres: `ALTER TABLE ADD COLUMN IF NOT EXISTS`
`database.py` branchez on the URL scheme.

### 12. Password recovery mode strand
If a user's session expires while the "set a new password" form is open, they're
stranded in recovery mode with no way back. Fix: clear `recoveryMode` in the
`SIGNED_OUT` auth state handler.

## CATEGORIES: fixed base + user-custom

Base categories (`BASE_CATEGORY_OPTIONS`) are a closed set defined server-side.
Users can add custom categories stored as JSON in `custom_categories_json` on
`AccountSettings`. Frontend merges base + custom in a `Set` for the category
dropdown.

The server validates: `_normalize_categories()` strips non-strings, trims
whitespace, deduplicates.

## CSS: Tailwind + custom properties

Uses Tailwind utility classes mixed with CSS custom properties for theming.
The `@apply` pattern is avoided — bare utility classes are easier to override
per-component.

Custom properties are set on `:root` and `[data-theme="dark"]` selectors via
JavaScript (not Tailwind's `dark:` prefix alone), giving the `system` theme mode
real reactivity via `matchMedia` listener.
