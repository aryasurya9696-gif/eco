import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import { invokeSearchSweep } from '../lib/sweep';
import type { DraftResult, KeywordSuggestionResult } from '../lib/ai';
import { generateAiOutreachDraft, generateAiKeywordsFromOffer } from '../lib/ai';
import { channelLabel, KEYWORD_LIMIT } from '../lib/constants';
import { walletStore } from '../lib/wallet-store';
import { useAuth } from './AuthContext';
import { downloadCsv, downloadTextFile } from '../lib/csv';
import type { Keyword, MonitoredPost, Platform, LeadStatus, Profile } from '../types';

export interface ToastMessage {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

type AddToast = (message: string, type?: 'info' | 'success' | 'error') => void;

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
// A context of their own. They used to live in the Echo context value, so
// every toast (and every toast expiring) re-rendered every useEcho consumer:
// the feed, the settings form, the sidebar. The actions context never changes,
// so callers that only raise toasts never re-render because of one.

interface ToastActions {
  addToast: AddToast;
  dismissToast: (id: string) => void;
}

const ToastListContext = createContext<ToastMessage[]>([]);
const ToastActionsContext = createContext<ToastActions | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback<AddToast>(
    (message, type = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      timers.current.set(id, setTimeout(() => dismissToast(id), 4000));
    },
    [dismissToast],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const actions = useMemo(() => ({ addToast, dismissToast }), [addToast, dismissToast]);

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastListContext.Provider value={toasts}>{children}</ToastListContext.Provider>
    </ToastActionsContext.Provider>
  );
};

/** Raise or dismiss toasts without subscribing to the list. */
export const useToastActions = (): ToastActions => {
  const ctx = useContext(ToastActionsContext);
  if (!ctx) throw new Error('useToastActions must be used within a ToastProvider');
  return ctx;
};

/** The visible toasts, for the toast container only. */
export const useToasts = (): ToastMessage[] => useContext(ToastListContext);


interface EchoContextType {
  keywords: Keyword[];
  keywordLimit: number;
  posts: MonitoredPost[];
  isLoadingKeywords: boolean;
  isLoadingPosts: boolean;
  filterKeyword: string;
  filterPlatform: Platform | 'all';
  filterStatus: LeadStatus | 'all';
  filterSearch: string;
  setFilterKeyword: (kw: string) => void;
  setFilterPlatform: (p: Platform | 'all') => void;
  setFilterStatus: (s: LeadStatus | 'all') => void;
  setFilterSearch: (query: string) => void;
  addKeyword: (kw: string) => Promise<{ success: boolean; error?: string }>;
  removeKeyword: (id: string) => Promise<{ success: boolean; error?: string }>;
  saveInitialKeywords: (keywords: string[]) => Promise<boolean>;
  updatePostStatus: (postId: string, status: LeadStatus) => void;
  runSweep: () => Promise<void>;
  isSweeping: boolean;
  addToast: AddToast;
  // AI features
  generateAiDraft: (
    post: MonitoredPost,
    tone: 'professional' | 'casual' | 'consultative' | 'direct',
    customOffer?: string
  ) => Promise<DraftResult>;
  suggestKeywordsFromOffer: (
    offerText: string,
    website?: string,
  ) => Promise<KeywordSuggestionResult>;
  // Export
  exportPostsToCsv: (customPosts?: MonitoredPost[]) => void;
  exportPostsToJson: (customPosts?: MonitoredPost[]) => void;
  // Settings
  minIntentThreshold: number;
  setMinIntentThreshold: (threshold: number) => void;
  feedRetentionDays: number;
  setFeedRetentionDays: (days: number) => void;
  clearFeed: () => Promise<{ success: boolean; deleted?: number; error?: string }>;
  pruneFeed: () => Promise<{ success: boolean; deleted?: number; error?: string }>;
  lookbackHours: number;
  setLookbackHours: (hours: number) => void;
  sweepTime: string;
  setSweepTime: (time: string) => void;
  sweepCadence: '24h' | '12h' | '6h';
  setSweepCadence: (cadence: '24h' | '12h' | '6h') => void;
  saveSettings: () => Promise<{ ok: boolean; warning?: string }>;
  enabledChannels: Platform[];
  toggleChannel: (platform: Platform) => void;
  /**
   * What the server will actually use: the settings last saved to the profile.
   * The editable values above may hold unsaved edits, so anything that
   * describes or filters by the current configuration reads these instead.
   */
  savedChannels: Platform[];
  savedMinIntentThreshold: number;
  savedSweepTime: string;
  savedSweepCadence: '24h' | '12h' | '6h';
  /** True while the Settings form holds edits that have not been saved. */
  hasUnsavedSettings: boolean;
  /** Puts the editable settings back to the saved profile values. */
  discardSettingsChanges: () => void;
  /** Mentions surfaced since this session started (a cheap usage readout). */
  mentionsFound: number;
}

