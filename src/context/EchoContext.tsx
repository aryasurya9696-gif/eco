import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import { performSocialFetchSweep } from '../lib/socialfetch';
import { generateAiOutreachDraft, generateAiKeywordsFromOffer } from '../lib/ai';
import { executeWaterfallEnrichment } from '../lib/waterfall';
import { useAuth } from './AuthContext';
import type { Keyword, MonitoredPost, Platform, LeadStatus, InvoiceItem, LeadUnlock } from '../types';
import { TopUpModal } from '../components/dashboard/TopUpModal';

interface ToastMessage {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

interface EchoContextType {
  keywords: Keyword[];
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
  // Phase 2: AI features
  generateAiDraft: (
    post: MonitoredPost,
    tone: 'professional' | 'casual' | 'consultative' | 'direct',
    customOffer?: string
  ) => Promise<string>;
  suggestKeywordsFromOffer: (offerText: string, website?: string) => Promise<string[]>;
  // Phase 3: Export & Integrations
  exportPostsToCsv: (customPosts?: MonitoredPost[]) => void;
  minIntentThreshold: number;
  setMinIntentThreshold: (threshold: number) => void;
  exportPostsToJson: (customPosts?: MonitoredPost[]) => void;
  slackWebhook: string;
  setSlackWebhook: (url: string) => void;
  emailDigest: boolean;
  setEmailDigest: (enabled: boolean) => void;
  lookbackHours: number;
  setLookbackHours: (hours: number) => void;
  sweepTime: string;
  setSweepTime: (time: string) => void;
  sweepCadence: '24h' | '12h' | '6h';
  setSweepCadence: (cadence: '24h' | '12h' | '6h') => void;
  saveSettings: () => Promise<void>;
  enabledChannels: Platform[];
  toggleChannel: (platform: Platform) => void;
  // Lead Selling & Credit Unlocking Engine
  creditsBalance: number;
  unlockedLeads: Record<string, LeadUnlock>;
  isUnlockingLead: Record<string, boolean>;
  unlockLead: (post: MonitoredPost) => Promise<{ success: boolean; data?: LeadUnlock; error?: string }>;
  topUpCredits: (amount: number, packName: string) => Promise<void>;
  isTopUpModalOpen: boolean;
  setIsTopUpModalOpen: (open: boolean) => void;
  // Phase 4: Billing
  currentPlan: 'starter' | 'pro' | 'scale';
  setCurrentPlan: (plan: 'starter' | 'pro' | 'scale') => void;
  monthlyCreditsUsed: number;
  invoices: InvoiceItem[];
}

const EchoContext = createContext<EchoContextType | undefined>(undefined);

const LOCAL_STORAGE_KEYWORDS_KEY = 'echo_mock_keywords';
const LOCAL_STORAGE_POSTS_KEY = 'echo_mock_posts';
const LOCAL_STORAGE_SETTINGS_KEY = 'echo_mock_settings';
const LOCAL_STORAGE_CREDITS_KEY = 'echo_credits_balance';
const LOCAL_STORAGE_UNLOCKS_KEY = 'echo_lead_unlocks';

export const EchoProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile } = useAuth();
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [posts, setPosts] = useState<MonitoredPost[]>([]);
  const [isLoadingKeywords, setIsLoadingKeywords] = useState<boolean>(true);
  const [isLoadingPosts, setIsLoadingPosts] = useState<boolean>(true);
  const [isSweeping, setIsSweeping] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Lead Selling & Credits Engine
  const [creditsBalance, setCreditsBalance] = useState<number>(25);
  const [unlockedLeads, setUnlockedLeads] = useState<Record<string, LeadUnlock>>({});
  const [isUnlockingLead, setIsUnlockingLead] = useState<Record<string, boolean>>({});
  const [isTopUpModalOpen, setIsTopUpModalOpen] = useState<boolean>(false);

  // Filtering
  const [filterKeyword, setFilterKeyword] = useState<string>('all');
  const [filterPlatform, setFilterPlatform] = useState<Platform | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<LeadStatus | 'all'>('all');
  const [filterSearch, setFilterSearch] = useState<string>('');

  // Settings
  const [slackWebhook, setSlackWebhook] = useState<string>('');
  const [emailDigest, setEmailDigest] = useState<boolean>(true);
  const [lookbackHours, setLookbackHours] = useState<number>(24);
  const [sweepTime, setSweepTime] = useState<string>('06:00');
  const [sweepCadence, setSweepCadence] = useState<'24h' | '12h' | '6h'>('24h');
  const [minIntentThreshold, setMinIntentThreshold] = useState<number>(85);
  const [enabledChannels, setEnabledChannels] = useState<Platform[]>(['twitter', 'reddit', 'google']);

  // Billing
  const [currentPlan, setCurrentPlan] = useState<'starter' | 'pro' | 'scale'>('starter');
  const [monthlyCreditsUsed, setMonthlyCreditsUsed] = useState<number>(0);

  const invoices: InvoiceItem[] = [];

  const addToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      dismissToast(id);
    }, 4000);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const toggleChannel = (platform: Platform) => {
    if (enabledChannels.includes(platform)) {
      if (enabledChannels.length <= 1) {
        addToast('At least one platform must remain active for monitoring.', 'error');
        return;
      }
      const updated = enabledChannels.filter((p) => p !== platform);
      setEnabledChannels(updated);
      addToast(`Deactivated ${platform === 'twitter' ? 'X' : platform === 'google' ? 'Web' : platform} channel.`, 'info');
    } else {
      const updated = [...enabledChannels, platform];
      setEnabledChannels(updated);
      addToast(`Activated ${platform === 'twitter' ? 'X' : platform === 'google' ? 'Web' : platform} channel.`, 'success');
    }
  };

  useEffect(() => {
    if (!user) {
      setKeywords([]);
      setPosts([]);
      setIsLoadingKeywords(false);
      setIsLoadingPosts(false);
      return;
    }

    loadKeywords();
    loadPosts();
    loadSettings();
  }, [user, profile]);

  const loadSettings = () => {
    if (!user) return;

    // Load server-persisted profile fields first
    if (profile) {
      if (profile.slack_webhook !== undefined && profile.slack_webhook !== null) {
        setSlackWebhook(profile.slack_webhook);
      }
      if (profile.email_digest !== undefined) {
        setEmailDigest(profile.email_digest);
      }
      if (profile.lookback_hours !== undefined && profile.lookback_hours !== null) {
        setLookbackHours(profile.lookback_hours);
      }
      if ((profile as any).sweep_time_utc) {
        setSweepTime((profile as any).sweep_time_utc);
      }
      if ((profile as any).sweep_frequency) {
        setSweepCadence((profile as any).sweep_frequency);
      }
      if (profile.enabled_channels && Array.isArray(profile.enabled_channels) && profile.enabled_channels.length > 0) {
        setEnabledChannels(profile.enabled_channels);
      }
      if (profile.credits_balance !== undefined && profile.credits_balance !== null) {
        setCreditsBalance(profile.credits_balance);
      }
    }

    // Overlay any client-side cached settings
    const saved = localStorage.getItem(`${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.slackWebhook !== undefined) setSlackWebhook(parsed.slackWebhook);
        if (parsed.emailDigest !== undefined) setEmailDigest(parsed.emailDigest);
        if (parsed.lookbackHours !== undefined) setLookbackHours(parsed.lookbackHours);
        if (parsed.currentPlan !== undefined) setCurrentPlan(parsed.currentPlan);
        if (parsed.sweepTime !== undefined) setSweepTime(parsed.sweepTime);
        if (parsed.sweepCadence !== undefined) setSweepCadence(parsed.sweepCadence);
        if (parsed.minIntentThreshold !== undefined) setMinIntentThreshold(parsed.minIntentThreshold);
        if (parsed.enabledChannels && Array.isArray(parsed.enabledChannels) && parsed.enabledChannels.length > 0) {
          setEnabledChannels(parsed.enabledChannels);
        }
      } catch (err) {
        console.error('Error loading settings:', err);
      }
    }

    const savedCredits = localStorage.getItem(`${LOCAL_STORAGE_CREDITS_KEY}_${user.id}`);
    if (savedCredits) {
      const parsedNum = parseInt(savedCredits, 10);
      if (!isNaN(parsedNum)) {
        setCreditsBalance(parsedNum);
      }
    }
  };

  const saveSettings = async () => {
    if (!user) return;
    const settings = {
      slackWebhook,
      emailDigest,
      lookbackHours,
      currentPlan,
      sweepTime,
      sweepCadence,
      minIntentThreshold,
      enabledChannels,
    };
    localStorage.setItem(`${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`, JSON.stringify(settings));

    if (isConfigured && supabase) {
      try {
        await supabase
          .from('profiles')
          .update({
            slack_webhook: slackWebhook || null,
            email_digest: emailDigest,
            lookback_hours: lookbackHours,
            sweep_time_utc: sweepTime,
            sweep_frequency: sweepCadence,
            enabled_channels: enabledChannels,
          })
          .eq('id', user.id);
      } catch (err) {
        console.error('Error syncing profile settings to database:', err);
      }
    }

    addToast('Preferences saved successfully.', 'success');
  };

  const loadKeywords = async () => {
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

        if (!error && data) {
          setKeywords(data as Keyword[]);
        }
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
  };

  const loadPosts = async () => {
    if (!user) return;
    setIsLoadingPosts(true);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('monitored_posts')
          .select('*')
          .eq('user_id', user.id)
          .order('posted_at', { ascending: false });

        // Load unlocked leads for current user
        const { data: unlocks } = await supabase
          .from('lead_unlocks')
          .select('*')
          .eq('user_id', user.id);

        const unlockMap: Record<string, LeadUnlock> = {};
        if (unlocks) {
          unlocks.forEach((u) => {
            unlockMap[u.post_id] = u as LeadUnlock;
          });
          setUnlockedLeads(unlockMap);
        }

        if (!error && data) {
          const merged = (data as MonitoredPost[]).map((p) => ({
            ...p,
            is_unlocked: !!unlockMap[p.id],
            unlock_data: unlockMap[p.id],
          }));
          setPosts(merged);
        }
      } catch (err) {
        console.error('Error loading Supabase monitored posts:', err);
      }
    } else {
      const savedUnlocks = localStorage.getItem(`${LOCAL_STORAGE_UNLOCKS_KEY}_${user.id}`);
      let unlockMap: Record<string, LeadUnlock> = {};
      if (savedUnlocks) {
        try {
          unlockMap = JSON.parse(savedUnlocks);
          setUnlockedLeads(unlockMap);
        } catch {}
      }

      const saved = localStorage.getItem(`${LOCAL_STORAGE_POSTS_KEY}_${user.id}`);
      if (saved) {
        try {
          const parsed: MonitoredPost[] = JSON.parse(saved);
          setPosts(
            parsed.map((p) => ({
              ...p,
              is_unlocked: !!unlockMap[p.id],
              unlock_data: unlockMap[p.id],
            }))
          );
        } catch {
          setPosts([]);
        }
      } else {
        setPosts([]);
      }
    }
    setIsLoadingPosts(false);
  };

  const addKeyword = async (rawKeyword: string): Promise<{ success: boolean; error?: string }> => {
    const clean = rawKeyword.trim().toLowerCase();
    if (!clean) return { success: false, error: 'Keyword cannot be empty.' };
    if (!user) return { success: false, error: 'You must be logged in.' };

    if (keywords.length >= 10) {
      const errorMsg = "You've reached the 10 keyword limit — remove one to add another.";
      addToast(errorMsg, 'error');
      return { success: false, error: errorMsg };
    }

    if (keywords.some((k) => k.keyword.toLowerCase() === clean)) {
      const errorMsg = `"${clean}" is already in your tracked keywords.`;
      addToast(errorMsg, 'error');
      return { success: false, error: errorMsg };
    }

    const newKeyword: Keyword = {
      id: `kw-${Date.now()}`,
      user_id: user.id,
      keyword: clean,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    const previous = [...keywords];
    const updated = [...keywords, newKeyword];
    setKeywords(updated);

    if (isConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('keywords')
          .insert({
            user_id: user.id,
            keyword: clean,
            is_active: true,
          })
          .select()
          .single();

        if (error) {
          setKeywords(previous);
          addToast(`Failed to add keyword: ${error.message}`, 'error');
          return { success: false, error: error.message };
        } else if (data) {
          setKeywords((prev) => prev.map((k) => (k.id === newKeyword.id ? data : k)));
        }
      } catch (err: any) {
        setKeywords(previous);
        addToast(`Error adding keyword: ${err.message}`, 'error');
        return { success: false, error: err.message };
      }
    } else {
      localStorage.setItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`, JSON.stringify(updated));
    }

    addToast(`Added keyword "${clean}"`, 'success');
    return { success: true };
  };

  const removeKeyword = async (id: string): Promise<{ success: boolean; error?: string }> => {
    if (!user) return { success: false, error: 'You must be logged in.' };

    const target = keywords.find((k) => k.id === id);
    const previous = [...keywords];
    const updated = keywords.filter((k) => k.id !== id);
    setKeywords(updated);

    if (isConfigured && supabase) {
      try {
        const { error } = await supabase.from('keywords').delete().eq('id', id);
        if (error) {
          setKeywords(previous);
          addToast(`Failed to delete keyword: ${error.message}`, 'error');
          return { success: false, error: error.message };
        }
      } catch (err: any) {
        setKeywords(previous);
        addToast(`Error deleting keyword: ${err.message}`, 'error');
        return { success: false, error: err.message };
      }
    } else {
      localStorage.setItem(`${LOCAL_STORAGE_KEYWORDS_KEY}_${user.id}`, JSON.stringify(updated));
    }

    if (target) {
      addToast(`Removed keyword "${target.keyword}"`, 'info');
    }
    return { success: true };
  };

  const saveInitialKeywords = async (initialKws: string[]): Promise<boolean> => {
    if (!user) return false;
    const capped = initialKws.slice(0, 10).map((k) => k.trim().toLowerCase());

    if (isConfigured && supabase) {
      try {
        const rows = capped.map((k) => ({
          user_id: user.id,
          keyword: k,
          is_active: true,
        }));
        const { data, error } = await supabase
          .from('keywords')
          .upsert(rows, { onConflict: 'user_id,keyword' })
          .select();
        if (error) {
          console.error('Error saving initial keywords:', error);
          return false;
        }
        if (data) setKeywords(data as Keyword[]);
      } catch (err) {
        console.error('Initial keywords exception:', err);
        return false;
      }
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
  };

  const updatePostStatus = async (postId: string, status: LeadStatus) => {
    const targetPost = posts.find((p) => p.id === postId);

    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, status } : p))
    );

    if (isConfigured && supabase && user) {
      try {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);
        if (isUuid) {
          await supabase
            .from('monitored_posts')
            .update({ status })
            .eq('id', postId)
            .eq('user_id', user.id);
        } else if (targetPost?.post_url) {
          await supabase
            .from('monitored_posts')
            .update({ status })
            .eq('post_url', targetPost.post_url)
            .eq('user_id', user.id);
        }
      } catch (err: any) {
        console.error('Error updating post status in database:', err);
      }
    } else if (user) {
      const updated = posts.map((p) => (p.id === postId ? { ...p, status } : p));
      localStorage.setItem(`${LOCAL_STORAGE_POSTS_KEY}_${user.id}`, JSON.stringify(updated));
    }

    addToast(`Lead marked as ${status}`, 'info');
  };

  const runSweep = async () => {
    if (!user) return;
    setIsSweeping(true);
    const channelNames = enabledChannels
      .map((c) => (c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c.charAt(0).toUpperCase() + c.slice(1)))
      .join(', ');
    addToast(`Scanning social networks across ${channelNames}...`, 'info');

    try {
      const activeKeywords = keywords.filter((k) => k.is_active);
      const startedAt = new Date().toISOString();

      // 1. Fetch live posts across user-enabled channels via Social Fetch API
      let fetchedPosts: MonitoredPost[] = [];
      if (activeKeywords.length > 0 && enabledChannels.length > 0) {
        fetchedPosts = await performSocialFetchSweep(activeKeywords, user.id, enabledChannels);
      }

      // 2. If Supabase is connected, persist to monitored_posts and sweep_runs
      if (isConfigured && supabase) {
        if (fetchedPosts.length > 0) {
          const postsToUpsert = fetchedPosts.map((p) => ({
            user_id: user.id,
            keyword_id: p.keyword_id && p.keyword_id.length === 36 ? p.keyword_id : null,
            matched_keyword: p.matched_keyword,
            platform: p.platform,
            channel_source: p.channel_source || null,
            post_url: p.post_url,
            author_name: p.author_name || null,
            author_handle: p.author_handle || null,
            author_avatar_url: p.author_avatar_url || null,
            body: p.body || null,
            posted_at: p.posted_at || new Date().toISOString(),
            intent_score: p.intent_score || 85,
            status: 'new',
            engagement: p.engagement || null,
          }));

          // Upsert posts avoiding duplicate (user_id, post_url)
          await supabase
            .from('monitored_posts')
            .upsert(postsToUpsert, { onConflict: 'user_id,post_url', ignoreDuplicates: true });
        }

        // Record sweep run in database audit log
        try {
          await supabase.from('sweep_runs').insert({
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            users_processed: 1,
            posts_inserted: fetchedPosts.length,
            errors: [],
          });
        } catch {
          // Non-blocking telemetry
        }

        // Query fresh posts from Supabase database
        const { data: freshPosts, error } = await supabase
          .from('monitored_posts')
          .select('*')
          .eq('user_id', user.id)
          .order('posted_at', { ascending: false });

        if (!error && freshPosts) {
          setPosts(freshPosts as MonitoredPost[]);
        } else if (fetchedPosts.length > 0) {
          setPosts((prev) => [...fetchedPosts, ...prev]);
        }
      } else {
        // Fallback local update if Supabase not configured
        if (fetchedPosts.length > 0) {
          setPosts((prev) => [...fetchedPosts, ...prev]);
        }
      }

      setMonthlyCreditsUsed((prev) => prev + (fetchedPosts.length > 0 ? fetchedPosts.length : 1));
      setIsSweeping(false);

      if (fetchedPosts.length > 0) {
        addToast(
          `Sweep completed! Found ${fetchedPosts.length} live opportunities across social channels.`,
          'success'
        );
      } else if (activeKeywords.length === 0) {
        addToast('No active keywords to track. Add keywords in Tracked Keywords tab.', 'info');
      } else {
        addToast('Sweep finished. No new mentions found in the last time window.', 'info');
      }
    } catch (err: any) {
      setIsSweeping(false);
      addToast(`Sweep error: ${err?.message || 'Failed to complete sweep'}`, 'error');
    }
  };

  // Phase 2: AI Outreach Draft Generator (OpenAI GPT-4o-mini powered)
  const generateAiDraft = async (
    post: MonitoredPost,
    tone: 'professional' | 'casual' | 'consultative' | 'direct',
    customOffer?: string
  ): Promise<string> => {
    return await generateAiOutreachDraft(
      post,
      tone,
      customOffer || profile?.core_offer || undefined,
      profile?.full_name || undefined
    );
  };

  // Phase 2: AI Keyword Suggestions from user's Core Offer (OpenAI GPT-4o-mini powered)
  const suggestKeywordsFromOffer = async (offerText: string, website?: string): Promise<string[]> => {
    return await generateAiKeywordsFromOffer(offerText, website || profile?.website || undefined);
  };

  // Lead Selling & Credit Waterfall Unlocking Engine
  const unlockLead = async (
    post: MonitoredPost
  ): Promise<{ success: boolean; data?: LeadUnlock; error?: string }> => {
    if (!user) {
      addToast('Please log in to unlock leads.', 'error');
      return { success: false, error: 'unauthenticated' };
    }

    if (unlockedLeads[post.id]) {
      return { success: true, data: unlockedLeads[post.id] };
    }

    if (creditsBalance < 3) {
      addToast('Insufficient credits. 3 credits required to unlock verified contact.', 'error');
      setIsTopUpModalOpen(true);
      return { success: false, error: 'insufficient_credits' };
    }

    setIsUnlockingLead((prev) => ({ ...prev, [post.id]: true }));

    try {
      const enriched = await executeWaterfallEnrichment(post, user.id);
      const newCredits = Math.max(0, creditsBalance - 3);
      setCreditsBalance(newCredits);

      const unlockRecord: LeadUnlock = {
        id: `unlock-${Date.now()}`,
        user_id: user.id,
        post_id: post.id,
        credits_spent: 3,
        verified_email: enriched.verified_email,
        email_status: enriched.email_status,
        enrichment_provider: enriched.enrichment_provider,
        contact_name: enriched.contact_name,
        company_name: enriched.company_name,
        company_domain: enriched.company_domain,
        linkedin_url: enriched.linkedin_url,
        unlocked_at: new Date().toISOString(),
      };

      const updatedMap = { ...unlockedLeads, [post.id]: unlockRecord };
      setUnlockedLeads(updatedMap);

      // Update post in memory with unlocked data
      setPosts((prev) =>
        prev.map((p) =>
          p.id === post.id
            ? { ...p, is_unlocked: true, unlock_data: unlockRecord }
            : p
        )
      );

      // Persist to Supabase if configured
      if (isConfigured && supabase) {
        try {
          await supabase.from('lead_unlocks').upsert({
            user_id: user.id,
            post_id: post.id,
            credits_spent: 3,
            verified_email: enriched.verified_email,
            email_status: enriched.email_status,
            enrichment_provider: enriched.enrichment_provider,
            contact_name: enriched.contact_name,
            company_name: enriched.company_name,
            company_domain: enriched.company_domain,
            linkedin_url: enriched.linkedin_url,
          }, { onConflict: 'user_id,post_id' });

          await supabase.from('credit_transactions').insert({
            user_id: user.id,
            amount: -3,
            type: 'lead_unlock',
            description: `Unlocked ${enriched.contact_name} (${enriched.company_name})`,
          });

          await supabase.from('profiles').update({ credits_balance: newCredits }).eq('id', user.id);
        } catch (dbErr) {
          console.warn('DB unlock persist warning:', dbErr);
        }
      }

      localStorage.setItem(`${LOCAL_STORAGE_CREDITS_KEY}_${user.id}`, String(newCredits));
      localStorage.setItem(`${LOCAL_STORAGE_UNLOCKS_KEY}_${user.id}`, JSON.stringify(updatedMap));

      addToast(
        `Lead unlocked! Verified email found via ${enriched.enrichment_provider} (3 credits).`,
        'success'
      );
      return { success: true, data: unlockRecord };
    } catch (err: any) {
      addToast(`Failed to enrich lead: ${err.message || 'Unknown error'}`, 'error');
      return { success: false, error: err.message };
    } finally {
      setIsUnlockingLead((prev) => ({ ...prev, [post.id]: false }));
    }
  };

  const topUpCredits = async (amount: number, packName: string): Promise<void> => {
    if (!user) return;
    const newBalance = creditsBalance + amount;
    setCreditsBalance(newBalance);

    if (isConfigured && supabase) {
      try {
        await supabase.from('profiles').update({ credits_balance: newBalance }).eq('id', user.id);
        await supabase.from('credit_transactions').insert({
          user_id: user.id,
          amount,
          type: 'topup',
          description: `Purchased ${packName} (${amount} Credits)`,
        });
      } catch (err) {
        console.warn('DB topup persist warning:', err);
      }
    }

    localStorage.setItem(`${LOCAL_STORAGE_CREDITS_KEY}_${user.id}`, String(newBalance));
  };

  // Phase 3: Export features with Unlocked Contact Columns
  const exportPostsToCsv = (customPosts?: MonitoredPost[]) => {
    const targetPosts = customPosts && customPosts.length > 0 ? customPosts : posts;
    if (!targetPosts || targetPosts.length === 0) {
      addToast('No leads available to export.', 'error');
      return;
    }

    const headers = [
      'Platform',
      'Author / Decision Maker',
      'Verified Work Email',
      'Email Status',
      'Company Name',
      'Company Domain',
      'LinkedIn Profile',
      'Enrichment Provider',
      'Matched Keyword',
      'Intent Score',
      'Status',
      'Channel Source',
      'Posted At',
      'Post URL',
      'Content / Body',
    ];

    const rows = targetPosts.map((p) => {
      const unlock = p.unlock_data || unlockedLeads[p.id];
      const isUnlocked = p.is_unlocked || !!unlock;

      return [
        `"${(p.platform || '').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.contact_name || p.author_name || '') : 'Locked (Unlock in Echo)').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.verified_email || '') : 'Locked (Unlock in Echo)').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.email_status || 'verified') : 'locked').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.company_name || '') : 'Locked').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.company_domain || '') : 'Locked').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.linkedin_url || '') : 'Locked').replace(/"/g, '""')}"`,
        `"${(isUnlocked ? (unlock?.enrichment_provider || 'QuickEnrich') : 'N/A').replace(/"/g, '""')}"`,
        `"${(p.matched_keyword || '').replace(/"/g, '""')}"`,
        p.intent_score || 85,
        `"${p.status || 'new'}"`,
        `"${(p.channel_source || '').replace(/"/g, '""')}"`,
        `"${p.posted_at || ''}"`,
        `"${(p.post_url || '').replace(/"/g, '""')}"`,
        `"${(p.body || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`,
      ];
    });

    // Prepend UTF-8 BOM (\uFEFF) for full Excel and Sheets compatibility
    const csvString = '\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\r\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `echo_leads_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 200);

    addToast(`Successfully downloaded ${targetPosts.length} leads as CSV`, 'success');
  };

  const exportPostsToJson = (customPosts?: MonitoredPost[]) => {
    const targetPosts = customPosts && customPosts.length > 0 ? customPosts : posts;
    if (!targetPosts || targetPosts.length === 0) {
      addToast('No leads available to export.', 'error');
      return;
    }

    const jsonString = JSON.stringify(targetPosts, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `echo_leads_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 200);

    addToast(`Successfully downloaded ${targetPosts.length} leads as JSON`, 'success');
  };

  return (
    <EchoContext.Provider
      value={{
        keywords,
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
        slackWebhook,
        setSlackWebhook,
        emailDigest,
        setEmailDigest,
        lookbackHours,
        setLookbackHours,
        sweepTime,
        setSweepTime,
        sweepCadence,
        setSweepCadence,
        saveSettings,
        minIntentThreshold,
        setMinIntentThreshold,
        enabledChannels,
        toggleChannel,
        creditsBalance,
        unlockedLeads,
        isUnlockingLead,
        unlockLead,
        topUpCredits,
        isTopUpModalOpen,
        setIsTopUpModalOpen,
        currentPlan,
        setCurrentPlan,
        monthlyCreditsUsed,
        invoices,
      }}
    >
      {children}
      <TopUpModal isOpen={isTopUpModalOpen} onClose={() => setIsTopUpModalOpen(false)} />
    </EchoContext.Provider>
  );
};

export const useEcho = () => {
  const context = useContext(EchoContext);
  if (!context) {
    throw new Error('useEcho must be used within an EchoProvider');
  }
  return context;
};
