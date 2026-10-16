export type Platform = 'twitter' | 'linkedin' | 'reddit' | 'facebook' | 'google';

export type LeadStatus = 'new' | 'saved' | 'contacted' | 'dismissed';

export type LeadIntent = 'high' | 'medium' | 'low';

export interface Profile {
  id: string;
  full_name: string | null;
  website: string | null;
  core_offer: string | null;
  onboarding_completed: boolean;
  onboarding_step: number;
  email_digest?: boolean;
  slack_webhook?: string | null;
  lookback_hours?: number;
  enabled_channels?: Platform[];
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

export interface PlanDetails {
  id: 'starter' | 'pro' | 'scale';
  name: string;
  price: number;
  interval: 'month';
  keyword_limit: number;
  sweep_cadence: string;
  ai_drafts_enabled: boolean;
  slack_alerts: boolean;
  credits_included: number;
}

export interface InvoiceItem {
  id: string;
  date: string;
  amount: number;
  status: 'paid' | 'pending';
  download_url: string;
}

export const APP_NAME = 'Echo';
