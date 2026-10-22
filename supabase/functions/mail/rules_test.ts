import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  buildDomainConnectApplyUrl,
  companyFromWebsite,
  detectDnsProvider,
  domainConnectApplyQuery,
  domainConnectSettingsUrl,
  domainConnectVars,
  isReservedLocalPart,
  RESERVED_LOCAL_PARTS,
  suggestionCandidates,
  syncUxBase,
  validateLocalPart,
} from './rules.ts';

Deno.test('validateLocalPart accepts ordinary names and normalises case', () => {
  assertEquals(validateLocalPart('  Rahul '), { ok: true, local: 'rahul' });
  assertEquals(validateLocalPart('rahul.k'), { ok: true, local: 'rahul.k' });
  assertEquals(validateLocalPart('r_k-99'), { ok: true, local: 'r_k-99' });
});

Deno.test('validateLocalPart refuses short, malformed and reserved names', () => {
  assertEquals(validateLocalPart('rk'), { ok: false, reason: 'too_short', local: 'rk' });
  assertEquals(validateLocalPart(''), { ok: false, reason: 'invalid', local: '' });
  assertEquals(validateLocalPart('r!'), { ok: false, reason: 'invalid', local: 'r!' });
  for (const bad of ['.rahul', 'rahul.', 'ra..hul', 'ra.-hul', 'rahul+x', 'ra hul', 'rähul', 'a'.repeat(65)]) {
    assertEquals(validateLocalPart(bad).ok, false, bad);
    assertEquals((validateLocalPart(bad) as any).reason, 'invalid', bad);
  }
  assertEquals(validateLocalPart('Admin'), { ok: false, reason: 'reserved', local: 'admin' });
  assertEquals(validateLocalPart('no.reply'), { ok: false, reason: 'reserved', local: 'no.reply' });
  assertEquals(validateLocalPart('mailer_daemon'), { ok: false, reason: 'reserved', local: 'mailer_daemon' });
});

Deno.test('every listed reserved name is reserved, ordinary names are not', () => {
  for (const r of RESERVED_LOCAL_PARTS) assert(isReservedLocalPart(r), r);
  assertEquals(RESERVED_LOCAL_PARTS.length, 24);
  assert(!isReservedLocalPart('rahul'));
  assert(!isReservedLocalPart('administrators'));
});

Deno.test('suggestions are valid, unique, exclude the request and use name/company', () => {
  const s = suggestionCandidates('rahul', { fullName: 'Rahul Kumar', company: 'Acme Labs' });
  assert(s.length >= 4);
  assertEquals(s.slice(0, 3), ['rahul.k', 'rahul.kumar', 'rahul-acmelabs']);
  assert(!s.includes('rahul'));
  assertEquals(new Set(s).size, s.length);
  for (const c of s) assert(validateLocalPart(c).ok, c);
});

Deno.test('suggestions for a reserved or short request fall back to the profile name', () => {
  const s = suggestionCandidates('admin', { fullName: 'Priya Shah' });
  assert(s.length > 0);
  assert(s.every((c) => !isReservedLocalPart(c)));
  assert(s.some((c) => c.startsWith('priya')));
  assertEquals(suggestionCandidates('x', {}), []);
});

Deno.test('suggestions without profile data still offer numbered variants', () => {
  const s = suggestionCandidates('sam_', {});
  assertEquals(s.slice(0, 2), ['sam2', 'sam3']);
});

Deno.test('companyFromWebsite takes the first host label', () => {
  assertEquals(companyFromWebsite('https://www.acme-labs.io/about'), 'acmelabs');
  assertEquals(companyFromWebsite('foo.com'), 'foo');
  assertEquals(companyFromWebsite(null), '');
});

