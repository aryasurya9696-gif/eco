import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  deliveryEventOf,
  escapeLike,
  headerValue,
  hmacSha256Base64,
  isAutoReply,
  isSpam,
  matchRecipient,
  messageIdLocalPart,
  normaliseMessageId,
  normaliseSubject,
  parseAddress,
  parseAddressList,
  parseMessageIds,
  snippetOf,
  timingSafeEqual,
  verifyWebhookSignature,
  withParticipant,
} from './rules.ts';

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

// Known vector from the Standard Webhooks reference test suite.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const MSG_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TS = '1614265330';
const BODY = '{"test": 2432232314}';
const EXPECTED_SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const TS_MS = Number(TS) * 1000;

function hdrs(h: Record<string, string>) {
  return new Headers(h);
}

Deno.test('signature: known Standard Webhooks vector verifies (svix-* headers)', async () => {
  const r = await verifyWebhookSignature(
    BODY, hdrs({ 'svix-id': MSG_ID, 'svix-timestamp': TS, 'svix-signature': EXPECTED_SIG }), SECRET, TS_MS,
  );
  assertEquals(r, { ok: true, reason: 'ok', id: MSG_ID });
});

Deno.test('signature: webhook-* header names are accepted', async () => {
  const r = await verifyWebhookSignature(
    BODY, hdrs({ 'webhook-id': MSG_ID, 'webhook-timestamp': TS, 'webhook-signature': EXPECTED_SIG }), SECRET, TS_MS,
  );
  assert(r.ok);
});

Deno.test('signature: one valid entry among several (rotation)', async () => {
  const r = await verifyWebhookSignature(
    BODY,
    hdrs({ 'svix-id': MSG_ID, 'svix-timestamp': TS, 'svix-signature': `v1,AAAA ${EXPECTED_SIG} v2,zzz` }),
    SECRET, TS_MS,
  );
  assert(r.ok);
});

Deno.test('signature: tampered body, wrong secret, missing headers, stale timestamp', async () => {
  const h = { 'svix-id': MSG_ID, 'svix-timestamp': TS, 'svix-signature': EXPECTED_SIG };
  assertEquals((await verifyWebhookSignature(BODY + ' ', hdrs(h), SECRET, TS_MS)).reason, 'signature_mismatch');
  assertEquals((await verifyWebhookSignature(BODY, hdrs(h), 'whsec_' + btoa('other'), TS_MS)).reason, 'signature_mismatch');
  assertEquals((await verifyWebhookSignature(BODY, hdrs({ 'svix-id': MSG_ID }), SECRET, TS_MS)).reason, 'missing_headers');
  assertEquals((await verifyWebhookSignature(BODY, hdrs(h), SECRET, TS_MS + 6 * 60 * 1000)).reason, 'timestamp_outside_window');
  assertEquals((await verifyWebhookSignature(BODY, hdrs(h), SECRET, TS_MS - 6 * 60 * 1000)).reason, 'timestamp_outside_window');
  assert((await verifyWebhookSignature(BODY, hdrs(h), SECRET, TS_MS + 4 * 60 * 1000)).ok);
  assertEquals((await verifyWebhookSignature(BODY, hdrs(h), '', TS_MS)).reason, 'no_secret');
  assertEquals((await verifyWebhookSignature(BODY, hdrs(h), 'whsec_!!notbase64', TS_MS)).reason, 'bad_secret_encoding');
  assertEquals(
    (await verifyWebhookSignature(BODY, hdrs({ ...h, 'svix-signature': 'v2,abc' }), SECRET, TS_MS)).reason,
    'no_v1_signature',
  );
  assertEquals(
    (await verifyWebhookSignature(BODY, hdrs({ ...h, 'svix-timestamp': '12abc' }), SECRET, TS_MS)).reason,
    'bad_timestamp',
  );
});

Deno.test('signature: round trip with a freshly generated secret', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = 'whsec_' + btoa(String.fromCharCode(...keyBytes));
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'abc' } });
  const sig = await hmacSha256Base64(keyBytes, `msg_1.${ts}.${body}`);
  const r = await verifyWebhookSignature(
    body, hdrs({ 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }), secret, now,
  );
  assert(r.ok);
});

