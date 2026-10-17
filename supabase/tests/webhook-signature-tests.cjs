// Signature verification tests, run against the DEPLOYED billing-webhook.
//
// These are not unit tests of a copy of the logic. They send real HTTP requests
// to the live function, so what passes here is the code that would process a
// real payment. The one thing they do not exercise is Dodo's actual payload
// shape, which cannot exist until there is a Dodo account — that is why the
// unmatched-order path returns cleanly instead of granting anything.
//
// No money moves. The events reference an order that does not exist, so even a
// correctly signed payment.succeeded settles nothing.

const crypto = require('crypto');

const HOOK = process.argv[2];
const SECRET = process.argv[3];

const enc = (s) => Buffer.from(s, 'utf8');

function secretBytes(secret) {
  const b64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  return Buffer.from(b64, 'base64');
}

function sign(id, ts, body, secret) {
  const mac = crypto.createHmac('sha256', secretBytes(secret))
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

const WRONG_SECRET = 'whsec_' + Buffer.from('a-completely-different-signing-key-abc123').toString('base64');

async function post(headers, body) {
  const res = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: !!condition, detail });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
}

(async () => {
  const now = Math.floor(Date.now() / 1000);

  const event = (id, type, extra) => JSON.stringify({
    business_id: 'biz_test',
    type,
    timestamp: now,
    data: { payload_type: 'Payment', payment_id: `pay_${id}`, total_amount: 1000, ...(extra || {}) },
  });

  // 1. A correctly signed event gets past verification.
  {
    const id = 'msg_valid_' + now;
    const body = event(id, 'payment.succeeded');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, body, SECRET) }, body);
    check('valid_signature_accepted', r.status === 200 && r.body?.ok === true, r);
  }

  // 2. Signature is valid but the body was altered after signing. The classic
  //    "change the amount" attack, and the one that has to fail.
  {
    const id = 'msg_tampered_' + now;
    const body = event(id, 'payment.succeeded');
    const tampered = body.replace('"total_amount":1000', '"total_amount":1');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, body, SECRET) }, tampered);
    check('tampered_body_rejected', r.status === 401, r);
  }

  // 3. Correctly formed, signed with the wrong key.
  {
    const id = 'msg_wrongsec_' + now;
    const body = event(id, 'payment.succeeded');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, body, WRONG_SECRET) }, body);
    check('wrong_secret_rejected', r.status === 401, r);
  }

  // 4. Valid signature, timestamp an hour old. Replay outside the window.
  {
    const id = 'msg_stale_' + now;
    const old = now - 3600;
    const body = event(id, 'payment.succeeded');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(old), 'webhook-signature': sign(id, now - 3600, body, SECRET) }, body);
    check('stale_timestamp_rejected', r.status === 401, r);
  }

  // 5. No webhook headers at all.
  {
    const body = event('msg_nohdrs', 'payment.succeeded');
    const r = await post({}, body);
    check('missing_headers_rejected', r.status === 401, r);
  }

  // 6. Secret rotation: two signatures present, only the second is current.
  //    This is what lets a key be rotated without dropping live events.
  {
    const id = 'msg_rotated_' + now;
    const body = event(id, 'payment.succeeded');
    const sig = `${sign(id, now, body, WRONG_SECRET)} ${sign(id, now, body, SECRET)}`;
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sig }, body);
    check('signature_rotation_accepted', r.status === 200 && r.body?.ok === true, r);
  }

  // 7. Replay of test 1, byte-identical including the id.
  {
    const id = 'msg_valid_' + now;
    const body = event(id, 'payment.succeeded');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, body, SECRET) }, body);
    check('replay_ignored_not_reprocessed', r.status === 200 && r.body?.duplicate === true, r);
  }

  // 8. A signed event for a payment we have no order for must not invent one.
  {
    const id = 'msg_noorder_' + now;
    const body = event(id, 'payment.succeeded');
    const r = await post({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, body, SECRET) }, body);
    check('unmatched_payment_grants_nothing', r.status === 200 && r.body?.matched === false, r);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();