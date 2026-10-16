// ============================================================================
// Supabase Edge Function: billing
// ----------------------------------------------------------------------------
// Credit top-ups, subscription checkout, and the admin pricing surface.
//
// A top-up is NOT profit. It is cash collected against search that has not been
// delivered yet. This function records the payment and the fee, converts the net
// cash into credits at the configured rate, and hands the grant to
// public.grant_credits() with a unit price of net / credits. That unit price is
// what makes revenue recognition honest: nothing is booked as earned until the
// credits are actually spent, and the remainder is carried as deferred revenue.
//
// SETTLEMENT LIVES IN THE WEBHOOK, NOT HERE
// This function only creates a Checkout session. Credits are granted when
// Stripe says the money arrived, because a session that is created but never
// completed must not produce balance. The webhook is idempotent on the Stripe
// session id, so Stripe's at-least-once redelivery cannot double-credit.
//
// NOTE: this file is intentionally SELF-CONTAINED. Do not split shared helpers
// into an underscore-prefixed folder — Supabase's bundler skips `_`-prefixed
// directories and the relative import fails to resolve on deploy.
//
// Deploy:  supabase functions deploy billing --no-verify-jwt
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_...
//          supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//          supabase secrets set APP_ORIGIN=https://your-app.example
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

// ---------------------------------------------------------------------------
// HMAC-SHA256, for verifying the Stripe webhook signature
// ---------------------------------------------------------------------------
// Web Crypto is already available in Deno, so there is no reason to trust a
// shared secret in a header or to skip the signature check entirely.

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return new Uint8Array(sig);
}

/** Constant-time compare so a signature cannot be recovered by timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  if (!parts.t || !parts.v1) return false;

  const expected = await hmacSha256(secret, `${parts.t}.${rawBody}`);

  // Every v1 candidate must be checked; Stripe sends several during a secret
  // rotation and accepting any one of them is the point.
  return sigHeader
    .split(',')
    .map((kv) => kv.trim())
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => timingSafeEqual(hexToBytes(kv.slice(3)), expected));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Turns a completed Checkout session into a payment row plus a credit grant.
 *
 * Idempotent on provider_ref: the unique index on payments.provider_ref turns a
 * redelivered webhook into a no-op rather than a second grant. The credit grant
 * carries the same session id as its idempotency key, so even a crash between
 * the two writes cannot allocate twice on retry.
 */
