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
 * Platform -> pricing operation.
 *
 * Module level rather than local to each action, because three separate places
 * here need the same mapping and three private copies is three chances to type
 * one of them wrong. The keys here are the platform names the product uses.
 */
const OPERATION_OF: Record<string, string> = {
  twitter: 'treg.twitter.search',
  reddit: 'treg.reddit.search',
  google: 'treg.web.search',
  news: 'treg.news.search',
};

/**
 * The caps the cron actually applies, read from the database so every quote
 * here agrees with what a sweep will reserve. 8/3 is the fallback only for a
 * database that predates sweep_shape.
 */
async function readSweepShape(
  admin: ReturnType<typeof createClient>,
): Promise<{ maxKeywords: number; maxChannels: number }> {
  const { data: shape } = await admin.rpc('sweep_shape');
  const k = Number(shape?.max_keywords);
  const c = Number(shape?.max_channels);
  return {
    maxKeywords: Number.isFinite(k) && k > 0 ? k : 8,
    maxChannels: Number.isFinite(c) && c > 0 ? c : 3,
  };
}

// Logged once per isolate, not per request: enough to notice a production
// deploy still pointed at the sandbox without flooding the logs.
let warnedTestMode = false;

function dodoBaseUrl(): string {
  if (Deno.env.get('DODO_ENVIRONMENT') === 'live_mode') return 'https://live.dodopayments.com';
  if (!warnedTestMode) {
    warnedTestMode = true;
    console.warn('[billing] DODO_ENVIRONMENT is not live_mode - using the Dodo TEST environment');
  }
  return 'https://test.dodopayments.com';
}

const stripSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * Where the provider sends the customer back to.
 *
 * APP_ORIGIN is authoritative. Without it, the request's Origin is used only
 * when it is exactly the configured ALLOWED_ORIGIN — echoing an arbitrary
 * Origin would let any page start a checkout that returns somewhere else.
 */
