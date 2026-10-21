// ============================================================================
// Supabase Edge Function: billing-webhook
// ----------------------------------------------------------------------------
// Receives Dodo Payments events and turns a confirmed payment into credits.
//
// This is the only path in the product that can add credits. That is the whole
// security model of a prepaid system: the browser cannot grant credits, the
// sweep functions cannot grant credits, and nothing can grant credits except a
// message from the payment provider that carries a signature we can verify. If
// this function is wrong, nobody gets free credits; they just stop getting
// credits at all, which is a much better failure.
//
// Verification follows the Standard Webhooks specification Dodo uses:
//
//   signed payload = "{webhook-id}.{webhook-timestamp}.{raw request body}"
//   secret          = the whsec_ key with the prefix stripped, base64-decoded
//   signature       = base64(HMAC-SHA256(signed payload, secret))
//   header          = space-separated "v1,<signature>" pairs
//
// Three checks, all of which have to pass:
//   1. at least one v1 signature matches, compared in constant time
//   2. the timestamp is within the replay window
//   3. the webhook id has not already been processed
//
// The third one matters because the provider retries, and retries can arrive
// hours apart and out of order. Recording the id before processing is what stops
// a redelivery of payment.succeeded from granting a second time.
//
// JWT verification is OFF. The provider has no Supabase session; the signature
// is the authentication, and adding a JWT check would reject every real event.
//
// Deploy:  supabase functions deploy billing-webhook --no-verify-jwt
// Secret:  DODO_PAYMENTS_WEBHOOK_KEY=whsec_...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Replays outside this window are refused even with a valid signature, so a
// captured request cannot be resent indefinitely.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

/** Dodo posts application/json; CORS headers are harmless and help local testing. */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, webhook-id, webhook-signature, webhook-timestamp',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/**
 * Constant-time comparison.
 *
 * Length is compared first, which is fine: the length of an HMAC is fixed and
 * public, so it leaks nothing an attacker could use. What matters is that the
 * loop does not stop early, because a comparison that returns as soon as it
 * finds a differing byte leaks the correct prefix one byte per attempt.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Verifies a Standard Webhooks signature.
 *
 * Returns a reason alongside the verdict rather than a bare boolean, because
 * "invalid" and "too old" are different bugs and a log that cannot tell them
 * apart is a log you will misread later. The shape is uniform rather than a
 * discriminated union so callers never have to narrow to read the reason.
 */
async function verifySignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): Promise<{ ok: boolean; reason: string }> {
  const webhookId = headers.get('webhook-id');
  const webhookTimestamp = headers.get('webhook-timestamp');
  const signatureHeader = headers.get('webhook-signature');

  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  // A signed timestamp from outside the window is a replay, whatever the
  // signature says. Checked before the HMAC so a stale replay cannot be used to
  // probe the comparison.
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  const age = Date.now() - ts * 1000;
  if (Math.abs(age) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_outside_window' };
  }

  // whsec_ is a marker, not part of the key. Stripping it is what the spec
  // requires; the remainder is standard base64.
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key: Uint8Array;
  try {
    key = base64ToBytes(raw);
  } catch {
    return { ok: false, reason: 'bad_secret_encoding' };
  }

  const expected = await hmacSha256(key, `${webhookId}.${webhookTimestamp}.${rawBody}`);

  // Several signatures may be present so a secret can be rotated without a gap.
  // Valid if ANY matches.
  const candidates = signatureHeader
    .split(' ')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1,'))
    .map((p) => p.slice(3));

  if (candidates.length === 0) return { ok: false, reason: 'no_v1_signature' };

  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) return { ok: true, reason: 'ok' };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Resolves the signing secret.
 *
 * The edge secret wins; otherwise it is read from public.service_secrets, which
 * has RLS on and no policies so the browser has no path to it. That fallback
 * matches how the treg token is handled elsewhere in this codebase and means the
 * secret can be rotated with a SQL statement rather than a redeploy.
 */
let webhookSecret = Deno.env.get('DODO_PAYMENTS_WEBHOOK_KEY') || '';

