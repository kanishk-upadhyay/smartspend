import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  loadOrCreateGuestSessionId,
  getErrorMessage,
} from '../lib/appConstants';
import type { View } from '../lib/appConstants';
import type { Toast } from './useToasts';

interface UseAuthParams {
  resetClientState: () => void;
  setAnnouncement: (value: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  setCurrentView: (view: View) => void;
}

export function useAuth({ resetClientState, setAnnouncement, pushToast, setCurrentView }: UseAuthParams) {
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [guestSessionId] = useState<string>(() => loadOrCreateGuestSessionId());
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authName, setAuthName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  // Reveal the "Resend confirmation email" affordance after a successful sign-up
  // or when sign-in fails because the address is unconfirmed.
  const [showResendConfirmation, setShowResendConfirmation] = useState(false);
  // PASSWORD_RECOVERY (Supabase) puts the app into a "set a new password" mode.
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  useEffect(() => {
    const client = supabase;
    if (!isSupabaseConfigured || !client) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAuthReady(true);
      return;
    }

    let active = true;
    const bootstrap = async () => {
      try {
        const { data, error } = await client.auth.getSession();
        if (!active) return;
        if (error) {
          setAuthError(error.message);
        }
        setSession(data.session);
      } catch (err) {
        // Never leave the app stuck on the loading gate if getSession rejects
        // (network/config failure) — surface it and fall through to authReady.
        if (active) setAuthError(getErrorMessage(err, 'Unable to restore session'));
      } finally {
        if (active) setAuthReady(true);
      }
    };

    bootstrap();

    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setAuthReady(true);
      if (_event === 'SIGNED_OUT') {
        // Multi-tab / expired-session sign-out: clear the previous identity's
        // in-memory state so a re-render never shows their data (see resetClientState).
        resetClientState();
        setAuthName('');
        setAuthEmail('');
        // If a session expires while the "set a new password" form is open,
        // don't strand the user in recovery mode with a dead session.
        setRecoveryMode(false);
        setRecoveryPassword('');
      } else if (_event === 'PASSWORD_RECOVERY') {
        // User returned from a reset link — surface the "set a new password" form.
        setRecoveryMode(true);
        setCurrentView('account');
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitAuth = async (mode: 'sign-in' | 'sign-up') => {
    const client = supabase;
    if (!client) {
      setAuthError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable email sign-in.');
      return;
    }

    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const email = authEmail.trim();
      if (!email || !authPassword) {
        throw new Error('Email and password are required.');
      }
      if (mode === 'sign-in') {
        const { error } = await client.auth.signInWithPassword({ email, password: authPassword });
        if (error) {
          // Supabase reports an unconfirmed address here — offer a resend.
          if (/email\s*not\s*confirmed/i.test(error.message || '')) {
            setShowResendConfirmation(true);
          }
          throw error;
        }
        setShowResendConfirmation(false);
        setAnnouncement(`Signed in as ${email}`);
      } else {
        const { data, error } = await client.auth.signUp({
          email,
          password: authPassword,
          options: {
            // Send the confirmation link back to wherever the app is actually
            // served (prod or local dev) instead of Supabase's default Site URL.
            emailRedirectTo: `${window.location.origin}/`,
            data: {
              display_name: authName.trim() || email.split('@')[0],
            },
          },
        });
        if (error) throw error;
        // With enumeration protection on, Supabase doesn't error on a duplicate
        // email — it returns a user with an empty `identities` array. Flag it
        // so people aren't told an account was created when it wasn't.
        if (data.user && (data.user.identities?.length ?? 0) === 0) {
          setAuthMode('sign-in');
          throw new Error('That email is already registered — sign in instead.');
        }
        setAnnouncement(`Account created for ${email}`);
        setAuthNotice('Account created — check your email to confirm, then sign in.');
        setShowResendConfirmation(true);
        setAuthMode('sign-in');
      }
      setAuthPassword('');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Authentication failed.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    const client = supabase;
    if (!client) {
      setSession(null);
      resetClientState();
      setAuthName('');
      setAuthEmail('');
      setShowResendConfirmation(false);
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
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
    const client = supabase;
    if (!client) {
      setAuthError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable email sign-in.');
      return;
    }
    const email = authEmail.trim();
    if (!email) {
      setAuthError('Enter your email first, then request a reset link.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/`,
      });
      if (error) throw error;
      setAuthNotice('Password reset link sent — check your email.');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Unable to send reset link.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const resendConfirmation = async () => {
    const client = supabase;
    if (!client) {
      setAuthError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable email sign-in.');
      return;
    }
    const email = authEmail.trim();
    if (!email) {
      setAuthError('Enter your email first, then resend the confirmation link.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const { error } = await client.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) throw error;
      setAuthNotice('Confirmation email resent — check your inbox.');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Unable to resend confirmation email.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const submitNewPassword = async () => {
    const client = supabase;
    if (!client) return;
    if (recoveryPassword.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }
    setRecoveryBusy(true);
    setAuthError(null);
    try {
      const { error } = await client.auth.updateUser({ password: recoveryPassword });
      if (error) throw error;
      setRecoveryMode(false);
      setRecoveryPassword('');
      setAuthNotice(null);
      pushToast({ message: 'Password updated.', tone: 'accent' });
      setAnnouncement('Password updated');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Unable to update password.'));
    } finally {
      setRecoveryBusy(false);
    }
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
