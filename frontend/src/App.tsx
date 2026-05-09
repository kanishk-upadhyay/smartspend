import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import {
  Upload,
  History,
  BarChart3,
  CheckCircle2,
  Loader2,
  Search,
  Filter,
  LayoutDashboard,
  ChevronDown,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';

const API_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')
).replace(/\/$/, '');

const getReceiptUrl = (imagePath: string) =>
  /^https?:\/\//i.test(imagePath) ? imagePath : `${API_URL}/uploads/${imagePath}`;

interface Expense {
  id: number;
  vendor: string;
  total_amount: number;
  date: string;
  category: string;
  currency?: string;
  source_currency?: string;
  raw_total_amount?: number;
  receipt_date?: string;
  fx_rate_date?: string;
  currency_warning?: string | null;
  item_warning?: string | null;
  items?: { name: string; amount: number; raw_amount?: number; currency?: string; source_currency?: string; fx_rate_date?: string; qty?: number }[];
  image_path?: string | null;
}

interface UploadResult {
  filename?: string;
  image_path?: string | null;
  extracted_data: ExtractedData;
}

interface Toast {
  id: number;
  message: string;
  tone?: 'info' | 'accent' | 'danger';
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface ExtractedData {
  vendor: string;
  total_amount: number;
  date: string;
  currency?: string;
  source_currency?: string;
  raw_total_amount?: number;
  receipt_date?: string;
  fx_rate_date?: string;
  detected_currencies?: string[];
  currency_warning?: string | null;
  item_warning?: string | null;
  items?: { name: string; amount: number; raw_amount?: number; currency?: string; source_currency?: string; fx_rate_date?: string; qty?: number }[];
  category?: string;
}

// Editorial palette — magenta carries the one-voice rule. Pie slices step through a
// single-hue tonal scale (graphite → ash) with magenta only on the leading slice.
const SLICE_COLORS = [
  'oklch(60% 0.25 350)',
  'oklch(25% 0 0)',
  'oklch(40% 0 0)',
  'oklch(55% 0 0)',
  'oklch(70% 0 0)',
];
const ACCENT = 'oklch(60% 0.25 350)';
const TEXT_DIM = 'oklch(55% 0 0)';

const DEFAULT_CURRENCY = 'INR';
const DEFAULT_CATEGORY = 'General';
const CATEGORY_OPTIONS = ['Food', 'Transport', 'Shopping', 'Bills', DEFAULT_CATEGORY];
const LAST_RECEIPT_CURRENCY_KEY = 'smartspend:lastReceiptCurrency';
const PREFERRED_HISTORY_CURRENCY_KEY = 'smartspend:preferredHistoryCurrency';

const saveToStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
};

const formatMoney = (amount: number, currency = DEFAULT_CURRENCY) => {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${currency} ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
  }
};

const getStoredLastReceiptCurrency = () => {
  try {
    return localStorage.getItem(LAST_RECEIPT_CURRENCY_KEY);
  } catch {
    return null;
  }
};