Deno.test('timingSafeEqual', () => {
  assert(timingSafeEqual('abc', 'abc'));
  assert(!timingSafeEqual('abc', 'abd'));
  assert(!timingSafeEqual('abc', 'abcd'));
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

Deno.test('headerValue is case-insensitive and joins arrays', () => {
  const h = { 'In-Reply-To': '<a@b>', references: ['<x@y>', '<z@w>'] };
  assertEquals(headerValue(h, 'in-reply-to'), '<a@b>');
  assertEquals(headerValue(h, 'References'), '<x@y> <z@w>');
  assertEquals(headerValue(h, 'missing'), null);
  assertEquals(headerValue(null, 'x'), null);
});

Deno.test('parseMessageIds: In-Reply-To / References', () => {
  assertEquals(parseMessageIds('<a@b.com>'), ['<a@b.com>']);
  assertEquals(
    parseMessageIds('<one@x.com>\r\n <two@x.com> <one@x.com>'),
    ['<one@x.com>', '<two@x.com>'],
  );
  assertEquals(parseMessageIds('bare-id@host.com'), ['<bare-id@host.com>']);
  assertEquals(parseMessageIds(''), []);
  assertEquals(parseMessageIds(null), []);
  assertEquals(parseMessageIds('<a@x> <b@x> <c@x>', 2), ['<b@x>', '<c@x>']);
});

Deno.test('messageIdLocalPart and normaliseMessageId', () => {
  assertEquals(messageIdLocalPart('<abc-123@email.example.com>'), 'abc-123');
  assertEquals(messageIdLocalPart('nothing'), null);
  assertEquals(normaliseMessageId(' <x@y.com> ', 'id1'), '<x@y.com>');
  assertEquals(normaliseMessageId(null, 'id1'), '<resend-inbound-id1@inbound.invalid>');
});

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

Deno.test('normaliseSubject strips reply/forward prefixes', () => {
  assertEquals(normaliseSubject('Re: Quick question'), 'quick question');
  assertEquals(normaliseSubject('RE: Fwd: re:  Quick   question '), 'quick question');
  assertEquals(normaliseSubject('Fw: [External] Re[2]: Quick question'), 'quick question');
  assertEquals(normaliseSubject('AW: Angebot'), 'angebot');
  assertEquals(normaliseSubject('Regarding pricing'), 'regarding pricing');
  assertEquals(normaliseSubject(''), '');
  assertEquals(normaliseSubject(null), '');
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

Deno.test('parseAddress', () => {
  assertEquals(parseAddress('Jane Doe <Jane@Example.com>'), { address: 'jane@example.com', name: 'Jane Doe' });
  assertEquals(parseAddress('"Doe, Jane" <jane@example.com>'), { address: 'jane@example.com', name: 'Doe, Jane' });
  assertEquals(parseAddress('jane@example.com'), { address: 'jane@example.com', name: null });
  assertEquals(parseAddress({ address: 'A@B.io', name: 'A' }), { address: 'a@b.io', name: 'A' });
  assertEquals(parseAddress('not an address'), null);
  assertEquals(parseAddress(42), null);
});

Deno.test('parseAddressList: arrays and header strings, deduplicated', () => {
  assertEquals(
    parseAddressList(['a@x.com', 'A@x.com', 'B <b@x.com>']).map((p) => p.address),
    ['a@x.com', 'b@x.com'],
  );
  assertEquals(
    parseAddressList('"Doe, Jane" <jane@x.com>, bob@x.com').map((p) => p.address),
    ['jane@x.com', 'bob@x.com'],
  );
  assertEquals(parseAddressList(undefined), []);
});

Deno.test('matchRecipient is case-insensitive and respects order', () => {
  assertEquals(matchRecipient(['other@x.com', 'Sales@Acme.io'], ['sales@acme.io']), 'sales@acme.io');
  assertEquals(matchRecipient(['a@acme.io', 'b@acme.io'], ['B@acme.io', 'a@ACME.io']), 'a@acme.io');
  assertEquals(matchRecipient(['nobody@x.com'], ['sales@acme.io']), null);
  assertEquals(matchRecipient([], []), null);
});

Deno.test('withParticipant adds the sender once', () => {
  const p = [{ address: 'lead@x.com', name: 'Lead' }];
  assertEquals(withParticipant(p, { address: 'lead@x.com', name: null }).length, 1);
  assertEquals(withParticipant(p, { address: 'new@x.com', name: 'N' }).length, 2);
  assertEquals(withParticipant(null, { address: 'new@x.com', name: null }), [{ address: 'new@x.com', name: null }]);
});

Deno.test('escapeLike', () => {
  assertEquals(escapeLike('first_last@x.com'), 'first\\_last@x.com');
  assertEquals(escapeLike('a%b\\c'), 'a\\%b\\\\c');
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test('isAutoReply', () => {
  assert(isAutoReply({ 'Auto-Submitted': 'auto-replied' }, 'Re: hello'));
  assert(!isAutoReply({ 'Auto-Submitted': 'no' }, 'Re: hello'));
  assert(isAutoReply({ 'X-Autoreply': 'yes' }, 'hello'));
  assert(isAutoReply({ precedence: 'auto_reply' }, 'hello'));
  assert(isAutoReply({}, 'Automatic reply: Quick question'));
  assert(isAutoReply({}, 'Out of Office: back Monday'));
  assert(isAutoReply({}, 'Re: Out of office'));
  assert(isAutoReply({}, 'Abwesenheitsnotiz: Angebot'));
  assert(!isAutoReply({}, 'Re: Quick question'));
  assert(!isAutoReply({ precedence: 'bulk' }, 'Newsletter'));
});

Deno.test('isSpam', () => {
  assert(isSpam({ 'X-Spam-Flag': 'YES' }));
  assert(isSpam({ 'x-spam-status': 'Yes, score=7.1' }));
  assert(!isSpam({ 'x-spam-status': 'No, score=0.1' }));
  assert(isSpam({ 'X-SES-Spam-Verdict': 'FAIL' }));
  assert(isSpam({ 'Authentication-Results': 'mx.resend.com; spf=pass; dkim=none; dmarc=fail (p=none) header.from=bank.example' }));
  assert(!isSpam({ 'Authentication-Results': 'mx.resend.com; spf=pass; dkim=pass; dmarc=pass header.from=lead.example' }));
  assert(isSpam({}, { spam: true }));
  assert(!isSpam({}));
});

// ---------------------------------------------------------------------------
// Text / events
// ---------------------------------------------------------------------------

Deno.test('snippetOf drops quoted history', () => {
  const t = 'Sounds good, call Tuesday?\n\nOn Mon, 1 Jan 2026 at 10:00, Me <me@x.com> wrote:\n> earlier text';
  assertEquals(snippetOf(t), 'Sounds good, call Tuesday?');
  assertEquals(snippetOf('> only quoted'), '> only quoted');
  assertEquals(snippetOf('x'.repeat(300)).length, 200);
});

Deno.test('deliveryEventOf', () => {
  assertEquals(deliveryEventOf('email.bounced'), 'bounced');
  assertEquals(deliveryEventOf('email.complained'), 'complained');
  assertEquals(deliveryEventOf('email.delivered'), 'delivered');
  assertEquals(deliveryEventOf('email.opened'), null);
});
