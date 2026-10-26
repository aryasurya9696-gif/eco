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

export type DashboardTab = 'feed' | 'leads' | 'keywords' | 'settings' | 'billing' | 'mail';

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam';

export interface Mailbox {
  id: string;
  user_id: string;
  kind: 'hosted' | 'app_password' | 'oauth_send';
  provider: 'google' | 'microsoft' | 'zoho' | 'resend' | 'ses' | 'brevo' | 'custom';
  address: string;
  display_name: string;
  domain_id?: string | null;
  status: 'active' | 'paused' | 'needs_reauth' | 'disabled';
  pause_reason?: string | null;
  daily_send_limit: number;
  sent_today: number;
  is_default: boolean;
}

export interface MailThread {
  id: string;
  user_id: string;
  mailbox_id: string;
  lead_id?: string | null;
  lead_name?: string | null;
  lead_company?: string | null;
  subject: string;
  snippet: string;
  participants: { name?: string; address: string }[];
  folder: MailFolder;
  unread_count: number;
  starred: boolean;
  has_attachments: boolean;
  last_message_at: string;
  created_at: string;
  lead_pipeline_status?: B2BPipelineStatus;
}

export interface MailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
}

export interface MailMessage {
  id: string;
  thread_id: string;
  user_id: string;
  mailbox_id: string;
  lead_id?: string | null;
  direction: 'in' | 'out';
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'received';
  is_auto_reply?: boolean;
  from_addr: string;
  to_addrs: { name?: string; address: string }[];
  cc_addrs?: { name?: string; address: string }[];
  bcc_addrs?: { name?: string; address: string }[];
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string;
  message_id_header?: string;
  in_reply_to?: string;
  references_hdr?: string;
  credits_charged?: number;
  sent_at?: string;
  received_at?: string;
  read_at?: string;
  created_at: string;
  attachments?: MailAttachment[];
}

export interface MailDnsRecord {
  type: string;
  host: string;
  value: string;
  status: 'verified' | 'pending' | 'missing';
  /** 'receiving' marks the root MX that routes replies into Echo. */
  purpose?: 'sending' | 'receiving';
  priority?: number;
}

export interface MailDomain {
  id: string;
  domain: string;
  status: 'pending' | 'verifying' | 'verified' | 'failed' | 'suspended';
  provider: 'resend' | 'ses' | 'brevo' | 'custom';
  dkim_tokens: string[];
  dns_records: MailDnsRecord[];
  inbound_provider: 'cloudflare' | 'ses' | 'none';
  verified_at?: string | null;
  last_checked_at?: string | null;
}


export type B2BLookupState = 'queued' | 'processing' | 'not_found' | 'failed' | 'no_credits';

export type B2BPipelineStatus = 'new' | 'contacted' | 'replied' | 'dismissed';

/** A company profile from the shared enrichment cache (leads `company-lookup` / `enrich-company`). */
export interface Company {
  domain: string;
  name: string | null;
  description: string | null;
  industry: string | null;
  /** Headcount or a range, as the provider states it. */
  employees: string | null;
  founded_year: number | null;
  location: string | null;
  linkedin_url: string | null;
  website: string | null;
  logo_url: string | null;
  enriched_at: string | null;
}

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
  /**
   * Client-only progress of an automatic or manual lookup. Absent when no
   * lookup has run. `not_found` = the provider answered with nothing (free),
   * `failed` = the lookup itself errored and can be retried, `no_credits` =
   * skipped because the wallet could not cover it.
   */
  email_lookup?: B2BLookupState | null;
  phone_lookup?: B2BLookupState | null;
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
