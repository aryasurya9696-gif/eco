// ============================================================================
// Supabase Edge Function: billing
// ----------------------------------------------------------------------------
// The customer's wallet: balance, what things cost, what they have bought, and
// starting a purchase.
//
// Read-only except for creating a payment order. It never moves credits itself —
// credits come from the webhook, and only after the payment provider says the
// money arrived. A client that could grant itself credits would not need a
// payment provider at all, which is the entire point of having one.
//
// Prices are read from pricing_config and topup_packages rather than from a
// client-supplied amount, so what the screen shows and what gets charged cannot
// drift apart.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy billing
// Request:  { action: 'balance' | 'packages' | 'history' | 'quote' | 'checkout' | 'status' }
// Response: { ok: true, ... }
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

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The wallet summary the Billing tab renders.
 *
 * `available` is what can actually be spent right now: the balance minus
 * whatever is held for a sweep currently in flight. Showing raw balance as
 * "spendable" would overstate it exactly when a sweep is mid-flight.
 */
async function actionBalance(admin: ReturnType<typeof createClient>, userId: string) {
  const { data: wallet, error } = await admin
    .from('wallet')
    .select('balance, reserved, lifetime_granted, lifetime_consumed, recognised_revenue_usd, service_cost_usd')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`wallet lookup failed: ${error.message}`);
  if (!wallet) {
    return { ok: true, wallet: { balance: 0, reserved: 0, available: 0 } };
  }

  const balance = num(wallet.balance);
  const reserved = num(wallet.reserved);

  // What a full sweep of this workspace would cost right now, so the page can
  // warn before the user is surprised by a stopped sweep.
  const { data: profile } = await admin
    .from('profiles')
    .select('enabled_channels')
    .eq('id', userId)
    .maybeSingle();
  const { count: keywords } = await admin
    .from('keywords')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);

  const { data: pricing } = await admin
    .from('pricing_config')
    .select('operation, credits')
    .eq('enabled', true);

  const opOf: Record<string, string> = {
    twitter: 'treg.twitter.search',
    reddit: 'treg.reddit.search',
    google: 'treg.web.search',
    news: 'treg.news.search',
  };
  const priceOf = new Map<string, number>((pricing ?? []).map((p: any) => [p.operation, num(p.credits)]));

  const channels: string[] = Array.isArray(profile?.enabled_channels)
    ? profile.enabled_channels
    : ['twitter', 'reddit', 'google'];

  let sweepCost = 0;
  for (const ch of channels) {
    sweepCost += (keywords ?? 0) * (priceOf.get(opOf[ch]) ?? 0);
  }

  const available = Math.max(balance - reserved, 0);

  return {
    ok: true,
    wallet: {
      balance,
      reserved,
      available,
      lifetime_granted: num(wallet.lifetime_granted),
      lifetime_consumed: num(wallet.lifetime_consumed),
      recognised_revenue_usd: num(wallet.recognised_revenue_usd),
      service_cost_usd: num(wallet.service_cost_usd),
    },
    sweep: {
      keywords: keywords ?? 0,
      channels,
      credits: sweepCost,
      // Whether the next scheduled sweep can run at all. Checked here so the
      // warning is visible before the cron silently skips the workspace.
      affordable: available >= sweepCost,
      shortfall: Math.max(sweepCost - available, 0),
    },
  };
}

/** What can be bought. Read from the database so the screen cannot show a stale price. */
async function actionPackages(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from('topup_packages')
    .select('code, display_name, gross_usd, credits, bonus_credits, currency')
    .eq('active', true)
    .order('sort_order');

  if (error) throw new Error(`package lookup failed: ${error.message}`);

  return {
    ok: true,
    packages: (data ?? []).map((p: any) => ({
      code: p.code,
      display_name: p.display_name,
      gross_usd: num(p.gross_usd),
      credits: num(p.credits),
      bonus_credits: num(p.bonus_credits),
      currency: p.currency,
      total_credits: num(p.credits) + num(p.bonus_credits),
      // Unit price shown on the card. Derived from the same numbers the grant
      // will use, so what is advertised is what is charged.
      per_credit_usd: num(p.credits) > 0 ? num(p.gross_usd) / num(p.credits) : 0,
    })),
  };
}

