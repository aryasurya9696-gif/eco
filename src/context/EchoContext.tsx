import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, isConfigured } from '../lib/supabase';
import { performSocialFetchSweep } from '../lib/socialfetch';
import { useAuth } from './AuthContext';
import type { Keyword, MonitoredPost, Platform, LeadStatus, InvoiceItem } from '../types';

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
  generateAiDraft: (post: MonitoredPost, tone: 'professional' | 'casual' | 'consultative' | 'direct') => string;
  suggestKeywordsFromOffer: (offerText: string) => string[];
  // Phase 3: Export & Integrations
  exportPostsToCsv: (customPosts?: MonitoredPost[]) => void;
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

export const EchoProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
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
  const [slackWebhook, setSlackWebhook] = useState<string>('');
  const [emailDigest, setEmailDigest] = useState<boolean>(true);
  const [lookbackHours, setLookbackHours] = useState<number>(24);
  const [sweepTime, setSweepTime] = useState<string>('06:00');
  const [sweepCadence, setSweepCadence] = useState<'24h' | '12h' | '6h'>('24h');

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
  }, [user]);

  const loadSettings = () => {
    if (!user) return;
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
      } catch (err) {
        console.error('Error loading settings:', err);
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
    };
    localStorage.setItem(`${LOCAL_STORAGE_SETTINGS_KEY}_${user.id}`, JSON.stringify(settings));
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

        if (!error && data) {
          setPosts(data as MonitoredPost[]);
        }
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
        const { data, error } = await supabase.from('keywords').insert(rows).select();
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
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, status } : p))
    );

    if (isConfigured && supabase && user) {
      try {
        await supabase
          .from('monitored_posts')
          .update({ status })
          .eq('id', postId)
          .eq('user_id', user.id);
      } catch (err: any) {
        console.error('Error updating post status in Supabase:', err);
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
    addToast('Scanning social networks across Twitter, Reddit & Web...', 'info');

    try {
      const activeKeywords = keywords.filter((k) => k.is_active);
      const activeKwTexts = activeKeywords.map((k) => k.keyword);
      const startedAt = new Date().toISOString();

      // 1. Fetch live posts across channels via Social Fetch API
      let fetchedPosts: MonitoredPost[] = [];
      if (activeKeywords.length > 0) {
        fetchedPosts = await performSocialFetchSweep(activeKeywords, user.id);
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

        // Record sweep run in Supabase
        await supabase.from('sweep_runs').insert({
          user_id: user.id,
          status: 'completed',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          posts_found: fetchedPosts.length,
          keywords_checked: activeKwTexts,
        });

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

  // Phase 2: AI Outreach Draft Generator
  const generateAiDraft = (
    post: MonitoredPost,
    tone: 'professional' | 'casual' | 'consultative' | 'direct'
  ): string => {
    const author = post.author_name ? post.author_name.split(' ')[0] : 'there';
    const keyword = post.matched_keyword;

    switch (tone) {
      case 'casual':
        return `Hey ${author}, saw your post regarding ${keyword}. We actually tackled this exact problem recently. Would love to share our benchmark notes if you're open to a quick comparison!`;
      case 'consultative':
        return `Hi ${author}, your observation about ${keyword} is spot-on. Many teams struggle with this transition. We put together a brief workflow analysis on how to optimize this without bloatware — happy to share the breakdown if helpful!`;
      case 'direct':
        return `Hi ${author}, noticed your requirement for ${keyword}. Echo monitors these exact intent signals automatically. Are you available for a 5-minute walkthrough this Thursday at 2pm?`;
      case 'professional':
      default:
        return `Hello ${author}, I came across your post about ${keyword}. We specialize in solving this challenge with streamlined automation. I would welcome the opportunity to connect and exchange thoughts on your current architecture.`;
    }
  };

  // Phase 2: AI Keyword Suggestions from user's Core Offer
  const suggestKeywordsFromOffer = (offerText: string): string[] => {
    const clean = offerText.toLowerCase();
    const defaults = [
      'ai agents',
      'b2b lead gen',
      'sales automation',
      'outbound pipeline',
      'crm workflow',
      'intent data',
      'social listening',
      'lead qualification',
    ];

    if (clean.includes('agent') || clean.includes('ai')) {
      return ['autonomous ai agents', 'ai lead qualification', 'ai sales workflow', 'agentic outbound', 'crm ai enrichment'];
    }
    if (clean.includes('sales') || clean.includes('lead') || clean.includes('outbound')) {
      return ['b2b lead gen', 'outbound pipeline', 'sales automation', 'buyer intent signal', 'cold outreach alternative'];
    }
    if (clean.includes('dev') || clean.includes('api') || clean.includes('code')) {
      return ['developer api', 'backend workflow', 'supabase edge functions', 'automation webhook', 'social scraping api'];
    }

    return defaults;
  };

  // Phase 3: Export features
  const exportPostsToCsv = (customPosts?: MonitoredPost[]) => {
    const targetPosts = customPosts && customPosts.length > 0 ? customPosts : posts;
    if (!targetPosts || targetPosts.length === 0) {
      addToast('No leads available to export.', 'error');
      return;
    }

    const headers = [
      'Platform',
      'Author Name',
      'Author Handle',
      'Matched Keyword',
      'Intent Score',
      'Status',
      'Channel Source',
      'Posted At',
      'Post URL',
      'Content / Body',
    ];

    const rows = targetPosts.map((p) => [
      `"${(p.platform || '').replace(/"/g, '""')}"`,
      `"${(p.author_name || '').replace(/"/g, '""')}"`,
      `"${(p.author_handle || '').replace(/"/g, '""')}"`,
      `"${(p.matched_keyword || '').replace(/"/g, '""')}"`,
      p.intent_score || 85,
      `"${p.status || 'new'}"`,
      `"${(p.channel_source || '').replace(/"/g, '""')}"`,
      `"${p.posted_at || ''}"`,
      `"${(p.post_url || '').replace(/"/g, '""')}"`,
      `"${(p.body || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`,
    ]);

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
        currentPlan,
        setCurrentPlan,
        monthlyCreditsUsed,
        invoices,
      }}
    >
      {children}
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
