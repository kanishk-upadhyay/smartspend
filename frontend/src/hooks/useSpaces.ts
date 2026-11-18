import { useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { API_URL, getErrorMessage } from '../lib/appConstants';
import type { Space, SpaceExpensesResponse, Expense } from '../lib/appConstants';
import type { Toast } from './useToasts';

interface UseSpacesParams {
  requestConfig: AxiosRequestConfig;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  setAnnouncement: (value: string) => void;
}

export function useSpaces({ requestConfig, pushToast, setAnnouncement }: UseSpacesParams) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<number | null>(null);
  const [activeSpaceData, setActiveSpaceData] = useState<SpaceExpensesResponse | null>(null);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spaceDataLoading, setSpaceDataLoading] = useState(false);

  const fetchSpaces = useCallback(async () => {
    try {
      setSpacesLoading(true);
      const res = await axios.get<Space[]>(`${API_URL}/spaces`, requestConfig);
      setSpaces(res.data);
    } catch (err) {
      console.error('Failed to load spaces:', err);
    } finally {
      setSpacesLoading(false);
    }
  }, [requestConfig]);

  const fetchSpaceData = useCallback(async (spaceId: number) => {
    try {
      setSpaceDataLoading(true);
      const res = await axios.get<SpaceExpensesResponse>(`${API_URL}/spaces/${spaceId}/expenses`, requestConfig);
      setActiveSpaceData(res.data);
    } catch (err) {
      console.error('Failed to load space data:', err);
      const msg = getErrorMessage(err, 'Failed to load space');
      pushToast({ message: msg, tone: 'danger' });
    } finally {
      setSpaceDataLoading(false);
    }
  }, [requestConfig, pushToast]);

  const createSpace = useCallback(async (name: string, baseCurrency = 'INR') => {
    try {
      const res = await axios.post<Space>(
        `${API_URL}/spaces`,
        { name, base_currency: baseCurrency },
        requestConfig
      );
      setSpaces(prev => [res.data, ...prev]);
      setActiveSpaceId(res.data.id);
      pushToast({ message: `Space "${res.data.name}" created!`, tone: 'accent' });
      setAnnouncement(`Created space ${res.data.name}`);
      return res.data;
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to create space');
      pushToast({ message: msg, tone: 'danger' });
      return null;
    }
  }, [requestConfig, pushToast, setAnnouncement]);

  const joinSpace = useCallback(async (codeOrSlug: string, displayName?: string) => {
    try {
      const res = await axios.post<Space>(
        `${API_URL}/spaces/join`,
        { code_or_slug: codeOrSlug, display_name: displayName || undefined },
        requestConfig
      );
      setSpaces(prev => {
        const filtered = prev.filter(s => s.id !== res.data.id);
        return [res.data, ...filtered];
      });
      setActiveSpaceId(res.data.id);
      pushToast({ message: `Joined space "${res.data.name}"!`, tone: 'accent' });
      setAnnouncement(`Joined space ${res.data.name}`);
      return res.data;
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to join space. Check the join code or link.');
      pushToast({ message: msg, tone: 'danger' });
      return null;
    }
  }, [requestConfig, pushToast, setAnnouncement]);

  const deleteSpace = useCallback(async (spaceId: number) => {
    try {
      await axios.delete(`${API_URL}/spaces/${spaceId}`, requestConfig);
      setSpaces(prev => prev.filter(s => s.id !== spaceId));
      if (activeSpaceId === spaceId) {
        setActiveSpaceId(null);
        setActiveSpaceData(null);
      }
      pushToast({ message: 'Space deleted', tone: 'accent' });
      return true;
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to delete space');
      pushToast({ message: msg, tone: 'danger' });
      return false;
    }
  }, [requestConfig, activeSpaceId, pushToast]);

  const addExpenseToSpace = useCallback(async (spaceId: number, expensePayload: Partial<Expense>) => {
    try {
      const res = await axios.post<Expense>(
        `${API_URL}/spaces/${spaceId}/expenses`,
        expensePayload,
        requestConfig
      );
      pushToast({ message: `Added receipt to space!`, tone: 'accent' });
      await fetchSpaceData(spaceId);
      return res.data;
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to add expense to space');
      pushToast({ message: msg, tone: 'danger' });
      return null;
    }
  }, [requestConfig, pushToast, fetchSpaceData]);

  // When activeSpaceId changes, refresh space data
  useEffect(() => {
    if (activeSpaceId != null) {
      fetchSpaceData(activeSpaceId);
    } else {
      setActiveSpaceData(null);
    }
  }, [activeSpaceId, fetchSpaceData]);

  const reset = useCallback(() => {
    setSpaces([]);
    setActiveSpaceId(null);
    setActiveSpaceData(null);
  }, []);

  return {
    spaces,
    activeSpaceId,
    setActiveSpaceId,
    activeSpaceData,
    spacesLoading,
    spaceDataLoading,
    fetchSpaces,
    fetchSpaceData,
    createSpace,
    joinSpace,
    deleteSpace,
    addExpenseToSpace,
    reset,
  };
}
