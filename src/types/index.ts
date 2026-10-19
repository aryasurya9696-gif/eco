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
  sweep_time_utc?: string;
  sweep_frequency?: string;
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

export type DashboardTab = 'feed' | 'leads' | 'keywords' | 'settings' | 'billing';

export type B2BPipelineStatus = 'new' | 'contacted' | 'replied' | 'dismissed';

export interface B2BLead {
  id: string;
  /**
   * The `user_leads.id` this lead was saved under, when it is known.
   *
   * `id` is whatever the search provider returned (or a synthetic `lead_…`
   * value), so it is not a UUID and cannot address a saved row. Status and
   * phone updates have to go through this instead, otherwise they address a row
   * that does not exist — and the query errors out rather than matching none.
   */
  db_id?: string | null;
  user_id?: string;
  first_name: string;
  last_name: string;
  full_name: string;
  title: string;
  company_name: string;
  company_domain: string;
  company_size?: string | null;
  company_revenue?: string | null;
  company_phone?: string | null;
  linkedin_url?: string | null;
  location?: string | null;
  country_code?: string | null;
  industry?: string | null;
  has_email?: boolean;
  has_phone?: boolean;
  has_linkedin?: boolean;
  work_email?: string | null;
  /**
   * The provider's unverified company/homepage address from a search result.
   * Kept apart from `revealed_email` on purpose: it is not the person's
   * verified work email and must not block a reveal of that address.
   */
  preview_email?: string | null;
  phone_number?: string | null;
  phone_type?: string | null;
  /** Client-only: set when a phone lookup came back empty (and was refunded). */
  phone_lookup?: 'not_found' | null;
  revealed_email?: string | null;
  revealed_phone?: string | null;
  email_status?: string | null;
  email_confidence?: number | null;
  status?: B2BPipelineStatus;
  notes?: string | null;
  is_saved?: boolean;
  created_at?: string;
  updated_at?: string;
}
