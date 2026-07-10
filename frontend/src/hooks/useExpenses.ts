import { useCallback, useMemo, useState } from 'react';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { API_URL, DEFAULT_CATEGORY, DEFAULT_CURRENCY, getErrorMessage } from '../lib/appConstants';
import type { Expense } from '../lib/appConstants';

export function useExpenses(
  requestConfig: AxiosRequestConfig,
  setAnnouncement: (value: string) => void,
) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expensesError, setExpensesError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategories, setFilterCategories] = useState<string[]>([]);

  const availableCategories = useMemo(() => {
    const s = Array.from(new Set(expenses.map(e => e.category))).sort();
    return s.length ? s : [DEFAULT_CATEGORY];
  }, [expenses]);

  const toggleCategory = (cat: string) => {
    setFilterCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  };

  const clearFilters = () => setFilterCategories([]);

  const filteredExpenses = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return expenses.filter(exp => {
      const matchesQuery = query === '' || exp.vendor.toLowerCase().includes(query) || exp.category.toLowerCase().includes(query);
      const matchesCategory = filterCategories.length === 0 || filterCategories.includes(exp.category);
      return matchesQuery && matchesCategory;
    });
  }, [expenses, searchQuery, filterCategories]);

  const fetchExpenses = useCallback(async () => {
    setListLoading(true);
    try {
      const response = await axios.get<Expense[]>(`${API_URL}/expenses`, requestConfig);
      const uniqueExpenses = Array.from(
        new Map(response.data.map((expense: Expense) => [expense.id, expense])).values()
      ).reverse() as Expense[];
      setExpenses(uniqueExpenses);
      setExpensesError(null);
    } catch (error) {
      console.error('Fetch failed:', error);
      const message = getErrorMessage(error, 'Unknown error');
      setExpensesError(message);
      setAnnouncement(`Unable to load expenses: ${message}`);
    } finally {
      setListLoading(false);
    }
  }, [requestConfig, setAnnouncement]);

  const exportCSV = () => {
    const headers = ['id', 'vendor', 'category', 'date', 'total_amount', 'currency', 'source_currency', 'raw_total_amount'];
    const rows = expenses.map(e => [
      e.id,
      '"' + String(e.vendor).replace(/"/g, '""') + '"',
      e.category,
      e.date,
      e.total_amount,
      e.currency || DEFAULT_CURRENCY,
      e.source_currency || e.currency || DEFAULT_CURRENCY,
      e.raw_total_amount ?? e.total_amount,
    ].join(','));
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

  const reset = useCallback(() => {
    setExpenses([]);
  }, []);

  return {
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
    reset,
  };
}