/** Ledger, payments and recent usage — the three histories the tab shows. */
async function actionHistory(admin: ReturnType<typeof createClient>, userId: string) {
  const [ledger, payments, usage] = await Promise.all([
    admin.from('credit_ledger')
      .select('id, delta, balance_after, kind, revenue_usd, service_cost_usd, note, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    admin.from('payment_orders')
      .select('id, package_code, gross_usd, currency, credits_granted, status, created_at, settled_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(25),
    admin.from('api_usage')
      .select('id, operation, provider_cost_usd, credits_charged, revenue_usd, outcome, created_at, metadata')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  for (const [name, res] of [['ledger', ledger], ['payments', payments], ['usage', usage]] as const) {
    if (res.error) throw new Error(`${name} lookup failed: ${res.error.message}`);
  }

  return {
    ok: true,
    ledger: (ledger.data ?? []).map((r: any) => ({
      ...r,
      delta: num(r.delta),
      balance_after: num(r.balance_after),
      revenue_usd: num(r.revenue_usd),
      service_cost_usd: num(r.service_cost_usd),
    })),
    payments: (payments.data ?? []).map((r: any) => ({
      ...r,
      gross_usd: num(r.gross_usd),
      credits_granted: num(r.credits_granted),
    })),
    usage: (usage.data ?? []).map((r: any) => ({
      ...r,
      provider_cost_usd: num(r.provider_cost_usd),
      credits_charged: num(r.credits_charged),
      revenue_usd: num(r.revenue_usd),
      calls: num(r.metadata?.calls),
    })),
  };
}

/**
 * What a sweep would cost, before running it. Lets the UI show a figure rather
 * than failing on a 402 after the user has already waited.
 */
async function actionQuote(
  admin: ReturnType<typeof createClient>,
  userId: string,
  channels: string[],
) {
  const opOf: Record<string, string> = {
    twitter: 'treg.twitter.search',
    reddit: 'treg.reddit.search',
    google: 'treg.web.search',
    news: 'treg.news.search',
  };
  const ops = channels.map((c) => opOf[c]).filter(Boolean);

  const { data: keywords } = await admin
    .from('keywords')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);

  const { data, error } = await admin.rpc('quote_sweep', {
    p_user_id: userId,
    p_keywords: keywords ?? 0,
    p_operations: ops,
  });
  if (error) throw new Error(`quote failed: ${error.message}`);

  return { ok: true, quote: data, keywords: keywords ?? 0 };
}

/**
 * Starts a purchase.
 *
 * Creates the order and returns a checkout URL. It does not grant credits and it
 * cannot — only the provider's signed webhook can do that. If the customer pays
 * and the webhook never arrives, the order stays pending and no credits appear,
 * which is the correct outcome: better no credits than free credits.
 */
async function actionCheckout(
  admin: ReturnType<typeof createClient>,
  userId: string,
  packageCode: string,
) {
  const { data: pkg, error } = await admin
    .from('topup_packages')
    .select('code, display_name, gross_usd, credits, currency')
    .eq('code', packageCode)
    .eq('active', true)
    .maybeSingle();

  if (error) throw new Error(`package lookup failed: ${error.message}`);
  if (!pkg) return { ok: false, error: 'unknown_package' };

  const apiKey = Deno.env.get('DODO_PAYMENTS_API_KEY');
  if (!apiKey) {
    // No payment account configured yet. Saying so plainly beats a checkout
    // button that silently does nothing.
    return {
      ok: false,
      error: 'payments_not_configured',
      message: 'Card payments are not switched on yet.',
    };
  }

  const base = Deno.env.get('DODO_ENVIRONMENT') === 'live_mode'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';

  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();

  const res = await fetch(`${base}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_cart: [{ product_id: pkg.code, quantity: 1 }],
      customer: { email: profile?.email, name: profile?.full_name },
      return_url: `${Deno.env.get('APP_ORIGIN') ?? ''}/?billing=returned`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[billing] checkout session failed:', res.status, body.slice(0, 300));
    return { ok: false, error: 'checkout_failed' };
  }

  const session = await res.json();

  const { data: order, error: orderError } = await admin
    .from('payment_orders')
    .insert({
      user_id: userId,
      provider: 'dodo',
      package_code: pkg.code,
      provider_order_id: session?.id ?? null,
      gross_usd: num(pkg.gross_usd),
      currency: pkg.currency,
      status: 'created',
      checkout_url: session?.url ?? null,
    })
    .select('id')
    .single();

  if (orderError) {
    console.error('[billing] order insert failed:', orderError.message);
    return { ok: false, error: 'order_create_failed' };
  }

  return { ok: true, order_id: order.id, checkout_url: session?.url ?? null };
}

/** Polls one order. Lets the page show "processing" while the webhook lands. */
async function actionStatus(admin: ReturnType<typeof createClient>, userId: string, orderId: string) {
  const { data, error } = await admin
    .from('payment_orders')
    .select('id, status, credits_granted, gross_usd, currency, created_at, settled_at')
    .eq('id', orderId)
    .eq('user_id', userId)          // scoped to the caller: not merely filtered later
    .maybeSingle();

  if (error) throw new Error(`order lookup failed: ${error.message}`);
  if (!data) return { ok: false, error: 'order_not_found' };

  return { ok: true, order: { ...data, gross_usd: num(data.gross_usd), credits_granted: num(data.credits_granted) } };
}

// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  try {
    switch (body?.action) {
      case 'balance':
        return json(await actionBalance(admin, userId));
      case 'packages':
        return json(await actionPackages(admin));
      case 'history':
        return json(await actionHistory(admin, userId));
      case 'quote':
        return json(await actionQuote(admin, userId, Array.isArray(body.channels) ? body.channels : []));
      case 'checkout':
        return json(await actionCheckout(admin, userId, String(body.packageCode ?? '')));
      case 'status':
        return json(await actionStatus(admin, userId, String(body.orderId ?? '')));
      default:
        return fail('Unknown action', 400);
    }
  } catch (err) {
    console.error('[billing] action failed:', (err as Error)?.message);
    return fail('Billing request failed', 500);
  }
});