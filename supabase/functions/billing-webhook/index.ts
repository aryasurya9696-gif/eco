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

/** Pulls the amount Dodo actually collected, if the payload carries one. */
function extractAmount(data: any): { gross?: number; fee?: number; net?: number } {
  const total = data?.total_amount ?? data?.amount;
  const fee = data?.fee_amount ?? data?.processing_fee ?? data?.fees;
  const gross = num(total);
  const feeNum = fee === undefined || fee === null ? null : num(fee);
  return {
    gross: gross || undefined,
    fee: feeNum === null ? undefined : feeNum,
    net: feeNum === null ? undefined : Math.max(gross - feeNum, 0),
  };
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
  // webhook_id is the actual replay guard: if a duplicate arrives, this insert
  // fails and we stop, rather than granting credits a second time.
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
    // 23505 = unique violation, i.e. this exact delivery was already seen.
    if (recordError.code === '23505') {
      console.warn(`[webhook] duplicate ${webhookId} (${eventType}) ignored`);
      return json({ ok: true, duplicate: true });
    }
    console.error('[webhook] could not record event:', recordError.message);
    return json({ ok: false, error: 'record_failed' }, 500);
  }

  try {
    const data = event?.data ?? {};

    if (eventType === 'payment.succeeded') {
      const providerRef = data?.payment_id ?? data?.id ?? null;

      // The order was created by our own checkout call, so match on the id we
      // were given. Falling back to the provider reference covers orders
      // created elsewhere.
      let orderId = data?.metadata?.order_id ?? null;
      if (!orderId && providerRef) {
        const { data: found } = await admin
          .from('payment_orders')
          .select('id')
          .eq('provider_order_id', providerRef)
          .maybeSingle();
        orderId = found?.id ?? null;
      }

      if (!orderId) {
        // A payment we have no order for. Recorded as ignored rather than
        // failed: retrying will not produce an order.
        await admin.from('webhook_events')
          .update({ status: 'ignored', last_error: 'no matching order' })
          .eq('webhook_id', webhookId);
        console.warn(`[webhook] ${eventType} with no matching order; provider ref ${providerRef}`);
        return json({ ok: true, matched: false });
      }

      const { data: settle, error: settleError } = await admin.rpc('wallet_topup_from_order', {
        p_order_id: orderId,
        p_fee_usd: extractAmount(data).fee ?? null,
        p_net_usd: extractAmount(data).net ?? null,
        p_provider_ref: providerRef,
        p_idempotency_key: `dodo:${webhookId}`,
      });

      if (settleError) throw new Error(`topup failed: ${settleError.message}`);

      await admin.from('webhook_events')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('webhook_id', webhookId);

      console.log(`[webhook] payment.settled order=${orderId} ${JSON.stringify(settle)}`);
      return json({ ok: true, settled: true });
    }

    if (eventType === 'refund.succeeded' || eventType === 'payment.refunded') {
      const providerRef = data?.payment_id ?? data?.id ?? null;
      let orderId = data?.metadata?.order_id ?? null;
      if (!orderId && providerRef) {
        const { data: found } = await admin
          .from('payment_orders')
          .select('id')
          .eq('provider_order_id', providerRef)
          .maybeSingle();
        orderId = found?.id ?? null;
      }

      if (orderId) {
        await admin.from('payment_orders').update({ status: 'refunded' }).eq('id', orderId);

        // Take back the unspent portion of whatever the purchase granted.
        // Credits already spent were consumed, so the service was delivered and
        // that money is not recoverable.
        const { data: grants } = await admin
          .from('credit_grants')
          .select('id')
          .eq('payment_order_id', orderId);

        for (const g of grants ?? []) {
          const { data: revoked, error } = await admin.rpc('wallet_revoke_grant', {
            p_grant_id: g.id,
            p_reason: 'refund',
          });
          if (error) console.error('[webhook] revoke failed:', error.message);
          else console.log(`[webhook] revoked grant ${g.id}: ${JSON.stringify(revoked)}`);
        }
      }

      await admin.from('webhook_events')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('webhook_id', webhookId);
      return json({ ok: true, refunded: true });
    }

    if (eventType === 'payment.failed' || eventType === 'dispute.created' || eventType === 'dispute.opened') {
      const providerRef = data?.payment_id ?? data?.id ?? null;
      if (providerRef) {
        await admin.from('payment_orders')
          .update({ status: 'failed' })
          .eq('provider_order_id', providerRef);
      }
      await admin.from('webhook_events')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('webhook_id', webhookId);
      return json({ ok: true });
    }

    // Recorded and acknowledged. An event type we do not act on yet should not
    // make the provider retry it eight times.
    await admin.from('webhook_events')
      .update({ status: 'ignored', last_error: `unhandled type ${eventType}` })
      .eq('webhook_id', webhookId);
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