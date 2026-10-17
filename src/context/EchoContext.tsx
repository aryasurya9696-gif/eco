import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import { invokeSearchSweep } from '../lib/sweep';
import type { KeywordSuggestionResult } from '../lib/ai';
import { generateAiOutreachDraft, generateAiKeywordsFromOffer } from '../lib/ai';
import { useAuth } from './AuthContext';
import type { Keyword, MonitoredPost, Platform, LeadStatus } from '../types';

interface ToastMessage {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}


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
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
  addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
  // AI features
  generateAiDraft: (
    post: MonitoredPost,
    tone: 'professional' | 'casual' | 'consultative' | 'direct',
    customOffer?: string
  ) => Promise<string>;
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
  saveSettings: () => Promise<void>;
  enabledChannels: Platform[];
  toggleChannel: (platform: Platform) => void;
  /** Mentions surfaced since this session started (a cheap usage readout). */
  mentionsFound: number;
}

const EchoContext = createContext<EchoContextType | undefined>(undefined);

const LOCAL_STORAGE_KEYWORDS_KEY = 'echo_mock_keywords';
const LOCAL_STORAGE_POSTS_KEY = 'echo_mock_posts';
const LOCAL_STORAGE_SETTINGS_KEY = 'echo_mock_settings';

/**
 * How many keywords a workspace may track. Mirrors public.keyword_limit()
 * in Postgres, which is what actually enforces it.
 */
const KEYWORD_LIMIT = 8;

const channelLabel = (platform: Platform): string => {
  if (platform === 'twitter') return 'X';
  if (platform === 'google') return 'Web';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
};