async function resolveSecret(admin: ReturnType<typeof createClient>): Promise<string> {
  if (webhookSecret) return webhookSecret;
  const { data, error } = await admin
    .from('service_secrets')
    .select('value')
    .eq('name', 'dodo_webhook_key')
    .maybeSingle();
  if (error) {
    console.error('[webhook] secret lookup failed:', error.message);
    return '';
  }
  webhookSecret = typeof data?.value === 'string' ? data.value : '';
  return webhookSecret;
}

// ISO 4217 minor-unit exponents that are not 2. Dodo sends amounts as integers
// in the currency's smallest unit, so 1000 is $10.00 but ¥1000.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function currencyExponent(currency: unknown): number {
  const c = String(currency ?? '').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Minor units -> major units. null stays null so "absent" is never read as 0. */
function toMajor(minor: unknown, currency: unknown): number | null {
  if (minor === undefined || minor === null || minor === '') return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** currencyExponent(currency);
}

/**
 * What Dodo actually collected, in major units of the payment currency.
 *
 * Passed to the database as-is: treating cents as dollars made a $10 payment
 * read as $1000 paid, which no amount check could ever catch.
 */
function extractAmount(data: any): { gross: number | null; fee: number | null; net: number | null; currency: string | null } {
  const currency = typeof data?.currency === 'string' ? data.currency.toUpperCase() : null;
  const gross = toMajor(data?.total_amount ?? data?.amount, currency);
  const fee = toMajor(data?.fee_amount ?? data?.processing_fee ?? data?.fees, currency);
  return {
    gross,
    fee,
    net: fee === null || gross === null ? null : Math.max(gross - fee, 0),
    currency,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Provider ids are interpolated into a PostgREST or() filter, where a comma or
// parenthesis would change the filter itself. Anything else is not an id.
const SAFE_REF_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface OrderRow {
  id: string;
  status: string;
  gross_usd: number;
  currency: string;
  refunded_usd: number;
}

const ORDER_COLUMNS = 'id, status, gross_usd, currency, refunded_usd';

/**
 * Finds the order an event is about.
 *
 * The metadata we put on the checkout session is the reliable join; the
 * provider ids are the fallback for events that do not echo metadata back
 * (refunds and disputes usually carry only payment_id). A metadata id that is
 * not a real order falls through to the refs rather than being trusted.
 */
async function findOrder(admin: ReturnType<typeof createClient>, data: any): Promise<OrderRow | null> {
  const metaId = data?.metadata?.order_id;
  if (typeof metaId === 'string' && UUID_RE.test(metaId)) {
    const { data: row, error } = await admin
      .from('payment_orders').select(ORDER_COLUMNS).eq('id', metaId).maybeSingle();
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    if (row) return row as unknown as OrderRow;
  }

  const refs = [data?.payment_id, data?.id]
    .filter((r): r is string => typeof r === 'string' && SAFE_REF_RE.test(r));
  for (const ref of refs) {
    const { data: found, error } = await admin
      .from('payment_orders')
      .select(ORDER_COLUMNS)
      .or(`provider_order_id.eq.${ref},provider_ref.eq.${ref}`)
      .limit(1);
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    if (found?.[0]) return found[0] as unknown as OrderRow;
  }
  return null;
}

/**
 * Revokes credits from every grant an order produced.
 *
 * `fraction` of each grant's ORIGINAL credits (1 = everything left). Each
 * revocation is tagged with `reason`, and a grant that already has a ledger
 * row with that tag is skipped — so a retried webhook that half-finished
 * the first time does not take the same refund twice.
 */
async function revokeOrderGrants(
  admin: ReturnType<typeof createClient>,
  orderId: string,
  reason: string,
  fraction: number | null,
): Promise<{ failures: number; revoked: number }> {
  const { data: grants, error } = await admin
    .from('credit_grants')
    .select('id, credits')
    .eq('payment_order_id', orderId);
  if (error) throw new Error(`grant lookup failed: ${error.message}`);

  let failures = 0;
  let revoked = 0;
  for (const g of grants ?? []) {
    const { count: already } = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('grant_id', g.id)
      .eq('note', reason);
    if ((already ?? 0) > 0) continue;

    const { data: out, error: revokeError } = await admin.rpc('wallet_revoke_grant', {
      p_grant_id: g.id,
      p_reason: reason,
      p_credits: fraction === null ? null : num(g.credits) * fraction,
    });
    if (revokeError || out?.ok === false) {
      failures++;
      console.error('[webhook] revoke failed:', revokeError?.message ?? out?.error);
    } else {
      revoked += num(out?.revoked);
    }
  }
  return { failures, revoked };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const secret = await resolveSecret(admin);
  if (!secret) {
    console.error('[webhook] no signing secret configured - refusing');
    return json({ ok: false, error: 'not_configured' }, 503);
  }

  // The raw body is required. Verifying against a re-serialised object would
  // change the bytes and the signature would never match.
  const rawBody = await req.text();

  const verified = await verifySignature(rawBody, req.headers, secret);
  if (!verified.ok) {
    // Logged without the body: the payload can carry customer details, and a
    // rejected request is exactly the one someone might later try to replay.
    console.warn(`[webhook] rejected: ${verified.reason}`);
    return json({ ok: false, error: 'invalid_signature' }, 401);
  }

  const webhookId = req.headers.get('webhook-id')!;
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const eventType = String(event?.type ?? 'unknown');

  // Record the delivery before acting on it. The unique constraint on
  // webhook_id is what makes a redelivery recognisable as one.
  //
  // A duplicate is not automatically "already handled". The first attempt
  // inserts the row and only then processes, so a delivery that failed
  // afterwards is still sitting here in 'received' or 'failed' — and the
  // payment provider will retry it, which is the only way that customer ever
  // gets their credits. Short-circuiting on the duplicate used to swallow
  // every retry, so a transient failure turned into "paid, no credits, and the
  // provider was told 200".
  const { error: recordError } = await admin
    .from('webhook_events')
    .insert({
      provider: 'dodo',
      webhook_id: webhookId,
      event_type: eventType,
      payload: event,
      status: 'received',
      attempts: 1,
    });

  if (recordError) {
    if (recordError.code === '23505') {
      // Already seen. Reprocess only if the earlier attempt did not finish.
      const { data: prior } = await admin
        .from('webhook_events')
        .select('status, attempts')
        .eq('webhook_id', webhookId)
        .maybeSingle();

      if (prior?.status === 'processed' || prior?.status === 'ignored') {
        console.log(`[webhook] ${webhookId} (${eventType}) already ${prior.status} - ignoring`);
        return json({ ok: true, duplicate: true, status: prior.status });
      }

      await admin.from('webhook_events')
        .update({ status: 'received', attempts: (prior?.attempts ?? 1) + 1 })
        .eq('webhook_id', webhookId);
      console.warn(`[webhook] ${webhookId} retrying after prior ${prior?.status ?? 'unknown'}`);
      // Falls through to processing.
    } else {
      console.error('[webhook] could not record event:', recordError.message);
      return json({ ok: false, error: 'record_failed' }, 500);
    }
  }

  // One place that closes out the delivery record, so every branch reports
  // the same way.
  const markEvent = (status: 'processed' | 'failed' | 'ignored', lastError: string | null = null) =>
    admin.from('webhook_events')
      .update({
        status,
        last_error: lastError,
        processed_at: status === 'processed' ? new Date().toISOString() : null,
      })
      .eq('webhook_id', webhookId);

  try {
    const data = event?.data ?? {};
    const providerRef: string | null = data?.payment_id ?? data?.id ?? null;

    if (eventType === 'payment.succeeded') {
      // The reliable join is the metadata we put on the checkout session
      // ourselves. The alternative — matching provider_order_id against the
      // payment id — compares two different identifiers, because checkout stored
      // a checkout-session id there, and could therefore never match. Both are
      // tried; the metadata is simply the one that works.
      const order = await findOrder(admin, data);

      if (!order) {
        // A payment we have no order for. Recorded as ignored rather than
        // failed: retrying will not produce an order.
        await markEvent('ignored', 'no matching order');
        console.warn(`[webhook] ${eventType} with no matching order; provider ref ${providerRef}`);
        return json({ ok: true, matched: false });
      }

      const amount = extractAmount(data);
      const { data: settle, error: settleError } = await admin.rpc('wallet_topup_from_order', {
        p_order_id: order.id,
        p_fee_usd: amount.fee,
        p_net_usd: amount.net,
        p_provider_ref: providerRef,
        p_idempotency_key: `dodo:${webhookId}`,
        p_paid_usd: amount.gross,
        p_paid_currency: amount.currency,
      });

      if (settleError) throw new Error(`topup failed: ${settleError.message}`);

      if (settle?.ok === false) {
        if (settle.error === 'amount_mismatch' || settle.error === 'currency_mismatch') {
          // The database has parked the order in 'review'. Retrying cannot
          // change what was paid, so this is final for the webhook: processed,
          // with the reason kept for whoever reviews it.
          await markEvent('processed', `review: ${settle.error}`);
          console.error(
            `[webhook] order ${order.id} held for review: ${settle.error} ` +
            `(paid ${amount.gross} ${amount.currency}, expected ${order.gross_usd} ${order.currency})`,
          );
          return json({ ok: true, settled: false, review: settle.error });
        }
        // Anything else (missing package, zero-credit package) is a config
        // problem a retry can succeed after, once someone fixes it.
        throw new Error(`topup refused: ${settle.error}`);
      }

      await markEvent('processed');
      console.log(`[webhook] payment.settled order=${order.id} ${JSON.stringify(settle)}`);
      return json({ ok: true, settled: true });
    }

    if (eventType === 'refund.succeeded' || eventType === 'payment.refunded') {
      const order = await findOrder(admin, data);

      if (!order) {
        // Not "processed": a refund we cannot attach to an order means money
        // went back and credits may not have. Failed, so it shows up for a
        // human. Answered 200 because a provider retry cannot produce the order.
        await markEvent('failed', 'refund_order_not_found');
        console.error(`[webhook] ${eventType} with no matching order; provider ref ${providerRef}`);
        return json({ ok: false, error: 'refund_order_not_found' });
      }

      const gross = num(order.gross_usd);
      const alreadyRefunded = num(order.refunded_usd);
      // A refund event carries its own amount; a payment.refunded carries the
      // payment, whose total is the whole order. If neither is present the
      // remainder is assumed — over-revoking a refunded customer is the
      // recoverable direction.
      const refundCurrency = data?.currency ?? order.currency;
      let refundAmount = eventType === 'refund.succeeded'
        ? toMajor(data?.amount ?? data?.refund_amount, refundCurrency)
        : toMajor(data?.refund_amount ?? data?.total_amount, refundCurrency);
      if (refundAmount === null) {
        console.warn(`[webhook] ${eventType} for order ${order.id} has no amount; treating as full refund`);
        refundAmount = Math.max(gross - alreadyRefunded, 0);
      }
      if (data?.currency && String(data.currency).toUpperCase() !== String(order.currency).toUpperCase()) {
        console.warn(`[webhook] refund currency ${data.currency} differs from order currency ${order.currency}`);
      }

      // Revoke the same share of each grant's original credits as the share of
      // the order that was refunded. A $5 refund on a $20 pack takes a quarter,
      // not the whole pack.
      const fraction = gross > 0 ? Math.min(refundAmount / gross, 1) : 1;

      // Revoke before marking the order refunded, and treat a failure as a
      // failure. Doing it the other way round meant a revoke that errored left
      // the order looking refunded with the credits still there.
      const { failures } = await revokeOrderGrants(admin, order.id, `refund:${webhookId}`, fraction);
      if (failures > 0) {
        // 500 so the provider retries, and the order is left untouched so a
        // human can see it still needs finishing.
        await markEvent('failed', `${failures} grant revocation(s) failed`);
        return json({ ok: false, error: 'revoke_failed' }, 500);
      }

      const refundedTotal = Math.min(alreadyRefunded + refundAmount, gross);
      const { error: orderError } = await admin.from('payment_orders')
        .update({
          refunded_usd: refundedTotal,
          status: refundedTotal + 0.005 >= gross ? 'refunded' : 'partially_refunded',
        })
        .eq('id', order.id);
      if (orderError) throw new Error(`order update failed: ${orderError.message}`);

      await markEvent('processed');
      console.log(`[webhook] refund order=${order.id} amount=${refundAmount} total=${refundedTotal}/${gross}`);
      return json({ ok: true, refunded: true, fraction });
    }

    if (eventType === 'payment.failed') {
      const order = await findOrder(admin, data);
      if (order) {
        // Only an order still waiting can fail. A late or out-of-order
        // payment.failed must not overwrite an order that already settled.
        const { error } = await admin.from('payment_orders')
          .update({ status: 'failed' })
          .eq('id', order.id)
          .in('status', ['created', 'pending']);
        if (error) throw new Error(`order update failed: ${error.message}`);
      }
      await markEvent('processed', order ? null : 'no matching order');
      return json({ ok: true, matched: !!order });
    }

    if (eventType === 'dispute.opened' || eventType === 'dispute.created') {
      const order = await findOrder(admin, data);
      if (!order) {
        await markEvent('ignored', 'no matching order');
        console.warn(`[webhook] ${eventType} with no matching order; provider ref ${providerRef}`);
        return json({ ok: true, matched: false });
      }

      // Freeze: the money is contested, so the unspent credits it bought stop
      // being spendable now rather than after the dispute is decided.
      const { failures, revoked } = await revokeOrderGrants(admin, order.id, `dispute:${order.id}`, null);
      if (failures > 0) {
        await markEvent('failed', `${failures} grant revocation(s) failed`);
        return json({ ok: false, error: 'revoke_failed' }, 500);
      }

      const { error } = await admin.from('payment_orders')
        .update({ status: 'disputed' })
        .eq('id', order.id);
      if (error) throw new Error(`order update failed: ${error.message}`);

      await markEvent('processed');
      console.warn(`[webhook] dispute opened order=${order.id}; froze ${revoked} credits`);
      return json({ ok: true, disputed: true });
    }

    if (eventType === 'dispute.won') {
      const order = await findOrder(admin, data);
      if (order && order.status === 'disputed') {
        const { error } = await admin.from('payment_orders')
          .update({ status: 'succeeded' })
          .eq('id', order.id);
        if (error) throw new Error(`order update failed: ${error.message}`);
        // Deliberately not automatic: a re-grant creates credits, and this
        // webhook only creates credits on payment.succeeded.
        console.warn(`[webhook] dispute won order=${order.id}; frozen credits are NOT re-granted automatically - restore manually`);
      }
      await markEvent('processed', order ? null : 'no matching order');
      return json({ ok: true, matched: !!order });
    }

    if (eventType === 'dispute.lost' || eventType === 'dispute.accepted') {
      const order = await findOrder(admin, data);
      if (order) {
        // Anything that became spendable since the freeze (a hold released) is
        // taken too. Credits a grant no longer has are simply not taken.
        const { failures } = await revokeOrderGrants(admin, order.id, 'dispute_lost', null);
        if (failures > 0) {
          await markEvent('failed', `${failures} grant revocation(s) failed`);
          return json({ ok: false, error: 'revoke_failed' }, 500);
        }
        const { error } = await admin.from('payment_orders')
          .update({ status: 'refunded', refunded_usd: num(order.gross_usd) })
          .eq('id', order.id);
        if (error) throw new Error(`order update failed: ${error.message}`);
        console.warn(`[webhook] dispute lost order=${order.id}`);
      }
      await markEvent('processed', order ? null : 'no matching order');
      return json({ ok: true, matched: !!order });
    }

    // Recorded and acknowledged. An event type we do not act on yet should not
    // make the provider retry it eight times.
    await markEvent('ignored', `unhandled type ${eventType}`);
    console.log(`[webhook] ignored ${eventType}`);
    return json({ ok: true, ignored: true });
  } catch (err) {
    console.error('[webhook] processing failed:', (err as Error)?.message);
    // Left in 'received' so a provider retry reprocesses it. Marking it failed
    // and returning 200 would silently drop a real payment.
    await admin.from('webhook_events')
      .update({ status: 'failed', last_error: String((err as Error)?.message ?? err).slice(0, 500) })
      .eq('webhook_id', webhookId);
    return json({ ok: false, error: 'processing_failed' }, 500);
  }
});