Deno.test('detectDnsProvider maps NS hosts', () => {
  const cases: [string[], string][] = [
    [['ada.ns.cloudflare.com.', 'bob.ns.cloudflare.com'], 'cloudflare'],
    [['ns01.domaincontrol.com'], 'godaddy'],
    [['dns1.registrar-servers.com'], 'namecheap'],
    [['ns1.dns-parking.com'], 'hostinger'],
    [['ns-123.awsdns-15.com', 'ns-9.awsdns-01.co.uk'], 'route53'],
    [['ns-cloud-a1.googledomains.com'], 'google'],
    [['ns1045.ui-dns.com'], 'ionos'],
    [['ns1.bluehost.com'], 'bluehost'],
    [['ns1.digitalocean.com'], 'digitalocean'],
    [['ns1.vercel-dns.com'], 'vercel'],
    [['dns1.p01.nsone.net'], 'other'],
    [['ns1.squarespacedns.com'], 'squarespace'],
    [['curitiba.ns.porkbun.com'], 'porkbun'],
    [[], 'other'],
  ];
  for (const [ns, id] of cases) assertEquals(detectDnsProvider(ns, 'acme.com').id, id, ns.join(','));
  assertEquals(detectDnsProvider(['ns01.domaincontrol.com'], 'acme.com').dns_url, 'https://dcc.godaddy.com/control/dnsmanagement?domainName=acme.com');
  assertEquals(detectDnsProvider(['x.example'], 'acme.com'), { id: 'other', name: 'Other', dns_url: null });
});

Deno.test('domainConnectSettingsUrl accepts host/path and refuses junk', () => {
  assertEquals(
    domainConnectSettingsUrl('api.cloudflare.com/client/v4/dns/domainconnect', 'acme.com'),
    'https://api.cloudflare.com/client/v4/dns/domainconnect/v2/acme.com/settings',
  );
  assertEquals(domainConnectSettingsUrl('domainconnect.godaddy.com', 'acme.com'), 'https://domainconnect.godaddy.com/v2/acme.com/settings');
  assertEquals(domainConnectSettingsUrl('localhost/x', 'acme.com'), null);
  assertEquals(domainConnectSettingsUrl('127.0.0.1', 'acme.com'), null);
  assertEquals(domainConnectSettingsUrl('evil.com?x=1', 'acme.com'), null);
  assertEquals(domainConnectSettingsUrl('', 'acme.com'), null);
});

Deno.test('syncUxBase only accepts https', () => {
  assertEquals(syncUxBase({ urlSyncUX: 'https://dash.cloudflare.com/' }), 'https://dash.cloudflare.com');
  assertEquals(syncUxBase({ urlSyncUX: 'http://dash.cloudflare.com' }), null);
  assertEquals(syncUxBase({ urlSyncUX: 'javascript:alert(1)' }), null);
  assertEquals(syncUxBase({}), null);
});

Deno.test('apply URL is deterministic and encodes variables', () => {
  const input = {
    urlSyncUX: 'https://dcc.godaddy.com/manage/',
    providerId: 'echo',
    serviceId: 'mail-sending',
    domain: 'acme.com',
    vars: { dkimValue: 'p=AB+/=', dkimHost: 'resend._domainkey' },
    state: 's1',
  };
  assertEquals(domainConnectApplyQuery(input), 'dkimHost=resend._domainkey&dkimValue=p%3DAB%2B%2F%3D&domain=acme.com&state=s1');
  assertEquals(
    buildDomainConnectApplyUrl(input),
    'https://dcc.godaddy.com/manage/v2/domainTemplates/providers/echo/services/mail-sending/apply?dkimHost=resend._domainkey&dkimValue=p%3DAB%2B%2F%3D&domain=acme.com&state=s1',
  );
  assert(buildDomainConnectApplyUrl(input, { sig: 'a+b', key: '_dck1' }).endsWith('&sig=a%2Bb&key=_dck1'));
});

Deno.test('domainConnectVars reads the Resend record set', () => {
  const records = [
    { type: 'TXT', host: 'resend._domainkey.acme.com', value: 'p=KEY' },
    { type: 'MX', host: 'send.acme.com', value: '10 feedback-smtp.us-east-1.amazonses.com' },
    { type: 'TXT', host: 'send.acme.com', value: 'v=spf1 include:amazonses.com ~all' },
    { type: 'MX', host: 'acme.com', value: '10 inbound-smtp.us-east-1.amazonaws.com' },
    { type: 'TXT', host: '_dmarc.acme.com', value: 'v=DMARC1; p=none;' },
  ];
  assertEquals(domainConnectVars('acme.com', records), {
    dkimHost: 'resend._domainkey',
    dkimValue: 'p=KEY',
    sendHost: 'send',
    spfValue: 'v=spf1 include:amazonses.com ~all',
    bounceMx: 'feedback-smtp.us-east-1.amazonses.com',
    inboundMx: 'inbound-smtp.us-east-1.amazonaws.com',
  });
  assertEquals(domainConnectVars('acme.com', records.slice(0, 3)), null);
});
