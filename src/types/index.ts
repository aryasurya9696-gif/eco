export type Platform = 'twitter' | 'reddit' | 'google' | 'news';

export type LeadStatus = 'new' | 'saved' | 'contacted' | 'dismissed';

export type LeadIntent = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
// The second Echo service. Feed finds people talking about buying; Leads finds
// the companies that would buy, the decision maker at each, and a verified work
// email for them through a waterfall of providers, cheapest first.
//
// These mirror the database shapes in 20261108_leads.sql. They are client-side
// views of the same thing, not an independent model: a status the UI accepts is
// a status the CHECK constraint accepts, so a value added here without the
// migration will be refused at the boundary rather than stored and mis-rendered.
// ---------------------------------------------------------------------------

export type LeadRunKind = 'find' | 'clean' | 'lab';

export type LeadRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * The verification verdict, which is a different question from whether an email
 * was found. `not_found` is the absence of a result and nothing was charged;
 * `invalid` is a confirmed dead address, which is worth retrying from the next
 * provider. `catch_all` is valid syntax at a domain that accepts any mailbox:
 * sendable and risky, and never presented without saying so.
 */
export type LeadEmailStatus =
  | 'verified'
  | 'catch_all'
  | 'invalid'
  | 'unknown'
  | 'not_found';

/** Where a row is in the pipeline, so a reconnecting browser resumes the animation. */
export type LeadRowState =
  | 'queued'
  | 'trying'
  | 'miss'
  | 'found'
  | 'done'
  | 'skipped'
  | 'failed';

/** The stage that owns the row right now. */
export type LeadStep = 'company' | 'person' | 'email' | 'verify' | 'phone' | 'enrich';

export type LeadCleanMode = 'verify_only' | 'verify_refind' | 'full_enrich';

/** Which panel is showing inside the Leads tab. Mirrors the sub-route in the hash. */
export type LeadsView =
  | 'runs'
  | 'new'
  | 'clean'
  | 'lab'
  | 'optouts'
  | 'run';

export interface LeadIcp {
  id: string;
  user_id: string;
  website: string | null;
  offer: string | null;
  inputs: Record<string, unknown>;
  pages: Array<{ url: string; title?: string; treg_call_id?: string }>;
  brand: Record<string, unknown> | null;
  json: LeadIcpDocument;
  version: number;
  note: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The AI's output. Optional on every field after `segments`: the generator is
 * asked for exactly this shape, but a model that drops a key must not take the
 * card down, and a partially filled ICP is still worth showing with the gap
 * visible.
 */
export interface LeadIcpSegment {
  name?: string;
  industries?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  countries?: string[];
  employeeRange?: [number, number];
  targetTitles?: string[];
  seniority?: string[];
  whyTheyBuy?: string;
  pains?: string[];
  openingAngle?: string;
}

/**
 * One thing the generator inferred, and how much a wrong inference would cost.
 *
 * The severity is about consequence rather than certainty: being fairly sure
 * about the wrong country is worse than being unsure about the right one.
 */
export interface LeadIcpAssumption {
  text: string;
  severity: 'high' | 'medium' | 'low';
  /** Why it matters if it is wrong. Empty when the model did not say. */
  why?: string;
}

export interface LeadIcpDocument {
  summary?: string;
  segments?: LeadIcpSegment[];
  primarySegment?: number;
  /**
   * Stored and not displayed.
   *
   * The severity is asked for, the model returns it, and the panel that showed it
   * was removed — the data is the thing to reach for when somebody asks why a
   * search returned what it did, and re-asking the model for it later is not
   * reliable enough to depend on.
   *
   * Profiles written before the shape changed hold bare strings here, which is why
   * the field is not simply `LeadIcpAssumption[]`. Anything reading this has to
   * cope with both.
   */
  assumptions?: Array<LeadIcpAssumption | string>;
  confidence?: number;
}

export interface LeadRun {
  id: string;
  user_id: string;
  icp_id: string | null;
  name: string | null;
  kind: LeadRunKind;
  target: number | null;
  mode: LeadCleanMode | null;
  options: {
    phone?: boolean;
    company_data?: boolean;
    row_cap_usd?: number;
    [k: string]: unknown;
  };
  status: LeadRunStatus;
  pause_reason: string | null;
  last_error: string | null;
  est_credits: number | null;
  max_credits: number | null;
  charged_credits: number;
  treg_cost_usd: number;
  counters: {
    rows?: number;
    found?: number;
    verified?: number;
    catch_all?: number;
    [k: string]: unknown;
  };
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  user_id: string;
  run_id: string;
  company_name: string | null;
  domain: string | null;
  logo_url: string | null;
  person_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_status: LeadEmailStatus;
  email_provider: string | null;
  phone: string | null;
  phone_provider: string | null;
  company_data: Record<string, unknown>;
  extra: Record<string, unknown>;
  credits: number;
  /**
   * What the provider charged for this row, in dollars.
   *
   * Null until the row has been worked. Null and zero are different and the UI
   * has to tell them apart: zero means the provider call was free, null means
   * there has not been one. Rendering null as 0.00 would tell a user a queued
   * row cost nothing, which is true today and will not be true in a minute.
   */
  treg_cost_usd: number | null;
  state: LeadRowState;
  step: LeadStep | null;
  current_provider: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One provider call made for a row. The evidence behind the row receipt, the
 * credits a row cost, and the hit rates the provider lab ranks on.
 */
export interface LeadAttempt {
  id: string;
  run_id: string;
  row_id: string;
  step: LeadStep;
  endpoint_id: string;
  hit: boolean;
  cost_usd: number;
  ms: number | null;
  treg_call_id: string | null;
  created_at: string;
}

/**
 * What a run costs before it starts. `max` is the figure the button is disabled
 * against, not `expected`: a run that cannot be paid for in full must not start,
 * so the wallet is checked against the ceiling rather than the guess.
 */
export interface LeadEstimate {
  min_credits: number;
  expected_credits: number;
  max_credits: number;
  /** Per-stage credit costs, for the breakdown shown on hover. */
  breakdown: Array<{ label: string; credits: number; note?: string }>;
}

export interface LeadSuppression {
  id: string;
  value: string;
  kind: 'email' | 'domain';
  reason: string | null;
  created_at: string;
}

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
  /**
   * Server-only. The client can read it — it has to, to know whether to show the
   * consent box — but cannot write it: the column holds no UPDATE grant, so
   * accepting the terms means going through the leads function.
   */
  leads_terms_accepted_at?: string | null;
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

export type DashboardTab = 'feed' | 'keywords' | 'leads' | 'settings' | 'billing';
