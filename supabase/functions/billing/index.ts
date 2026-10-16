// ============================================================================
// Supabase Edge Function: billing
// ----------------------------------------------------------------------------
// Creates Stripe Checkout sessions for subscription plan changes and activates
// the plan only after the payment is confirmed for the calling user.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy billing
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_...
//          supabase secrets set APP_ORIGIN=https://your-app.example
//
// Request body:
//   { planId, interval }   -> { checkoutUrl }
//   { checkoutSessionId }  -> activates the plan
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/** Verifies the caller's JWT server-side. Identity is never taken from the body. */
async function requireUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;

  try {
    const res = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: anonKey },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Authoritative subscription catalogue. Must match src/lib/billing.ts. */
const PLANS = {
  starter: { name: 'Starter', monthlyCents: 2900, yearlyCents: 28800 },
  pro: { name: 'Pro', monthlyCents: 7900, yearlyCents: 78000 },
  scale: { name: 'Scale', monthlyCents: 19900, yearlyCents: 198000 },
} as const;

const STRIPE_API = 'https://api.stripe.com/v1';

const isKeyOf = <T extends object>(obj: T, value: unknown): value is keyof T =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(obj, value);

async function stripeRequest(
  secretKey: string,
  endpoint: string,
  form: Record<string, string> = {},
  method: 'POST' | 'GET' = 'POST',
): Promise<any> {
  const res = await fetch(STRIPE_API + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' ? new URLSearchParams(form).toString() : undefined,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe ${endpoint} failed (${res.status})`);
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  if (!rateLimit('billing:' + userId, 15, 60 * 60 * 1000)) {
    return fail('Too many billing requests. Please try again later.', 429);
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) {
    return fail(
      'Payments are not configured on this deployment. Plan changes are unavailable.',
      503,
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail('Invalid JSON body');
  }

  const origin = Deno.env.get('APP_ORIGIN') || '';

  // ---- Path A: start a subscription checkout ------------------------------
  if (!body?.checkoutSessionId) {
    if (!isKeyOf(PLANS, body?.planId)) return fail('Unknown plan');

    const interval = body?.interval === 'year' ? 'year' : 'month';
    const plan = PLANS[body.planId];
    const unitAmount = interval === 'year' ? plan.yearlyCents : plan.monthlyCents;

    try {
      const session = await stripeRequest(stripeKey, '/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(unitAmount),
        'line_items[0][price_data][recurring][interval]': interval,
        'line_items[0][price_data][product_data][name]': `Echo — ${plan.name}`,
        'line_items[0][quantity]': '1',
        client_reference_id: userId,
        'metadata[user_id]': userId,
        'metadata[plan_id]': body.planId,
        'metadata[interval]': interval,
        success_url: `${origin}/#/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/#/dashboard?billing=cancelled`,
      });

      return json({ ok: true, checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      console.error('[billing] could not start checkout:', err);
      return fail('Could not start checkout. Please try again.', 502);
    }
  }

  // ---- Path B: confirm a completed session, then activate the plan --------
  const sessionId = String(body.checkoutSessionId);
  if (!sessionId.startsWith('cs_')) return fail('Invalid checkout session id');

  let session: any;
  try {
    session = await stripeRequest(
      stripeKey,
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {},
      'GET',
    );
  } catch (err) {
    console.error('[billing] session lookup failed:', err);
    return fail('Could not verify the payment.', 502);
  }

  if (session.payment_status !== 'paid') {
    return fail('Payment has not completed yet.', 402);
  }

  // The session must have been created by this app, for this user.
  if (session.metadata?.user_id !== userId) {
    return fail('Checkout session does not belong to this account.', 403);
  }

  const planId = session.metadata?.plan_id;
  if (!isKeyOf(PLANS, planId)) {
    return fail('Unrecognised plan on the payment.', 400);
  }

  const interval = session.metadata?.interval === 'year' ? 'year' : 'month';

  // apply_subscription_plan is SECURITY DEFINER and service-role only, so the
  // client can never set its own plan.
  const { data, error } = await admin.rpc('apply_subscription_plan', {
    p_user_id: userId,
    p_plan: planId,
    p_interval: interval,
    p_renews_at: null,
  });

  if (error) {
    console.error('[billing] plan activation failed:', error.message);
    return fail('Payment received, but plan activation failed. Contact support.', 500);
  }

  return json({ ok: true, plan: planId, interval, result: data });
});