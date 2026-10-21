import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  !supabaseUrl.includes('your-project') &&
  !supabaseAnonKey.includes('your-anon-key')
);

/**
 * A production build without Supabase settings must not quietly fall back to
 * the local sandbox: visitors would "sign up" into localStorage and lose
 * everything. App renders this message instead of the product.
 */
export const configError: string | null =
  import.meta.env.PROD && !isConfigured
    ? 'Echo is not configured: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY were not set when this build was made.'
    : null;

/**
 * Whether this page load is the return leg of an email link (sign-up
 * confirmation, password reset, magic link). Captured before the client is
 * created, because supabase-js strips the tokens from the URL once it has
 * read them, which can happen before the first render.
 */
export const arrivedFromAuthCallback: boolean =
  typeof window !== 'undefined' &&
  (/(^#|[#&/])access_token=/.test(window.location.hash) ||
    /[?&]code=/.test(window.location.search));

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
