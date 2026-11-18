import { useMemo } from 'react';
import type { UserSession } from '../lib/appConstants';

export function useRequestConfig(session: UserSession | null, guestSessionId: string) {
  const accessToken = session?.access_token;
  const userEmail = session?.user?.email;
  const displayName = session?.user?.user_metadata?.display_name;
  const requestConfig = useMemo(() => ({
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(userEmail ? { 'X-SmartSpend-User-Email': userEmail } : {}),
      ...(displayName ? { 'X-SmartSpend-User-Name': displayName } : {}),
      'X-SmartSpend-Guest-Id': guestSessionId,
    },
  }), [guestSessionId, accessToken, userEmail, displayName]);
  return requestConfig;
}