function resolveAppOrigin(req: Request): string | null {
  const configured = Deno.env.get('APP_ORIGIN');
  if (configured && configured.trim()) return stripSlash(configured.trim());

  const origin = req.headers.get('Origin');
  if (origin && ALLOWED_ORIGIN !== '*' && stripSlash(origin) === stripSlash(ALLOWED_ORIGIN)) {
    return stripSlash(origin);
  }
  return null;
}

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
    // Revenue and service cost are our margin, not the customer's business, so
    // they are not even selected.
    .select('balance, reserved, lifetime_granted, lifetime_consumed')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`wallet lookup failed: ${error.message}`);

  // A workspace with no wallet row at all is the one that most needs telling
  // they are out of credits, so this path must still report the sweep cost.
  // Returning early without it left the UI with nothing to warn about, which is
  // the opposite of what someone on zero credits should see.
  if (!wallet) {
    const empty = { balance: 0, reserved: 0, available: 0 };
    // The keyword count comes from `count` — a head:true query has no `data`,
    // so reading the whole response as a number quoted every empty wallet as
    // free.
    const [profileRes, keywordRes, priceRows, shape] = await Promise.all([
      admin.from('profiles').select('enabled_channels').eq('id', userId).maybeSingle(),
      admin.from('keywords').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('is_active', true),
      admin.from('pricing_config').select('operation, credits').eq('enabled', true),
      readSweepShape(admin),
    ]);

    const enabledChannels: string[] = Array.isArray(profileRes.data?.enabled_channels)
      ? profileRes.data.enabled_channels
      : ['twitter', 'reddit', 'google'];
    const channels = enabledChannels.slice(0, shape.maxChannels);
    const configuredKeywords = keywordRes.count ?? 0;
    const effectiveKeywords = Math.min(configuredKeywords, shape.maxKeywords);
    const priceOf = new Map<string, number>(
      (priceRows.data ?? []).map((p: any) => [p.operation, num(p.credits)]),
    );

    let cost = 0;
    for (const ch of channels) cost += effectiveKeywords * (priceOf.get(OPERATION_OF[ch]) ?? 0);

    return {
      ok: true,
      wallet: {
        ...empty,
        lifetime_granted: 0,
        lifetime_consumed: 0,
        credits_purchased: 0,
        credits_free: 0,
        search_count: 0,
      },
      sweep: {
        keywords: effectiveKeywords,
        keywords_configured: configuredKeywords,
        channels,
        channels_configured: enabledChannels,
        credits: cost,
        affordable: cost === 0,
        shortfall: cost,
      },
    };
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

  const priceOf = new Map<string, number>((pricing ?? []).map((p: any) => [p.operation, num(p.credits)]));

  // The caps the cron actually applies. Quoting the sweep as if the tables
  // were unlimited told a workspace at the limit that its next sweep cost more
  // than the sweep could ever reserve, and could show "you can afford this"
  // for a sweep the cron then skipped every single night.
  const { maxKeywords, maxChannels } = await readSweepShape(admin);

  const enabledChannels: string[] = Array.isArray(profile?.enabled_channels)
    ? profile.enabled_channels
    : ['twitter', 'reddit', 'google'];
  const channels = enabledChannels.slice(0, maxChannels);
  const effectiveKeywords = Math.min(keywords ?? 0, maxKeywords);

  let sweepCost = 0;
  for (const ch of channels) {
    sweepCost += effectiveKeywords * (priceOf.get(OPERATION_OF[ch]) ?? 0);
  }

  const available = Math.max(balance - reserved, 0);

  // Two totals the history query cannot supply.
  //
  // lifetime_granted is every credit this workspace has ever received, which
  // includes the welcome grant. Labelling that "bought" would tell someone who
  // has never paid anything that they have, which is both wrong and the kind of
  // wrong a bank statement later corrects. Credits that came from a settled
  // payment are counted separately from credits that were given away.
  const [paidAgg, usageCount] = await Promise.all([
    admin.from('payment_orders')
      .select('credits_granted')
      .eq('user_id', userId)
      .eq('status', 'succeeded'),
    admin.from('api_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId),
  ]);

  const creditsPurchased = (paidAgg.data ?? []).reduce(
    (sum: number, p: any) => sum + num(p.credits_granted),
    0,
  );
  const lifetimeGranted = num(wallet.lifetime_granted);

  return {
    ok: true,
    wallet: {
      balance,
      reserved,
      available,
      lifetime_granted: lifetimeGranted,
      lifetime_consumed: num(wallet.lifetime_consumed),
      // What actually went through a payment, and what was given. Never merged.
      credits_purchased: creditsPurchased,
      credits_free: Math.max(lifetimeGranted - creditsPurchased, 0),
      // A real total, not the length of the recent-searches list. That list is
      // capped for rendering, and a counter derived from it would read 50 to
      // anyone who has run more than 50 searches — flattering precisely for the
      // people most likely to be checking it.
      search_count: usageCount.count ?? 0,
    },
    sweep: {
      // What will actually be swept, not what is stored. A workspace holding 12
      // keywords is quoted for 8, and told so, rather than discovering the
      // difference when two of its keywords never appear.
      keywords: effectiveKeywords,
      keywords_configured: keywords ?? 0,
      channels,
      channels_configured: enabledChannels,
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
      .select('id, delta, balance_after, kind, note, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    admin.from('payment_orders')
      .select('id, package_code, gross_usd, currency, credits_granted, status, created_at, settled_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(25),
    admin.from('api_usage')
      .select('id, operation, credits_charged, outcome, created_at, metadata')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  for (const [name, res] of [['ledger', ledger], ['payments', payments], ['usage', usage]] as const) {
    if (res.error) throw new Error(`${name} lookup failed: ${res.error.message}`);
  }

  // Revenue and provider cost are ours, not the customer's: they are left out
  // of every row, and usage metadata is reduced to the call count.
  return {
    ok: true,
    ledger: (ledger.data ?? []).map((r: any) => ({
      ...r,
      delta: num(r.delta),
      balance_after: num(r.balance_after),
    })),
    payments: (payments.data ?? []).map((r: any) => ({
      ...r,
      gross_usd: num(r.gross_usd),
      credits_granted: num(r.credits_granted),
    })),
    usage: (usage.data ?? []).map((r: any) => ({
      id: r.id,
      operation: r.operation,
      outcome: r.outcome,
      created_at: r.created_at,
      credits_charged: num(r.credits_charged),
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
  const opOf: Record<string, string> = OPERATION_OF;
  const ops = channels.map((c) => opOf[c]).filter(Boolean);

  // head:true returns no rows, only `count`. Reading `data` here always gave
  // null, so every quote was for zero keywords.
  const { count: keywords } = await admin
    .from('keywords')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);

  const { maxKeywords, maxChannels } = await readSweepShape(admin);

  const { data, error } = await admin.rpc('quote_sweep', {
    p_user_id: userId,
    p_keywords: Math.min(keywords ?? 0, maxKeywords),
    p_operations: ops.slice(0, maxChannels),
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
  req: Request,
  userId: string,
  packageCode: string,
) {
  const { data: pkg, error } = await admin
    .from('topup_packages')
    .select('code, display_name, gross_usd, credits, currency, provider_ref')
    .eq('code', packageCode)
    .eq('active', true)
    .maybeSingle();

  if (error) throw new Error(`package lookup failed: ${error.message}`);
  if (!pkg) return { __status: 404, ok: false, error: 'unknown_package' };

  // Every configuration check happens before the order row exists, so a
  // misconfigured deploy does not leave a trail of orphaned 'created' orders.
  //
  // provider_ref is the Dodo product id (pdt_...). Our package code is not a
  // product Dodo knows, so without it the session would be rejected anyway.
  const apiKey = Deno.env.get('DODO_PAYMENTS_API_KEY');
  const productId = typeof pkg.provider_ref === 'string' ? pkg.provider_ref.trim() : '';
  if (!apiKey || !productId) {
    // No payment account configured yet. Saying so plainly beats a checkout
    // button that silently does nothing. 503 rather than 400: nothing is wrong
    // with what the customer asked for.
    if (apiKey && !productId) console.error(`[billing] package ${pkg.code} has no provider_ref (Dodo product id)`);
    return {
      __status: 503,
      ok: false,
      error: 'payments_not_configured',
      message: 'Card payments are not switched on yet.',
    };
  }

  const appOrigin = resolveAppOrigin(req);
  if (!appOrigin) {
    console.error('[billing] APP_ORIGIN is not set and the request Origin is not ALLOWED_ORIGIN');
    return {
      __status: 503,
      ok: false,
      error: 'app_origin_not_configured',
      message: 'Card payments are not switched on yet.',
    };
  }

  // Durable, per user. Each attempt creates an order and a provider session,
  // so an unbounded loop here is spam on both sides. Fails closed: if the
  // limiter cannot answer, no checkout is started.
  const { data: allowed, error: limitError } = await admin.rpc('take_rate_limit', {
    p_user_id: userId,
    p_bucket: 'checkout',
    p_limit: 10,
    p_window_seconds: 3600,
  });
  if (limitError) {
    console.error('[billing] rate limit check failed:', limitError.message);
    return { __status: 503, ok: false, error: 'rate_limit_unavailable', message: 'Checkout is temporarily unavailable.' };
  }
  if (allowed !== true) {
    return {
      __status: 429,
      ok: false,
      error: 'rate_limited',
      message: 'Too many checkout attempts. Please try again later.',
    };
  }

  const base = dodoBaseUrl();

  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();

  // The order row is created first, so its id can be carried into the session's
  // metadata. That is the only identifier the webhook is reliably handed back:
  // a checkout-session id and a payment id are different things, and matching
  // one against the other could never succeed.
  const { data: order, error: orderError } = await admin
    .from('payment_orders')
    .insert({
      user_id: userId,
      provider: 'dodo',
      package_code: pkg.code,
      gross_usd: num(pkg.gross_usd),
      currency: pkg.currency,
      status: 'created',
    })
    .select('id')
    .single();

  if (orderError) {
    console.error('[billing] order insert failed:', orderError.message);
    return fail('Could not start checkout', 500);
  }

  const res = await fetch(`${base}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: profile?.email, name: profile?.full_name },
      metadata: { order_id: order.id, package_code: pkg.code },
      // Returns to the Billing tab. The flag goes in the real query string,
      // before the hash: BillingTab reads window.location.search, and a
      // "?billing=" inside the hash is invisible to it.
      return_url: `${appOrigin}/?billing=returned#dashboard/billing`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[billing] checkout session failed:', res.status, body.slice(0, 300));
    // Leave the order abandoned rather than deleting it: if the provider did
    // charge and only the response failed, the webhook can still find it.
    return fail('Payment provider rejected the request', 502);
  }

  const session = await res.json();

  await admin
    .from('payment_orders')
    .update({
      provider_order_id: session?.id ?? null,
      checkout_url: session?.url ?? null,
      status: 'pending',
    })
    .eq('id', order.id);

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
  if (!data) return { __status: 404, ok: false, error: 'order_not_found' };

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
    // Actions return a body; a body carrying __status is sent with that status
    // rather than a blanket 200. An ok:false at HTTP 200 is indistinguishable
    // from success to any client that checks res.ok, which is how a customer
    // ends up sitting on a spinner waiting for a checkout that never opened.
    let result: any;
    let status = 200;

    switch (body?.action) {
      case 'balance':
        result = await actionBalance(admin, userId);
        break;
      case 'packages':
        result = await actionPackages(admin);
        break;
      case 'history':
        result = await actionHistory(admin, userId);
        break;
      case 'quote':
        result = await actionQuote(admin, userId, Array.isArray(body.channels) ? body.channels : []);
        break;
      case 'checkout':
        result = await actionCheckout(admin, req, userId, String(body.packageCode ?? ''));
        break;
      case 'status':
        result = await actionStatus(admin, userId, String(body.orderId ?? ''));
        break;
      default:
        return fail('Unknown action', 400);
    }

    if (typeof result?.__status === 'number') {
      status = result.__status;
      const { __status: _omit, ...clean } = result;
      return json(clean, status);
    }
    return json(result, status);
  } catch (err) {
    console.error('[billing] action failed:', (err as Error)?.message);
    return fail('Billing request failed', 500);
  }
});