const getStoredPreferredHistoryCurrency = () => {
  try {
    return localStorage.getItem(PREFERRED_HISTORY_CURRENCY_KEY) || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

const getErrorMessage = (error: unknown, fallback: string) => {
  const err = error as {
    response?: { data?: { detail?: string; message?: string } };
    message?: string;
  } | undefined;
  return err?.response?.data?.detail || err?.response?.data?.message || err?.message || fallback;
};

type View = 'dashboard' | 'analytics' | 'history';

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [showItemsModal, setShowItemsModal] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [historyCurrencyMode, setHistoryCurrencyMode] = useState<'converted' | 'source'>('converted');
  const [lastReceiptCurrency, setLastReceiptCurrency] = useState<string | null>(getStoredLastReceiptCurrency);
  const [preferredHistoryCurrency, setPreferredHistoryCurrency] = useState<string>(getStoredPreferredHistoryCurrency);
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [categoryWasSuggested, setCategoryWasSuggested] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<string>('');
  const [showHeicHelper, setShowHeicHelper] = useState(false);
  const [lastWasHeic, setLastWasHeic] = useState(false);
  const [editDraft, setEditDraft] = useState<Expense | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const deletionTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const availableCategories = useMemo(() => {
    const s = Array.from(new Set(expenses.map(e => e.category))).sort();
    return s.length ? s : [DEFAULT_CATEGORY];
  }, [expenses]);

  const toggleCategory = (cat: string) => {
    setFilterCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  };

  const clearFilters = () => setFilterCategories([]);

  const fetchExpenses = async () => {
    try {
      const response = await axios.get(`${API_URL}/expenses`);
      setExpenses(response.data.reverse());
    } catch (error) {
      console.error('Fetch failed:', error);
      setAnnouncement(`Unable to load expenses: ${getErrorMessage(error, 'Unknown error')}`);
    }
  };

  useEffect(() => {
    const load = async () => {
      await fetchExpenses();
    };
    load();
  }, []);

  const totalSpent = useMemo(
    () => expenses.reduce((sum, exp) => sum + exp.total_amount, 0),
    [expenses]
  );

  const filteredExpenses = useMemo(() => {
    return expenses.filter(exp => {
      const matchesQuery = searchQuery.trim() === '' || exp.vendor.toLowerCase().includes(searchQuery.toLowerCase()) || exp.category.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = filterCategories.length === 0 || filterCategories.includes(exp.category);
      return matchesQuery && matchesCategory;
    });
  }, [expenses, searchQuery, filterCategories]);

  const chartData = useMemo(() => {
    const categories: Record<string, number> = {};
    expenses.forEach(exp => {
      categories[exp.category] = (categories[exp.category] || 0) + exp.total_amount;
    });
    return Object.entries(categories)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [expenses]);

  const timeSeriesData = useMemo(() => {
    const daily: Record<string, number> = {};
    expenses.forEach(exp => {
      const iso = exp.receipt_date || exp.date;
      if (!iso || iso === 'Unknown' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      daily[iso] = (daily[iso] || 0) + exp.total_amount;
    });
    const sorted = Object.entries(daily)
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return sorted.slice(-30).map(d => ({
      ...d,
      label: d.date.slice(5).replace('-', '/'),
    }));
  }, [expenses]);

  const topMerchants = useMemo(() => {
    const tally: Record<string, { count: number; total: number }> = {};
    expenses.forEach(exp => {
      const v = exp.vendor || 'Unknown';
      if (!tally[v]) tally[v] = { count: 0, total: 0 };
      tally[v].count += 1;
      tally[v].total += exp.total_amount;
    });
    return Object.entries(tally)
      .map(([vendor, { count, total }]) => ({ vendor, count, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [expenses]);

  const largestReceipt = useMemo(() => {
    if (!expenses.length) return null;
    return expenses.reduce((max, exp) => exp.total_amount > max.total_amount ? exp : max, expenses[0]);
  }, [expenses]);

  const currentReceiptSourceCurrency = result?.extracted_data.source_currency || null;
  const currentReceiptCurrencies = result?.extracted_data.detected_currencies || [];
  const shouldShowCurrencyNotice = Boolean(
    result &&
    currentReceiptSourceCurrency &&
    currentReceiptSourceCurrency !== DEFAULT_CURRENCY &&
    (
      currentReceiptCurrencies.length === 2 ||
      (lastReceiptCurrency && lastReceiptCurrency !== currentReceiptSourceCurrency)
    )
  );

  const selectedExpenseSourceCurrency = selectedExpense?.source_currency || selectedExpense?.currency || DEFAULT_CURRENCY;
  const selectedExpenseDisplayCurrency = selectedExpense?.currency || DEFAULT_CURRENCY;
  const canToggleHistoryCurrency = Boolean(
    selectedExpense &&
    selectedExpense.raw_total_amount !== undefined &&
    selectedExpenseSourceCurrency !== selectedExpenseDisplayCurrency
  );
  const historyDisplayAmount = selectedExpense
    ? (historyCurrencyMode === 'source' && selectedExpense.raw_total_amount !== undefined
      ? selectedExpense.raw_total_amount
      : selectedExpense.total_amount)
    : 0;
  const historyDisplayCurrency = selectedExpense
    ? (historyCurrencyMode === 'source' && selectedExpense.raw_total_amount !== undefined
      ? selectedExpenseSourceCurrency
      : selectedExpenseDisplayCurrency)
    : DEFAULT_CURRENCY;

  const isHeicFile = (f: File) => {
    const lower = (f.type || f.name || '').toLowerCase();
    return lower.includes('heic') || lower.includes('heif') ||
      f.name.toLowerCase().endsWith('.heic') || f.name.toLowerCase().endsWith('.heif');
  };

  const enqueueFiles = (incoming: File[]) => {
    const heicCount = incoming.filter(isHeicFile).length;
    const acceptable = incoming.filter(f => !isHeicFile(f));

    if (heicCount > 0) {
      setLastWasHeic(true);
      pushToast({
        message: heicCount === incoming.length
          ? 'HEIC / HEIF can\'t be previewed in browsers. Convert to JPEG or PNG.'
          : `Skipped ${heicCount} HEIC/HEIF file${heicCount === 1 ? '' : 's'} — convert to JPEG/PNG.`,
        tone: 'danger',
        duration: 5000,
      });
    } else {
      setLastWasHeic(false);
    }

    if (!acceptable.length) return;

    setPendingFiles(prev => [...prev, ...acceptable]);
    setAnnouncement(
      acceptable.length === 1
        ? `Queued ${acceptable[0].name}.`
        : `Queued ${acceptable.length} receipts.`
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length) {
      enqueueFiles(Array.from(e.target.files));
      try { e.target.value = ''; } catch (err) { console.warn('Could not clear file input', err); }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) {
      enqueueFiles(Array.from(e.dataTransfer.files));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (editDraft) {
        setEditDraft(null);
      } else if (showItemsModal) {
        setShowItemsModal(false);
      } else if (showHeicHelper) {
        setShowHeicHelper(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editDraft, showHeicHelper, showItemsModal]);

  const runOcr = async (file: File) => {
    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await axios.post<UploadResult>(`${API_URL}/upload`, formData);
      setResult(response.data);
      const suggested = response.data?.extracted_data?.category;
      if (suggested && CATEGORY_OPTIONS.includes(suggested)) {
        setCategory(suggested);
        setCategoryWasSuggested(true);
      } else {
        setCategory(DEFAULT_CATEGORY);
        setCategoryWasSuggested(false);
      }
      const warn = response.data?.extracted_data?.item_warning || response.data?.extracted_data?.currency_warning;
      if (warn) {
        pushToast({ message: warn, tone: 'accent', duration: 5000 });
      }
      setAnnouncement(warn || `Read ${file.name}`);
    } catch (error: unknown) {
      console.error('Upload failed:', error);
      const msg = getErrorMessage(error, 'Upload failed');
      pushToast({ message: `${file.name}: ${msg}`, tone: 'danger', duration: 5000 });
      setAnnouncement(`Upload failed: ${msg}`);
      // Drop the failed file from the queue and try the next one
      setPendingFiles(prev => prev.slice(1));
    } finally {
      setLoading(false);
    }
  };

  // Auto-process queue head whenever it's ready and nothing is in flight
  useEffect(() => {
    if (!loading && !result && pendingFiles.length > 0) {
      runOcr(pendingFiles[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles, loading, result]);

  const skipCurrent = () => {
    setResult(null);
    setCategoryWasSuggested(false);
    setPendingFiles(prev => prev.slice(1));
    setAnnouncement('Skipped');
  };

  const clearQueue = () => {
    setPendingFiles([]);
    setResult(null);
    setCategoryWasSuggested(false);
    setAnnouncement('Queue cleared');
  };

  const saveExpense = async () => {
    if (!result || isSaving) return;
    setIsSaving(true);
    try {
      const sourceCurrency = result.extracted_data.source_currency || DEFAULT_CURRENCY;
      const receiptDate = result.extracted_data.receipt_date || result.extracted_data.date;
      const payload = {
        vendor: result.extracted_data.vendor,
        total_amount: parseFloat(result.extracted_data.total_amount.toString()),
        date: result.extracted_data.date,
        category: category,
        currency: result.extracted_data.currency || DEFAULT_CURRENCY,
        source_currency: sourceCurrency,
        raw_total_amount: result.extracted_data.raw_total_amount ?? result.extracted_data.total_amount,
        receipt_date: receiptDate,
        fx_rate_date: result.extracted_data.fx_rate_date || null,
        currency_warning: result.extracted_data.currency_warning || null,
        item_warning: result.extracted_data.item_warning || null,
        items: result.extracted_data.items || [],
        image_path: result.image_path || null,
      };
      await axios.post(`${API_URL}/expenses`, payload);
      saveToStorage(LAST_RECEIPT_CURRENCY_KEY, sourceCurrency);
      setLastReceiptCurrency(sourceCurrency);
      setResult(null);
      setCategoryWasSuggested(false);
      // pop the saved file off the queue; the effect picks up the next one
      setPendingFiles(prev => prev.slice(1));
      pushToast({ message: `Saved ${payload.vendor || 'receipt'}.`, tone: 'accent' });
      fetchExpenses();
    } catch (error) {
      console.error('Save failed:', error);
      pushToast({ message: `Save failed: ${getErrorMessage(error, 'Unknown error')}`, tone: 'danger', duration: 5000 });
      setAnnouncement(`Unable to save expense: ${getErrorMessage(error, 'Unknown error')}`);
    } finally {
      setIsSaving(false);
    }
  };

  const exportCSV = () => {
    const headers = ['id', 'vendor', 'category', 'date', 'total_amount'];
    const rows = expenses.map(e => [e.id, '"' + String(e.vendor).replace(/"/g, '""') + '"', e.category, e.date, e.total_amount].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'expenses.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleEditExpense = (exp: Expense) => {
    setEditDraft({ ...exp });
  };

  const saveEdit = async () => {
    if (!editDraft) return;
    const payload: Partial<Expense> = {
      vendor: editDraft.vendor,
      total_amount: Number(editDraft.total_amount),
      date: editDraft.date,
      category: editDraft.category,
      currency: editDraft.currency || DEFAULT_CURRENCY,
      source_currency: editDraft.source_currency || editDraft.currency || DEFAULT_CURRENCY,
      raw_total_amount: editDraft.raw_total_amount ?? editDraft.total_amount,
      receipt_date: editDraft.receipt_date || editDraft.date,
      fx_rate_date: editDraft.fx_rate_date || undefined,
      currency_warning: editDraft.currency_warning || undefined,
      items: editDraft.items || [],
    };
    try {
      await axios.put(`${API_URL}/expenses/${editDraft.id}`, payload);
      setExpenses(prev => prev.map(item => item.id === editDraft.id ? { ...item, ...payload } : item));
      setSelectedExpense(prev => prev && prev.id === editDraft.id ? { ...prev, ...payload } : prev);
      setEditDraft(null);
      setAnnouncement('Entry updated');
    } catch (error) {
      console.error('Update failed', error);
      setAnnouncement(`Unable to update expense: ${getErrorMessage(error, 'Unknown error')}`);
    }
  };

  const dismissToast = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const pushToast = (toast: Omit<Toast, 'id'>): number => {
    const id = ++toastIdRef.current;
    const duration = toast.duration ?? 4000;
    setToasts(prev => [...prev, { ...toast, id, duration }]);
    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration);
    }
    return id;
  };

  const handleDeleteExpense = (exp: Expense) => {
    // Optimistically remove + show 5s undo toast. Actual DELETE fires when the timer resolves.
    setExpenses(prev => prev.filter(item => item.id !== exp.id));
    setShowItemsModal(false);
    setSelectedExpense(null);
    setAnnouncement(`Deleted ${exp.vendor || 'receipt'}`);

    const toastId = pushToast({
      message: `Deleted ${exp.vendor || 'receipt'}.`,
      tone: 'info',
      duration: 5000,
      action: {
        label: 'Undo',
        onClick: () => {
          const timer = deletionTimers.current.get(exp.id);
          if (timer) clearTimeout(timer);
          deletionTimers.current.delete(exp.id);
          setExpenses(prev => [exp, ...prev].sort((a, b) =>
            (b.receipt_date || b.date || '').localeCompare(a.receipt_date || a.date || '')
          ));
          dismissToast(toastId);
          setAnnouncement('Deletion undone');
        },
      },
    });

    const timer = setTimeout(async () => {
      deletionTimers.current.delete(exp.id);
      try {
        await axios.delete(`${API_URL}/expenses/${exp.id}`);
      } catch (error) {
        console.error('Delete failed', error);
        // restore on failure so the user isn't silently lying to
        setExpenses(prev => [exp, ...prev].sort((a, b) =>
          (b.receipt_date || b.date || '').localeCompare(a.receipt_date || a.date || '')
        ));
        pushToast({
          message: `Unable to delete: ${getErrorMessage(error, 'Unknown error')}`,
          tone: 'danger',
          duration: 5000,
        });
      }
    }, 5000);
    deletionTimers.current.set(exp.id, timer);
  };

  const navItem = (view: View, label: string, Icon: React.ComponentType<{ className?: string }>) => {
    const active = currentView === view;
    return (
      <button
        onClick={() => setCurrentView(view)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={`group flex items-center gap-3 py-2 transition-colors duration-150 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-soft-charcoal)] hover:text-[var(--color-accent)]'}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block w-1.5 h-1.5 transition-opacity duration-150 ${active ? 'opacity-100' : 'opacity-0'}`}
          style={{ backgroundColor: 'var(--color-accent)' }}
        />
        <Icon className="w-4 h-4" />
        <span className="font-body text-sm font-medium">{label}</span>
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="grid grid-cols-1 lg:grid-cols-12 min-h-screen mx-auto" style={{ maxWidth: 'var(--width-max)' }}>

        {/* Sidebar — quiet editorial nav, no glow, no watermark */}
        <nav className="lg:col-span-2 lg:sticky lg:top-0 lg:self-start lg:h-screen px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-12 border-b lg:border-b-0 lg:border-r border-[var(--color-paper-mist)] flex flex-col sm:flex-row lg:flex-col gap-4 sm:gap-6 lg:gap-8">
          <div className="flex items-baseline gap-2">
            <span className="display-italic text-3xl">Smart</span>
            <span className="font-body text-sm font-medium tracking-[0.1em] uppercase text-[var(--color-mid-ash)]">Spend</span>
          </div>
          <div className="flex flex-wrap sm:flex-nowrap lg:flex-col gap-3 sm:gap-6 lg:gap-2 lg:mt-6">
            {navItem('dashboard', 'Dashboard', LayoutDashboard)}
            {navItem('analytics', 'Analytics', BarChart3)}
            {navItem('history', 'Receipts', History)}
          </div>
        </nav>

        {/* Main */}
        <main className="lg:col-span-10 overflow-y-auto overflow-x-hidden custom-scrollbar">

          <AnimatePresence mode="wait">
            {currentView === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="px-4 sm:px-6 lg:px-12 py-10 sm:py-14 lg:py-20 mx-auto"
                style={{ maxWidth: 'var(--width-content)' }}
              >
                <header className="mb-12 sm:mb-16 lg:mb-20">
                  <p className="micro-label mb-4">Receipts · Capture</p>
                  <h1 className="display-italic" style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)' }}>Today's ledger.</h1>
                  <p className="title-italic mt-4 text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2.5vw, 1.5rem)' }}>
                    {expenses.length} {expenses.length === 1 ? 'receipt' : 'receipts'} · {formatMoney(totalSpent, DEFAULT_CURRENCY)} total.
                  </p>
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                  {/* Capture */}
                  <section className="lg:col-span-5">
                    <p className="micro-label mb-6">Capture receipts</p>

                    <label
                      onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true); }}
                      onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                      onDrop={handleDrop}
                      className={`block relative border border-dashed flex flex-col items-center justify-center transition-colors duration-150 cursor-pointer py-12 sm:py-16 lg:py-20 bg-[var(--color-crisp-paper-white)] ${isDragging ? 'border-[var(--color-accent)]' : 'border-[var(--color-paper-mist)] hover:border-[var(--color-accent)]'}`}
                      style={{ borderRadius: 'var(--radius-md)' }}
                    >
                      {loading ? (
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-8 h-8 text-[var(--color-accent)] animate-spin" />
                          <p className="font-body text-sm text-[var(--color-soft-charcoal)] italic truncate max-w-[180px] sm:max-w-[260px]">
                            Reading {pendingFiles[0]?.name || 'receipt'}…
                          </p>
                        </div>
                      ) : pendingFiles.length > 0 ? (
                        <div className="flex flex-col items-center gap-2">
                          <Upload className="w-8 h-8 text-[var(--color-accent)]" />
                          <p className="font-body text-sm text-[var(--color-deep-graphite)]">
                            {pendingFiles.length} {pendingFiles.length === 1 ? 'receipt' : 'receipts'} queued
                          </p>
                          <p className="micro-label">Reviewing on the right</p>
                        </div>
                      ) : (
                        <>
                          <Upload className={`w-8 h-8 mb-4 ${isDragging ? 'text-[var(--color-accent)]' : 'text-[var(--color-mid-ash)]'}`} />
                          <p className="font-body text-sm text-[var(--color-soft-charcoal)]">
                            {isDragging ? 'Drop to queue.' : 'Drop receipts, or click to browse.'}
                          </p>
                          <p className="font-body text-xs text-[var(--color-mid-ash)] italic mt-2">
                            One or many · JPG, PNG, PDF, WebP
                          </p>
                        </>
                      )}
                      <input
                        type="file"
                        accept="image/*,application/pdf,.heic,.heif"
                        multiple
                        capture="environment"
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={handleFileUpload}
                        aria-label="Receipt files"
                      />
                    </label>

                    <div className="mt-6 space-y-4">
                      {pendingFiles.length > 1 && (
                        <button onClick={clearQueue} className="btn-quiet btn--sm w-full">
                          Clear queue ({pendingFiles.length})
                        </button>
                      )}

                      {lastWasHeic && (
                        <button onClick={() => setShowHeicHelper(true)} className="font-body text-sm text-[var(--color-accent)] hover:text-[var(--color-editorial-magenta-deep)] underline underline-offset-4 transition-colors">
                          How to convert HEIC / HEIF
                        </button>
                      )}
                    </div>
                  </section>

                  {/* Review form / quiet placeholder */}
                  <aside className="lg:col-span-7">
                    <AnimatePresence mode="wait">
                      {result ? (
                        <motion.div
                          key="verify"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <div className="flex flex-wrap items-baseline gap-3 mb-6">
                            <p className="micro-label">Review</p>
                            <span className="font-mono text-xs text-[var(--color-mid-ash)]">
                              {pendingFiles.length > 1
                                ? `1 of ${pendingFiles.length} · ${pendingFiles.length - 1} remaining`
                                : 'awaiting save'}
                            </span>
                            {pendingFiles.length > 1 && (
                              <button onClick={skipCurrent} className="btn-text ml-auto">Skip</button>
                            )}
                          </div>

                          {result.image_path && (
                            <div className="mb-6 border border-[var(--color-paper-mist)] bg-[var(--color-warm-ash-cream)] flex items-center justify-center overflow-hidden" style={{ borderRadius: 'var(--radius-md)' }}>
                              {result.image_path.toLowerCase().endsWith('.pdf') ? (
                                <embed src={getReceiptUrl(result.image_path)} type="application/pdf" className="w-full h-64" />
                              ) : (
                                <a href={getReceiptUrl(result.image_path)} target="_blank" rel="noreferrer" className="block">
                                  <img src={getReceiptUrl(result.image_path)} alt={pendingFiles[0]?.name || 'Receipt'} className="max-h-64 object-contain mx-auto" />
                                </a>
                              )}
                            </div>
                          )}

                          <div className="space-y-6">
                            <div>
                              <label className="micro-label block mb-2">Merchant</label>
                              <input
                                value={result.extracted_data.vendor}
                                onChange={(e) => setResult({ ...result, extracted_data: { ...result.extracted_data, vendor: e.target.value } })}
                                className="input-editorial"
                              />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                              <div>
                                <label className="micro-label block mb-2">Total</label>
                                <input
                                  type="number"
                                  value={result.extracted_data.total_amount}
                                  onChange={(e) => setResult({ ...result, extracted_data: { ...result.extracted_data, total_amount: parseFloat(e.target.value) } })}
                                  className="input-editorial"
                                />
                                <p className="font-body text-xs text-[var(--color-mid-ash)] mt-2">
                                  {result.extracted_data.currency || DEFAULT_CURRENCY}
                                  {result.extracted_data.source_currency && result.extracted_data.source_currency !== result.extracted_data.currency
                                    ? ` · detected ${result.extracted_data.source_currency}`
                                    : ''}
                                </p>
                                {result.extracted_data.currency_warning && (
                                  <p className="font-body text-xs text-[var(--color-accent)] mt-2">{result.extracted_data.currency_warning}</p>
                                )}
                              </div>

                              <div>
                                <div className="flex items-baseline justify-between mb-2">
                                  <label className="micro-label">Category</label>
                                  {categoryWasSuggested && (
                                    <span className="font-body text-xs text-[var(--color-accent)] italic flex items-center gap-1.5">
                                      <span className="inline-block w-1.5 h-1.5" style={{ backgroundColor: 'var(--color-accent)' }} />
                                      Suggested
                                    </span>
                                  )}
                                </div>
                                <div className="relative">
                                  <select
                                    value={category}
                                    onChange={(e) => { setCategory(e.target.value); setCategoryWasSuggested(false); }}
                                    className="input-editorial appearance-none pr-10"
                                  >
                                    {CATEGORY_OPTIONS.map(opt => (
                                      <option key={opt}>{opt}</option>
                                    ))}
                                  </select>
                                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-mid-ash)] pointer-events-none" />
                                </div>
                              </div>
                            </div>

                            {/* Items editor */}
                            <div className="pt-6 border-t border-[var(--color-paper-mist)]">
                              <p className="micro-label mb-4">Detected items</p>

                              {result.extracted_data.item_warning && (
                                <p className="font-body text-sm text-[var(--color-soft-charcoal)] italic mb-4">
                                  {result.extracted_data.item_warning}
                                </p>
                              )}

                              {shouldShowCurrencyNotice && (
                                <div className="mb-6 pl-4 border-l border-[var(--color-accent)]">
                                  <p className="micro-label text-[var(--color-accent)]">Currency changed</p>
                                  <p className="font-body text-sm text-[var(--color-soft-charcoal)] mt-2">
                                    Detected {currentReceiptSourceCurrency}. Last receipt was {lastReceiptCurrency || 'not recorded'}.
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-3">
                                    <button
                                      onClick={() => {
                                        setPreferredHistoryCurrency(DEFAULT_CURRENCY);
                                        saveToStorage(PREFERRED_HISTORY_CURRENCY_KEY, DEFAULT_CURRENCY);
                                      }}
                                      className="btn-quiet btn--sm"
                                    >
                                      Keep {DEFAULT_CURRENCY}
                                    </button>
                                    <button
                                      onClick={() => {
                                        if (!currentReceiptSourceCurrency) return;
                                        setPreferredHistoryCurrency(currentReceiptSourceCurrency);
                                        saveToStorage(PREFERRED_HISTORY_CURRENCY_KEY, currentReceiptSourceCurrency);
                                      }}
                                      className="btn-primary btn--sm"
                                    >
                                      Use {currentReceiptSourceCurrency}
                                    </button>
                                  </div>
                                </div>
                              )}

                              <div className="space-y-3 overflow-x-auto">
                                <div className="grid min-w-[560px] grid-cols-12 gap-3 px-1">
                                  <p className="micro-label col-span-6">Item</p>
                                  <p className="micro-label col-span-2">Qty</p>
                                  <p className="micro-label col-span-3">Amount</p>
                                  <span className="col-span-1" />
                                </div>
                                {(result.extracted_data.items || []).map((it, idx) => (
                                  <div key={idx} className="grid min-w-[560px] grid-cols-12 gap-3 items-center">
                                    <input
                                      className="input-editorial col-span-6"
                                      value={it.name}
                                      onChange={(e) => setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.map((x, i) => i === idx ? { ...x, name: e.target.value } : x) } }) : r)}
                                    />
                                    <input
                                      type="number"
                                      step="any"
                                      className="input-editorial col-span-2"
                                      value={it.qty ?? ''}
                                      placeholder="—"
                                      onChange={(e) => setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.map((x, i) => i === idx ? { ...x, qty: e.target.value === '' ? undefined : (parseFloat(e.target.value) || 0) } : x) } }) : r)}
                                    />
                                    <input
                                      type="number"
                                      className="input-editorial col-span-3"
                                      value={it.amount}
                                      onChange={(e) => setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.map((x, i) => i === idx ? { ...x, amount: parseFloat(e.target.value) || 0 } : x) } }) : r)}
                                    />
                                    <button
                                      aria-label="Remove item"
                                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                                        e.stopPropagation();
                                        setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.filter((_, i) => i !== idx) } }) : r);
                                      }}
                                      className="btn-text col-span-1 justify-self-end"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}

                                <button
                                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                                    e.stopPropagation();
                                    setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: [...(r.extracted_data.items || []), { name: '', amount: 0 }] } }) : r);
                                  }}
                                  className="btn-quiet btn--sm"
                                >
                                  Add item
                                </button>
                              </div>
                            </div>

                            <button
                              onClick={saveExpense}
                              disabled={isSaving}
                              className="btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              {isSaving ? 'Saving…' : 'Save receipt'}
                            </button>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="empty"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="h-full flex items-center"
                        >
                          <div>
                            <p className="micro-label mb-3">Awaiting</p>
                            <p className="title-italic text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2vw, 1.5rem)' }}>
                              Capture a receipt and a review form will appear here, ready to save.
                            </p>
                            {expenses.length > 0 && (
                              <p className="font-body text-sm text-[var(--color-mid-ash)] mt-6">
                                Average receipt {formatMoney((totalSpent / (expenses.length || 1)) || 0, DEFAULT_CURRENCY)} · across {availableCategories.length} {availableCategories.length === 1 ? 'category' : 'categories'}.
                              </p>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </aside>
                </div>
              </motion.div>
            )}

            {currentView === 'analytics' && (
              <motion.div
                key="analytics"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                 className="px-4 sm:px-6 lg:px-12 py-10 sm:py-14 lg:py-20 mx-auto"
                style={{ maxWidth: 'var(--width-content)' }}
              >
                 <header className="mb-12 sm:mb-16">
                  <p className="micro-label mb-4">Analytics</p>
                  <h1 className="display-italic" style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)' }}>How you spend.</h1>
                  <p className="title-italic mt-4 text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2.5vw, 1.5rem)' }}>
                    The shape of your ledger, at a glance.
                  </p>
                </header>

                {chartData.length === 0 ? (
                  <p className="font-body text-base text-[var(--color-soft-charcoal)] italic">
                    Save a receipt to see allocation and trend.
                  </p>
                ) : (
                  <div className="space-y-20">
                    {/* Top-line stats */}
                    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8 sm:gap-y-10 pb-10 sm:pb-12 border-b border-[var(--color-paper-mist)]">
                      <div>
                        <p className="micro-label mb-2">Total spent</p>
                        <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)' }}>
                          {formatMoney(totalSpent, DEFAULT_CURRENCY)}
                        </p>
                      </div>
                      <div>
                        <p className="micro-label mb-2">Receipts</p>
                        <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)' }}>
                          {expenses.length}
                        </p>
                      </div>
                      <div>
                        <p className="micro-label mb-2">Average</p>
                        <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)' }}>
                          {formatMoney(totalSpent / (expenses.length || 1), DEFAULT_CURRENCY)}
                        </p>
                      </div>
                      <div>
                        <p className="micro-label mb-2">Largest</p>
                        <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)' }}>
                          {largestReceipt ? formatMoney(largestReceipt.total_amount, largestReceipt.currency || DEFAULT_CURRENCY) : '—'}
                        </p>
                        {largestReceipt && (
                          <p className="font-body text-sm text-[var(--color-mid-ash)] italic mt-1 truncate">
                            {largestReceipt.vendor}
                          </p>
                        )}
                      </div>
                    </section>

                    {/* Category allocation */}
                    <section>
                      <p className="micro-label mb-6">By category</p>
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
                        <div className="lg:col-span-5 h-[280px] min-w-0">
                          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
                            <PieChart>
                              <Pie
                                data={chartData}
                                cx="50%"
                                cy="50%"
                                innerRadius={80}
                                outerRadius={120}
                                paddingAngle={2}
                                dataKey="value"
                                stroke="none"
                              >
                                {chartData.map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
                                ))}
                              </Pie>
                              <RechartsTooltip
                                contentStyle={{ backgroundColor: 'var(--color-crisp-paper-white)', border: '1px solid var(--color-paper-mist)', borderRadius: '4px', padding: '10px 14px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                itemStyle={{ color: 'var(--color-deep-graphite)' }}
                                cursor={false}
                                formatter={(v: unknown, name: unknown) => [formatMoney(Number(v), DEFAULT_CURRENCY), String(name)]}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>

                        <div className="lg:col-span-7 space-y-1">
                          {chartData.map((d, i) => {
                            const pct = totalSpent > 0 ? Math.round((d.value / totalSpent) * 100) : 0;
                            return (
                              <div key={i} className="flex items-baseline justify-between gap-4 py-3 border-b border-[var(--color-paper-mist)]">
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="block w-2.5 h-2.5 flex-shrink-0" style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                                  <span className="font-body text-base text-[var(--color-deep-graphite)] truncate">{d.name}</span>
                                </div>
                                <div className="flex items-baseline gap-4 flex-shrink-0">
                                  <span className="font-mono text-xs text-[var(--color-mid-ash)]">{pct}%</span>
                                  <span className="font-body text-base font-medium text-[var(--color-deep-graphite)]">{formatMoney(d.value, DEFAULT_CURRENCY)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </section>

                    {/* Activity over time */}
                    <section>
                      <div className="flex items-baseline justify-between mb-6">
                        <p className="micro-label">Recent activity</p>
                        <span className="font-mono text-xs text-[var(--color-mid-ash)]">
                          {timeSeriesData.length > 0 ? `last ${timeSeriesData.length} ${timeSeriesData.length === 1 ? 'day' : 'days'}` : 'no dated receipts'}
                        </span>
                      </div>
                      {timeSeriesData.length === 0 ? (
                        <p className="font-body text-sm text-[var(--color-mid-ash)] italic">
                          Receipts need parsable dates to plot a timeline. Edit a receipt's date to add it here.
                        </p>
                      ) : (
                        <div className="h-[280px] min-w-0">
                          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
                            <BarChart data={timeSeriesData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="oklch(92% 0 0)" />
                              <XAxis
                                dataKey="label"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: TEXT_DIM, fontSize: 11, fontFamily: 'Instrument Sans, sans-serif' }}
                                dy={10}
                              />
                              <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: TEXT_DIM, fontSize: 11, fontFamily: 'Instrument Sans, sans-serif' }}
                                dx={-8}
                              />
                              <RechartsTooltip
                                cursor={{ fill: 'oklch(92% 0 0 / 0.4)' }}
                                contentStyle={{ backgroundColor: 'var(--color-crisp-paper-white)', border: '1px solid var(--color-paper-mist)', borderRadius: '4px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                labelFormatter={(label, payload) => {
                                  const item = (payload as readonly { payload?: { date?: string } }[])[0]?.payload;
                                  return item?.date || String(label);
                                }}
                                formatter={(v: unknown) => [formatMoney(Number(v), DEFAULT_CURRENCY), 'Total']}
                              />
                              <Bar dataKey="amount" fill={ACCENT} radius={[2, 2, 0, 0]} barSize={20} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </section>

                    {/* Top merchants */}
                    {topMerchants.length > 0 && (
                      <section>
                        <p className="micro-label mb-6">Top merchants</p>
                        <div>
                          {topMerchants.map((m, i) => {
                            const pct = totalSpent > 0 ? (m.total / totalSpent) * 100 : 0;
                            return (
                              <div key={m.vendor} className="py-4 border-b border-[var(--color-paper-mist)]">
                                <div className="flex items-baseline justify-between gap-4 mb-2">
                                  <div className="flex items-baseline gap-4 min-w-0">
                                    <span className="font-mono text-xs text-[var(--color-mid-ash)]">{String(i + 1).padStart(2, '0')}</span>
                                    <span className="font-body text-base text-[var(--color-deep-graphite)] truncate">{m.vendor}</span>
                                    <span className="font-body text-sm text-[var(--color-mid-ash)] italic flex-shrink-0">
                                      {m.count} {m.count === 1 ? 'receipt' : 'receipts'}
                                    </span>
                                  </div>
                                  <span className="font-body text-base font-medium text-[var(--color-deep-graphite)] flex-shrink-0">
                                    {formatMoney(m.total, DEFAULT_CURRENCY)}
                                  </span>
                                </div>
                                <div className="h-px bg-[var(--color-paper-mist)] relative">
                                  <div
                                    className="absolute inset-y-0 left-0"
                                    style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: 'var(--color-accent)', height: '2px', top: '-1px' }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </motion.div>
            )}

            {currentView === 'history' && (
              <motion.div
                key="history"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="px-4 sm:px-6 lg:px-12 py-10 sm:py-14 lg:py-20 mx-auto"
                style={{ maxWidth: 'var(--width-content)' }}
              >
                <header className="mb-12 sm:mb-16">
                  <p className="micro-label mb-4">Receipts</p>
                  <h1 className="display-italic" style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)' }}>Every receipt, in order.</h1>
                </header>

                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 mb-10">
                  <div className="flex-1 max-w-md relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-mid-ash)] pointer-events-none" />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search receipts"
                      aria-label="Search receipts"
                      className="input-editorial pl-9"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                    <div className="relative">
                      <button
                        onClick={() => setFilterOpen(o => !o)}
                        aria-expanded={filterOpen}
                        aria-pressed={filterCategories.length > 0}
                        className="btn-quiet w-full sm:w-auto"
                      >
                        <Filter className="w-4 h-4" />
                        Filter {filterCategories.length > 0 && <span className="font-mono text-xs">({filterCategories.length})</span>}
                      </button>
                      {filterOpen && (
                        <div
                          className="absolute left-0 sm:left-auto sm:right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-[var(--color-crisp-paper-white)] border border-[var(--color-paper-mist)] p-4 z-20"
                          style={{ borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-popover)' }}
                        >
                          <p className="micro-label mb-3">Filter by category</p>
                          <div className="flex flex-col gap-2 max-h-44 overflow-auto pr-2">
                            {availableCategories.map(cat => (
                              <label key={cat} className="flex items-center gap-3 font-body text-sm text-[var(--color-deep-graphite)] cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="checkbox-editorial"
                                  checked={filterCategories.includes(cat)}
                                  onChange={() => toggleCategory(cat)}
                                />
                                <span>{cat}</span>
                              </label>
                            ))}
                          </div>
                          <div className="mt-4 flex justify-between items-center pt-3 border-t border-[var(--color-paper-mist)]">
                            <button onClick={() => { clearFilters(); setFilterOpen(false); }} className="btn-text">
                              Clear
                            </button>
                            <button onClick={() => setFilterOpen(false)} className="btn-primary btn--sm">
                              Done
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button onClick={exportCSV} className="btn-quiet w-full sm:w-auto">
                      Export CSV
                    </button>
                  </div>
                </div>

                {filteredExpenses.length === 0 ? (
                  <div className="py-32 text-center">
                    <p className="title-italic text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2vw, 1.5rem)' }}>
                      No receipts match.
                    </p>
                    <p className="font-body text-sm text-[var(--color-mid-ash)] mt-3">
                      Adjust the search or filters above.
                    </p>
                  </div>
                ) : (
                  <>
                  <div className="md:hidden space-y-3">
                    {filteredExpenses.map((exp) => (
                      <button
                        key={exp.id}
                        onClick={() => {
                          setSelectedExpense(exp);
                          const sourceCurrency = exp.source_currency || exp.currency || DEFAULT_CURRENCY;
                          const displayCurrency = exp.currency || DEFAULT_CURRENCY;
                          setHistoryCurrencyMode(
                            sourceCurrency !== displayCurrency && sourceCurrency === preferredHistoryCurrency ? 'source' : 'converted'
                          );
                          setShowItemsModal(true);
                        }}
                        className="w-full text-left border border-[var(--color-paper-mist)] p-4 bg-[var(--color-crisp-paper-white)]"
                        style={{ borderRadius: 'var(--radius-md)' }}
                      >
                        <p className="font-body text-base font-medium text-[var(--color-deep-graphite)] truncate">{exp.vendor}</p>
                        <p className="font-body text-sm text-[var(--color-soft-charcoal)] italic mt-1">{exp.category}</p>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="font-mono text-xs text-[var(--color-mid-ash)]">{exp.date}</span>
                          <span className="font-body text-base font-medium text-[var(--color-deep-graphite)]">
                            {formatMoney(exp.total_amount, exp.currency || DEFAULT_CURRENCY)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="hidden md:block">
                    <div className="grid grid-cols-12 gap-6 px-2 py-3 sticky top-0 z-10 bg-[var(--color-bg)] border-y border-[var(--color-paper-mist)]">
                      <p className="micro-label col-span-5">Merchant</p>
                      <p className="micro-label col-span-3">Category</p>
                      <p className="micro-label col-span-2">Date</p>
                      <p className="micro-label col-span-2 text-right">Amount</p>
                    </div>
                    {filteredExpenses.map((exp) => (
                      <button
                        key={exp.id}
                        onClick={() => {
                          setSelectedExpense(exp);
                          const sourceCurrency = exp.source_currency || exp.currency || DEFAULT_CURRENCY;
                          const displayCurrency = exp.currency || DEFAULT_CURRENCY;
                          setHistoryCurrencyMode(
                            sourceCurrency !== displayCurrency && sourceCurrency === preferredHistoryCurrency ? 'source' : 'converted'
                          );
                          setShowItemsModal(true);
                        }}
                        className="grid grid-cols-12 gap-6 w-full text-left px-2 py-5 border-b border-[var(--color-paper-mist)] hover:bg-[var(--color-crisp-paper-white)] transition-colors duration-150 items-baseline"
                      >
                        <div className="col-span-5 flex items-baseline gap-3 min-w-0">
                          <span className="font-body text-base font-medium text-[var(--color-deep-graphite)] truncate">{exp.vendor}</span>
                          {exp.source_currency && exp.source_currency !== (exp.currency || DEFAULT_CURRENCY) && (
                            <span className="font-mono text-xs text-[var(--color-accent)] uppercase tracking-[0.1em]">
                              {exp.source_currency}→{exp.currency || DEFAULT_CURRENCY}
                            </span>
                          )}
                        </div>
                        <div className="col-span-3 font-body text-sm text-[var(--color-soft-charcoal)] italic truncate">
                          {exp.category}
                        </div>
                        <div className="col-span-2 font-mono text-xs text-[var(--color-mid-ash)]">
                          {exp.date}
                        </div>
                        <div className="col-span-2 text-right font-body text-base font-medium text-[var(--color-deep-graphite)]">
                          {formatMoney(exp.total_amount, exp.currency || DEFAULT_CURRENCY)}
                        </div>
                      </button>
                    ))}
                  </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* HEIC helper dialog */}
          {showHeicHelper && (
            <div role="dialog" aria-modal="true" aria-labelledby="heic-helper-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
              <button
                type="button"
                aria-label="Close HEIC help dialog"
                className="absolute inset-0 border-0 bg-[var(--color-deep-graphite)]/40 p-0"
                onClick={() => setShowHeicHelper(false)}
              />
              <div
                className="relative z-10 w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-crisp-paper-white)] border border-[var(--color-paper-mist)] p-5 sm:p-8 mt-2 sm:mt-0"
                style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lifted-card)' }}
              >
                <div className="flex justify-end mb-3">
                  <button
                    onClick={() => setShowHeicHelper(false)}
                    aria-label="Close"
                    className="btn-text"
                  >
                    Close
                  </button>
                </div>
                <div className="mb-6">
                  <h3 id="heic-helper-title" className="headline text-2xl text-[var(--color-deep-graphite)]">Convert HEIC / HEIF</h3>
                </div>
                <div className="space-y-4 font-body text-base text-[var(--color-soft-charcoal)]" style={{ lineHeight: 1.65 }}>
                  <p>Most browsers can't preview HEIC/HEIF. Quick fixes:</p>
                  <ul className="space-y-3 list-disc pl-5">
                    <li><strong className="text-[var(--color-deep-graphite)]">macOS Preview:</strong> open in Preview → File → Export → JPEG.</li>
                    <li><strong className="text-[var(--color-deep-graphite)]">iPhone / iPad:</strong> Photos → Share → Save as JPEG.</li>
                    <li><strong className="text-[var(--color-deep-graphite)]">Online:</strong> CloudConvert or image.online-convert.com.</li>
                    <li><strong className="text-[var(--color-deep-graphite)]">Desktop:</strong> <span className="font-mono text-sm">magick input.heic output.jpg</span>.</li>
                  </ul>
                  <p className="text-sm text-[var(--color-mid-ash)] italic">Re-upload the converted JPG/PNG here.</p>
                </div>
                <div className="mt-8 flex justify-end">
                  <button onClick={() => setShowHeicHelper(false)} className="btn-primary">Got it</button>
                </div>
              </div>
            </div>
          )}

          {/* Receipt details modal */}
          {showItemsModal && selectedExpense && (
            <div role="dialog" aria-modal="true" aria-labelledby="receipt-details-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
              <button
                type="button"
                aria-label="Close receipt details dialog"
                className="absolute inset-0 border-0 bg-[var(--color-deep-graphite)]/40 p-0"
                onClick={() => setShowItemsModal(false)}
              />
              <div
                className="relative z-10 w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-crisp-paper-white)] border border-[var(--color-paper-mist)] p-5 sm:p-10 mt-2 sm:mt-0"
                style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lifted-card)' }}
              >
                <div className="flex justify-end mb-3">
                  <button
                    onClick={() => setShowItemsModal(false)}
                    aria-label="Close"
                    className="btn-text"
                  >
                    Close
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between items-start gap-4 sm:gap-6 mb-8">
                  <div>
                    <p className="micro-label mb-3">Receipt</p>
                    <h3 id="receipt-details-title" className="headline text-3xl text-[var(--color-deep-graphite)]">{selectedExpense.vendor}</h3>
                    <p className="font-body text-sm text-[var(--color-mid-ash)] mt-2">
                      {selectedExpense.receipt_date || selectedExpense.date}
                      {selectedExpense.fx_rate_date && <> · FX {selectedExpense.fx_rate_date}</>}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto justify-start sm:justify-end">
                    <button onClick={() => handleEditExpense(selectedExpense)} className="btn-quiet btn--sm">Edit</button>
                    <button onClick={() => handleDeleteExpense(selectedExpense)} className="btn-danger btn--sm">Delete</button>
                  </div>
                </div>

                {selectedExpense.image_path && (
                  <div className="mb-8 border border-[var(--color-paper-mist)] bg-[var(--color-warm-ash-cream)] flex items-center justify-center overflow-hidden" style={{ borderRadius: 'var(--radius-md)' }}>
                    {selectedExpense.image_path.toLowerCase().endsWith('.pdf') ? (
                      <embed src={getReceiptUrl(selectedExpense.image_path)} type="application/pdf" className="w-full h-72" />
                    ) : (
                      <a href={getReceiptUrl(selectedExpense.image_path)} target="_blank" rel="noreferrer" className="block">
                        <img src={getReceiptUrl(selectedExpense.image_path)} alt={`Receipt for ${selectedExpense.vendor}`} className="max-h-80 object-contain mx-auto" />
                      </a>
                    )}
                  </div>
                )}

                <div className="mb-8 pb-8 border-b border-[var(--color-paper-mist)]">
                  <p className="micro-label mb-2">Amount</p>
                  <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>
                    {formatMoney(historyDisplayAmount, historyDisplayCurrency)}
                  </p>
                  {selectedExpense.source_currency && selectedExpense.source_currency !== (selectedExpense.currency || DEFAULT_CURRENCY) && (
                    <div className="mt-3 flex items-center gap-4 flex-wrap">
                      <p className="font-body text-sm text-[var(--color-mid-ash)] italic">
                        {historyCurrencyMode === 'source' ? 'Original receipt currency.' : 'Converted using receipt date.'}
                      </p>
                      {canToggleHistoryCurrency && (
                        <button
                          onClick={() => setHistoryCurrencyMode(historyCurrencyMode === 'converted' ? 'source' : 'converted')}
                          className="btn-text btn-text--accent"
                        >
                          Show {historyCurrencyMode === 'converted' ? selectedExpenseSourceCurrency : 'converted'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <p className="micro-label mb-4">Items</p>
                  {selectedExpense.items && selectedExpense.items.length > 0 ? (
                    <ul>
                      {selectedExpense.items.map((it, i) => {
                        const sourceAmount = it.raw_amount ?? it.amount;
                        const currentAmount = historyCurrencyMode === 'source' && it.raw_amount !== undefined ? sourceAmount : it.amount;
                        const currentCurrency = historyCurrencyMode === 'source' ? selectedExpenseSourceCurrency : (it.currency || selectedExpenseDisplayCurrency);
                        const showQty = typeof it.qty === 'number' && it.qty > 1;
                        return (
                          <li key={i} className="flex justify-between items-baseline gap-6 py-3 border-b border-[var(--color-paper-mist)]">
                            <span className="font-body text-base text-[var(--color-deep-graphite)]">
                              {it.name || 'Item'}
                              {showQty && (
                                <span className="font-mono text-sm text-[var(--color-mid-ash)] ml-2">× {it.qty}</span>
                              )}
                            </span>
                            <span className="font-mono text-sm text-[var(--color-soft-charcoal)]">{formatMoney(Number(currentAmount), currentCurrency)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="font-body text-sm text-[var(--color-mid-ash)] italic">No items recorded for this receipt.</p>
                  )}
                </div>

                {selectedExpense.currency_warning && (
                  <p className="mt-6 font-body text-sm text-[var(--color-accent)] italic">
                    {selectedExpense.currency_warning}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Edit modal */}
          {editDraft && (
            <div role="dialog" aria-modal="true" aria-labelledby="edit-receipt-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
              <button
                type="button"
                aria-label="Close edit receipt dialog"
                className="absolute inset-0 border-0 bg-[var(--color-deep-graphite)]/40 p-0"
                onClick={() => setEditDraft(null)}
              />
              <div
                className="relative z-10 w-full max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-crisp-paper-white)] border border-[var(--color-paper-mist)] p-5 sm:p-10 mt-2 sm:mt-0"
                style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lifted-card)' }}
              >
                <div className="flex justify-end mb-3">
                  <button
                    onClick={() => setEditDraft(null)}
                    aria-label="Close"
                    className="btn-text"
                  >
                    Close
                  </button>
                </div>
                <div className="flex justify-between items-baseline mb-8">
                  <div>
                    <p className="micro-label mb-3">Edit receipt</p>
                    <h3 id="edit-receipt-title" className="headline text-2xl text-[var(--color-deep-graphite)]">{editDraft.vendor || 'Untitled'}</h3>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="micro-label block mb-2">Merchant</label>
                    <input
                      className="input-editorial"
                      value={editDraft.vendor}
                      onChange={(e) => setEditDraft(d => d ? { ...d, vendor: e.target.value } : d)}
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div>
                      <label className="micro-label block mb-2">Total</label>
                      <input
                        type="number"
                        className="input-editorial"
                        value={editDraft.total_amount}
                        onChange={(e) => setEditDraft(d => d ? { ...d, total_amount: parseFloat(e.target.value) || 0 } : d)}
                      />
                    </div>
                    <div>
                      <label className="micro-label block mb-2">Date</label>
                      <input
                        className="input-editorial"
                        value={editDraft.date}
                        onChange={(e) => setEditDraft(d => d ? { ...d, date: e.target.value } : d)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="micro-label block mb-2">Category</label>
                    <div className="relative">
                      <select
                        className="input-editorial appearance-none pr-10"
                        value={editDraft.category}
                        onChange={(e) => setEditDraft(d => d ? { ...d, category: e.target.value } : d)}
                      >
                        {Array.from(new Set([...CATEGORY_OPTIONS, editDraft.category])).map(opt => (
                          <option key={opt}>{opt}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-mid-ash)] pointer-events-none" />
                    </div>
                  </div>
                </div>

                <div className="mt-10 flex flex-col-reverse sm:flex-row justify-end gap-3">
                  <button onClick={() => setEditDraft(null)} className="btn-quiet btn--sm">Cancel</button>
                  <button onClick={saveEdit} className="btn-primary btn--sm">Save changes</button>
                </div>
              </div>
            </div>
          )}

          {/* Toast stack — bottom-right, paper-white, hairline border, optional action */}
          <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col gap-3 pointer-events-none">
            <AnimatePresence>
              {toasts.map(t => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="pointer-events-auto bg-[var(--color-crisp-paper-white)] border border-[var(--color-paper-mist)] px-4 sm:px-5 py-4 flex items-center gap-3 sm:gap-4 w-[calc(100vw-2rem)] sm:w-auto min-w-0 sm:min-w-[280px] max-w-md"
                  style={{ borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-popover)' }}
                >
                  {t.tone === 'accent' && (
                    <span aria-hidden="true" className="block w-2 h-2 flex-shrink-0" style={{ backgroundColor: 'var(--color-accent)' }} />
                  )}
                  <p className="font-body text-sm text-[var(--color-deep-graphite)] flex-1">{t.message}</p>
                  {t.action && (
                    <button
                      onClick={() => { t.action!.onClick(); }}
                      className="btn-text btn-text--accent flex-shrink-0"
                    >
                      {t.action.label}
                    </button>
                  )}
                  <button
                    onClick={() => dismissToast(t.id)}
                    aria-label="Dismiss"
                    className="btn-text flex-shrink-0"
                  >
                    ✕
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div aria-live="polite" style={{ position: 'absolute', left: -9999, top: 'auto' }}>{announcement}</div>

        </main>
      </div>
    </div>
  );
}