export const EchoProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile } = useAuth();

  // --- Data -----------------------------------------------------------------
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [posts, setPosts] = useState<MonitoredPost[]>([]);
  const [isLoadingKeywords, setIsLoadingKeywords] = useState<boolean>(true);
  const [isLoadingPosts, setIsLoadingPosts] = useState<boolean>(true);
  const [isSweeping, setIsSweeping] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  
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

  // --- Toasts ---------------------------------------------------------------
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: 'info' | 'success' | 'error' = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismissToast(id), 4000);
    },
    [dismissToast],
  );

  const toggleChannel = useCallback(
    (platform: Platform) => {
      setEnabledChannels((prev) => {
        if (prev.includes(platform)) {
          if (prev.length <= 1) {
            addToast('At least one platform must remain active for monitoring.', 'error');
            return prev;
          }
          addToast(`Deactivated ${channelLabel(platform)} channel.`, 'info');
          return prev.filter((p) => p !== platform);
        }
        addToast(`Activated ${channelLabel(platform)} channel.`, 'success');
        return [...prev, platform];
      });
    },
    [addToast],
  );

  // --- Loading --------------------------------------------------------------

  const loadKeywords = useCallback(async () => {
    if (!user) return;
    setIsLoadingKeywords(true);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('keywords')
          .select('*')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .order('created_at', { ascending: true });

        if (!error && data) setKeywords(data as Keyword[]);
      } catch (err) {
        console.error('Error loading Supabase keywords:', err);
      }
    } else {
      const saved = localStorage.getItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`);
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
  }, [user]);

  const loadPosts = useCallback(async () => {
    if (!user) return;
    setIsLoadingPosts(true);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('monitored_posts')
          .select('*')
          .eq('user_id', user.id)
          // nullsFirst:false keeps web-search rows (no date) at the bottom
          // instead of letting Postgres float them to the top of the feed.
          .order('posted_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false });

        if (!error && data) setPosts(data as MonitoredPost[]);
      } catch (err) {
        console.error('Error loading Supabase monitored posts:', err);
      }
    } else {
      const saved = localStorage.getItem(`${LOCAL_STORAGE_POSTS_KEY}_${user.id}`);
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
  }, [user]);

  const loadSettings = useCallback(() => {
    if (!user) return;

    // Server-persisted profile fields are authoritative in connected mode.
    if (profile) {
      if (profile.lookback_hours !== undefined && profile.lookback_hours !== null) {
        setLookbackHours(profile.lookback_hours);
      }
      if (profile.sweep_time_utc) setSweepTime(profile.sweep_time_utc);
      if (profile.sweep_frequency) {
        setSweepCadence(profile.sweep_frequency as '24h' | '12h' | '6h');
      }
      if (profile.min_intent_threshold !== undefined && profile.min_intent_threshold !== null) {
        setMinIntentThreshold(profile.min_intent_threshold);
      }
      if (profile.feed_retention_days !== undefined && profile.feed_retention_days !== null) {
        setFeedRetentionDays(profile.feed_retention_days);
      }
      if (Array.isArray(profile.enabled_channels) && profile.enabled_channels.length > 0) {
        setEnabledChannels(profile.enabled_channels);
      }
    }

    // Local sandbox preferences overlay (mock mode only for server fields).
    const saved = localStorage.getItem(`${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`);
    if (saved && !isConfigured) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.lookbackHours !== undefined) setLookbackHours(parsed.lookbackHours);
        if (parsed.sweepTime !== undefined) setSweepTime(parsed.sweepTime);
        if (parsed.sweepCadence !== undefined) setSweepCadence(parsed.sweepCadence);
        if (parsed.minIntentThreshold !== undefined) {
          setMinIntentThreshold(parsed.minIntentThreshold);
        }
        if (parsed.feedRetentionDays !== undefined) {
          setFeedRetentionDays(parsed.feedRetentionDays);
        }
        if (Array.isArray(parsed.enabledChannels) && parsed.enabledChannels.length > 0) {
          setEnabledChannels(parsed.enabledChannels);
        }
      } catch (err) {
        console.error('Error loading settings:', err);
      }
    }
  }, [user, profile]);

  // --- Bootstrapping --------------------------------------------------------
  useEffect(() => {
    if (!user) {
      setKeywords([]);
      setPosts([]);
      setIsLoadingKeywords(false);
      setIsLoadingPosts(false);
      return;
    }

    void loadKeywords();
    void loadPosts();
    loadSettings();
  }, [user, profile, loadKeywords, loadPosts, loadSettings]);

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
        const { error } = await supabase.from('keywords').delete().eq('id', id);
        if (error) {
          setKeywords(previous);
          addToast(`Failed to delete keyword: ${error.message}`, 'error');
          return { success: false, error: error.message };
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

          if (query) await query.eq('user_id', user.id);
        } catch (err) {
          console.error('Error updating post status in database:', err);
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
    setIsSweeping(true);
    addToast(`Scanning ${enabledChannels.map(channelLabel).join(', ')}...`, 'info');

    try {
      const activeKeywords = keywords.filter((k) => k.is_active);

      if (activeKeywords.length === 0) {
        setIsSweeping(false);
        addToast('No active keywords to track. Add keywords in the Keywords tab.', 'info');
        return;
      }
      if (enabledChannels.length === 0) {
        setIsSweeping(false);
        addToast('Enable at least one channel in Settings.', 'error');
        return;
      }

      const result = await invokeSearchSweep();

      if (isConfigured) {
        // The edge function already persisted anything new. Re-read so the feed
        // shows the database truth.
        await loadPosts();
        setMentionsFound((prev) => prev + result.posts.length);
      } else if (result.posts.length > 0) {
        setPosts((prev) => {
          const seen = new Set(prev.map((p) => p.post_url.toLowerCase()));
          const fresh = result.posts.filter(
            (p) => p.post_url && !seen.has(p.post_url.toLowerCase()),
          );
          return [...fresh, ...prev];
        });
      }

      setIsSweeping(false);

      // treg bills USD per call, so surface the spend.
      const spend = result.usd_spent ? ` (~$${result.usd_spent.toFixed(4)})` : '';
      const housekeeping = [
        result.dropped_stale ? `${result.dropped_stale} out-of-window result(s) dropped` : '',
        result.pruned ? `${result.pruned} expired mention(s) cleaned up` : '',
      ]
        .filter(Boolean)
        .join(', ');

      if (result.posts.length > 0) {
        addToast(
          `Sweep complete — ${result.posts.length} new mention(s) found${spend}.`,
          'success',
        );
      } else {
        addToast(
          `Sweep finished. Nothing new above your ${minIntentThreshold}% intent threshold${spend}.`,
          'info',
        );
      }

      if (housekeeping) addToast(housekeeping, 'info');
      for (const e of result.errors?.slice(0, 3) ?? []) addToast(e, 'error');
    } catch (err) {
      setIsSweeping(false);
      addToast(`Sweep failed: ${(err as Error)?.message || 'Unknown error'}`, 'error');
    }
  }, [user, keywords, enabledChannels, minIntentThreshold, addToast, loadPosts]);

  // --- AI -------------------------------------------------------------------

  const generateAiDraft = useCallback(
    async (
      post: MonitoredPost,
      tone: 'professional' | 'casual' | 'consultative' | 'direct',
      customOffer?: string,
    ): Promise<string> =>
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

  const saveSettings = useCallback(async () => {
    if (!user) return;

    localStorage.setItem(
      `${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`,
      JSON.stringify({
        lookbackHours,
        sweepTime,
        sweepCadence,
        minIntentThreshold,
        enabledChannels,
      }),
    );

    if (isConfigured && supabase) {
      const { error } = await supabase
        .from('profiles')
        .update({
          lookback_hours: lookbackHours,
          sweep_time_utc: sweepTime,
          sweep_frequency: sweepCadence,
          enabled_channels: enabledChannels,
          min_intent_threshold: minIntentThreshold,
          feed_retention_days: feedRetentionDays,
        })
        .eq('id', user.id);

      if (error) {
        console.error('Error syncing profile settings to database:', error);
        addToast(`Settings saved locally, but the server rejected them: ${error.message}`, 'error');
        return;
      }
    }

    addToast('Preferences saved successfully.', 'success');
  }, [
    user,
    lookbackHours,
    sweepTime,
    sweepCadence,
    minIntentThreshold,
    feedRetentionDays,
    enabledChannels,
    addToast,
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
      const targetPosts = customPosts && customPosts.length > 0 ? customPosts : posts;
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

      const esc = (v: string | null | undefined) =>
        `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

      const rows = targetPosts.map((p) =>
        [
          esc(p.platform),
          esc(p.channel_source),
          esc(p.author_name),
          esc(p.author_handle),
          esc(p.matched_keyword),
          String(p.intent_score ?? 0),
          esc(p.intent_level ?? ''),
          esc(p.status || 'new'),
          esc(p.posted_at),
          esc(p.post_url),
          esc(p.body),
        ].join(','),
      );

      const csvString =
        '\uFEFF' + [headers.map((h) => esc(h)).join(','), ...rows].join('\r\n');

      downloadBlob(
        new Blob([csvString], { type: 'text/csv;charset=utf-8;' }),
        `echo_mentions_${new Date().toISOString().slice(0, 10)}.csv`,
      );

      addToast(`Exported ${targetPosts.length} mentions as CSV.`, 'success');
    },
    [posts, addToast],
  );

  const exportPostsToJson = useCallback(
    (customPosts?: MonitoredPost[]) => {
      const targetPosts = customPosts && customPosts.length > 0 ? customPosts : posts;
      if (targetPosts.length === 0) {
        addToast('No mentions available to export.', 'error');
        return;
      }

      downloadBlob(
        new Blob([JSON.stringify(targetPosts, null, 2)], {
          type: 'application/json;charset=utf-8;',
        }),
        `echo_mentions_${new Date().toISOString().slice(0, 10)}.json`,
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
      toasts,
      dismissToast,
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
      toasts,
      dismissToast,
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
      mentionsFound,
    ],
  );

  return (
    <EchoContext.Provider value={value}>{children}</EchoContext.Provider>
  );
};

/** Triggers a client-side file download and cleans up the object URL. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 200);
}

export const useEcho = (): EchoContextType => {
  const context = useContext(EchoContext);
  if (!context) {
    throw new Error('useEcho must be used within an EchoProvider');
  }
  return context;
};