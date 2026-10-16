import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import type { Profile } from '../types';

interface AuthContextType {
  user: { id: string; email: string } | null;
  profile: Profile | null;
  isLoading: boolean;
  isMock: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string; message?: string }>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<Profile>) => Promise<{ error?: string }>;
  completeOnboarding: (data: { full_name: string; website: string; core_offer: string }) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOCAL_STORAGE_USER_KEY = 'echo_mock_user';
const LOCAL_STORAGE_PROFILE_KEY = 'echo_mock_profile';

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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const isMock = !isConfigured;

  /**
   * Loads (or lazily creates) the profile row for a Supabase user.
   * Declared before the init effect so it is not captured mid-initialisation.
   */
  const fetchSupabaseProfile = useCallback(async (userId: string) => {
    if (!supabase) return;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        // The on_auth_user_created trigger normally creates this row; only fall
        // back to a manual insert when it genuinely is missing.
        console.warn('Profile fetch warning (may need creation):', error.message);
        const newProf = buildEmptyProfile(userId);
        const { error: insertError } = await supabase.from('profiles').insert(newProf);
        if (insertError) {
          console.error('Could not create profile row:', insertError.message);
          return;
        }
        setProfile(newProf);
      } else if (data) {
        setProfile(data as Profile);
      }
    } catch (err) {
      console.error('Error fetching Supabase profile:', err);
    }
  }, []);

  // Initialise auth state once.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const initAuth = async () => {
      if (isConfigured && supabase) {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();

          if (session?.user) {
            setUser({ id: session.user.id, email: session.user.email || '' });
            await fetchSupabaseProfile(session.user.id);
          } else {
            setUser(null);
            setProfile(null);
          }

          const {
            data: { subscription },
          } = supabase.auth.onAuthStateChange((_event, nextSession) => {
            if (cancelled) return;
            if (nextSession?.user) {
              setUser({ id: nextSession.user.id, email: nextSession.user.email || '' });
              void fetchSupabaseProfile(nextSession.user.id);
            } else {
              setUser(null);
              setProfile(null);
            }
          });

          unsubscribe = () => subscription.unsubscribe();
        } catch (err) {
          console.error('Supabase init error, falling back to local:', err);
          initMockAuth();
        }
      } else {
        initMockAuth();
      }

      if (!cancelled) setIsLoading(false);
    };

    const initMockAuth = () => {
      const savedUser = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
      const savedProfile = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY);
      if (!savedUser) return;

      try {
        setUser(JSON.parse(savedUser));
        setProfile(savedProfile ? JSON.parse(savedProfile) : buildEmptyProfile('mock-user-1'));
      } catch {
        setUser(null);
        setProfile(null);
      }
    };

    void initAuth();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
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

      if (data.user) {
        setUser({ id: data.user.id, email: data.user.email || email });
        await fetchSupabaseProfile(data.user.id);
      }
      return {};
    }

    // Local sandbox sign-in.
    const mockUser = { id: 'mock-user-1', email };
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

    if (isConfigured && supabase) {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/#/dashboard`,
        },
      });
      if (error) return { error: error.message };

      if (data.session?.user) {
        setUser({ id: data.session.user.id, email: data.session.user.email || email });
        await fetchSupabaseProfile(data.session.user.id);
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
    setUser(null);
    setProfile(null);
    localStorage.removeItem(LOCAL_STORAGE_USER_KEY);
    localStorage.removeItem(LOCAL_STORAGE_PROFILE_KEY);
  };

  const updateProfile = async (updates: Partial<Profile>): Promise<{ error?: string }> => {
    if (!profile) return { error: 'No profile found' };

    const updated: Profile = {
      ...profile,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (isConfigured && supabase && user) {
      const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
      if (error) return { error: error.message };
    }

    setProfile(updated);
    localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(updated));
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
        isMock,
        signIn,
        signUp,
        signOut,
        updateProfile,
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