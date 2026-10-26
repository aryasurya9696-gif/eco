import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import { leadsStore } from '../components/leads/leads-store';
import { mailStore } from '../components/mail/mail-store';
import { socialStore } from '../lib/social';
import { companyStore } from '../components/leads/company-store';
import type { Profile } from '../types';

type AuthUser = { id: string; email: string };

interface AuthContextType {
  user: AuthUser | null;
  profile: Profile | null;
  isLoading: boolean;
  /** Set when the profile row could not be read (other than "no row yet"). */
  profileError: string | null;
  retryProfile: () => Promise<void>;
  /** True after arriving from a password-reset link, until a new password is set. */
  passwordRecovery: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string; message?: string }>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ error?: string; message?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  updateProfile: (updates: Partial<Profile>) => Promise<{ error?: string }>;
  /**
   * Merges fields that were already persisted elsewhere into the in-memory
   * profile, without writing to the database.
   */
  patchProfile: (fields: Partial<Profile>) => void;
  completeOnboarding: (data: { full_name: string; website: string; core_offer: string }) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Matches the sign-up and reset forms. */
const MIN_PASSWORD_LENGTH = 8;

const LOCAL_STORAGE_USER_KEY = 'echo_mock_user';
const LOCAL_STORAGE_PROFILE_KEY = 'echo_mock_profile';

/** PostgREST code for `.single()` matching zero rows. */
const NO_ROWS = 'PGRST116';

