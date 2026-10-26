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

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';

/** The service-role client. Untyped schema: rows are checked where they are read. */
type Db = SupabaseClient<any, 'public', any>;

// Replays outside this window are refused even with a valid signature, so a
// captured request cannot be resent indefinitely.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

// No CORS headers: this endpoint is called server-to-server by Dodo, never by
// a browser, so there is no origin to allow (it used to answer "*").
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

async function resolveSecret(admin: Db): Promise<string> {
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
async function findOrder(admin: Db, data: any): Promise<OrderRow | null> {
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
 * The refund's own id, so a redelivery (or a second event about the same
 * refund) is recognised by the database. refund.succeeded carries the refund
 * object itself; anything else only counts when it names a refund explicitly.
 */
function refundIdOf(eventType: string, data: any): string | null {
  const explicit = data?.refund_id ?? data?.refund?.refund_id ?? data?.refund?.id;
  if (typeof explicit === 'string' && explicit) return explicit.slice(0, 128);
  if (eventType === 'refund.succeeded' && typeof data?.id === 'string' && data.id) return data.id.slice(0, 128);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
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

  // Claim the delivery before acting on it (H7). webhook_claim inserts the row
  // or, for a redelivery, takes it under a row lock: a delivery that already
  // finished is answered as a duplicate, one that another invocation is
  // processing right now is refused with 409 (the provider retries later), and
  // one whose earlier attempt failed or crashed is reprocessed — the provider's
  // retry is the only way that customer ever gets their credits.
  const { data: claim, error: claimError } = await admin.rpc('webhook_claim', {
    p_provider: 'dodo',
    p_webhook_id: webhookId,
    p_event_type: eventType,
    p_payload: event,
  });
  if (claimError) {
    console.error('[webhook] could not record event:', claimError.message);
    return json({ ok: false, error: 'record_failed' }, 500);
  }
  if (claim?.claimed !== true) {
    if (claim?.in_flight) {
      console.warn(`[webhook] ${webhookId} (${eventType}) is being processed by another invocation`);
      return json({ ok: false, error: 'in_flight' }, 409);
    }
    console.log(`[webhook] ${webhookId} (${eventType}) already ${claim?.status} - ignoring`);
    return json({ ok: true, duplicate: true, status: claim?.status ?? null });
  }
  if (claim?.first === false) {
    console.warn(`[webhook] ${webhookId} retrying after prior ${claim?.prior_status ?? 'unknown'}`);
  }

  // One place that closes out the delivery record, so every branch reports
  // the same way.
  const markEvent = (status: 'processed' | 'failed' | 'ignored', lastError: string | null = null) =>
    admin.from('webhook_events')
      .update({
        status,
        last_error: lastError,
        claimed_at: null,
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
        if (settle.error === 'amount_mismatch' || settle.error === 'currency_mismatch' || settle.error === 'account_deleted') {
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
        if (settle.error === 'order_not_grantable') {
          // The order was refunded or disputed (possibly before this payment
          // event arrived). Granting now would hand out credits for money that
          // went back, and a retry cannot change that, so this is final.
          await markEvent('processed', `not granted: order ${settle.status}`);
          console.warn(`[webhook] payment event for ${settle.status} order ${order.id}; no credits granted`);
          return json({ ok: true, settled: false, not_grantable: settle.status });
        }
        // Anything else (missing package, zero-credit package) is a config
        // problem a retry can succeed after, once someone fixes it.
        throw new Error(`topup refused: ${settle.error}`);
      }

      await markEvent('processed');
      console.log(`[webhook] payment.settled order=${order.id} duplicate=${settle?.duplicate === true} credits=${settle?.credits_granted ?? 0}`);
      return json({ ok: true, settled: true });
    }

    if (eventType === 'refund.succeeded' || eventType === 'payment.refunded') {
      const order = await findOrder(admin, data);

      if (!order) {
        // Usually the refund arrived before payment.succeeded: refunds carry
        // only the payment id, which is stored on the order when the payment
        // event is processed. Left for a retry (not acknowledged), so it is
        // applied once the order can be found instead of being lost while the
        // late payment grants the full package.
        console.error(`[webhook] ${eventType} with no matching order yet; provider ref ${providerRef}; asking for a retry`);
        throw new Error('refund_order_not_found');
      }

      // A refund event carries its own amount (incremental); a payment.refunded
      // carries the payment, whose refunded total is cumulative. The database
      // records each refund once per (order, refund id), takes the larger of
      // "sum of refunds" and "largest cumulative total", revokes the matching
      // share of the order's credits under the key refund:<order>:<refund id>,
      // and updates the order — all in one transaction. A refund in another
      // currency is parked in 'review' instead of being guessed at.
      const cumulative = eventType === 'payment.refunded';
      const refundCurrency = typeof data?.currency === 'string' ? data.currency.toUpperCase() : null;
      // No fallback to the payment total: a partial refund whose amount is
      // missing must not revoke the whole order.
      const rawAmount = cumulative ? (data?.refund_amount ?? data?.total_refunded) : (data?.amount ?? data?.refund_amount);
      if (rawAmount === undefined || rawAmount === null) {
        const { error: parkError } = await admin
          .from('payment_orders')
          .update({ status: 'review', review_reason: `refund_amount_unknown: ${eventType} ${webhookId}` })
          .eq('id', order.id);
        if (parkError) throw new Error(`order update failed: ${parkError.message}`);
        await markEvent('processed', 'review: refund amount unknown');
        console.error(`[webhook] ${eventType} on order ${order.id} carries no refund amount; parked for review`);
        return json({ ok: true, refunded: false, review: 'refund_amount_unknown' });
      }
      const refundAmount = toMajor(rawAmount, refundCurrency ?? order.currency);
      const refundId = refundIdOf(eventType, data) ?? (cumulative ? null : `webhook:${webhookId}`);

      const { data: out, error: refundError } = await admin.rpc('wallet_refund_order', {
        p_order_id: order.id,
        p_refund_id: refundId,
        p_amount: refundAmount,
        p_currency: refundCurrency,
        p_cumulative: cumulative,
        p_webhook_id: webhookId,
      });
      if (refundError) throw new Error(`refund failed: ${refundError.message}`);

      if (out?.ok === false) {
        if (out.error === 'currency_mismatch') {
          // Final for the webhook: a retry cannot change the currency.
          await markEvent('processed', 'review: refund currency_mismatch');
          console.error(`[webhook] refund on order ${order.id} in ${refundCurrency} parked for review (order ${order.currency})`);
          return json({ ok: true, refunded: false, review: 'currency_mismatch' });
        }
        throw new Error(`refund refused: ${out.error}`);
      }

      await markEvent('processed', out?.duplicate ? 'duplicate refund' : null);
      console.log(`[webhook] refund order=${order.id} key=${out?.refund_key ?? '-'} duplicate=${out?.duplicate === true} total=${out?.refunded_usd}`);
      return json({ ok: true, refunded: true, duplicate: out?.duplicate === true, fraction: out?.fraction ?? 0 });
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
        // As with refunds: most likely ahead of payment.succeeded. Retried so
        // the freeze is applied once the order can be found.
        console.warn(`[webhook] ${eventType} with no matching order yet; provider ref ${providerRef}; asking for a retry`);
        throw new Error('dispute_order_not_found');
      }

      // Freeze: the money is contested, so the unspent credits it bought stop
      // being spendable now rather than after the dispute is decided. One
      // atomic call; revokes are keyed per order, stage and grant.
      const { data: out, error } = await admin.rpc('wallet_dispute_order', {
        p_order_id: order.id,
        p_stage: 'opened',
      });
      if (error || out?.ok === false) throw new Error(`dispute freeze failed: ${error?.message ?? out?.error}`);

      await markEvent('processed');
      console.warn(`[webhook] dispute opened order=${order.id}; froze ${num(out?.revoked)} credits`);
      return json({ ok: true, disputed: true });
    }

    // Cancelled and expired disputes end like a won one: the merchant keeps the
    // money, so the order is released from 'disputed' and nothing more is owed.
    if (eventType === 'dispute.won' || eventType === 'dispute.cancelled' || eventType === 'dispute.expired') {
      const order = await findOrder(admin, data);
      if (order && order.status === 'disputed') {
        const { data: out, error } = await admin.rpc('wallet_dispute_order', {
          p_order_id: order.id,
          p_stage: 'won',
        });
        if (error || out?.ok === false) throw new Error(`dispute update failed: ${error?.message ?? out?.error}`);
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
        // taken too, and the order is marked refunded, in one transaction.
        const { data: out, error } = await admin.rpc('wallet_dispute_order', {
          p_order_id: order.id,
          p_stage: 'lost',
        });
        if (error || out?.ok === false) throw new Error(`dispute revoke failed: ${error?.message ?? out?.error}`);
        console.warn(`[webhook] dispute lost order=${order.id}; revoked ${num(out?.revoked)} more credits`);
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
      .update({ status: 'failed', claimed_at: null, last_error: String((err as Error)?.message ?? err).slice(0, 500) })
      .eq('webhook_id', webhookId);
    return json({ ok: false, error: 'processing_failed' }, 500);
  }
});