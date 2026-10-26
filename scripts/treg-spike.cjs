// Phase 0 spike for docs/plans/treg-enrichment-and-social-reply.md.
//
//   TREG_TOKEN=trg_live_... node scripts/treg-spike.cjs [domain] [linkedin-url]
//
// 1. Calls treg.companies.enrich and treg.people.enrich once each and prints
//    who served, what it cost and the output fields, so the mappers in
//    supabase/functions/leads/lib.ts can be checked against real answers.
//    Each call is capped with X-Treg-Route-Max-Cost, the same caps the leads
//    function sends. Spend is a few cents at most.
// 2. Lists the team's OAuth connections and the X / Reddit / LinkedIn entries
//    of /oauth/providers. Connections belong to the team, which is why social
//    replies use Echo's own OAuth apps (supabase/functions/social) instead.

const BASE = 'https://treg.to';
const token = process.env.TREG_TOKEN;
if (!token) {
  console.error('Set TREG_TOKEN first.');
  process.exit(1);
}
const domain = process.argv[2] || 'stripe.com';
const linkedin = process.argv[3] || 'https://www.linkedin.com/in/patrickcollison';

async function call(id, body, maxCost) {
  const res = await fetch(`${BASE}/call/${id}`, {
    method: 'POST',
    headers: {
      'X-Treg-Token': token,
      'X-Treg-Route-Max-Cost': maxCost,
      'X-Treg-Meta': 'feature=spike',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // printed raw below
  }
  console.log(`\n=== ${id} ${JSON.stringify(body)}`);
  console.log('status      ', res.status);
  console.log('served by   ', res.headers.get('x-treg-served-by') || json?._treg?.served_by || '-');
  console.log('cost (USD)  ', Number(res.headers.get('x-treg-cost-micro') || 0) / 1e6);
  console.log('tried       ', JSON.stringify(json?._treg?.tried ?? null));
  console.log('output      ', json ? JSON.stringify(json.output ?? null, null, 2) : text.slice(0, 500));
  console.log('raw keys    ', json?.raw && typeof json.raw === 'object' ? Object.keys(json.raw).join(', ') : '-');
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Treg-Token': token } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  await call('treg.companies.enrich', { domain }, '0.02');
  await call('treg.people.enrich', { linkedin_url: linkedin }, '0.03');

  const connections = await get('/connections');
  console.log('\n=== GET /connections', connections.status);
  console.log(JSON.stringify(connections.body, null, 2)?.slice(0, 2000));

  const providers = await get('/oauth/providers');
  console.log('\n=== /oauth/providers (social)');
  for (const p of providers.body || []) {
    if (['x', 'reddit', 'linkedin'].includes(p.service)) {
      console.log(`${p.service}: auth=${p.auth_kind} configured=${p.configured} capabilities=${JSON.stringify(p.capabilities)}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
