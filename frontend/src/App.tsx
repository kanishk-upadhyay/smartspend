import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
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
  CircleUserRound,
  LogIn,
  LogOut,
  Monitor,
  MoonStar,
  SunMedium,
  ShieldCheck,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  AreaChart,
  Area,
  ReferenceLine,
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { useToasts } from './hooks/useToasts';
import { useTheme } from './hooks/useTheme';
import { useRequestConfig } from './hooks/useRequestConfig';
import { useExpenses } from './hooks/useExpenses';
import { useReceiptQueue } from './hooks/useReceiptQueue';
import { useAuth } from './hooks/useAuth';
import { useAccountSettings } from './hooks/useAccountSettings';
import {
  API_URL,
  getReceiptUrl,
  DEFAULT_CURRENCY,
  CURRENCY_OPTIONS,
  DEFAULT_CATEGORY,
  BASE_CATEGORY_OPTIONS,
  PREFERRED_HISTORY_CURRENCY_KEY,
  saveToStorage,
  formatMoney,
  formatDate,
  toDateInputValue,
  isValidAmount,
  getStoredPreferredHistoryCurrency,
  getErrorMessage,
  coerceItems,
  editSignature,
} from './lib/appConstants';
import type {
  Expense,
  View,
} from './lib/appConstants';

// Editorial palette — magenta carries the one-voice rule. The theme-aware chart
// colors live in useTheme; ACCENT_MUTED is theme-independent and stays here.
const ACCENT_MUTED = 'oklch(60% 0.12 350)';

// Window-scroll virtualizer: renders only visible rows while keeping the app's
// single-document scroll (no inner scrollbox), so large receipt lists stay fast.
function WindowVirtualList<T>({
  items,
  estimateSize,
  getKey,
  renderItem,
}: {
  items: T[];
  estimateSize: number;
  getKey: (item: T) => React.Key;
  renderItem: (item: T) => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      if (parentRef.current) setScrollMargin(parentRef.current.offsetTop);
    };
    measure();
    // Content above the list (e.g. a collapsible filter panel) can change the
    // list's offset without changing item count, which would leave rows misaligned.
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [items.length]);
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    overscan: 8,
    scrollMargin,
  });
  return (
    <div ref={parentRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map(vi => (
        <div
          key={getKey(items[vi.index])}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
          }}
        >
          {renderItem(items[vi.index])}
        </div>
      ))}
    </div>
  );
}

