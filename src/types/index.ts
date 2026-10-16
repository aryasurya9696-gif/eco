export type Platform = 'twitter' | 'reddit' | 'google' | 'news';

export type LeadStatus = 'new' | 'saved' | 'contacted' | 'dismissed';

export type LeadIntent = 'high' | 'medium' | 'low';

export interface Profile {
  id: string;
  full_name: string | null;
  website: string | null;
  core_offer: string | null;
  onboarding_completed: boolean;
  onboarding_step: number;
  lookback_hours?: number;
  enabled_channels?: Platform[];
  min_intent_threshold?: number;
  /** 0 = keep forever; otherwise days of mentions to retain. */
  feed_retention_days?: number;
  is_admin?: boolean;
  sweep_time_utc?: string;
  sweep_frequency?: string;
  subscription_plan?: 'starter' | 'pro' | 'scale';
  subscription_interval?: 'month' | 'year';
  subscription_status?: 'active' | 'past_due' | 'canceled';
  subscription_renews_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Keyword {
  id: string;
  user_id: string;
  keyword: string;
  is_active: boolean;
  created_at: string;
  mention_count?: number;
}

export interface MonitoredPost {
  id: string;
  user_id: string;
  keyword_id?: string | null;
  matched_keyword: string;
  platform: Platform;
  channel_source?: string; // e.g. 'r/SaaS', 'B2B Founders Group', 'Google Discussions'
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  body: string | null;
  posted_at: string | null;
  intent_score?: number; // 0 - 100
  intent_level?: LeadIntent;
  status?: LeadStatus;
  notes?: string;
  engagement?: {
    likes?: number | null;
    retweets?: number | null;
    replies?: number | null;
    comments?: number | null;
    reposts?: number | null;
  } | null;
  raw?: any;
  created_at: string;
}

export interface SweepRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  users_processed: number;
  posts_inserted: number;
  errors: any[];
}

export type DashboardTab = 'feed' | 'keywords' | 'settings' | 'billing';

export const APP_NAME = 'Echo';
