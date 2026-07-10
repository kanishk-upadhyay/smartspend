export const API_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')
).replace(/\/$/, '');

export const getReceiptUrl = (imagePath: string) =>
  /^https?:\/\//i.test(imagePath) ? imagePath : `${API_URL}/uploads/${imagePath}`;

export interface Expense {
  id: number;
  vendor: string;
  total_amount: number;
  date: string;
  category: string;
  currency?: string;
  source_currency?: string;
  raw_total_amount?: number;
  receipt_date?: string;
  fx_rate_date?: string | null;
  currency_warning?: string | null;
  item_warning?: string | null;
  items?: { name: string; amount: number; raw_amount?: number; currency?: string; source_currency?: string; fx_rate_date?: string; qty?: number }[];
  image_path?: string | null;
}

export interface UploadResult {
  filename?: string;
  image_path?: string | null;
  extracted_data: ExtractedData;
}

export interface ExtractedData {
  vendor: string;
  total_amount: number;
  date: string;
  currency?: string;
  source_currency?: string;
  raw_total_amount?: number;
  receipt_date?: string;
  fx_rate_date?: string | null;
  detected_currencies?: string[];
  currency_warning?: string | null;
  item_warning?: string | null;
  items?: { name: string; amount: number; raw_amount?: number; currency?: string; source_currency?: string; fx_rate_date?: string; qty?: number }[];
  category?: string;
}

export interface AccountSettingsPayload {
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  currency?: string | null;
  theme?: 'system' | 'light' | 'dark' | null;
  custom_categories?: string[];
}

export const DEFAULT_CURRENCY = 'INR';
// Common ISO 4217 codes offered in the account preference. A closed list keeps a
// typo from producing a nonsense code (e.g. "XYZ 1,234") anywhere it's formatted.
export const CURRENCY_OPTIONS = ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'AED', 'SGD'];
export const DEFAULT_CATEGORY = 'General';
export const BASE_CATEGORY_OPTIONS = ['Food', 'Groceries', 'Transport', 'Travel', 'Shopping', 'Bills', 'Medical', 'Entertainment', 'Education', DEFAULT_CATEGORY];
export const LAST_RECEIPT_CURRENCY_KEY = 'smartspend:lastReceiptCurrency';
export const PREFERRED_HISTORY_CURRENCY_KEY = 'smartspend:preferredHistoryCurrency';
export const CATEGORY_STORAGE_KEY = 'smartspend:custom-categories';
export const GUEST_SESSION_KEY = 'smartspend:guest-session';

export const loadOrCreateGuestSessionId = () => {
  try {
    const existing = localStorage.getItem(GUEST_SESSION_KEY);
    if (existing) return existing;
    const created = `guest-${crypto.randomUUID()}`;
    localStorage.setItem(GUEST_SESSION_KEY, created);
    return created;
  } catch {
    return `guest-${crypto.randomUUID()}`;
  }
};

export const loadCustomCategories = () => {
  try {
    const raw = localStorage.getItem(CATEGORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0 && !BASE_CATEGORY_OPTIONS.includes(value));
  } catch {
    return [];
  }
};

export const saveToStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
};

export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });

const _moneyFmt = new Map<string, Intl.NumberFormat>();
export const formatMoney = (amount: number, currency = DEFAULT_CURRENCY) => {
  try {
    let fmt = _moneyFmt.get(currency);
    if (!fmt) {
      fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
      _moneyFmt.set(currency, fmt);
    }
    return fmt.format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${currency} ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
  }
};

const _dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
export const formatDate = (iso: string) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || 'Unknown';
  try {
    return _dateFmt.format(new Date(`${iso}T00:00:00`));
  } catch {
    return iso;
  }
};

// Native <input type="date"> only accepts an ISO YYYY-MM-DD string (or empty).
// OCR can yield "Unknown" or a malformed value — coerce anything non-ISO to ''
// so the control stays valid/controlled and undated receipts render blank.
export const toDateInputValue = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';

// A total/amount is saveable only if it parses to a finite, non-negative number.
// Blocks empty and negative inputs before they reach the `Number(...) || 0` path.
export const isValidAmount = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0;
};

export const getStoredLastReceiptCurrency = () => {
  try {
    return localStorage.getItem(LAST_RECEIPT_CURRENCY_KEY);
  } catch {
    return null;
  }
};

export const getStoredPreferredHistoryCurrency = () => {
  try {
    return localStorage.getItem(PREFERRED_HISTORY_CURRENCY_KEY) || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

export const getErrorMessage = (error: unknown, fallback: string) => {
  const err = error as {
    response?: { data?: { detail?: string; message?: string } };
    message?: string;
  } | undefined;
  return err?.response?.data?.detail || err?.response?.data?.message || err?.message || fallback;
};

export type View = 'dashboard' | 'analytics' | 'history' | 'account';

// Number inputs hold raw strings (so the field can be cleared); coerce at the
// save boundary so the backend never persists a string in a numeric column.
export const coerceItems = (items: Expense['items']) =>
  (items ?? []).map(i => ({
    ...i,
    amount: Number(i.amount) || 0,
    qty: i.qty == null || (i.qty as unknown as string) === '' ? undefined : Number(i.qty),
  }));

// Stable signature of the user-editable fields, type-normalized so a number that
// became a string while typing doesn't read as a change.
export const editSignature = (e: Expense) =>
  JSON.stringify({
    vendor: e.vendor,
    date: e.date,
    category: e.category,
    currency: e.currency ?? '',
    total_amount: Number(e.total_amount) || 0,
    items: coerceItems(e.items),
  });
