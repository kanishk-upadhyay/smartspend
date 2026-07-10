import { useMemo } from 'react';
import type { Session } from '@supabase/supabase-js';

export function useRequestConfig(session: Session | null, guestSessionId: string) {
  const accessToken = session?.access_token;
  const requestConfig = useMemo(() => ({
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      'X-SmartSpend-Guest-Id': guestSessionId,
    },
  }), [guestSessionId, accessToken]);
  return requestConfig;
}
