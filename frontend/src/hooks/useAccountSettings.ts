import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { getStoredThemePreference } from '../lib/theme';
import type { ThemePreference } from '../lib/theme';
import {
  API_URL,
  DEFAULT_CATEGORY,
  DEFAULT_CURRENCY,
  BASE_CATEGORY_OPTIONS,
  CATEGORY_STORAGE_KEY,
  loadCustomCategories,
  getErrorMessage,
} from '../lib/appConstants';
import type { AccountSettingsPayload } from '../lib/appConstants';
import type { Toast } from './useToasts';

interface UseAccountSettingsParams {
  requestConfig: AxiosRequestConfig;
  session: Session | null;
  authReady: boolean;
  isGuestSession: boolean;
  themePreference: ThemePreference;
  setThemePreference: (theme: ThemePreference) => void;
  fetchExpenses: () => Promise<void> | void;
  setAnnouncement: (value: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  setAuthName: (value: string) => void;
  setAuthEmail: (value: string) => void;
  // The receipt-form category state lives in useReceiptQueue, which is created
  // after this hook (it needs customCategories from here). removeCustomCategory
  // only touches it in an event handler, so a ref reaches the live value/setter
  // without a render-time dependency cycle.
  categoryRef: React.MutableRefObject<{ category: string; setCategory: (value: string) => void }>;
  setFilterCategories: React.Dispatch<React.SetStateAction<string[]>>;
}

export function useAccountSettings({
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
}: UseAccountSettingsParams) {
  const [customCategories, setCustomCategories] = useState<string[]>(loadCustomCategories);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [accountDraft, setAccountDraft] = useState({
    displayName: '',
    email: '',
    avatarUrl: '',
    currency: DEFAULT_CURRENCY,
  });
  const [accountBusy, setAccountBusy] = useState(false);
  const [reconvertBusy, setReconvertBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (isGuestSession) {
        localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(customCategories));
      } else {
        localStorage.removeItem(CATEGORY_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [customCategories, isGuestSession]);

  const loadAccountSettings = useCallback(async () => {
    try {
      if (session?.user) {
        await axios.post(`${API_URL}/account-migrate-guest`, {}, requestConfig);
      }
      const response = await axios.get<AccountSettingsPayload>(`${API_URL}/account-settings`, requestConfig);
      const storedCategories = loadCustomCategories();
      const nextTheme = response.data.theme === 'light' || response.data.theme === 'dark' || response.data.theme === 'system'
        ? response.data.theme
        : getStoredThemePreference();
      setAccountDraft({
        displayName: response.data.display_name || '',
        email: response.data.email || session?.user?.email || '',
        avatarUrl: response.data.avatar_url || '',
        currency: response.data.currency || DEFAULT_CURRENCY,
      });
      setAuthName(response.data.display_name || '');
      setAuthEmail(response.data.email || session?.user?.email || '');
      setCustomCategories(
        session?.user
          ? (response.data.custom_categories || [])
          : ((response.data.custom_categories && response.data.custom_categories.length > 0)
            ? response.data.custom_categories
            : storedCategories)
      );
      setThemePreference(nextTheme);
      setAccountError(null);
    } catch (error) {
      setAccountError(getErrorMessage(error, 'Unable to load account settings.'));
    }
  }, [requestConfig, session, setAuthName, setAuthEmail, setThemePreference]);

  useEffect(() => {
    if (!authReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAccountSettings();
  }, [authReady, loadAccountSettings]);

  const addCustomCategory = () => {
    const nextCategory = categoryDraft.trim();
    if (!nextCategory) return;
    setCustomCategories(prev => prev.includes(nextCategory) ? prev : [...prev, nextCategory]);
    setCategoryDraft('');
    setAnnouncement(`Added category ${nextCategory}`);
  };

  const removeCustomCategory = (categoryName: string) => {
    if (BASE_CATEGORY_OPTIONS.includes(categoryName)) return;
    setCustomCategories(prev => prev.filter(cat => cat !== categoryName));
    setFilterCategories(prev => prev.filter(cat => cat !== categoryName));
    if (categoryRef.current.category === categoryName) {
      categoryRef.current.setCategory(DEFAULT_CATEGORY);
    }
    setAnnouncement(`Removed category ${categoryName}`);
  };

  const saveAccountSettings = async () => {
    setAccountBusy(true);
    setAccountError(null);
    try {
      const payload: AccountSettingsPayload = {
        display_name: accountDraft.displayName.trim() || null,
        email: accountDraft.email.trim() || null,
        avatar_url: accountDraft.avatarUrl.trim() || null,
        currency: accountDraft.currency || DEFAULT_CURRENCY,
        theme: themePreference,
        custom_categories: customCategories,
      };
      await axios.put(`${API_URL}/account-settings`, payload, requestConfig);
      const client = supabase;
      if (session?.user && client) {
        const metadata = {
          display_name: payload.display_name || '',
          avatar_url: payload.avatar_url || '',
          currency: payload.currency || DEFAULT_CURRENCY,
          theme: payload.theme || 'system',
          custom_categories: payload.custom_categories || [],
        };
        await client.auth.updateUser({
          ...(payload.email && payload.email !== session.user.email ? { email: payload.email } : {}),
          data: metadata,
        });
      }
      setAnnouncement('Account settings saved');
      pushToast({ message: 'Account settings saved.', tone: 'accent' });
      if (payload.email) setAuthEmail(payload.email);
      if (payload.theme) setThemePreference(payload.theme);
    } catch (error) {
      setAccountError(getErrorMessage(error, 'Unable to save account settings.'));
    } finally {
      setAccountBusy(false);
    }
  };

  const reconvertExistingReceipts = async () => {
    const preferred = accountDraft.currency || DEFAULT_CURRENCY;
    setReconvertBusy(true);
    try {
      const response = await axios.post<{ reconverted: number; failed: number; skipped: number }>(
        `${API_URL}/expenses/reconvert`,
        {},
        requestConfig,
      );
      const { reconverted, failed } = response.data;
      const noun = reconverted === 1 ? 'receipt' : 'receipts';
      const message = reconverted > 0
        ? `Reconverted ${reconverted} ${noun} to ${preferred}${failed ? ` · ${failed} couldn't be converted` : ''}.`
        : failed > 0
          ? `Couldn't reconvert ${failed} ${failed === 1 ? 'receipt' : 'receipts'} — no FX rate for their dates.`
          : `Everything is already in ${preferred}.`;
      pushToast({ message, tone: failed > 0 && reconverted === 0 ? 'danger' : 'accent', duration: 5000 });
      await fetchExpenses();
    } catch (error) {
      pushToast({ message: `Reconvert failed: ${getErrorMessage(error, 'Unknown error')}`, tone: 'danger', duration: 5000 });
    } finally {
      setReconvertBusy(false);
    }
  };

  const reset = useCallback(() => {
    setAccountDraft({
      displayName: '',
      email: '',
      avatarUrl: '',
      currency: DEFAULT_CURRENCY,
    });
    setCustomCategories(loadCustomCategories());
  }, []);

  return {
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
    reset,
  };
}
