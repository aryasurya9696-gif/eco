import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import type { Profile } from '../types';

interface AuthContextType {
  user: { id: string; email: string } | null;
  profile: Profile | null;
  isLoading: boolean;
  isMock: boolean;
  signIn: (email: string, password?: string) => Promise<{ error?: string }>;
  signUp: (email: string, password?: string) => Promise<{ error?: string; message?: string }>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<Profile>) => Promise<{ error?: string }>;
  completeOnboarding: (data: { full_name: string; website: string; core_offer: string }) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOCAL_STORAGE_USER_KEY = 'echo_mock_user';
const LOCAL_STORAGE_PROFILE_KEY = 'echo_mock_profile';

const defaultProfile: Profile = {
  id: 'mock-user-1',
  full_name: '',
  website: '',
  core_offer: '',
  onboarding_completed: false,
  onboarding_step: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const isMock = !isConfigured;

  // Initialize auth state
  useEffect(() => {
    async function initAuth() {
      if (isConfigured && supabase) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user) {
            setUser({ id: session.user.id, email: session.user.email || '' });
            await fetchSupabaseProfile(session.user.id);
          } else {
            setUser(null);
            setProfile(null);
          }

          setIsLoading(false);

          const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, session) => {
            if (session?.user) {
              setUser({ id: session.user.id, email: session.user.email || '' });
              await fetchSupabaseProfile(session.user.id);
            } else {
              setUser(null);
              setProfile(null);
            }
          });

          return () => {
            authListener.subscription.unsubscribe();
          };
        } catch (err) {
          console.error("Supabase init error, falling back to local:", err);
          initMockAuth();
        }
      } else {
        initMockAuth();
      }
      setIsLoading(false);
    }

    function initMockAuth() {
      const savedUser = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
      const savedProfile = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY);
      if (savedUser) {
        try {
          setUser(JSON.parse(savedUser));
          if (savedProfile) {
            setProfile(JSON.parse(savedProfile));
          } else {
            setProfile(defaultProfile);
          }
        } catch {
          setUser(null);
          setProfile(null);
        }
      }
    }

    initAuth();
  }, []);

  const fetchSupabaseProfile = async (userId: string) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        console.warn('Profile fetch warning (may need creation):', error.message);
        // Create initial profile if missing
        const newProf: Profile = {
          id: userId,
          full_name: '',
          website: '',
          core_offer: '',
          onboarding_completed: false,
          onboarding_step: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await supabase.from('profiles').insert(newProf);
        setProfile(newProf);
      } else if (data) {
        setProfile(data as Profile);
      }
    } catch (err) {
      console.error('Error fetching Supabase profile:', err);
    }
  };

  const signIn = async (email: string, password: string = 'password123'): Promise<{ error?: string }> => {
    if (isConfigured && supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return { error: error.message };
      if (data.user) {
        setUser({ id: data.user.id, email: data.user.email || email });
        await fetchSupabaseProfile(data.user.id);
      }
      return {};
    }

    // Mock sign in
    const mockUser = { id: 'mock-user-1', email };
    setUser(mockUser);
    localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(mockUser));
    
    const existingProfile = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY);
    if (existingProfile) {
      setProfile(JSON.parse(existingProfile));
    } else {
      setProfile(defaultProfile);
      localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(defaultProfile));
    }
    return {};
  };

  const signUp = async (email: string, password: string = 'password123'): Promise<{ error?: string; message?: string }> => {
    if (isConfigured && supabase) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });
      if (error) return { error: error.message };
      if (data.session?.user) {
        setUser({ id: data.session.user.id, email: data.session.user.email || email });
        await fetchSupabaseProfile(data.session.user.id);
      } else if (data.user) {
        return { message: 'Confirmation link sent to your email! Please verify your inbox to sign in.' };
      }
      return {};
    }

    // Mock sign up (brand new user with onboarding_completed = false)
    const mockUser = { id: 'mock-user-1', email };
    const newProfile: Profile = {
      id: 'mock-user-1',
      full_name: '',
      website: '',
      core_offer: '',
      onboarding_completed: false,
      onboarding_step: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
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
  };

  const updateProfile = async (updates: Partial<Profile>): Promise<{ error?: string }> => {
    if (!profile) return { error: 'No profile found' };

    const updated = {
      ...profile,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (isConfigured && supabase && user) {
      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id);
      if (error) return { error: error.message };
    }

    setProfile(updated);
    localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(updated));
    return {};
  };

  const completeOnboarding = async (data: { full_name: string; website: string; core_offer: string }) => {
    return await updateProfile({
      ...data,
      onboarding_completed: true,
      onboarding_step: 4,
    });
  };

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

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