const buildEmptyProfile = (id: string): Profile => ({
  id,
  full_name: '',
  website: '',
  core_offer: '',
  onboarding_completed: false,
  onboarding_step: 0,
  lookback_hours: 24,
  sweep_time_utc: '06:00',
  sweep_frequency: '24h',
  min_intent_threshold: 0,
  enabled_channels: ['twitter', 'reddit', 'google'],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

/** Sandbox mode only: the signed-in user and profile kept in localStorage. */
function readMockSession(): { user: AuthUser; profile: Profile } | null {
  if (isConfigured) return null;
  try {
    const savedUser = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
    if (!savedUser) return null;
    const savedProfile = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY);
    return {
      user: JSON.parse(savedUser) as AuthUser,
      profile: savedProfile ? (JSON.parse(savedProfile) as Profile) : buildEmptyProfile('mock-user-1'),
    };
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mockSession] = useState(readMockSession);
  const [user, setUser] = useState<AuthUser | null>(() => mockSession?.user ?? null);
  const [profile, setProfile] = useState<Profile | null>(() => mockSession?.profile ?? null);
  // Sandbox mode resolves synchronously; connected mode waits for INITIAL_SESSION.
  const [isLoading, setIsLoading] = useState<boolean>(isConfigured);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState<boolean>(false);

  /** The user id the current state belongs to; guards against stale fetches. */
  const currentUserIdRef = useRef<string | null>(mockSession?.user.id ?? null);
  /** The in-flight profile load for currentUserIdRef, shared by every caller. */
  const profileLoadRef = useRef<Promise<void> | null>(null);

  /**
   * Loads (or, only when genuinely missing, creates) the profile row.
   * Results for a user who is no longer signed in are discarded.
   */
  const fetchSupabaseProfile = useCallback(async (userId: string): Promise<void> => {
    if (!supabase) return;
    const isCurrent = () => currentUserIdRef.current === userId;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (!isCurrent()) return;

      if (error) {
        if (error.code !== NO_ROWS) {
          // A network or permission failure is not a missing row. Inserting
          // here would at best fail and at worst reset onboarding.
          console.error('Profile fetch failed:', error.message);
          setProfileError(error.message || 'Could not load your profile.');
          return;
        }
        // The on_auth_user_created trigger normally creates this row; only fall
        // back to a manual insert when it genuinely is missing.
        const newProf = buildEmptyProfile(userId);
        const { error: insertError } = await supabase.from('profiles').insert(newProf);
        if (!isCurrent()) return;
        if (insertError) {
          console.error('Could not create profile row:', insertError.message);
          setProfileError(insertError.message || 'Could not create your profile.');
          return;
        }
        setProfileError(null);
        setProfile(newProf);
      } else if (data) {
        setProfileError(null);
        setProfile(data as Profile);
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching Supabase profile:', err);
      setProfileError((err as Error)?.message || 'Could not load your profile.');
    }
  }, []);

  /**
   * Applies a session user. A repeat of the same id (token refresh, the
   * SIGNED_IN event that follows signInWithPassword) is a no-op apart from an
   * email change, so it neither re-renders consumers nor refetches the profile.
   */
  const applySessionUser = useCallback(
    (sessionUser: { id: string; email?: string | null } | null): Promise<void> => {
      if (!sessionUser) {
        currentUserIdRef.current = null;
        profileLoadRef.current = null;
        setUser(null);
        setProfile(null);
        setProfileError(null);
        return Promise.resolve();
      }

      const email = sessionUser.email || '';
      if (currentUserIdRef.current === sessionUser.id) {
        setUser((prev) =>
          prev && prev.id === sessionUser.id && prev.email === email
            ? prev
            : { id: sessionUser.id, email },
        );
        return profileLoadRef.current ?? Promise.resolve();
      }

      currentUserIdRef.current = sessionUser.id;
      setUser({ id: sessionUser.id, email });
      setProfile(null);
      setProfileError(null);
      // Deferred a tick: supabase-js holds its auth lock while running
      // onAuthStateChange callbacks, and a query issued inside one can deadlock.
      const load = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
        fetchSupabaseProfile(sessionUser.id),
      );
      profileLoadRef.current = load;
      return load;
    },
    [fetchSupabaseProfile],
  );

  // Mail is account-scoped and read outside the Mail tab (the Sidebar unread
  // badge, a composer opened from Leads), so it follows the signed-in user
  // here rather than being loaded by MailTab. init(null) resets it.
  useEffect(() => {
    mailStore.init(user?.id ?? null);
  }, [user?.id]);

  // Initialise auth state once. The subscription is made synchronously so a
  // StrictMode mount/unmount/mount cycle cleans up and resubscribes correctly.
  useEffect(() => {
    // Sandbox mode was initialised from localStorage in the state initialisers.
    if (!isConfigured || !supabase) return;

    let cancelled = false;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      const load = applySessionUser(session?.user ?? null);
      if (event === 'INITIAL_SESSION') {
        void load.finally(() => {
          if (!cancelled) setIsLoading(false);
        });
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applySessionUser]);

  const retryProfile = useCallback(async () => {
    const id = currentUserIdRef.current;
    if (!id || !isConfigured) return;
    setProfileError(null);
    const load = fetchSupabaseProfile(id);
    profileLoadRef.current = load;
    await load;
  }, [fetchSupabaseProfile]);

  const signIn = async (
    email: string,
    password: string,
  ): Promise<{ error?: string }> => {
    if (!email.trim() || !password) {
      return { error: 'Email and password are both required.' };
    }

    if (isConfigured && supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) return { error: error.message };
      // Shares the load already started by the SIGNED_IN event, if any.
      if (data.user) await applySessionUser(data.user);
      return {};
    }

    // Local sandbox sign-in.
    const mockUser = { id: 'mock-user-1', email };
    currentUserIdRef.current = mockUser.id;
    setUser(mockUser);
    localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(mockUser));

    const savedProfile = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY);
    if (savedProfile) {
      try {
        setProfile(JSON.parse(savedProfile));
      } catch {
        setProfile(buildEmptyProfile('mock-user-1'));
      }
    } else {
      const fresh = buildEmptyProfile('mock-user-1');
      setProfile(fresh);
      localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(fresh));
    }
    return {};
  };

  const signUp = async (
    email: string,
    password: string,
  ): Promise<{ error?: string; message?: string }> => {
    if (!email.trim() || !password) {
      return { error: 'Email and password are both required.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }

    if (isConfigured && supabase) {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // No hash: the auth tokens come back in the fragment, and App routes
          // a signed-in arrival from that callback to the dashboard.
          emailRedirectTo: `${window.location.origin}/`,
        },
      });
      if (error) return { error: error.message };

      if (data.session?.user) {
        await applySessionUser(data.session.user);
      } else if (data.user) {
        return {
          message: 'Confirmation link sent to your email! Please verify your inbox to sign in.',
        };
      }
      return {};
    }

    // Local sandbox sign-up — always starts a fresh onboarding.
    const mockUser = { id: 'mock-user-1', email };
    const newProfile = buildEmptyProfile('mock-user-1');
    currentUserIdRef.current = mockUser.id;
    setUser(mockUser);
    setProfile(newProfile);
    localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(mockUser));
    localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(newProfile));
    return {};
  };

  const signOut = async () => {
    if (isConfigured && supabase) {
      await supabase.auth.signOut();
    }
    // Lead results, reveals and the run sequence belong to the old account.
    leadsStore.reset();
    mailStore.init(null);
    socialStore.reset();
    companyStore.reset();
    currentUserIdRef.current = null;
    profileLoadRef.current = null;
    setUser(null);
    setProfile(null);
    setProfileError(null);
    setPasswordRecovery(false);
    localStorage.removeItem(LOCAL_STORAGE_USER_KEY);
    localStorage.removeItem(LOCAL_STORAGE_PROFILE_KEY);
  };

  const requestPasswordReset = async (
    email: string,
  ): Promise<{ error?: string; message?: string }> => {
    if (!email.trim()) return { error: 'Enter your email address first.' };
    if (!isConfigured || !supabase) {
      return { error: 'Password reset needs a connected Supabase project.' };
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/`,
    });
    if (error) return { error: error.message };
    return { message: 'If an account exists for that email, a reset link is on its way.' };
  };

  const updatePassword = async (password: string): Promise<{ error?: string }> => {
    if (!isConfigured || !supabase) {
      return { error: 'Password reset needs a connected Supabase project.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { error: error.message };
    setPasswordRecovery(false);
    return {};
  };

  const patchProfile = useCallback((fields: Partial<Profile>) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const next: Profile = { ...prev, ...fields, updated_at: new Date().toISOString() };
      if (!isConfigured) localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateProfile = async (updates: Partial<Profile>): Promise<{ error?: string }> => {
    if (!profile) return { error: 'No profile found' };

    if (isConfigured && supabase && user) {
      const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
      if (error) return { error: error.message };
    }

    // Functional merge, so a concurrent patch (e.g. settings saved alongside)
    // is not overwritten by this call's stale copy of the profile.
    patchProfile(updates);
    return {};
  };

  const completeOnboarding = async (data: {
    full_name: string;
    website: string;
    core_offer: string;
  }) =>
    updateProfile({
      ...data,
      onboarding_completed: true,
      onboarding_step: 4,
    });

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isLoading,
        profileError,
        retryProfile,
        passwordRecovery,
        signIn,
        signUp,
        signOut,
        requestPasswordReset,
        updatePassword,
        updateProfile,
        patchProfile,
        completeOnboarding,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
