import { useCallback, useRef, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
  tone?: 'info' | 'accent' | 'danger';
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>): number => {
    const id = ++toastIdRef.current;
    const duration = toast.duration ?? 4000;
    setToasts(prev => [...prev, { ...toast, id, duration }]);
    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration);
    }
    return id;
  }, [dismissToast]);

  return { toasts, pushToast, dismissToast };
}