const EchoContext = createContext<EchoContextType | undefined>(undefined);

const LOCAL_STORAGE_KEYWORDS_KEY = 'echo_mock_keywords';
const LOCAL_STORAGE_POSTS_KEY = 'echo_mock_posts';
const LOCAL_STORAGE_SETTINGS_KEY = 'echo_mock_settings';

const DEFAULT_CHANNELS: Platform[] = ['twitter', 'reddit', 'google'];

type Cadence = '24h' | '12h' | '6h';

interface SettingsSnapshot {
  lookbackHours: number;
  sweepTime: string;
  sweepCadence: Cadence;
  minIntentThreshold: number;
  feedRetentionDays: number;
  enabledChannels: Platform[];
}

const DEFAULT_SETTINGS: SettingsSnapshot = {
  lookbackHours: 24,
  sweepTime: '06:00',
  sweepCadence: '24h',
  minIntentThreshold: 0,
  feedRetentionDays: 30,
  enabledChannels: DEFAULT_CHANNELS,
};

/** The settings a profile row describes, with the defaults filled in. */
function settingsFromProfile(profile: Profile | null): SettingsSnapshot {
  if (!profile) return DEFAULT_SETTINGS;
  return {
    lookbackHours: profile.lookback_hours ?? DEFAULT_SETTINGS.lookbackHours,
    sweepTime: profile.sweep_time_utc || DEFAULT_SETTINGS.sweepTime,
    sweepCadence: (profile.sweep_frequency as Cadence) || DEFAULT_SETTINGS.sweepCadence,
    minIntentThreshold: profile.min_intent_threshold ?? DEFAULT_SETTINGS.minIntentThreshold,
    feedRetentionDays: profile.feed_retention_days ?? DEFAULT_SETTINGS.feedRetentionDays,
    enabledChannels:
      Array.isArray(profile.enabled_channels) && profile.enabled_channels.length > 0
        ? profile.enabled_channels
        : DEFAULT_SETTINGS.enabledChannels,
  };
}

const sameSettings = (a: SettingsSnapshot, b: SettingsSnapshot): boolean =>
  a.lookbackHours === b.lookbackHours &&
  a.sweepTime === b.sweepTime &&
  a.sweepCadence === b.sweepCadence &&
  a.minIntentThreshold === b.minIntentThreshold &&
  a.feedRetentionDays === b.feedRetentionDays &&
  a.enabledChannels.length === b.enabledChannels.length &&
  a.enabledChannels.every((c) => b.enabledChannels.includes(c));