// Measures its own box and hands concrete pixel dimensions to the chart, so we
// never feed Recharts the width(-1) sentinel that ResponsiveContainer logs about.
// The fixed-height className means the box has a real size on first layout.
function ChartFrame({ className, ariaLabel, children }: { className: string; ariaLabel: string; children: (w: number, h: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} role="img" aria-label={ariaLabel}>
      {size.w > 0 && size.h > 0 ? children(size.w, size.h) : null}
    </div>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [showItemsModal, setShowItemsModal] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [historyCurrencyMode, setHistoryCurrencyMode] = useState<'converted' | 'source'>('converted');
  const [preferredHistoryCurrency, setPreferredHistoryCurrency] = useState<string>(getStoredPreferredHistoryCurrency);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [editDraft, setEditDraft] = useState<Expense | null>(null);
  const { toasts, pushToast, dismissToast } = useToasts();
  const deletionTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const editOriginalRef = useRef<string | null>(null);
  const {
    themePreference,
    setThemePreference,
    setThemeAndPersist,
    SLICE_COLORS,
    ACCENT,
    TEXT_DIM,
    GRID_STROKE,
    TOOLTIP_FILL,
  } = useTheme();
  // resetClientState is composed from the data hooks below, but useAuth (which
  // runs first, so it can produce `session` for the data hooks) needs to call it
  // on sign-out. A ref breaks that cycle: useAuth invokes the always-current
  // composed reset without depending on its identity.
  const resetClientStateRef = useRef<() => void>(() => {});
  const callResetClientState = useCallback(() => resetClientStateRef.current(), []);

  const {
    authReady,
    session,
    guestSessionId,
    authMode,
    setAuthMode,
    authEmail,
    setAuthEmail,
    authPassword,
    setAuthPassword,
    showPassword,
    setShowPassword,
    authName,
    setAuthName,
    authBusy,
    authError,
    setAuthError,
    authNotice,
    showResendConfirmation,
    recoveryMode,
    setRecoveryMode,
    recoveryPassword,
    setRecoveryPassword,
    recoveryBusy,
    isSignedIn,
    submitAuth,
    signOut,
    requestPasswordReset,
    resendConfirmation,
    submitNewPassword,
    keepGuestMode,
  } = useAuth({
    resetClientState: callResetClientState,
    setAnnouncement,
    pushToast,
    setCurrentView,
  });
  const isGuestSession = !session?.user;

  const requestConfig = useRequestConfig(session, guestSessionId);
  const {
    expenses,
    setExpenses,
    expensesError,
    listLoading,
    searchQuery,
    setSearchQuery,
    filterCategories,
    setFilterCategories,
    toggleCategory,
    clearFilters,
    availableCategories,
    filteredExpenses,
    fetchExpenses,
    exportCSV,
    reset: resetExpenses,
  } = useExpenses(requestConfig, setAnnouncement);

  // Bridges the receipt-form category state (owned by useReceiptQueue, created
  // below) into useAccountSettings.removeCustomCategory without a render cycle.
  const categoryRef = useRef<{ category: string; setCategory: (value: string) => void }>({
    category: DEFAULT_CATEGORY,
    setCategory: () => {},
  });

  const {
    accountDraft,
    setAccountDraft,
    accountBusy,
    accountError,
    reconvertBusy,
    customCategories,
    categoryDraft,
    setCategoryDraft,
    loadAccountSettings,
    saveAccountSettings,
    reconvertExistingReceipts,
    addCustomCategory,
    removeCustomCategory,
    reset: resetAccount,
  } = useAccountSettings({
    requestConfig,
    session,
    authReady,
    isGuestSession,
    themePreference,
    setThemePreference,
    fetchExpenses,
    setAnnouncement,
    pushToast,
    setAuthName,
    setAuthEmail,
    categoryRef,
    setFilterCategories,
  });

  const categoryOptions = useMemo(() => {
    const extras = customCategories.filter(cat => !BASE_CATEGORY_OPTIONS.includes(cat));
    return Array.from(new Set([...BASE_CATEGORY_OPTIONS, ...extras]));
  }, [customCategories]);

  const {
    loading,
    isSaving,
    result,
    setResult,
    lastReceiptCurrency,
    category,
    setCategory,
    categoryWasSuggested,
    setCategoryWasSuggested,
    showHeicHelper,
    setShowHeicHelper,
    lastWasHeic,
    pendingFiles,
    isDragging,
    setIsDragging,
    prefetchedResults,
    currentFileName,
    handleFileUpload,
    handleDrop,
    skipCurrent,
    clearQueue,
    saveExpense,
    reset: resetReceiptQueue,
  } = useReceiptQueue(requestConfig, fetchExpenses, setAnnouncement, pushToast, categoryOptions, customCategories);
  useLayoutEffect(() => {
    categoryRef.current = { category, setCategory };
  });

  useEffect(() => {
    const timers = deletionTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const totalSpent = useMemo(
    () => expenses.reduce((sum, exp) => sum + exp.total_amount, 0),
    [expenses]
  );

  // The user's preferred currency is the base their receipts are captured into,
  // so dashboards/aggregates are labelled with it. Per-receipt rows keep their
  // own stored currency (handled separately below).
  const aggregateCurrency = accountDraft.currency || DEFAULT_CURRENCY;

  // True when some loaded receipt is not stored in the preferred currency, so
  // the aggregate totals silently mix currencies until the user reconverts.
  const hasMixedAggregateCurrencies = useMemo(
    () => expenses.some(exp => (exp.currency || DEFAULT_CURRENCY) !== aggregateCurrency),
    [expenses, aggregateCurrency]
  );

  const chartData = useMemo(() => {
    const categories: Record<string, number> = {};
    expenses.forEach(exp => {
      categories[exp.category] = (categories[exp.category] || 0) + exp.total_amount;
    });
    return Object.entries(categories)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [expenses]);

  // Cap donut at 6 slices (top 5 + Other) so slice colors never repeat.
  const donutData = useMemo(() => {
    if (chartData.length <= 6) return chartData;
    const top = chartData.slice(0, 5);
    const otherValue = chartData.slice(5).reduce((sum, d) => sum + d.value, 0);
    return [...top, { name: 'Other', value: otherValue }];
  }, [chartData]);

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

  // Spending by weekday — surfaces the user's weekly rhythm (Mon → Sun for easy reading).
  const weekdayData = useMemo(() => {
    const totals = [0, 0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0, 0];
    expenses.forEach(exp => {
      const iso = exp.receipt_date || exp.date;
      if (!iso || iso === 'Unknown' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      const day = new Date(`${iso}T00:00:00`).getDay();
      totals[day] += exp.total_amount;
      counts[day] += 1;
    });
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = [1, 2, 3, 4, 5, 6, 0];
    return order.map(i => ({
      day: labels[i],
      amount: totals[i],
      count: counts[i],
      average: counts[i] > 0 ? totals[i] / counts[i] : 0,
    }));
  }, [expenses]);

  const busiestWeekday = useMemo(() => {
    if (!weekdayData.some(d => d.amount > 0)) return null;
    return weekdayData.reduce((max, d) => (d.amount > max.amount ? d : max), weekdayData[0]);
  }, [weekdayData]);

  // Calendar-month totals — last 12 months with data.
  const monthlyData = useMemo(() => {
    const monthly: Record<string, { amount: number; count: number }> = {};
    expenses.forEach(exp => {
      const iso = exp.receipt_date || exp.date;
      if (!iso || iso === 'Unknown' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      const ym = iso.slice(0, 7);
      if (!monthly[ym]) monthly[ym] = { amount: 0, count: 0 };
      monthly[ym].amount += exp.total_amount;
      monthly[ym].count += 1;
    });
    return Object.entries(monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, { amount, count }]) => {
        const [year, mon] = month.split('-');
        const monthName = new Date(Number(year), Number(mon) - 1).toLocaleString('en-US', { month: 'short' });
        return { month, amount, count, label: `${monthName} '${year.slice(2)}` };
      });
  }, [expenses]);

  const monthOverMonthDelta = useMemo(() => {
    if (monthlyData.length < 2) return null;
    const current = monthlyData[monthlyData.length - 1];
    const prior = monthlyData[monthlyData.length - 2];
    if (prior.amount === 0) return null;
    return {
      current,
      prior,
      delta: current.amount - prior.amount,
      pct: ((current.amount - prior.amount) / prior.amount) * 100,
    };
  }, [monthlyData]);

  const monthlyAvg = useMemo(() => {
    if (monthlyData.length === 0) return 0;
    return monthlyData.reduce((sum, d) => sum + d.amount, 0) / monthlyData.length;
  }, [monthlyData]);

  // Cumulative spend trajectory — rolled up by day so the line is smooth.
  const cumulativeData = useMemo(() => {
    const daily: Record<string, number> = {};
    expenses.forEach(exp => {
      const iso = exp.receipt_date || exp.date;
      if (!iso || iso === 'Unknown' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      daily[iso] = (daily[iso] || 0) + exp.total_amount;
    });
    const sorted = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b));
    return sorted.reduce<{ date: string; cumulative: number; daily: number; label: string }[]>((acc, [date, amount]) => {
      const previous = acc.length > 0 ? acc[acc.length - 1].cumulative : 0;
      acc.push({
        date,
        cumulative: previous + amount,
        daily: amount,
        label: date.slice(5).replace('-', '/'),
      });
      return acc;
    }, []);
  }, [expenses]);

  const cumulativeSpan = useMemo(() => {
    if (cumulativeData.length < 2) return null;
    const first = new Date(`${cumulativeData[0].date}T00:00:00`).getTime();
    const last = new Date(`${cumulativeData[cumulativeData.length - 1].date}T00:00:00`).getTime();
    const days = Math.max(1, Math.round((last - first) / (1000 * 60 * 60 * 24)) + 1);
    const total = cumulativeData[cumulativeData.length - 1].cumulative;
    return { days, total, perDay: total / days };
  }, [cumulativeData]);

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
  const queueRemainingCount = pendingFiles.length + prefetchedResults.length;
  const identityLabel = isSignedIn
    ? (accountDraft.displayName.trim() || session?.user.email || 'Signed in')
    : `Guest ${guestSessionId.slice(-6)}`;

  useEffect(() => {
    if (!authReady) return;
    fetchExpenses();
  }, [authReady, fetchExpenses]);

  const closeEdit = useCallback(() => {
    if (editDraft && editOriginalRef.current && editSignature(editDraft) !== editOriginalRef.current) {
      if (!window.confirm('Discard unsaved changes to this receipt?')) return;
    }
    setEditDraft(null);
  }, [editDraft]);

  // Close the category filter popover and hand focus back to its trigger button.
  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    filterTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (filterOpen) {
        closeFilter();
      } else if (editDraft) {
        closeEdit();
      } else if (showItemsModal) {
        setShowItemsModal(false);
      } else if (showHeicHelper) {
        setShowHeicHelper(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editDraft, showHeicHelper, showItemsModal, closeEdit, filterOpen, closeFilter, setShowHeicHelper]);

  // Dismiss the filter popover on a pointerdown outside it (ignoring the trigger,
  // whose own onClick toggles the state).
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (filterPopoverRef.current?.contains(target)) return;
      if (filterTriggerRef.current?.contains(target)) return;
      setFilterOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [filterOpen]);

  useEffect(() => {
    if (!editDraft && !result) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editDraft, result]);

  // Wipe transient in-memory user state on sign-out so the next identity (or the
  // guest fallback) never sees the previous user's drafts, receipts, or profile.
  // The guest localStorage id and persisted custom categories are intentionally
  // left alone — fetchExpenses/loadAccountSettings re-run on the session change
  // and reload the correct guest data (custom categories reset via the guest loader
  // to avoid a flicker rather than blanking to []).
  //
  // This covers only the non-auth state; useAuth adds the auth-form / recovery
  // resets that differ between the explicit signOut and the SIGNED_OUT event.
  const resetClientState = useCallback(() => {
    resetAccount();
    resetExpenses();
    resetReceiptQueue();
    setEditDraft(null);
  }, [resetAccount, resetExpenses, resetReceiptQueue]);
  useLayoutEffect(() => {
    resetClientStateRef.current = resetClientState;
  });

  const handleEditExpense = (exp: Expense) => {
    editOriginalRef.current = editSignature(exp);
    setEditDraft({ ...exp });
  };

  const saveEdit = async () => {
    if (!editDraft) return;
    // A manual edit makes the entered total authoritative in the display currency,
    // so the converted/source pair stays consistent (drop the stale FX linkage).
    const editedTotal = Number(editDraft.total_amount) || 0;
    const editedCurrency = editDraft.currency || DEFAULT_CURRENCY;
    const payload: Partial<Expense> = {
      vendor: editDraft.vendor,
      total_amount: editedTotal,
      date: editDraft.date,
      category: editDraft.category,
      currency: editedCurrency,
      source_currency: editedCurrency,
      raw_total_amount: editedTotal,
      receipt_date: editDraft.receipt_date || editDraft.date,
      fx_rate_date: null,
      currency_warning: editDraft.currency_warning || null,
      item_warning: editDraft.item_warning || null,
      items: coerceItems(editDraft.items),
    };
    try {
      await axios.put(`${API_URL}/expenses/${editDraft.id}`, payload, requestConfig);
      setExpenses(prev => prev.map(item => item.id === editDraft.id ? { ...item, ...payload } : item));
      setSelectedExpense(prev => prev && prev.id === editDraft.id ? { ...prev, ...payload } : prev);
      setEditDraft(null);
      setAnnouncement('Entry updated');
    } catch (error) {
      console.error('Update failed', error);
      setAnnouncement(`Unable to update expense: ${getErrorMessage(error, 'Unknown error')}`);
    }
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
          setExpenses(prev => {
            const withoutExisting = prev.filter(item => item.id !== exp.id);
            return [exp, ...withoutExisting].sort((a, b) =>
              (b.receipt_date || b.date || '').localeCompare(a.receipt_date || a.date || '')
            );
          });
          dismissToast(toastId);
          setAnnouncement('Deletion undone');
        },
      },
    });

    const timer = setTimeout(async () => {
      deletionTimers.current.delete(exp.id);
      try {
        await axios.delete(`${API_URL}/expenses/${exp.id}`, requestConfig);
      } catch (error) {
        console.error('Delete failed', error);
        // restore on failure so the user isn't silently lying to
        setExpenses(prev => {
          const withoutExisting = prev.filter(item => item.id !== exp.id);
          return [exp, ...withoutExisting].sort((a, b) =>
            (b.receipt_date || b.date || '').localeCompare(a.receipt_date || a.date || '')
          );
        });
        pushToast({
          message: `Unable to delete: ${getErrorMessage(error, 'Unknown error')}`,
          tone: 'danger',
          duration: 5000,
        });
      }
    }, 5000);
    deletionTimers.current.set(exp.id, timer);
  };

  // Visible failure state for the expense fetch, with a Retry that re-runs it.
  // Rendered above each view's body so an empty chart/list never reads as "no data".
  const expensesErrorBanner = expensesError ? (
    <div
      className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-[var(--color-accent)] bg-[var(--color-surface)] p-4"
      style={{ borderRadius: 'var(--radius-md)' }}
      role="alert"
    >
      <div>
        <p className="micro-label text-[var(--color-accent)]">Couldn't load receipts</p>
        <p className="font-body text-sm text-[var(--color-soft-charcoal)] mt-1">{expensesError}</p>
      </div>
      <button type="button" onClick={() => fetchExpenses()} className="btn-primary btn--sm self-start sm:self-auto">
        Retry
      </button>
    </div>
  ) : null;

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

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex items-center justify-center px-6">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-[var(--color-accent)] animate-spin" />
          <p className="font-body text-sm text-[var(--color-soft-charcoal)]">Loading session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="grid grid-cols-1 lg:grid-cols-12 min-h-screen mx-auto" style={{ maxWidth: 'var(--width-max)' }}>

        {/* Sidebar — quiet editorial nav, no glow, no watermark */}
        <nav className="lg:col-span-2 lg:sticky lg:top-0 lg:self-start lg:h-screen px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-12 border-b lg:border-b-0 lg:border-r border-[var(--color-paper-mist)] flex flex-col sm:flex-row lg:flex-col gap-4 sm:gap-6 lg:gap-8">
          <div className="flex items-baseline gap-2">
            <span className="display-italic text-3xl">Smart</span>
            <span className="font-body text-sm font-medium tracking-[0.1em] uppercase text-[var(--color-mid-ash)]">Spend</span>
          </div>
          <div className="border border-[var(--color-paper-mist)] bg-[var(--color-surface)] p-4 space-y-3" style={{ borderRadius: 'var(--radius-md)' }}>
            <p className="micro-label">Session</p>
            <div className="flex items-center gap-3">
              {accountDraft.avatarUrl ? (
                <img src={accountDraft.avatarUrl} alt="" width={24} height={24} onError={(e) => { e.currentTarget.style.display = 'none'; }} className="w-6 h-6 rounded-full object-cover flex-shrink-0 ring-1 ring-[var(--color-paper-mist)]" />
              ) : (
                <CircleUserRound className="w-4 h-4 text-[var(--color-accent)] flex-shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-body text-sm font-medium text-[var(--color-deep-graphite)] truncate">{identityLabel}</p>
                <p className="font-body text-xs text-[var(--color-mid-ash)] italic truncate">
                  {isSignedIn ? 'Signed in account' : 'Guest mode'}
                </p>
              </div>
            </div>
            <button onClick={() => setCurrentView('account')} className="btn-quiet btn--sm w-full">
              Manage account
            </button>
          </div>
          <div className="flex flex-wrap sm:flex-nowrap lg:flex-col gap-3 sm:gap-6 lg:gap-2 lg:mt-6">
            {navItem('dashboard', 'Dashboard', LayoutDashboard)}
            {navItem('analytics', 'Analytics', BarChart3)}
            {navItem('history', 'Receipts', History)}
            <button
              onClick={() => setCurrentView('account')}
              aria-label="Account"
              aria-current={currentView === 'account' ? 'page' : undefined}
              className={`group flex items-center gap-3 py-2 transition-colors duration-150 ${currentView === 'account' ? 'text-[var(--color-accent)]' : 'text-[var(--color-soft-charcoal)] hover:text-[var(--color-accent)]'}`}
            >
              <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 transition-opacity duration-150 ${currentView === 'account' ? 'opacity-100' : 'opacity-0'}`} style={{ backgroundColor: 'var(--color-accent)' }} />
              {accountDraft.avatarUrl ? (
                <img src={accountDraft.avatarUrl} alt="" width={16} height={16} onError={(e) => { e.currentTarget.style.display = 'none'; }} className="w-4 h-4 rounded-full object-cover flex-shrink-0" />
              ) : (
                <CircleUserRound className="w-4 h-4" />
              )}
              <span className="font-body text-sm font-medium">Account</span>
            </button>
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
                    {expenses.length} {expenses.length === 1 ? 'receipt' : 'receipts'} · {formatMoney(totalSpent, aggregateCurrency)} total.
                  </p>
                  {hasMixedAggregateCurrencies && (
                    <p className="mt-2 font-body text-sm text-[var(--color-soft-charcoal)]/70">
                      Totals may mix currencies — reconvert to show everything in {aggregateCurrency}.
                    </p>
                  )}
                </header>

                {expensesErrorBanner}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                  {/* Capture */}
                  <section className="lg:col-span-5">
                    <p className="micro-label mb-6">Capture receipts</p>

                    <label
                      onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true); }}
                      onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                      onDrop={handleDrop}
                      className={`relative border border-dashed flex flex-col items-center justify-center transition-colors duration-150 cursor-pointer py-12 sm:py-16 lg:py-20 bg-[var(--color-surface)] ${isDragging ? 'border-[var(--color-accent)]' : 'border-[var(--color-paper-mist)] hover:border-[var(--color-accent)]'}`}
                      style={{ borderRadius: 'var(--radius-md)' }}
                    >
                      {loading ? (
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-8 h-8 text-[var(--color-accent)] animate-spin" />
                          <p className="font-body text-sm text-[var(--color-soft-charcoal)] italic truncate max-w-[180px] sm:max-w-[260px]">
                            Reading {currentFileName || pendingFiles[0]?.name || 'receipt'}…
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
                      {queueRemainingCount > 0 && (
                        <button onClick={clearQueue} className="btn-quiet btn--sm w-full">
                          Clear queue ({queueRemainingCount})
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
                              {queueRemainingCount > 0
                                ? `${currentFileName || 'current file'} · ${queueRemainingCount} queued`
                                : 'awaiting save'}
                            </span>
                            {queueRemainingCount > 0 && (
                              <button onClick={skipCurrent} className="btn-text ml-auto">Skip</button>
                            )}
                          </div>

                          {result.image_path && (
                            <div className="mb-6 border border-[var(--color-paper-mist)] bg-[var(--color-warm-ash-cream)] flex items-center justify-center overflow-hidden" style={{ borderRadius: 'var(--radius-md)' }}>
                              {result.image_path.toLowerCase().endsWith('.pdf') ? (
                                <div className="w-full">
                                  <embed
                                    src={getReceiptUrl(result.image_path)}
                                    type="application/pdf"
                                    title={`PDF preview of ${currentFileName || 'receipt'}`}
                                    className="w-full h-64"
                                  />
                                  <div className="px-3 py-2 border-t border-[var(--color-paper-mist)] text-center">
                                    <a
                                      href={getReceiptUrl(result.image_path)}
                                      target="_blank"
                                      rel="noopener"
                                      className="btn-text btn-text--accent"
                                    >
                                      Open PDF ↗
                                    </a>
                                  </div>
                                </div>
                              ) : (
                                <a href={getReceiptUrl(result.image_path)} target="_blank" rel="noreferrer" className="block">
                                  <img src={getReceiptUrl(result.image_path)} alt={currentFileName || pendingFiles[0]?.name || 'Receipt'} loading="lazy" className="max-h-64 object-contain mx-auto" />
                                </a>
                              )}
                            </div>
                          )}

                          <div className="space-y-6">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                              <div>
                                <label className="micro-label block mb-2">Merchant</label>
                                <input
                                  value={result.extracted_data.vendor}
                                  onChange={(e) => setResult({ ...result, extracted_data: { ...result.extracted_data, vendor: e.target.value } })}
                                  className="input-editorial"
                                />
                              </div>
                              <div>
                                <label className="micro-label block mb-2">Date</label>
                                <input
                                  type="date"
                                  value={toDateInputValue(result.extracted_data.date)}
                                  onChange={(e) => setResult({ ...result, extracted_data: { ...result.extracted_data, date: e.target.value } })}
                                  className="input-editorial"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                              <div>
                                <label className="micro-label block mb-2">Total</label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  inputMode="decimal"
                                  value={result.extracted_data.total_amount}
                                  onChange={(e) => setResult({ ...result, extracted_data: { ...result.extracted_data, total_amount: e.target.value as unknown as number } })}
                                  className="input-editorial"
                                />
                                {!isValidAmount(result.extracted_data.total_amount) && (
                                  <p className="font-body text-xs text-[var(--color-accent)] mt-2">
                                    Enter a total of 0 or more to save.
                                  </p>
                                )}
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
                                    {categoryOptions.map(opt => (
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
                                <div className="mb-6 p-4 border border-[var(--color-paper-mist)] bg-[var(--color-accent-dim)]" style={{ borderRadius: 'var(--radius-md)' }}>
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
                                      inputMode="decimal"
                                      className="input-editorial col-span-2"
                                      value={it.qty ?? ''}
                                      placeholder="—"
                                      onChange={(e) => setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.map((x, i) => i === idx ? { ...x, qty: e.target.value === '' ? undefined : (e.target.value as unknown as number) } : x) } }) : r)}
                                    />
                                    <input
                                      type="number"
                                      step="any"
                                      min="0"
                                      inputMode="decimal"
                                      className="input-editorial col-span-3"
                                      value={it.amount}
                                      onChange={(e) => setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.map((x, i) => i === idx ? { ...x, amount: e.target.value as unknown as number } : x) } }) : r)}
                                    />
                                    <button
                                      aria-label="Remove item"
                                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                                        e.stopPropagation();
                                        setResult(r => r ? ({ ...r, extracted_data: { ...r.extracted_data, items: r.extracted_data.items?.filter((_, i) => i !== idx) } }) : r);
                                      }}
                                      className="btn-text tap-target col-span-1 justify-self-end"
                                    >
                                      <X className="w-3.5 h-3.5" />
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
                              type="button"
                              onClick={saveExpense}
                              disabled={isSaving || !isValidAmount(result.extracted_data.total_amount)}
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
                                Average receipt {formatMoney((totalSpent / (expenses.length || 1)) || 0, aggregateCurrency)} · across {availableCategories.length} {availableCategories.length === 1 ? 'category' : 'categories'}.
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

                {expensesErrorBanner}

                {chartData.length === 0 ? (
                  (!listLoading && !expensesError) && (
                  <div className="py-16 sm:py-24">
                    <p className="display-italic text-[var(--color-deep-graphite)]" style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)' }}>
                      Nothing yet.
                    </p>
                    <p className="title-italic mt-3 text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1rem, 2vw, 1.25rem)' }}>
                      Your spending patterns will appear here once you save a receipt.
                    </p>
                    <p className="font-body text-sm text-[var(--color-mid-ash)] mt-5">
                      Drop your first receipt on the Dashboard.
                    </p>
                  </div>
                  )
                ) : (
                  <div className="space-y-12 sm:space-y-16 lg:space-y-20">
                    {/* Top-line: total as an editorial statement, supporting metrics demoted */}
                    <section className="pb-10 sm:pb-12 border-b border-[var(--color-paper-mist)]">
                      <p className="micro-label mb-3">Total spent</p>
                      <p className="display-italic text-[var(--color-accent)]" style={{ fontSize: 'clamp(2.75rem, 8vw, 5rem)' }}>
                        {formatMoney(totalSpent, aggregateCurrency)}
                      </p>
                      <p className="title-italic mt-2 text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1rem, 2vw, 1.25rem)' }}>
                        across {expenses.length} {expenses.length === 1 ? 'receipt' : 'receipts'}.
                      </p>
                      {hasMixedAggregateCurrencies && (
                        <p className="mt-2 font-body text-sm text-[var(--color-soft-charcoal)]/70">
                          Totals may mix currencies — reconvert to show everything in {aggregateCurrency}.
                        </p>
                      )}

                      <div className="mt-8 sm:mt-10 flex flex-wrap gap-x-12 gap-y-4">
                        <div className="flex items-baseline gap-3">
                          <span className="micro-label">Average</span>
                          <span className="font-body text-base font-medium text-[var(--color-deep-graphite)] tabular-nums">
                            {formatMoney(totalSpent / (expenses.length || 1), aggregateCurrency)}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-3 min-w-0">
                          <span className="micro-label">Largest</span>
                          <span className="font-body text-base font-medium text-[var(--color-deep-graphite)] tabular-nums">
                            {largestReceipt ? formatMoney(largestReceipt.total_amount, largestReceipt.currency || DEFAULT_CURRENCY) : '—'}
                          </span>
                          {largestReceipt && (
                            <span className="font-body text-sm text-[var(--color-mid-ash)] italic truncate">
                              {largestReceipt.vendor}
                            </span>
                          )}
                        </div>
                      </div>
                    </section>

                    {/* Category allocation */}
                    <section>
                      <p className="micro-label mb-6">By category</p>
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
                        <ChartFrame
                          className="lg:col-span-5 h-[280px] min-w-0"
                          ariaLabel={`Spending by category: ${donutData.map(d => `${d.name} ${totalSpent > 0 ? Math.round((d.value / totalSpent) * 100) : 0}%`).join(', ')}.`}
                        >
                          {(w, h) => (
                            <PieChart width={w} height={h}>
                              <Pie
                                data={donutData}
                                cx="50%"
                                cy="50%"
                                innerRadius={80}
                                outerRadius={120}
                                paddingAngle={2}
                                dataKey="value"
                                stroke="none"
                              >
                                {donutData.map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
                                ))}
                              </Pie>
                              <RechartsTooltip
                                contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '4px', padding: '10px 14px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                itemStyle={{ color: 'var(--color-text)' }}
                                cursor={false}
                                formatter={(v: unknown, name: unknown) => [formatMoney(Number(v), aggregateCurrency), String(name)]}
                              />
                            </PieChart>
                          )}
                        </ChartFrame>

                        <div className="lg:col-span-7 space-y-1">
                          {donutData.map((d, i) => {
                            const pct = totalSpent > 0 ? Math.round((d.value / totalSpent) * 100) : 0;
                            return (
                              <div key={i} className="flex items-baseline justify-between gap-4 py-3 border-b border-[var(--color-paper-mist)]">
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="block w-2.5 h-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                                  <span className="font-body text-base text-[var(--color-deep-graphite)] truncate">{d.name}</span>
                                </div>
                                <div className="flex items-baseline gap-4 flex-shrink-0">
                                  <span className="font-mono text-xs text-[var(--color-mid-ash)]">{pct}%</span>
                                  <span className="font-body text-base font-medium text-[var(--color-deep-graphite)]">{formatMoney(d.value, aggregateCurrency)}</span>
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
                        <ChartFrame className="h-[280px] min-w-0" ariaLabel={`Daily spending over the last ${timeSeriesData.length} ${timeSeriesData.length === 1 ? 'day' : 'days'}.`}>
                          {(w, h) => (
                            <BarChart width={w} height={h} data={timeSeriesData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }} syncId="analytics">
                              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={GRID_STROKE} />
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
                                cursor={{ fill: TOOLTIP_FILL }}
                                contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '4px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                labelFormatter={(label, payload) => {
                                  const item = (payload as readonly { payload?: { date?: string } }[])[0]?.payload;
                                  return item?.date || String(label);
                                }}
                                formatter={(v: unknown) => [formatMoney(Number(v), aggregateCurrency), 'Total']}
                              />
                              <Bar dataKey="amount" fill={ACCENT_MUTED} radius={[2, 2, 0, 0]} barSize={20} isAnimationActive animationDuration={400} />
                            </BarChart>
                          )}
                        </ChartFrame>
                      )}
                    </section>

                    {/* Weekday rhythm */}
                    {weekdayData.some(d => d.amount > 0) && (
                      <section>
                        <div className="flex items-baseline justify-between mb-6">
                          <p className="micro-label">Weekday rhythm</p>
                          {busiestWeekday && (
                            <span className="font-mono text-xs text-[var(--color-mid-ash)]">
                              busiest · {busiestWeekday.day.toLowerCase()}
                            </span>
                          )}
                        </div>
                        <ChartFrame className="h-[240px] min-w-0" ariaLabel={busiestWeekday ? `Spending by weekday, busiest on ${busiestWeekday.day}.` : 'Spending by weekday.'}>
                          {(w, h) => (
                            <BarChart width={w} height={h} data={weekdayData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }} syncId="analytics">
                              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={GRID_STROKE} />
                              <XAxis
                                dataKey="day"
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
                                cursor={{ fill: TOOLTIP_FILL }}
                                contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '4px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                labelFormatter={(label, payload) => {
                                  const item = (payload as readonly { payload?: { count: number; average: number } }[])[0]?.payload;
                                  if (!item) return String(label);
                                  const avg = item.average > 0 ? ` · avg ${formatMoney(item.average, aggregateCurrency)}` : '';
                                  return `${label} — ${item.count} ${item.count === 1 ? 'receipt' : 'receipts'}${avg}`;
                                }}
                                formatter={(v: unknown) => [formatMoney(Number(v), aggregateCurrency), 'Total']}
                              />
                              <Bar dataKey="amount" fill={ACCENT_MUTED} radius={[2, 2, 0, 0]} barSize={22} isAnimationActive animationDuration={400} />
                            </BarChart>
                          )}
                        </ChartFrame>
                        {busiestWeekday && (
                          <p className="font-body text-sm text-[var(--color-mid-ash)] italic mt-4">
                            You spend most on {busiestWeekday.day}s — {formatMoney(busiestWeekday.amount, aggregateCurrency)} across {busiestWeekday.count} {busiestWeekday.count === 1 ? 'receipt' : 'receipts'}.
                          </p>
                        )}
                      </section>
                    )}

                    {/* Monthly totals */}
                    {monthlyData.length > 0 && (
                      <section>
                        <div className="flex items-baseline justify-between mb-6">
                          <p className="micro-label">By month</p>
                          <span className="font-mono text-xs text-[var(--color-mid-ash)]">
                            {monthlyData.length} {monthlyData.length === 1 ? 'month' : 'months'}
                          </span>
                        </div>
                        <ChartFrame className="h-[260px] min-w-0" ariaLabel={`Spending by month across ${monthlyData.length} ${monthlyData.length === 1 ? 'month' : 'months'}.`}>
                          {(w, h) => (
                            <BarChart width={w} height={h} data={monthlyData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }} syncId="analytics">
                              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={GRID_STROKE} />
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
                                cursor={{ fill: TOOLTIP_FILL }}
                                contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '4px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                labelFormatter={(label, payload) => {
                                  const item = (payload as readonly { payload?: { count: number } }[])[0]?.payload;
                                  if (!item) return String(label);
                                  return `${label} — ${item.count} ${item.count === 1 ? 'receipt' : 'receipts'}`;
                                }}
                                formatter={(v: unknown) => [formatMoney(Number(v), aggregateCurrency), 'Total']}
                              />
                              <Bar dataKey="amount" fill={ACCENT_MUTED} radius={[2, 2, 0, 0]} barSize={26} isAnimationActive animationDuration={400} />
                              <ReferenceLine y={monthlyAvg} stroke={TEXT_DIM} strokeDasharray="4 3" strokeWidth={1} label={{ value: 'avg', position: 'insideTopRight', fill: TEXT_DIM, fontSize: 10, fontFamily: 'Instrument Sans, sans-serif' }} />
                            </BarChart>
                          )}
                        </ChartFrame>
                        {monthOverMonthDelta && (
                          <p className="font-body text-sm text-[var(--color-mid-ash)] italic mt-4">
                            {monthOverMonthDelta.delta >= 0 ? 'Up' : 'Down'} {formatMoney(Math.abs(monthOverMonthDelta.delta), aggregateCurrency)} ({monthOverMonthDelta.pct >= 0 ? '+' : ''}{monthOverMonthDelta.pct.toFixed(0)}%) versus {monthOverMonthDelta.prior.label}.
                          </p>
                        )}
                      </section>
                    )}

                    {/* Cumulative trajectory */}
                    {cumulativeData.length > 1 && (
                      <section>
                        <div className="flex items-baseline justify-between mb-6">
                          <p className="micro-label">Trajectory</p>
                          {cumulativeSpan && (
                            <span className="font-mono text-xs text-[var(--color-mid-ash)]">
                              {cumulativeSpan.days} {cumulativeSpan.days === 1 ? 'day' : 'days'}
                            </span>
                          )}
                        </div>
                        <ChartFrame className="h-[260px] min-w-0" ariaLabel={`Cumulative spending trajectory${cumulativeSpan ? ` over ${cumulativeSpan.days} ${cumulativeSpan.days === 1 ? 'day' : 'days'}` : ''}.`}>
                          {(w, h) => (
                            <AreaChart width={w} height={h} data={cumulativeData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }} syncId="analytics">
                              <defs>
                                <linearGradient id="trajectoryGradient" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke={GRID_STROKE} />
                              <XAxis
                                dataKey="label"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: TEXT_DIM, fontSize: 11, fontFamily: 'Instrument Sans, sans-serif' }}
                                dy={10}
                                minTickGap={24}
                              />
                              <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: TEXT_DIM, fontSize: 11, fontFamily: 'Instrument Sans, sans-serif' }}
                                dx={-8}
                              />
                              <RechartsTooltip
                                cursor={{ stroke: ACCENT, strokeWidth: 1, strokeDasharray: '3 3' }}
                                contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '4px', fontFamily: 'var(--font-body)', fontSize: '13px' }}
                                labelFormatter={(label, payload) => {
                                  const item = (payload as readonly { payload?: { date?: string; daily?: number } }[])[0]?.payload;
                                  if (!item) return String(label);
                                  const dayLine = item.daily ? ` · ${formatMoney(item.daily, aggregateCurrency)} that day` : '';
                                  return `${item.date || label}${dayLine}`;
                                }}
                                formatter={(v: unknown) => [formatMoney(Number(v), aggregateCurrency), 'Running total']}
                              />
                              <Area
                                type="monotone"
                                dataKey="cumulative"
                                stroke={ACCENT}
                                strokeWidth={2}
                                fill="url(#trajectoryGradient)"
                                isAnimationActive
                                animationDuration={400}
                              />
                            </AreaChart>
                          )}
                        </ChartFrame>
                        {cumulativeSpan && (
                          <p className="font-body text-sm text-[var(--color-mid-ash)] italic mt-4">
                            Averaging {formatMoney(cumulativeSpan.perDay, aggregateCurrency)} per day across this window.
                          </p>
                        )}
                      </section>
                    )}

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
                                    {formatMoney(m.total, aggregateCurrency)}
                                  </span>
                                </div>
                                <div className="h-0.5 bg-[var(--color-paper-mist)] rounded-full overflow-hidden mt-2">
                                  <div
                                    className="h-full rounded-full transition-all duration-500"
                                    style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: 'var(--color-accent)' }}
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

            {currentView === 'account' && (
              <motion.div
                key="account"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="px-4 sm:px-6 lg:px-12 py-10 sm:py-14 lg:py-20 mx-auto"
                style={{ maxWidth: 'var(--width-content)' }}
              >
                <header className="mb-12 sm:mb-16 lg:mb-20">
                  <p className="micro-label mb-4">Account · Access & preferences</p>
                  <h1 className="display-italic" style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)' }}>Your space.</h1>
                  <p className="title-italic mt-4 text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2.5vw, 1.5rem)' }}>
                    {isSignedIn ? 'Manage your signed-in session, theme, and categories.' : 'Use guest mode or sign in with Supabase Auth.'}
                  </p>
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                  <section className="lg:col-span-5 space-y-8">
                    <div>
                    <p className="micro-label mb-6">Session</p>
                    <div className="border border-[var(--color-paper-mist)] bg-[var(--color-surface)] p-6 sm:p-8 space-y-6" style={{ borderRadius: 'var(--radius-lg)' }}>
                      {recoveryMode ? (
                        <>
                          <div className="space-y-2">
                            <p className="micro-label text-[var(--color-accent)]">Reset password</p>
                            <p className="headline text-2xl text-[var(--color-deep-graphite)]">Set a new password.</p>
                            <p className="font-body text-sm text-[var(--color-soft-charcoal)]">
                              Choose a new password for {session?.user?.email || 'your account'}.
                            </p>
                          </div>
                          <div>
                            <label htmlFor="recovery-password" className="micro-label block mb-2">New password</label>
                            <div className="relative">
                              <input
                                id="recovery-password"
                                value={recoveryPassword}
                                onChange={(e) => setRecoveryPassword(e.target.value)}
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="new-password"
                                className="input-editorial pr-12"
                              />
                              <button
                                type="button"
                                onClick={() => setShowPassword(v => !v)}
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                aria-pressed={showPassword}
                                className="tap-target absolute right-1 top-1/2 -translate-y-1/2 flex items-center text-[var(--color-mid-ash)] hover:text-[var(--color-accent)] transition-colors"
                              >
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                          </div>
                          {authError && (
                            <p className="font-body text-sm text-[var(--color-accent)]">{authError}</p>
                          )}
                          <div className="flex flex-wrap gap-3">
                            <button
                              type="button"
                              onClick={submitNewPassword}
                              disabled={recoveryBusy}
                              className="btn-primary"
                            >
                              {recoveryBusy ? 'Updating…' : 'Update password'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setRecoveryMode(false); setRecoveryPassword(''); setAuthError(null); }}
                              className="btn-quiet"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : isSignedIn ? (
                        <>
                          <div className="space-y-2">
                            <p className="font-body text-sm text-[var(--color-mid-ash)]">Signed in as</p>
                            <p className="headline text-2xl text-[var(--color-deep-graphite)]">{identityLabel}</p>
                            <p className="font-body text-sm text-[var(--color-soft-charcoal)]">
                              {session?.user?.email || 'No email available'}
                            </p>
                          </div>
                          <button onClick={signOut} disabled={authBusy} className="btn-primary">
                            <LogOut className="w-4 h-4" />
                            {authBusy ? 'Signing out…' : 'Sign out'}
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 text-[var(--color-soft-charcoal)]">
                            <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
                            <p className="font-body text-sm">Guest mode is active for this browser.</p>
                          </div>

                          <div className="flex flex-wrap gap-3">
                            <button
                              type="button"
                              onClick={() => setAuthMode('sign-in')}
                              className={`btn-quiet btn--sm ${authMode === 'sign-in' ? 'is-active' : ''}`}
                            >
                              <LogIn className="w-4 h-4" />
                              Sign in
                            </button>
                            <button
                              type="button"
                              onClick={() => setAuthMode('sign-up')}
                              className={`btn-quiet btn--sm ${authMode === 'sign-up' ? 'is-active' : ''}`}
                            >
                              Create account
                            </button>
                          </div>

                          <div className="space-y-4">
                            <div>
                              <label className="micro-label block mb-2">Email</label>
                              <input
                                value={authEmail}
                                onChange={(e) => setAuthEmail(e.target.value)}
                                type="email"
                                autoComplete="email"
                                className="input-editorial"
                              />
                            </div>
                            {authMode === 'sign-up' && (
                              <div>
                                <label className="micro-label block mb-2">Display name</label>
                                <input
                                  value={authName}
                                  onChange={(e) => setAuthName(e.target.value)}
                                  type="text"
                                  autoComplete="nickname"
                                  className="input-editorial"
                                />
                              </div>
                            )}
                            <div>
                              <label className="micro-label block mb-2">Password</label>
                              <div className="relative">
                                <input
                                  value={authPassword}
                                  onChange={(e) => setAuthPassword(e.target.value)}
                                  type={showPassword ? 'text' : 'password'}
                                  autoComplete={authMode === 'sign-up' ? 'new-password' : 'current-password'}
                                  className="input-editorial pr-12"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowPassword(v => !v)}
                                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                                  aria-pressed={showPassword}
                                  className="tap-target absolute right-1 top-1/2 -translate-y-1/2 flex items-center text-[var(--color-mid-ash)] hover:text-[var(--color-accent)] transition-colors"
                                >
                                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              </div>
                              {authMode === 'sign-in' && (
                                <button
                                  type="button"
                                  onClick={requestPasswordReset}
                                  disabled={authBusy}
                                  className="btn-text mt-2"
                                >
                                  Forgot password?
                                </button>
                              )}
                            </div>
                          </div>

                          {authError && (
                            <p className="font-body text-sm text-[var(--color-accent)]">{authError}</p>
                          )}
                          {authNotice && (
                            <p className="font-body text-sm text-[var(--color-soft-charcoal)]">{authNotice}</p>
                          )}
                          {showResendConfirmation && (
                            <button
                              type="button"
                              onClick={resendConfirmation}
                              disabled={authBusy}
                              className="btn-text"
                            >
                              Resend confirmation email
                            </button>
                          )}

                          <div className="flex flex-wrap gap-3">
                            <button
                              onClick={() => submitAuth(authMode)}
                              disabled={authBusy}
                              className="btn-primary"
                            >
                              {authMode === 'sign-in' ? <LogIn className="w-4 h-4" /> : <CircleUserRound className="w-4 h-4" />}
                              {authBusy ? 'Working…' : (authMode === 'sign-in' ? 'Sign in' : 'Create account')}
                            </button>
                            <button onClick={keepGuestMode} className="btn-quiet">
                              Keep guest mode
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    </div>
                    <div>
                      <p className="micro-label mb-6">Profile</p>
                      <div className="border border-[var(--color-paper-mist)] bg-[var(--color-surface)] p-6 sm:p-8 space-y-4" style={{ borderRadius: 'var(--radius-lg)' }}>
                        <div className="flex items-center gap-4 pb-4 border-b border-[var(--color-paper-mist)]">
                          {accountDraft.avatarUrl ? (
                            <img src={accountDraft.avatarUrl} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} className="w-14 h-14 rounded-full object-cover flex-shrink-0 ring-1 ring-[var(--color-paper-mist)]" />
                          ) : (
                            <div className="w-14 h-14 rounded-full bg-[var(--color-paper-mist)] flex items-center justify-center flex-shrink-0">
                              <CircleUserRound className="w-7 h-7 text-[var(--color-accent)]" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="font-body font-medium text-[var(--color-deep-graphite)] truncate">{accountDraft.displayName.trim() || 'Your name'}</p>
                            <p className="font-body text-sm text-[var(--color-mid-ash)] truncate">{accountDraft.email || 'you@example.com'}</p>
                          </div>
                        </div>
                        <div>
                          <label className="micro-label block mb-2">Display name</label>
                          <input
                            value={accountDraft.displayName}
                            onChange={(e) => setAccountDraft(prev => ({ ...prev, displayName: e.target.value }))}
                            className="input-editorial"
                          />
                        </div>
                        <div>
                          <label className="micro-label block mb-2">Email</label>
                          <input
                            value={accountDraft.email}
                            onChange={(e) => setAccountDraft(prev => ({ ...prev, email: e.target.value }))}
                            type="email"
                            autoComplete="email"
                            className="input-editorial"
                          />
                        </div>
                        <div>
                          <label className="micro-label block mb-2">Avatar URL</label>
                          <input
                            value={accountDraft.avatarUrl}
                            onChange={(e) => setAccountDraft(prev => ({ ...prev, avatarUrl: e.target.value }))}
                            type="url"
                            className="input-editorial"
                            placeholder="https://..."
                          />
                        </div>
                        <div>
                          {/*
                            This preference is the base currency your receipts are
                            captured into, so aggregate totals and charts render in it
                            (see aggregateCurrency). When some loaded receipt is stored
                            in a different currency, the mixed-currency note near each
                            total is the honesty guard rather than silently re-labelling.
                            A closed <select> (vs free text) also prevents typo'd ISO codes.
                          */}
                          <label htmlFor="account-currency" className="micro-label block mb-2">Preferred currency</label>
                          <div className="relative">
                            <select
                              id="account-currency"
                              value={accountDraft.currency}
                              onChange={(e) => setAccountDraft(prev => ({ ...prev, currency: e.target.value }))}
                              className="input-editorial appearance-none pr-10"
                            >
                              {/* Include any previously-saved free-text code so the select
                                  never silently blanks or rewrites an existing preference. */}
                              {(CURRENCY_OPTIONS.includes(accountDraft.currency) || !accountDraft.currency
                                ? CURRENCY_OPTIONS
                                : [accountDraft.currency, ...CURRENCY_OPTIONS]
                              ).map(code => (
                                <option key={code} value={code}>{code}</option>
                              ))}
                            </select>
                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-mid-ash)] pointer-events-none" />
                          </div>
                          <p className="font-body text-xs text-[var(--color-mid-ash)] mt-2">
                            Your usual receipt currency. Totals stay in the base currency each receipt is converted to.
                          </p>
                          <button
                            type="button"
                            onClick={reconvertExistingReceipts}
                            disabled={reconvertBusy}
                            className="btn-quiet btn--sm mt-4 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {reconvertBusy ? 'Reconverting…' : `Reconvert existing receipts to ${accountDraft.currency || DEFAULT_CURRENCY}`}
                          </button>
                          <p className="font-body text-xs text-[var(--color-mid-ash)] mt-2">
                            Recomputes stored totals of past receipts into {accountDraft.currency || DEFAULT_CURRENCY} at each receipt's date.
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="lg:col-span-7 space-y-8">
                    <div>
                      <p className="micro-label mb-6">Theme</p>
                      <div className="border border-[var(--color-paper-mist)] bg-[var(--color-surface)] p-6 sm:p-8 space-y-4" style={{ borderRadius: 'var(--radius-lg)' }}>
                        <p className="font-body text-sm text-[var(--color-soft-charcoal)]">
                          Auto follows your device theme. You can force light or dark anytime.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {([
                            ['system', 'Auto', Monitor],
                            ['light', 'Light', SunMedium],
                            ['dark', 'Dark', MoonStar],
                          ] as const).map(([value, label, Icon]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setThemeAndPersist(value)}
                              className={`btn-quiet justify-start ${themePreference === value ? 'is-active' : ''}`}
                              aria-pressed={themePreference === value}
                            >
                              <Icon className="w-4 h-4" />
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="micro-label mb-6">Categories</p>
                      <div className="border border-[var(--color-paper-mist)] bg-[var(--color-surface)] p-6 sm:p-8 space-y-5" style={{ borderRadius: 'var(--radius-lg)' }}>
                        <p className="font-body text-sm text-[var(--color-soft-charcoal)]">
                          Add or remove expense categories. The receipt form uses this list immediately.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-3">
                          <input
                            value={categoryDraft}
                            onChange={(e) => setCategoryDraft(e.target.value)}
                            className="input-editorial"
                            placeholder="Add a category"
                          />
                          <button type="button" onClick={addCustomCategory} className="btn-primary">
                            Add
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {categoryOptions.map((cat) => {
                            const removable = !BASE_CATEGORY_OPTIONS.includes(cat);
                            return (
                              <button
                                key={cat}
                                type="button"
                                onClick={() => removable ? removeCustomCategory(cat) : undefined}
                                className={`btn-quiet btn--sm ${removable ? '' : 'is-active'}`}
                                aria-label={removable ? `Remove ${cat}` : `${cat} is built in`}
                              >
                                {cat}
                                {removable && <X aria-hidden="true" className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {accountError && (
                      <p className="font-body text-sm text-[var(--color-accent)]">{accountError}</p>
                    )}

                    <div className="flex flex-wrap gap-3">
                      <button type="button" onClick={saveAccountSettings} disabled={accountBusy} className="btn-primary">
                        {accountBusy ? 'Saving…' : 'Save profile & preferences'}
                      </button>
                      <button
                        type="button"
                        onClick={() => loadAccountSettings()}
                        className="btn-quiet"
                      >
                        Reload settings
                      </button>
                    </div>
                  </section>
                </div>
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

                {expensesErrorBanner}

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
                        ref={filterTriggerRef}
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
                          ref={filterPopoverRef}
                          className="absolute left-0 sm:left-auto sm:right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-[var(--color-surface)] border border-[var(--color-paper-mist)] p-4 z-20"
                          style={{ borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-popover)' }}
                        >
                          <p className="micro-label mb-3">Filter by category</p>
                          <div className="flex flex-col gap-2 max-h-44 overflow-auto pr-2">
                            {availableCategories.map(cat => (
                              <label key={cat} className="flex items-center gap-3 font-body text-sm text-[var(--color-text)] cursor-pointer">
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
                            <button onClick={() => { clearFilters(); closeFilter(); }} className="btn-text">
                              Clear
                            </button>
                            <button onClick={closeFilter} className="btn-primary btn--sm">
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
                  (!listLoading && !expensesError) && (
                    expenses.length === 0 ? (
                      // Brand-new user with zero receipts (no active filter) — first-run state.
                      <div className="py-32 text-center">
                        <p className="title-italic text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2vw, 1.5rem)' }}>
                          No receipts yet.
                        </p>
                        <p className="font-body text-sm text-[var(--color-mid-ash)] mt-3">
                          Capture one on the Dashboard to start your ledger.
                        </p>
                        <button
                          type="button"
                          onClick={() => setCurrentView('dashboard')}
                          className="btn-primary btn--sm mt-6"
                        >
                          Go to Dashboard
                        </button>
                      </div>
                    ) : (
                      // Receipts exist but a search/filter matched none.
                      <div className="py-32 text-center">
                        <p className="title-italic text-[var(--color-soft-charcoal)]" style={{ fontSize: 'clamp(1.125rem, 2vw, 1.5rem)' }}>
                          No receipts match.
                        </p>
                        <p className="font-body text-sm text-[var(--color-mid-ash)] mt-3">
                          Adjust the search or filters above.
                        </p>
                      </div>
                    )
                  )
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
                        className="w-full text-left border border-[var(--color-paper-mist)] p-4 bg-[var(--color-surface)]"
                        style={{ borderRadius: 'var(--radius-md)' }}
                      >
                        <div className="flex items-baseline gap-2 min-w-0">
                          <p className="font-body text-base font-medium text-[var(--color-deep-graphite)] truncate">{exp.vendor}</p>
                          {exp.source_currency && exp.source_currency !== (exp.currency || DEFAULT_CURRENCY) && (
                            <span className="font-mono text-xs text-[var(--color-accent)] uppercase tracking-[0.1em] flex-shrink-0">
                              {exp.source_currency}→{exp.currency || DEFAULT_CURRENCY}
                            </span>
                          )}
                        </div>
                        <p className="font-body text-sm text-[var(--color-soft-charcoal)] italic mt-1">{exp.category}</p>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="font-mono text-xs text-[var(--color-mid-ash)] tabular-nums">{formatDate(exp.date)}</span>
                          <span className="font-body text-base font-medium text-[var(--color-deep-graphite)] tabular-nums">
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
                    <WindowVirtualList
                      items={filteredExpenses}
                      estimateSize={65}
                      getKey={(exp) => exp.id}
                      renderItem={(exp) => (
                      <button
                        onClick={() => {
                          setSelectedExpense(exp);
                          const sourceCurrency = exp.source_currency || exp.currency || DEFAULT_CURRENCY;
                          const displayCurrency = exp.currency || DEFAULT_CURRENCY;
                          setHistoryCurrencyMode(
                            sourceCurrency !== displayCurrency && sourceCurrency === preferredHistoryCurrency ? 'source' : 'converted'
                          );
                          setShowItemsModal(true);
                        }}
                        className="grid grid-cols-12 gap-6 w-full text-left px-2 py-5 border-b border-[var(--color-paper-mist)] hover:bg-[var(--color-surface)] transition-colors duration-150 items-baseline"
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
                        <div className="col-span-2 font-mono text-xs text-[var(--color-mid-ash)] tabular-nums">
                          {formatDate(exp.date)}
                        </div>
                        <div className="col-span-2 text-right font-body text-base font-medium text-[var(--color-deep-graphite)] tabular-nums">
                          {formatMoney(exp.total_amount, exp.currency || DEFAULT_CURRENCY)}
                        </div>
                      </button>
                    )}
                    />
                  </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* HEIC helper dialog */}
          {showHeicHelper && (
            <div role="dialog" aria-modal="true" aria-labelledby="heic-helper-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto overscroll-contain">
              <button
                type="button"
                aria-label="Close HEIC help dialog"
                className="absolute inset-0 border-0 bg-black/40 p-0"
                onClick={() => setShowHeicHelper(false)}
              />
              <div
                className="relative z-10 w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-paper-mist)] p-5 sm:p-8 mt-2 sm:mt-0"
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
            <div role="dialog" aria-modal="true" aria-labelledby="receipt-details-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto overscroll-contain">
              <button
                type="button"
                aria-label="Close receipt details dialog"
                className="absolute inset-0 border-0 bg-black/40 p-0"
                onClick={() => setShowItemsModal(false)}
              />
              <div
                className="relative z-10 w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-paper-mist)] p-5 sm:p-10 mt-2 sm:mt-0"
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
                      {formatDate(selectedExpense.receipt_date || selectedExpense.date)}
                      {selectedExpense.fx_rate_date && <> · FX {formatDate(selectedExpense.fx_rate_date)}</>}
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
                      <div className="w-full">
                        <embed
                          src={getReceiptUrl(selectedExpense.image_path)}
                          type="application/pdf"
                          title={`PDF receipt for ${selectedExpense.vendor || 'receipt'}`}
                          className="w-full h-72"
                        />
                        <div className="px-3 py-2 border-t border-[var(--color-paper-mist)] text-center">
                          <a
                            href={getReceiptUrl(selectedExpense.image_path)}
                            target="_blank"
                            rel="noopener"
                            className="btn-text btn-text--accent"
                          >
                            Open PDF ↗
                          </a>
                        </div>
                      </div>
                    ) : (
                      <a href={getReceiptUrl(selectedExpense.image_path)} target="_blank" rel="noreferrer" className="block">
                        <img src={getReceiptUrl(selectedExpense.image_path)} alt={`Receipt for ${selectedExpense.vendor}`} loading="lazy" className="max-h-80 object-contain mx-auto" />
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
            <div role="dialog" aria-modal="true" aria-labelledby="edit-receipt-title" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto overscroll-contain">
              <button
                type="button"
                aria-label="Close edit receipt dialog"
                className="absolute inset-0 border-0 bg-black/40 p-0"
                onClick={closeEdit}
              />
              <div
                className="relative z-10 w-full max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-paper-mist)] p-5 sm:p-10 mt-2 sm:mt-0"
                style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lifted-card)' }}
              >
                <div className="flex justify-end mb-3">
                  <button
                    onClick={closeEdit}
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
                        step="any"
                        min="0"
                        inputMode="decimal"
                        className="input-editorial"
                        value={editDraft.total_amount}
                        onChange={(e) => setEditDraft(d => d ? { ...d, total_amount: e.target.value as unknown as number } : d)}
                      />
                      {!isValidAmount(editDraft.total_amount) && (
                        <p className="font-body text-xs text-[var(--color-accent)] mt-2">
                          Enter a total of 0 or more to save.
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="micro-label block mb-2">Date</label>
                      <input
                        type="date"
                        className="input-editorial"
                        value={toDateInputValue(editDraft.date)}
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
                        {Array.from(new Set([...categoryOptions, editDraft.category])).map(opt => (
                          <option key={opt}>{opt}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-mid-ash)] pointer-events-none" />
                    </div>
                  </div>
                </div>

                <div className="mt-10 flex flex-col-reverse sm:flex-row justify-end gap-3">
                  <button onClick={closeEdit} className="btn-quiet btn--sm">Cancel</button>
                  <button
                    onClick={saveEdit}
                    disabled={!isValidAmount(editDraft.total_amount)}
                    className="btn-primary btn--sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Save changes
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Toast stack — bottom-right, paper-white, hairline border, optional action */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="false"
            className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col gap-3 pointer-events-none"
          >
            <AnimatePresence>
              {toasts.map(t => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="pointer-events-auto bg-[var(--color-surface)] border border-[var(--color-paper-mist)] px-4 sm:px-5 py-4 flex items-center gap-3 sm:gap-4 w-[calc(100vw-2rem)] sm:w-auto min-w-0 sm:min-w-[280px] max-w-md"
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
                    className="btn-text tap-target flex-shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
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
