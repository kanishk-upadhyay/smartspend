import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import {
  API_URL,
  DEFAULT_CATEGORY,
  DEFAULT_CURRENCY,
  BASE_CATEGORY_OPTIONS,
  LAST_RECEIPT_CURRENCY_KEY,
  fileToBase64,
  saveToStorage,
  getErrorMessage,
  coerceItems,
  getStoredLastReceiptCurrency,
} from '../lib/appConstants';
import type { UploadResult } from '../lib/appConstants';
import type { Toast } from './useToasts';

export function useReceiptQueue(
  requestConfig: AxiosRequestConfig,
  onSaved: () => void,
  setAnnouncement: (value: string) => void,
  pushToast: (toast: Omit<Toast, 'id'>) => number,
  categoryOptions: string[],
  customCategories: string[],
) {
  const [loading, setLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [lastReceiptCurrency, setLastReceiptCurrency] = useState<string | null>(getStoredLastReceiptCurrency);
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [categoryWasSuggested, setCategoryWasSuggested] = useState(false);
  const [showHeicHelper, setShowHeicHelper] = useState(false);
  const [lastWasHeic, setLastWasHeic] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [prefetchedResults, setPrefetchedResults] = useState<UploadResult[]>([]);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const saveLockRef = useRef(false);

  const promoteNextResult = useCallback(() => {
    setPrefetchedResults(prev => {
      if (prev.length === 0) {
        setResult(null);
        setCurrentFileName(null);
        setCategoryWasSuggested(false);
        return prev;
      }

      const [next, ...rest] = prev;
      setResult(next);
      setCurrentFileName(next.filename || null);
      const suggested = next.extracted_data?.category;
      if (suggested && BASE_CATEGORY_OPTIONS.concat(customCategories).includes(suggested)) {
        setCategory(suggested);
        setCategoryWasSuggested(true);
      } else {
        setCategory(DEFAULT_CATEGORY);
        setCategoryWasSuggested(false);
      }
      return rest;
    });
  }, [customCategories]);

  useEffect(() => {
    if (!result && prefetchedResults.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      promoteNextResult();
    }
  }, [result, prefetchedResults, promoteNextResult]);

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

  const runOcr = useCallback(async (file: File) => {
    setLoading(true);
    setPendingFiles(prev => prev.slice(1));
    const shouldDisplayNow = !result;
    if (shouldDisplayNow) {
      setCurrentFileName(file.name);
    }
    try {
      const response = await axios.post<UploadResult>(`${API_URL}/upload`, {
        filename: file.name,
        content_type: file.type || undefined,
        data_base64: await fileToBase64(file),
      }, requestConfig);
      if (shouldDisplayNow) {
        setResult(response.data);
        setCurrentFileName(response.data.filename || file.name);
      } else {
        setPrefetchedResults(prev => [...prev, response.data]);
      }
      const suggested = response.data?.extracted_data?.category;
      if (shouldDisplayNow && suggested && categoryOptions.includes(suggested)) {
        setCategory(suggested);
        setCategoryWasSuggested(true);
      } else if (shouldDisplayNow) {
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
    } finally {
      setLoading(false);
    }
  }, [result, categoryOptions, pushToast, requestConfig, setAnnouncement]);

  useEffect(() => {
    if (!loading && pendingFiles.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runOcr(pendingFiles[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles, loading]);

  const skipCurrent = () => {
    setResult(null);
    setCategoryWasSuggested(false);
    setCurrentFileName(null);
    setAnnouncement('Skipped');
  };

  const clearQueue = () => {
    setPendingFiles([]);
    setPrefetchedResults([]);
    setResult(null);
    setCurrentFileName(null);
    setCategoryWasSuggested(false);
    setAnnouncement('Queue cleared');
  };

  const saveExpense = async () => {
    if (!result || isSaving || saveLockRef.current) return;
    saveLockRef.current = true;
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
        items: coerceItems(result.extracted_data.items),
        image_path: result.image_path || null,
      };
      await axios.post(`${API_URL}/expenses`, payload, requestConfig);
      saveToStorage(LAST_RECEIPT_CURRENCY_KEY, sourceCurrency);
      setLastReceiptCurrency(sourceCurrency);
      setResult(null);
      setCurrentFileName(null);
      setCategoryWasSuggested(false);
      pushToast({ message: `Saved ${payload.vendor || 'receipt'}.`, tone: 'accent' });
      onSaved();
    } catch (error) {
      console.error('Save failed:', error);
      pushToast({ message: `Save failed: ${getErrorMessage(error, 'Unknown error')}`, tone: 'danger', duration: 5000 });
      setAnnouncement(`Unable to save expense: ${getErrorMessage(error, 'Unknown error')}`);
    } finally {
      setIsSaving(false);
      saveLockRef.current = false;
    }
  };

  const reset = useCallback(() => {
    setResult(null);
    setPrefetchedResults([]);
    setPendingFiles([]);
    setCurrentFileName(null);
  }, []);

  return {
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
    reset,
  };
}