export const EchoProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile, patchProfile } = useAuth();
  // Effects key on the id, not the object: a token refresh or a new object for
  // the same account must not reload data or reset unsaved settings.
  const userId = user?.id ?? null;

  // --- Data -----------------------------------------------------------------
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [posts, setPosts] = useState<MonitoredPost[]>([]);
  const [isLoadingKeywords, setIsLoadingKeywords] = useState<boolean>(true);
  const [isLoadingPosts, setIsLoadingPosts] = useState<boolean>(true);
  const [isSweeping, setIsSweeping] = useState<boolean>(false);
  const { addToast } = useToastActions();

  
  // Filtering
  const [filterKeyword, setFilterKeyword] = useState<string>('all');
  const [filterPlatform, setFilterPlatform] = useState<Platform | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<LeadStatus | 'all'>('all');
  const [filterSearch, setFilterSearch] = useState<string>('');

  // Settings
  const [lookbackHours, setLookbackHours] = useState<number>(24);
  const [sweepTime, setSweepTime] = useState<string>('06:00');
  const [sweepCadence, setSweepCadence] = useState<'24h' | '12h' | '6h'>('24h');
  const [minIntentThreshold, setMinIntentThreshold] = useState<number>(0);
  const [feedRetentionDays, setFeedRetentionDays] = useState<number>(30);
  const [enabledChannels, setEnabledChannels] = useState<Platform[]>(['twitter', 'reddit', 'google']);
  const [mentionsFound, setMentionsFound] = useState<number>(0);

  const keywordLimit = KEYWORD_LIMIT;

  /**
   * Edits the (unsaved) channel selection. No toast on success: nothing has
   * been saved yet, so "Activated X" described a change the server did not
   * know about. The Settings form shows the unsaved state instead. The
   * last-channel guard is decided outside the state updater, because an
   * updater runs twice under StrictMode and toasted twice.
   */
  const toggleChannel = useCallback(
    (platform: Platform) => {
      if (enabledChannels.includes(platform) && enabledChannels.length <= 1) {
        addToast('At least one channel must stay on.', 'error');
        return;
      }
      setEnabledChannels((prev) =>
        prev.includes(platform)
          ? prev.length <= 1
            ? prev
            : prev.filter((p) => p !== platform)
          : [...prev, platform],
      );
    },
    [enabledChannels, addToast],
  );

  // --- Loading --------------------------------------------------------------

  const loadKeywords = useCallback(async () => {
    if (!userId) return;
    setIsLoadingKeywords(true);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('keywords')
          .select('*')
          .eq('user_id', userId)
          .eq('is_active', true)
          .order('created_at', { ascending: true });

        if (!error && data) setKeywords(data as Keyword[]);
      } catch (err) {
        console.error('Error loading Supabase keywords:', err);
      }
    } else {
      const saved = localStorage.getItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${userId}`);
      if (saved) {
        try {
          setKeywords(JSON.parse(saved));
        } catch {
          setKeywords([]);
        }
      } else {
        setKeywords([]);
      }
    }
    setIsLoadingKeywords(false);
  }, [userId]);

  const loadPosts = useCallback(async () => {
    if (!userId) return;
    setIsLoadingPosts(true);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('monitored_posts')
          .select('*')
          .eq('user_id', userId)
          // nullsFirst:false keeps web-search rows (no date) at the bottom
          // instead of letting Postgres float them to the top of the feed.
          .order('posted_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false });

        if (!error && data) setPosts(data as MonitoredPost[]);
      } catch (err) {
        console.error('Error loading Supabase monitored posts:', err);
      }
    } else {
      const saved = localStorage.getItem(`${LOCAL_STORAGE_POSTS_KEY}_${userId}`);
      if (saved) {
        try {
          setPosts(JSON.parse(saved));
        } catch {
          setPosts([]);
        }
      } else {
        setPosts([]);
      }
    }
    setIsLoadingPosts(false);
  }, [userId]);

  /**
   * Copies the saved preferences into the editable settings state.
   *
   * Runs when the signed-in user's profile first arrives, and again whenever
   * the saved values change while the form holds no unsaved edits (a save, a
   * retry that finally loaded the profile, another tab). It never runs over
   * unsaved edits. Adjusted during render (React's "storing information from
   * previous renders" pattern) rather than in an effect, so there is no pass
   * showing defaults before the saved values.
   */
  const profileForUser = profile && userId && profile.id === userId ? profile : null;
  const savedSettings = useMemo(() => {
    const fromProfile = settingsFromProfile(profileForUser);
    if (isConfigured || !userId) return fromProfile;
    // Local sandbox: localStorage is the store.
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_SETTINGS_KEY}_${userId}`);
      return raw ? { ...fromProfile, ...(JSON.parse(raw) as Partial<SettingsSnapshot>) } : fromProfile;
    } catch {
      return fromProfile;
    }
  }, [profileForUser, userId]);

  const currentSettings: SettingsSnapshot = useMemo(
    () => ({ lookbackHours, sweepTime, sweepCadence, minIntentThreshold, feedRetentionDays, enabledChannels }),
    [lookbackHours, sweepTime, sweepCadence, minIntentThreshold, feedRetentionDays, enabledChannels],
  );

  const applySettings = useCallback((next: SettingsSnapshot) => {
    setLookbackHours(next.lookbackHours);
    setSweepTime(next.sweepTime);
    setSweepCadence(next.sweepCadence);
    setMinIntentThreshold(next.minIntentThreshold);
    setFeedRetentionDays(next.feedRetentionDays);
    setEnabledChannels(next.enabledChannels);
  }, []);

  // What the form was last synced from: null until a profile has been applied.
  const [hydratedFrom, setHydratedFrom] = useState<{ user: string; settings: SettingsSnapshot } | null>(null);
  if (!userId && hydratedFrom !== null) setHydratedFrom(null);
  if (userId && profileForUser) {
    const firstForUser = hydratedFrom?.user !== userId;
    const savedChanged = !firstForUser && !sameSettings(hydratedFrom!.settings, savedSettings);
    const formClean = !firstForUser && sameSettings(hydratedFrom!.settings, currentSettings);
    if (firstForUser || (savedChanged && formClean)) {
      setHydratedFrom({ user: userId, settings: savedSettings });
      applySettings(savedSettings);
    } else if (savedChanged && sameSettings(currentSettings, savedSettings)) {
      // The edits were just saved: the form already shows the new values.
      setHydratedFrom({ user: userId, settings: savedSettings });
    }
  }

  const hasUnsavedSettings = Boolean(profileForUser) && !sameSettings(currentSettings, savedSettings);
  const savedChannels = savedSettings.enabledChannels;
  const savedMinIntentThreshold = savedSettings.minIntentThreshold;
  const savedSweepTime = savedSettings.sweepTime;
  const savedSweepCadence = savedSettings.sweepCadence;

  const discardSettingsChanges = useCallback(() => applySettings(savedSettings), [applySettings, savedSettings]);

  // --- Bootstrapping --------------------------------------------------------
  useEffect(() => {
    if (!userId) {
      setKeywords([]);
      setPosts([]);
      setIsLoadingKeywords(false);
      setIsLoadingPosts(false);
      return;
    }

    void loadKeywords();
    void loadPosts();
  }, [userId, loadKeywords, loadPosts]);

  // --- Keywords -------------------------------------------------------------

  const addKeyword = useCallback(
    async (rawKeyword: string): Promise<{ success: boolean; error?: string }> => {
      const clean = rawKeyword.trim().toLowerCase();
      if (!clean) return { success: false, error: 'Keyword cannot be empty.' };
      if (!user) return { success: false, error: 'You must be logged in.' };

      if (keywords.length >= keywordLimit) {
        const errorMsg = `You can track ${keywordLimit} keywords - remove one to add another.`;
        addToast(errorMsg, 'error');
        return { success: false, error: errorMsg };
      }

      if (keywords.some((k) => k.keyword.toLowerCase() === clean)) {
        const errorMsg = `"${clean}" is already in your tracked keywords.`;
        addToast(errorMsg, 'error');
        return { success: false, error: errorMsg };
      }

      const previous = [...keywords];

      if (isConfigured && supabase) {
        const { data, error } = await supabase
          .from('keywords')
          .insert({ user_id: user.id, keyword: clean, is_active: true })
          .select()
          .single();

        if (error) {
          addToast(`Failed to add keyword: ${error.message}`, 'error');
          return { success: false, error: error.message };
        }
        // Rely on the returned row so the DB trigger's limit is authoritative.
        setKeywords((prev) => [...prev, data as Keyword]);
      } else {
        const newKeyword: Keyword = {
          id: `kw-${Date.now()}`,
          user_id: user.id,
          keyword: clean,
          is_active: true,
          created_at: new Date().toISOString(),
        };
        const updated = [...keywords, newKeyword];
        setKeywords(updated);
        localStorage.setItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`, JSON.stringify(updated));
      }

      // Roll back the optimistic list if a concurrent insert tripped the cap.
      if (previous.length >= keywordLimit) void loadKeywords();

      addToast(`Added keyword "${clean}"`, 'success');
      return { success: true };
    },
    [keywords, keywordLimit, user, addToast, loadKeywords],
  );

  const removeKeyword = useCallback(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      if (!user) return { success: false, error: 'You must be logged in.' };

      const target = keywords.find((k) => k.id === id);
      const previous = [...keywords];
      setKeywords(previous.filter((k) => k.id !== id));

      if (isConfigured && supabase) {
        const { data, error } = await supabase
          .from('keywords')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id)
          .select('id');
        // RLS turns a refused delete into zero affected rows, not an error.
        const message =
          error?.message ?? (!data || data.length === 0 ? 'keyword not found.' : null);
        if (message) {
          setKeywords(previous);
          addToast(`Failed to delete keyword: ${message}`, 'error');
          return { success: false, error: message };
        }
      } else {
        const updated = previous.filter((k) => k.id !== id);
        localStorage.setItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`, JSON.stringify(updated));
      }

      if (target) addToast(`Removed keyword "${target.keyword}"`, 'info');
      return { success: true };
    },
    [keywords, user, addToast],
  );

  const saveInitialKeywords = useCallback(
    async (initialKws: string[]): Promise<boolean> => {
      if (!user) return false;
      const capped = initialKws
        .slice(0, keywordLimit)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      if (capped.length === 0) return false;

      if (isConfigured && supabase) {
        const { data, error } = await supabase
          .from('keywords')
          .upsert(
            capped.map((k) => ({ user_id: user.id, keyword: k, is_active: true })),
            { onConflict: 'user_id,keyword' },
          )
          .select();

        if (error) {
          console.error('Error saving initial keywords:', error);
          return false;
        }
        setKeywords(data as Keyword[]);
      } else {
        const rows: Keyword[] = capped.map((k, i) => ({
          id: `kw-init-${i}-${Date.now()}`,
          user_id: user.id,
          keyword: k,
          is_active: true,
          created_at: new Date().toISOString(),
        }));
        setKeywords(rows);
        localStorage.setItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`, JSON.stringify(rows));
      }
      return true;
    },
    [user, keywordLimit],
  );

  const updatePostStatus = useCallback(
    async (postId: string, status: LeadStatus) => {
      const targetPost = posts.find((p) => p.id === postId);

      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, status } : p)));

      if (isConfigured && supabase && user) {
        try {
          const isUuid =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);

          const query = isUuid
            ? supabase.from('monitored_posts').update({ status }).eq('id', postId)
            : targetPost?.post_url
            ? supabase.from('monitored_posts').update({ status }).eq('post_url', targetPost.post_url)
            : null;

          if (query) {
            // PostgREST resolves a write as HTTP 200 with an error body, so a
            // rejected update arrives as a value rather than a rejection.
            // `await query.eq(...)` never throws, which is why the catch below was
            // unreachable — an RLS denial or a bad column left the row unchanged
            // while the optimistic state kept the new status and the toast
            // claimed success. The next sweep then redrew the feed and undid it,
            // which read as the app randomly forgetting the user's own edit.
            const { error } = await query.eq('user_id', user.id);
            if (error) {
              console.error('Error updating post status in database:', error);
              // Roll back only this row, so a concurrent change to another lead
              // is not discarded along with it.
              setPosts((prev) =>
                targetPost
                  ? prev.map((p) => (p.id === postId ? { ...p, status: targetPost.status } : p))
                  : prev,
              );
              addToast(`Could not mark that lead as ${status}.`, 'error');
              return;
            }
          }
        } catch (err) {
          console.error('Error updating post status in database:', err);
          setPosts((prev) =>
            targetPost
              ? prev.map((p) => (p.id === postId ? { ...p, status: targetPost.status } : p))
              : prev,
          );
          addToast(`Could not mark that lead as ${status}.`, 'error');
          return;
        }
      } else if (user) {
        const updated = posts.map((p) => (p.id === postId ? { ...p, status } : p));
        localStorage.setItem(`${LOCAL_STORAGE_POSTS_KEY}_${user.id}`, JSON.stringify(updated));
      }

      addToast(`Lead marked as ${status}`, 'info');
    },
    [posts, user, addToast],
  );

  // --- Sweep ----------------------------------------------------------------

  const runSweep = useCallback(async () => {
    if (!user) return;
    // The server sweeps the saved channels, so that is what is announced.
    const activeKeywords = keywords.filter((k) => k.is_active);
    if (activeKeywords.length === 0) {
      addToast('No active keywords to track. Add keywords in the Keywords tab.', 'info');
      return;
    }
    if (savedChannels.length === 0) {
      addToast('Enable at least one channel in Settings.', 'error');
      return;
    }

    setIsSweeping(true);
    addToast(`Scanning ${savedChannels.map(channelLabel).join(', ')}...`, 'info');

    try {
      const result = await invokeSearchSweep();

      // The edge function already persisted anything new. Re-read so the feed
      // shows the database truth. (Without Supabase, invokeSearchSweep throws,
      // so there is no local merge path.)
      await loadPosts();
      setMentionsFound((prev) => prev + result.posts.length);

      setIsSweeping(false);

      const housekeeping = [
        result.dropped_stale ? `${result.dropped_stale} out-of-window result(s) dropped` : '',
        result.pruned ? `${result.pruned} expired mention(s) cleaned up` : '',
      ]
        .filter(Boolean)
        .join(', ');

      if (result.posts.length > 0) {
        addToast(
          `Sweep complete — ${result.posts.length} new mention(s) found.`,
          'success',
        );
      } else {
        addToast(
          savedMinIntentThreshold > 0
            ? `Sweep finished. Nothing new above your ${savedMinIntentThreshold}% intent threshold.`
            : 'Sweep finished. Nothing new this time.',
          'info',
        );
      }

      if (housekeeping) addToast(housekeeping, 'info');
      for (const e of result.errors?.slice(0, 3) ?? []) addToast(e, 'error');
    } catch (err) {
      setIsSweeping(false);
      addToast(`Sweep failed: ${(err as Error)?.message || 'Unknown error'}`, 'error');
    } finally {
      // A sweep reserves and settles credits whether or not it found anything
      // (and a failed one may have released a hold), so every balance on screen
      // is re-read from the one wallet store.
      void walletStore.refresh().catch(() => {});
    }
  }, [user, keywords, savedChannels, savedMinIntentThreshold, addToast, loadPosts]);

  // --- AI -------------------------------------------------------------------

  const generateAiDraft = useCallback(
    async (
      post: MonitoredPost,
      tone: 'professional' | 'casual' | 'consultative' | 'direct',
      customOffer?: string,
    ): Promise<DraftResult> =>
      generateAiOutreachDraft(
        post,
        tone,
        customOffer || profile?.core_offer || undefined,
        profile?.full_name || undefined,
      ),
    [profile],
  );

  const suggestKeywordsFromOffer = useCallback(
    async (offerText: string, website?: string): Promise<KeywordSuggestionResult> =>
      generateAiKeywordsFromOffer(offerText, website || profile?.website || undefined, {
        // Already-tracked keywords are filtered out server-side so the model
        // spends its limited slots on genuinely new suggestions.
        existingKeywords: keywords.map((k) => k.keyword),
        channels: enabledChannels,
        slots: Math.max(1, keywordLimit - keywords.length),
        lookbackHours,
      }),
    [profile, keywords, enabledChannels, keywordLimit, lookbackHours],
  );

  // --- Settings persistence -------------------------------------------------

  /**
   * Writes preferences to the database (or localStorage in sandbox mode) and
   * merges them into the AuthContext profile.
   *
   * Deliberately silent. It used to toast on both paths, and every caller toasts
   * too — pressing Save produced two "saved" notifications, and pruning produced
   * a "preferences saved" toast nobody asked for followed by the one that said
   * what actually happened. The result is returned instead; the caller owns the
   * single message, which is the only one that can describe what the user tried
   * to do.
   *
   * A server rejection is a failure (ok: false): nothing else stores the
   * settings in connected mode.
   */
  const saveSettings = useCallback(async (): Promise<{ ok: boolean; warning?: string }> => {
    if (!user) return { ok: false, warning: 'Not signed in.' };
    // Without the profile, the form shows defaults rather than the saved
    // values; writing them would replace a real configuration with defaults.
    if (!profileForUser) {
      return { ok: false, warning: 'Your profile has not loaded yet, so nothing was saved. Try again in a moment.' };
    }

    const fields = {
      lookback_hours: lookbackHours,
      sweep_time_utc: sweepTime,
      sweep_frequency: sweepCadence,
      enabled_channels: enabledChannels,
      min_intent_threshold: minIntentThreshold,
      feed_retention_days: feedRetentionDays,
    };

    if (isConfigured && supabase) {
      const { error } = await supabase.from('profiles').update(fields).eq('id', user.id);
      if (error) {
        console.error('Error syncing profile settings to database:', error);
        return { ok: false, warning: `Could not save your settings: ${error.message}` };
      }
    } else {
      // Sandbox mode only: localStorage is the store there.
      localStorage.setItem(
        `${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`,
        JSON.stringify({
          lookbackHours,
          sweepTime,
          sweepCadence,
          minIntentThreshold,
          feedRetentionDays,
          enabledChannels,
        }),
      );
    }

    // Keep the shared profile in step, so anything reading it (and any later
    // re-hydration) sees what was just saved rather than the old values.
    patchProfile(fields);
    return { ok: true };
  }, [
    user,
    profileForUser,
    lookbackHours,
    sweepTime,
    sweepCadence,
    minIntentThreshold,
    feedRetentionDays,
    enabledChannels,
    patchProfile,
  ]);

  // --- Feed cleanup -----------------------------------------------------

  /**
   * Deletes every mention in the workspace. Goes through the clear_feed() RPC
   * so the count comes back from the database rather than the client.
   */
  const clearFeed = useCallback(async (): Promise<{ success: boolean; deleted?: number; error?: string }> => {
    if (!user) return { success: false, error: 'not_authenticated' };

    if (!isConfigured || !supabase) {
      setPosts([]);
      return { success: true, deleted: 0 };
    }

    const { data, error } = await supabase.rpc('clear_feed', { p_user_id: user.id });
    if (error) return { success: false, error: error.message };
    if (data?.success !== true) return { success: false, error: data?.error || 'clear_failed' };

    const deleted = typeof data.deleted === 'number' ? data.deleted : 0;
    setPosts([]);
    return { success: true, deleted };
  }, [user]);

  /**
   * Applies the retention window immediately, without waiting for a sweep.
   * Never touches rows written after `keepAfter`.
   */
  const pruneFeed = useCallback(async (params: { keepAfter?: string } = {}): Promise<{ success: boolean; deleted?: number; error?: string }> => {
    if (!user) return { success: false, error: 'not_authenticated' };

    if (!isConfigured || !supabase) return { success: true, deleted: 0 };

    const { data, error } = await supabase.rpc('prune_feed', {
      p_user_id: user.id,
      p_keep_after: params.keepAfter ?? null,
    });
    if (error) return { success: false, error: error.message };
    if (data?.success !== true) return { success: false, error: data?.error || 'prune_failed' };

    const deleted = typeof data.deleted === 'number' ? data.deleted : 0;
    if (deleted > 0) await loadPosts();
    return { success: true, deleted };
  }, [user, loadPosts]);

  // --- Exports --------------------------------------------------------------

  const exportPostsToCsv = useCallback(
    (customPosts?: MonitoredPost[]) => {
      // A passed (filtered) list is exported as-is even when empty: falling
      // back to every post would export exactly what the user filtered out.
      const targetPosts = customPosts ?? posts;
      if (targetPosts.length === 0) {
        addToast('No mentions available to export.', 'error');
        return;
      }

      const headers = [
        'Platform',
        'Channel Source',
        'Author',
        'Author Handle',
        'Matched Keyword',
        'Intent Score',
        'Intent Level',
        'Status',
        'Posted At',
        'Post URL',
        'Content / Body',
      ];

      const rows = targetPosts.map((p) => [
        p.platform,
        p.channel_source,
        p.author_name,
        p.author_handle,
        p.matched_keyword,
        p.intent_score ?? 0,
        p.intent_level ?? '',
        p.status || 'new',
        p.posted_at,
        p.post_url,
        p.body,
      ]);

      downloadCsv(`echo_mentions_${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...rows]);

      addToast(`Exported ${targetPosts.length} mentions as CSV.`, 'success');
    },
    [posts, addToast],
  );

  const exportPostsToJson = useCallback(
    (customPosts?: MonitoredPost[]) => {
      const targetPosts = customPosts ?? posts;
      if (targetPosts.length === 0) {
        addToast('No mentions available to export.', 'error');
        return;
      }

      downloadTextFile(
        `echo_mentions_${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(targetPosts, null, 2),
        'application/json',
      );

      addToast(`Exported ${targetPosts.length} mentions as JSON.`, 'success');
    },
    [posts, addToast],
  );

  const value = useMemo<EchoContextType>(
    () => ({
      keywords,
      keywordLimit,
      posts,
      isLoadingKeywords,
      isLoadingPosts,
      filterKeyword,
      filterPlatform,
      filterStatus,
      filterSearch,
      setFilterKeyword,
      setFilterPlatform,
      setFilterStatus,
      setFilterSearch,
      addKeyword,
      removeKeyword,
      saveInitialKeywords,
      updatePostStatus,
      runSweep,
      isSweeping,
      addToast,
      generateAiDraft,
      suggestKeywordsFromOffer,
      exportPostsToCsv,
      exportPostsToJson,
      minIntentThreshold,
      setMinIntentThreshold,
      feedRetentionDays,
      setFeedRetentionDays,
      clearFeed,
      pruneFeed,
      lookbackHours,
      setLookbackHours,
      sweepTime,
      setSweepTime,
      sweepCadence,
      setSweepCadence,
      saveSettings,
      enabledChannels,
      toggleChannel,
      savedChannels,
      savedMinIntentThreshold,
      savedSweepTime,
      savedSweepCadence,
      hasUnsavedSettings,
      discardSettingsChanges,
      mentionsFound,
    }),
    [
      keywords,
      keywordLimit,
      posts,
      isLoadingKeywords,
      isLoadingPosts,
      filterKeyword,
      filterPlatform,
      filterStatus,
      filterSearch,
      addToast,
      addKeyword,
      removeKeyword,
      saveInitialKeywords,
      updatePostStatus,
      runSweep,
      isSweeping,
      generateAiDraft,
      suggestKeywordsFromOffer,
      exportPostsToCsv,
      exportPostsToJson,
      minIntentThreshold,
      feedRetentionDays,
      clearFeed,
      pruneFeed,
      lookbackHours,
      sweepTime,
      sweepCadence,
      saveSettings,
      enabledChannels,
      toggleChannel,
      savedChannels,
      savedMinIntentThreshold,
      savedSweepTime,
      savedSweepCadence,
      hasUnsavedSettings,
      discardSettingsChanges,
      mentionsFound,
    ],
  );

  return (
    <EchoContext.Provider value={value}>{children}</EchoContext.Provider>
  );
};

export const useEcho = (): EchoContextType => {
  const context = useContext(EchoContext);
  if (!context) {
    throw new Error('useEcho must be used within an EchoProvider');
  }
  return context;
};