async function settleCheckoutSession(
  admin: ReturnType<typeof createClient>,
  session: any,
  origin: string,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const userId = session.metadata?.user_id;
  const kind = session.metadata?.kind;
  if (typeof userId !== 'string' || (kind !== 'topup' && kind !== 'subscription')) {
    return { ok: false, error: 'session is missing its metadata' };
  }

  const grossUsd = (session.amount_total ?? 0) / 100;

  // Stripe does not hand the fee back on the session. Balance transactions are
  // the authoritative source; when they are not readable yet, fall back to the
  // published card rate so the fee is at least recorded rather than assumed away.
  let feeUsd: number;
  try {
    const txn = await stripeRequest(
      Deno.env.get('STRIPE_SECRET_KEY')!,
      `/balance_transactions/${session.payment_intent}`,
      {},
      'GET',
    );
    feeUsd = Math.abs(txn?.fee ?? 0) / 100;
  } catch {
    feeUsd = grossUsd * 0.029 + 0.3;
  }

  const netUsd = Math.max(0, grossUsd - feeUsd);

  const idempotencyKey = `stripe:${kind}:${session.id}`;
  const period = new Date().toISOString().slice(0, 7);

  const { data: payment, error: payErr } = await admin
    .from('payments')
    .insert({
      user_id: userId,
      provider: 'stripe',
      provider_ref: session.id,
      kind,
      status: 'succeeded',
      gross_usd: grossUsd,
      fee_usd: feeUsd,
      net_usd: netUsd,
      credits_granted: 0,
      idempotency_key: idempotencyKey,
      provider_payment_intent:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
      settled_at: new Date().toISOString(),
      note: session.metadata?.package_id ?? null,
    })
    .select('id')
    .single();

  if (payErr) {
    // 23505 is the unique violation on provider_ref, i.e. a redelivery.
    if (payErr.code === '23505') return { ok: true, duplicate: true };
    return { ok: false, error: payErr.message };
  }

  const paymentId = payment?.id;

  if (kind === 'topup') {
    const { data: cfgRows } = await admin
      .from('billing_config')
      .select('value')
      .eq('key', 'credit_rate')
      .maybeSingle();
    const rate = Number(cfgRows?.value?.credits_per_usd ?? 20);

    const bonus = Number(session.metadata?.bonus_credits ?? 0);
    const paidCredits = Math.round(netUsd * rate * 100) / 100;
    const totalCredits = paidCredits + bonus;

    if (totalCredits <= 0) {
      return { ok: true, duplicate: false };
    }

    // The bonus is funded out of margin, so it carries no revenue of its own.
    // Valuing it at zero keeps it from inflating recognised revenue later.
    const bonusValue = totalCredits > 0 ? (bonus / totalCredits) * netUsd : 0;
    const paidValue = netUsd - bonusValue;
    const paidShare = paidCredits / totalCredits;

    const { error: grantErr } = await admin.rpc('grant_credits', {
      p_user_id: userId,
      p_credits: totalCredits,
      p_source: bonus > 0 ? 'bonus' : 'topup',
      p_unit_price_usd: paidShare > 0 ? paidValue / paidCredits : 0,
      p_payment_id: paymentId,
      p_kind: bonus > 0 ? 'bonus' : 'topup',
      p_idempotency_key: idempotencyKey,
      p_note: session.metadata?.package_id ?? null,
    });
    if (grantErr) return { ok: false, error: grantErr.message };

    await admin
      .from('payments')
      .update({ credits_granted: totalCredits })
      .eq('id', paymentId);
  } else {
    // Subscription: activate the plan and grant the month's allowance. The plan
    // price is revenue on delivery, not on grant, so it is tracked here only as
    // a payment and the allowance carries no unit price.
    const planId = session.metadata?.plan_id;
    if (isKeyOf(PLANS, planId)) {
      await admin.rpc('apply_subscription_plan', {
        p_user_id: userId,
        p_plan: planId,
        p_interval: session.metadata?.interval === 'year' ? 'year' : 'month',
        p_renews_at: null,
      });
    }

    const { data: prof } = await admin
      .from('profiles')
      .select('subscription_plan')
      .eq('id', userId)
      .maybeSingle();

    const { data: grantRows } = await admin
      .from('billing_config')
      .select('value')
      .eq('key', 'plan_grants')
      .maybeSingle();
    const allowance = Number(grantRows?.value?.[prof?.subscription_plan ?? 'starter'] ?? 1200);

    const { error: grantErr } = await admin.rpc('grant_credits', {
      p_user_id: userId,
      p_credits: allowance,
      p_source: 'subscription',
      // A subscription is prepaid for a period of service, so its allowance
      // recognises revenue as it is used, exactly like a top-up.
      p_unit_price_usd: netUsd / allowance,
      p_payment_id: paymentId,
      p_kind: 'subscription_grant',
      p_period: period,
      p_idempotency_key: idempotencyKey,
      p_note: 'Monthly plan allowance',
    });
    if (grantErr) return { ok: false, error: grantErr.message };

    await admin
      .from('payments')
      .update({ credits_granted: allowance })
      .eq('id', paymentId);
  }

  return { ok: true, duplicate: false };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });

  // ---- webhook: no JWT, identity comes from the verified signature --------
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/webhook')) {
    const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      console.error('[billing] STRIPE_WEBHOOK_SECRET is not configured.');
      return fail('Webhook is not configured', 503);
    }

    const rawBody = await req.text();
    if (!(await verifyStripeSignature(rawBody, req.headers.get('stripe-signature'), secret))) {
      return fail('Invalid signature', 400);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return fail('Malformed event', 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data?.object;
          if (session?.payment_status === 'paid') {
            const r = await settleCheckoutSession(admin, session, Deno.env.get('APP_ORIGIN') || '');
            if (!r.ok) {
              console.error('[billing] settlement failed:', r.error);
              return fail('Settlement failed', 500);
            }
          }
          break;
        }
        case 'charge.refunded': {
          const charge = event.data?.object;
          const intent =
            typeof charge?.payment_intent === 'string' ? charge.payment_intent : null;
          if (!intent) break;

          const { data: original } = await admin
            .from('payments')
            .select('id, user_id, gross_usd, status')
            .eq('provider_payment_intent', intent)
            .eq('kind', 'topup')
            .maybeSingle();

          // Already handled: Stripe redelivers, and a second pass must not
          // revoke the credits twice.
          if (!original || original.status === 'refunded') break;

          // Take back the credits this payment never spent. Anything already
          // consumed bought search that has been delivered, so it stays spent.
          const { data: grants } = await admin
            .from('credit_grants')
            .select('id')
            .eq('payment_id', original.id)
            .gt('credits_remaining', 0);

          for (const grant of grants ?? []) {
            await admin.rpc('revoke_grant_credits', {
              p_grant_id: grant.id,
              p_note: 'Refunded top-up',
            });
          }

          await admin
            .from('payments')
            .update({ status: 'refunded' })
            .eq('id', original.id);

          // Recorded as its own row so the revenue totals subtract refunds
          // explicitly instead of relying on the original row's status alone.
          await admin.from('payments').insert({
            user_id: original.user_id,
            provider: 'stripe',
            provider_ref: `re:${charge.id}`,
            provider_payment_intent: intent,
            kind: 'refund',
            status: 'succeeded',
            gross_usd: original.gross_usd,
            fee_usd: 0,
            net_usd: 0,
            idempotency_key: `stripe:refund:${charge.id}`,
            note: 'Top-up refunded',
          });

          break;
        }
        default:
          // Acknowledged and ignored on purpose. Returning 200 for events we do
          // not handle stops Stripe retrying them forever.
          break;
      }
    } catch (err) {
      console.error('[billing] webhook handler threw:', err);
      return fail('Handler error', 500);
    }

    return json({ received: true });
  }

  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const userId = await requireUserId(req);
  if (!userId) return fail('Unauthorized', 401);

  if (!rateLimit('billing:' + userId, 30, 60 * 60 * 1000)) {
    return fail('Too many billing requests. Please try again later.', 429);
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

  // ---- pricing is readable without Stripe, so the UI can render ----------
  if (body?.action === 'pricing') {
    const { data } = await admin
      .from('billing_config')
      .select('key, value')
      .in('key', ['credit_rate', 'operation_pricing', 'plan_grants', 'topup_packages']);
    const config = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
    return json({ ok: true, config });
  }

  // ---- balance ------------------------------------------------------------
  if (body?.action === 'balance') {
    const { data: profile } = await admin
      .from('profiles')
      .select('credit_balance, credit_recognized_usd, subscription_plan')
      .eq('id', userId)
      .maybeSingle();
    return json({
      ok: true,
      balance: Number(profile?.credit_balance ?? 0),
      recognisedUsd: Number(profile?.credit_recognized_usd ?? 0),
      plan: profile?.subscription_plan ?? 'starter',
    });
  }

  // ---- history ------------------------------------------------------------
  if (body?.action === 'history') {
    const [ledger, payments] = await Promise.all([
      admin
        .from('credit_ledger')
        .select('id, delta, balance_after, kind, source, revenue_usd, service_cost_usd, note, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50),
      admin
        .from('payments')
        .select('id, kind, status, gross_usd, fee_usd, net_usd, credits_granted, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(25),
    ]);
    return json({
      ok: true,
      ledger: ledger.data ?? [],
      payments: payments.data ?? [],
    });
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) {
    return fail(
      'Payments are not configured on this deployment. Plan changes and top-ups are unavailable.',
      503,
    );
  }

  // ---- start a checkout ---------------------------------------------------
  if (body?.action === 'topup') {
    const { data: pkgRows } = await admin
      .from('billing_config')
      .select('value')
      .eq('key', 'topup_packages')
      .maybeSingle();
    const packages: any[] = pkgRows?.value ?? [];
    const pkg = packages.find((p) => p.id === body.packageId);
    if (!pkg) return fail('Unknown top-up package');

    const cents = Math.round(Number(pkg.usd) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return fail('Invalid package');

    try {
      const session = await stripeRequest(stripeKey, '/checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': `Echo credits — ${pkg.label}`,
        'line_items[0][quantity]': '1',
        client_reference_id: userId,
        'metadata[user_id]': userId,
        'metadata[kind]': 'topup',
        'metadata[package_id]': pkg.id,
        'metadata[bonus_credits]': String(pkg.bonus_credits ?? 0),
        success_url: `${origin}/#/dashboard/billing?topup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/#/dashboard/billing?topup=cancelled`,
      });

      return json({ ok: true, checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      console.error('[billing] could not start top-up:', err);
      return fail('Could not start checkout. Please try again.', 502);
    }
  }

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
        'metadata[kind]': 'subscription',
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

  // ---- confirm a completed session ----------------------------------------
  // Kept for the browser's benefit so the UI can refresh immediately after a
  // redirect. Settlement still happens in the webhook; this only reads back what
  // Stripe already recorded, so it cannot grant credits a second time.
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

  if (session.metadata?.user_id !== userId) {
    return fail('Checkout session does not belong to this account.', 403);
  }

  const settled = await settleCheckoutSession(admin, session, origin);
  if (!settled.ok) {
    return fail('Payment received, but credits could not be applied. Contact support.', 500);
  }

  return json({ ok: true, settled: true, duplicate: settled.duplicate === true });
});
