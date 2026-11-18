import { useState } from 'react';
import {
  loadOrCreateGuestSessionId,
  getErrorMessage,
} from '../lib/appConstants';
import type { UserSession, View } from '../lib/appConstants';
import type { Toast } from './useToasts';

interface UseAuthParams {
  resetClientState: () => void;
  setAnnouncement: (value: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  setCurrentView: (view: View) => void;
}

export function useAuth({ resetClientState, setAnnouncement, pushToast, setCurrentView }: UseAuthParams) {
  const [authReady] = useState(true);
  const [session, setSession] = useState<UserSession | null>(() => {
    try {
      const stored = localStorage.getItem('smartspend:session');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [guestSessionId] = useState<string>(() => loadOrCreateGuestSessionId());
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authName, setAuthName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [showResendConfirmation, setShowResendConfirmation] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const submitAuth = async (mode: 'sign-in' | 'sign-up') => {
    const email = authEmail.trim();
    if (!email || !authPassword) {
      setAuthError('Email and password are required.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const userId = `user_${email.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const userSession: UserSession = {
        access_token: `${userId}__${crypto.randomUUID()}`,
        user: {
          id: userId,
          email,
          user_metadata: {
            display_name: authName.trim() || email.split('@')[0],
          },
        },
      };
      try {
        localStorage.setItem('smartspend:session', JSON.stringify(userSession));
      } catch {
        // ignore
      }
      setSession(userSession);
      const actionMsg = mode === 'sign-in' ? `Signed in as ${email}` : `Account created for ${email}`;
      setAnnouncement(actionMsg);
      pushToast({ message: actionMsg, tone: 'accent' });
      setCurrentView('dashboard');
      setAuthPassword('');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Authentication failed.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      try {
        localStorage.removeItem('smartspend:session');
      } catch {
        // ignore
      }
      setSession(null);
      resetClientState();
      setAuthName('');
      setAuthEmail('');
      setShowResendConfirmation(false);
      setAnnouncement('Signed out');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Sign-out failed.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const requestPasswordReset = async () => {
    const email = authEmail.trim();
    if (!email) {
      setAuthError('Enter your email first, then request a reset link.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice('Password reset link sent — check your email.');
    setAuthBusy(false);
  };

  const resendConfirmation = async () => {
    const email = authEmail.trim();
    if (!email) {
      setAuthError('Enter your email first, then resend the confirmation link.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice('Confirmation email resent — check your inbox.');
    setAuthBusy(false);
  };

  const submitNewPassword = async () => {
    if (recoveryPassword.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }
    setRecoveryBusy(true);
    setAuthError(null);
    setRecoveryMode(false);
    setRecoveryPassword('');
    setAuthNotice(null);
    pushToast({ message: 'Password updated.', tone: 'accent' });
    setAnnouncement('Password updated');
    setRecoveryBusy(false);
  };

  const keepGuestMode = () => {
    loadOrCreateGuestSessionId();
    setSession(null);
    setAnnouncement('Guest session active');
    setCurrentView('dashboard');
  };

  const isSignedIn = Boolean(session?.user);

  return {
    authReady,
    session,
    setSession,
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
  };
}
