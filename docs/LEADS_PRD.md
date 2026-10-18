# Echo Leads — PRD

Waterfall enrichment inside Echo. A new Leads item in the Echo sidebar turns
"what you sell" into a list of decision makers with verified work emails.

Echo already finds people who are talking about buying. Leads is the second
service: it writes an ideal customer profile (ICP) from the website and core
offer Echo already holds, finds matching companies and the decision maker at
each, then pours each person through a waterfall of email providers via Treg,
cheapest first, until one finds a verified email. It uses the same Supabase
backend, the same Treg token and the same prepaid credit wallet as Echo search,
and every action shows its price in Echo credits before it runs.

This is not a new app. The Cascade PRD described a standalone Next.js + SQLite
product. Everything below has been rewritten to fit what is in this repository
today: Vite + React 19, Supabase (Postgres, Auth, Edge Functions, pg_cron), the
Treg data gateway, and the Dodo-backed credit wallet from migrations 20261102 to
20261107. Where the Cascade PRD and this repository disagree, this PRD follows
the repository.

## What changed from the Cascade PRD

| Area | Cascade PRD said | Echo Leads does | Why |
| --- | --- | --- | --- |
| Product | Standalone lead SaaS with its own landing, signup and onboarding | A new "Leads" tab in the existing Echo dashboard sidebar | Same users, same login, same wallet |
| Frontend | Next.js App Router | Existing Vite 8 + React 19 + Tailwind v4 app. No router added: Leads is a DashboardTab with its own sub-views | Echo uses a hash router plus tab state in DashboardPage.tsx |
| Database | Local SQLite with Drizzle | Existing Supabase Postgres. New `lead_*` tables via `supabase/migrations/YYYYMMDD_*.sql`, appended to deploy-all.sql | One database, RLS already in place |
| Auth | bcrypt + session cookie, first user is admin | Existing Supabase Auth. No new signup. No roles (Echo has none) | Do not fork auth |
| Server | Next.js route handlers | One new Supabase Edge Function `leads` (Deno), self-contained, same CORS / `requireUserId()` / rate-limit pattern as social-search | Supabase bundler skips `_shared` |
| Long runs | In-process job runner + server-sent events | Queue in `lead_runs` / `lead_rows`, processed in chunks by the leads function (action `work`), kicked on start and by pg_cron every minute. UI updates via Supabase Realtime, with 3s polling fallback | Edge Functions have a wall-clock limit; Echo already schedules with pg_cron + pg_net |
| AI | Anthropic SDK, Opus 5.5 | Existing `ai` function gets a new `icp` action. Model from `ICP_MODEL` secret; defaults to the model `ai` uses today (OpenAI gpt-4o-mini). Switching to Claude Opus 5.5 is an open decision | Reuse the existing AI path and key |
| Payments | Stripe Checkout or mock top-up | No new payment code. Existing Dodo checkout + webhook top up the shared wallet | Credits only ever enter through the webhook |
| Credits | 1 credit = $0.01, own ledger, holds and refunds | Existing wallet: 1 credit = $0.05 (200 credits = $10). `wallet_reserve` / `wallet_settle` / `wallet_release`, `api_usage`, `pricing_config`. All Cascade prices converted (see Pricing) | One balance across Feed search and Leads |
| Free credits | 50 on signup | Existing 20 welcome credits (`handle_new_user`). Nothing new | Already live |
| Admin margin | Admin Margin tab in the app | Existing SQL views `v_margin_by_operation`, `v_margin_by_user`, `v_treg_reconciliation` pick up `leads.*` operations automatically. No admin UI in this PRD | Echo has no admin role |
| Onboarding | New fixed-size 5-step card | Reuse the existing onboarding answers (`profiles.website`, `profiles.core_offer`). The ICP builder lives inside the Leads tab | Users already onboarded once |
| Landing | Full new landing page | One new Leads section and one pricing line on the existing LandingPage | Echo already has a landing page |
| Design | Daygent: Geist, no caps, watercolour washes | Echo design system: Inter, square corners, grayscale tokens, mono uppercase 10px section labels, emerald for live. Provider pastel chips are the only new colour | Must look like Echo |
| Tenancy | Users and businesses | Per user (`user_id` → `auth.users`), RLS (`select auth.uid() = user_id`), writes only through the service role | Matches every other Echo table |
| New | n/a | Feed tie-in: "Add to Leads" on a feed post (later phase) | Connects the two services |

## Where it lives: the sidebar

`src/components/dashboard/Sidebar.tsx` builds its nav from a grouped `navItems`
array with lucide-react icons. Leads is added to the MAIN group, after Keywords.

```ts
// src/types/index.ts
export type DashboardTab = 'feed' | 'keywords' | 'leads' | 'settings' | 'billing';
```

```tsx
// src/components/dashboard/Sidebar.tsx  (MAIN group)
{ id: 'feed',     label: 'Feed',     icon: <Inbox className="w-4 h-4" />, count: posts.length },
{ id: 'keywords', label: 'Keywords', icon: <Tag className="w-4 h-4" />,   count: `${keywords.length}/${keywordLimit}` },
{ id: 'leads',    label: 'Leads',    icon: <Users className="w-4 h-4" />, count: activeRunCount || undefined },
```

```tsx
// src/pages/DashboardPage.tsx
// header title chain: activeTab === 'leads' ? 'Leads' : ...
{activeTab === 'leads' && <LeadsTab />}
```

- The count badge shows running lead runs (hidden when zero), so the sidebar
  shows work in progress.
- Collapsed sidebar (`w-16`) shows only the icon with the existing tooltip;
  nothing else changes.
- Inside the tab, a sub-nav row switches between: Runs (default), New search,
  Clean a list, Provider lab, Opt-outs. Sub-view is kept in the URL hash
  (`#dashboard/leads/runs`, `#dashboard/leads/run/<id>`) so a refresh lands on the
  same screen. This needs a small extension to the hash parsing in `App.tsx`; no
  router library is added.
- Settings tab gets a "Leads" block (per-row cost cap, phone opt-in default,
  waterfall order reset). Billing tab is unchanged apart from ledger labels.

## What we're building

The user flow, inside Echo:

1. Click Leads in the sidebar. First time: an empty state with one line ("No runs
   yet. Describe who buys from you and Echo finds them.") and a New search button.
2. New search is prefilled from onboarding: website and core offer. The user can
   add who they think buys it, regions, company sizes and how many leads (10 to
   200, default 50).
3. Echo reads the website through Treg and hands the text to the AI, which writes
   the ICP. A free count shows how many companies match before anything is spent.
4. The user approves the ICP and presses the run button, which shows the estimate
   and maximum in credits.
5. The run finds the companies, the decision maker at each, and a verified email
   through the waterfall. The table fills in live, cell by cell, with provider
   colours and a cost per row.
6. Export to CSV or Excel. Or import their own CSV on Clean a list and verify,
   refind or fully enrich it, with the price shown first.
7. Credits come out of the same wallet as Feed searches. Billing shows each run as
   one line in the history.

**Demo story:** "I run a CRM SaaS for accountants." Two minutes later there's a
table of 50 UK and US accounting-firm CEOs with verified emails, and a run
receipt showing what it cost in credits.

## Done looks like

- [ ] A Leads item sits in the sidebar under MAIN, works collapsed and expanded,
      and survives a page refresh on any sub-view
- [ ] An onboarded user goes from New search to an approved ICP in under 2
      minutes, prefilled from their profile
- [ ] The free count shows how many companies match before any paid call
- [ ] 50 companies and decision makers are found, and the email waterfall runs
      with each cell showing the provider that hit and its cost
- [ ] Verified, catch-all and not-found states are clearly different
- [ ] Import a CSV, map its columns, see an estimate, run a clean, export the
      result
- [ ] Every paid button shows its price in credits; a run never starts without an
      estimate on screen
- [ ] Credits are reserved and settled through the existing wallet RPCs;
      `api_usage` holds one row per Treg call with the real `x-treg-cost-micro`
      cost; the run receipt equals the sum of its settled credits
- [ ] Closing the tab does not stop a run; reopening shows it where it is
- [ ] The provider lab runs the same leads through each provider alone and through
      the waterfall, and charts the difference
- [ ] `v_margin_by_operation` shows `leads.*` operations with revenue, Treg cost
      and margin
- [ ] No credit is ever granted or charged from the browser; all new RPCs are
      service-role only

## The engine

Four stages find the people, then the waterfall finds their emails. Every stage
is a Treg call except the ICP, which is the AI.

```
website + core offer ──► ICP (ai function)
        │
        ▼
1 companies ──► 2 decision maker ──► 3 email waterfall ──► 4 verify ──► (5 phone / company data, opt-in)
  tomba            icypeas              QuickEnrich → Kitt →     ContactOut →
  icypeas          findymail            AI Ark → Tomba →         Kitt verify →
  treg             leadmagic            LeadsForge               MillionVerifier
```

Providers with free misses mean a lead only ever pays for the one provider that
finds its email. That is the whole economic idea, and the run receipt proves it.

## Treg integration

Echo already calls Treg from `social-search` and `daily-sweep` with `TREG_TOKEN`
and reads `x-treg-cost-micro`. Leads uses the same token and the same pattern,
inside the new `leads` function (copy the helper in; do not import across
functions).

```ts
// supabase/functions/leads/treg.ts
const res = await fetch(`https://treg.to/call/${endpointId}`, {
  method: 'POST',
  headers: {
    'X-Treg-Token': Deno.env.get('TREG_TOKEN')!,
    'Content-Type': 'application/json',
    'X-Treg-Route-Max-Cost': String(maxCostUsd),   // hard per-call cap, 402 if exceeded
    'Idempotency-Key': `leads:${runId}:${rowId}:${step}:${endpointId}`,
    'X-Treg-Meta': `user=${userId},run=${runId},step=${step}`,
  },
  body: JSON.stringify(params),
});
const costMicro = Number(res.headers.get('x-treg-cost-micro') ?? 0); // real charge, micro-USD
const callId = res.headers.get('x-treg-call-id');
```

Rules:

- Write one `api_usage` row per call: `operation` = the `leads.*` operation it
  served, `provider` = `treg`, `provider_call_id`, `provider_cost_usd` =
  costMicro / 1e6, `outcome` (`success`, `free` for a free miss, `upstream_failed`,
  `not_billed`, `uncertain`). The provider's response body is never the source of
  truth for cost. A missing header means no charge.
- 402 from Treg (out of balance or over max cost): pause the run with "Data
  provider balance is low, try again later", release the held credits, and log it.
  Never show Treg wording to the customer.
- 429 (`tag_spend_cap_reached`, `platform_daily_cap_reached`): pause the run with a
  clear message; the worker retries on the next cron tick.
- Retry once on network errors with the same `Idempotency-Key`, so a replay is
  never charged twice.
- At most 5 rows in flight per run (a small inline limiter, no npm dependency
  needed in Deno).
- The `TREG_TOKEN` never reaches the browser. All calls happen in the edge
  function.

## The endpoint registry

Prices are from the Treg catalog on 10 Oct 2026 and must be re-checked with the
Treg MCP (`catalog_get`) before each endpoint is coded. "Success" in the catalog
means the call completed, not that it found a result, which is why Leads tracks
its own hit rates. The old removed prototype (commit 8ff7b5c,
`src/lib/waterfall.ts`) used the same five email providers and prices; use it
only as a reference, never restore it.

| Step | Endpoint id | Price | Notes |
| --- | --- | --- | --- |
| Read website | `branddev.web.scrape` | ~$0.0025 a call | Markdown of one page. Fallback: `treg.web.extract` ($0 to $0.01, routed, misses can bill) |
| Brand | `branddev.brand.retrieve` | ~$0.025 a call | Logo, colours, industry. Optional: only for the ICP card logo |
| Count companies (free) | `icypeas.companies.search.count`, `companyenrich.companies.search.count` | Free | Shown before any paid search |
| Count people (free) | `icypeas.people.search.count`, `getleadsio.people.search.count` | Free | |
| Find companies | `tomba.companies.search.reveal` | ~$0.000178 per up to 50 | Fallbacks: `icypeas.companies.search` (~$0.00038 a row), `treg.companies.search` |
| Company name to domain | `crustdata.companies.identify` | Free | For imported rows without a domain |
| Decision maker | `icypeas.people.search` | ~$0.00038 a row | Fallbacks: `findymail.search.employees` ($0.0198), `leadmagic.people.search` ($0.025) |
| Email waterfall 1 | `quickenrich.people.email.find` | $0.0048 a hit, misses free | Name + company, or LinkedIn URL |
| Email waterfall 2 | `trykitt.people.email.find` | $0.005 a hit, misses free | Name + domain |
| Email waterfall 3 | `aiark.people.email.find` | $0.0053 a hit, misses free | Needs a profile URL |
| Email waterfall 4 | `tomba.people.email.find` | $0.0089 a hit, misses free | Name + domain |
| Email waterfall 5 | `leadsforge.people.email.find` | $0.0245 a hit, misses free | |
| Verify 1 | `contactout.people.email.verify` | Free | Deliverability and catch-all |
| Verify 2 | `trykitt.people.email.verify` | $0.0015 | Catch-all or unknown |
| Verify 3 | `millionverifier.people.email.verify` | $0.00178 | Backup |
| Phone (opt-in) | `aiark.people.phone.find`, `dropleads.people.phone.find`, `leadmagic.people.phone.find` | $0.026, $0.054, $0.125 | Only with the phone toggle and a per-row cap |
| Phone live check | `hlrlookup.people.phone.network` | $0.0033 | |
| Company data (optional) | `prospeo.companies.enrich` | ~$0.0245 per match | Firmographics, funding, tech |

`supabase/functions/leads/registry.ts` holds one entry per endpoint, filled from
`catalog_get`: id, display name, provider colour, list price, required inputs, how
to read a hit from the response, and whether misses bill. The waterfall and the
estimator read from this file only.

## Stack (what is reused, what is new)

| Part | Choice | Status |
| --- | --- | --- |
| App | Vite 8, React 19, TypeScript, Tailwind v4, framer-motion, lucide-react | Existing |
| State | Local state in LeadsTab plus `src/lib/leads.ts`; toasts through EchoContext | Existing pattern |
| Backend | Supabase Postgres + Auth + Edge Functions + pg_cron/pg_net + Realtime | Existing (Realtime is new to Echo) |
| Server calls | `invokeFunction('leads', { action, ... })` from `src/lib/api.ts` | Existing helper |
| Data | Treg over REST with `TREG_TOKEN` | Existing secret |
| AI | `ai` function, new action `icp`, model from `ICP_MODEL` | Existing function, new action |
| Billing | Wallet RPCs, `pricing_config`, `api_usage`, Dodo top-ups | Existing |
| Table | @tanstack/react-table + @tanstack/react-virtual | New dependency |
| CSV / Excel | papaparse for import, xlsx (SheetJS) for Excel export. CSV export reuses the Feed export approach | New dependency |
| Drag and drop | @dnd-kit/core, @dnd-kit/sortable for waterfall order | New dependency |
| Charts | recharts for the provider lab | New dependency |
| Validation | Hand-written validators in the function (as today), or npm:zod in Deno for the ICP JSON | Pick one and keep it |

**New secrets** (Supabase edge secrets or `service_secrets`, never in the
frontend): `LEADS_WORKER_SECRET` (guards the work action, like
`x-sweep-secret`), `ICP_MODEL` (optional), `LEADS_ROW_CAP_USD` (default 0.05).
Existing: `TREG_TOKEN`, `OPENAI_API_KEY`.

## Design

Leads must look like the rest of Echo. Use the tokens in `src/index.css` and the
patterns already in Feed and Billing:

- Background `#f6f6f4`, cards `#ffffff`, borders `#e3e3de` and `#eeeeea`, text
  `#141414`, muted `#8a8a86`, subtle `#9b9b96`. Square corners (`rounded-none`).
  Inter.
- Section labels: `text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]`,
  as in the sidebar groups. Active states `bg-[#141414] text-white`. Emerald for
  live and running.
- All numbers use `tabular-nums` so costs and counts do not jitter.
- Table rows exactly 44px, header 40px. Skeletons match final sizes, so loading
  never shifts layout.
- Motion: framer-motion, transform and opacity only, 200 to 300ms; respect
  `prefers-reduced-motion`.
- Copy: short, literal, numbers over adjectives. No exclamation marks or emoji.

Status colours: verified `#1a7f4b` on `#e3f2e9`, catch-all `#b5801f` on
`#f8eedb`, not found `#c0462e` on `#f8e4df`, running emerald.

Provider colours are the only new palette. Used only on chips, cell dots and
charts, never as large fills:

| Provider | Chip | Ink |
| --- | --- | --- |
| QuickEnrich | `#dff3ea` | `#2f7d5b` |
| Kitt | `#dcebfa` | `#2f6aa8` |
| AI Ark | `#ece5f7` | `#6a4fa3` |
| Tomba | `#fbe8dc` | `#a65a2e` |
| LeadsForge | `#f8f0d2` | `#8a6d16` |
| ContactOut | `#e6efe0` | `#4f7a3a` |
| MillionVerifier | `#f7e2e6` | `#a2445a` |
| Phone providers | `#f1ece4` | `#7a6650` |

Dropped from the Cascade PRD: Geist, watercolour washes and paper grain,
brand-tint shifting, the drip sound, and the separate app shell (Echo's shell
already exists).

## ICP generation

New search form (inside the Leads tab, one card, fixed height):

| Field | Input | Notes |
| --- | --- | --- |
| Website | Prefilled from `profiles.website` | Editable; validates the domain on blur |
| What you sell | Prefilled from `profiles.core_offer`, up to 140 characters | Price point chips: under $50/mo, $50 to $500/mo, $500+/mo, one-off |
| Who buys it | Optional text. Region chips: UK, US, Canada, Australia, Ireland, EU, India. Size chips: 1-10, 11-50, 51-200, 201-1,000 | "Not sure? Leave it, we'll work it out from your site" |
| How many leads | Slider 10 to 200, default 50. Phone toggle (off, with its price) | Estimate updates live under the slider |

Pressing **Write my ICP** shows a live checklist (fixed-height lines, pulsing dot
to tick): reading your homepage (`branddev.web.scrape`), reading up to 3 more
pages (pricing, about, customers), pulling your brand
(`branddev.brand.retrieve`, optional), writing your ideal customer profile. Each
line shows its cost in small grey text. The website read and ICP are free to the
user (0 credits) and logged in `api_usage` as `leads.icp.generate` so the cost
still shows in margin views.

`ai` function, action `icp`: takes the form answers plus the scraped pages
(trimmed to about 15,000 words), validates the JSON response, and retries once on
invalid JSON. Same per-user rate limit as the other `ai` actions.

**System prompt:**

> You are a B2B go-to-market strategist. From a company's website and its own
> description, define who is most likely to buy, in terms a data provider can
> search.
> Use only the inputs. Be specific: real industries, real job titles, employee
> ranges, countries. Prefer one tight segment over a broad one. If the user stated
> a segment, start there and refine it. List your assumptions. Return only JSON
> matching the schema.

**ICP schema:**

```json
{
  "summary": "Accounting firms that still run client work in spreadsheets and email.",
  "segments": [
    {
      "name": "Small UK and US accounting firms",
      "industries": ["Accounting"],
      "keywords": ["accounting", "bookkeeping", "tax advisory"],
      "excludeKeywords": ["software", "recruitment"],
      "countries": ["GB", "US"],
      "employeeRange": [10, 50],
      "targetTitles": ["CEO", "Managing Partner", "Founder", "Owner"],
      "seniority": ["owner", "partner", "c_suite"],
      "whyTheyBuy": "Partners lose hours chasing client documents across email.",
      "pains": ["", "", ""],
      "openingAngle": ""
    }
  ],
  "primarySegment": 0,
  "assumptions": [""],
  "confidence": 0.8
}
```

### The ICP card

- Segment name in large type, editable chip rows for industries, countries,
  employee range (dual slider), target titles, keywords and exclusions. "Why they
  buy" and "opening angle" sit at the bottom in muted text.
- Changing a chip triggers a free re-count after 600ms. **Regenerate** reruns the
  AI with a one-line note ("smaller firms", "US only"). **Add a segment** for a
  second ICP.
- Saved ICPs are listed on the Runs view with "Find more" on each.

### Free count before spending

Under the card: "About 4,820 companies match. 2,960 have a matching title." From
the free count endpoints; show whichever answers first, with "about".

### Turning the ICP into provider filters

- Countries become ISO codes or provider location values via the free geo lookups
  (`companyenrich.geo.country.get`, `companyenrich.geo.cities.search`).
- Titles normalised with the free `companyenrich.positions.autocomplete`.
- Industries map through each provider's free "list filter values" endpoint,
  cached in `lead_filter_cache` for 7 days.
- If a value cannot be mapped, fall back to keyword search and flag it on the card
  ("matched by keyword").

## The run button

"Find 50 leads · est. 43 credits (max 61)", with a breakdown on hover: companies,
decision makers, emails found (from your hit rates, or 70% by default).

The two smaller numbers for that search are 1 credit minimum and 43 expected.
Minimum is the company line alone, because that is the only line charged whether
or not anything is found — the row exists because a company search returned that
domain. The decision-maker line is charged only when the people waterfall returns
somebody, so it is at the hit rate like the email line rather than unconditional.

The button is disabled with a "Top up" link when available credits
(`balance - reserved`) are below the maximum.

## Runs: finding the leads and the waterfall

A run is one job: an ICP plus a target count, or an imported list plus a clean
mode. It is stored in `lead_runs`, its rows in `lead_rows`, and processed by the
leads function in chunks.

### How a run executes on Supabase

1. `start` (user JWT): validates input, checks available credits against the
   maximum estimate, inserts the run (`queued`) and, for find runs, nothing else
   yet. Then fires `work` for that run through pg_net / a non-awaited fetch and
   returns the run id at once.
2. `work` (header `x-leads-worker-secret`): claims up to 25 rows with
   `select ... for update skip locked`, works them 5 at a time, and stops at a 50
   second time budget. If rows remain, it re-invokes itself; pg_cron calls `work`
   every minute as a safety net for anything left running.
3. **Billing per chunk:** `wallet_reserve` the chunk's maximum with key
   `leads:<run>:chunk:<n>`, then `wallet_settle` the credits actually earned by
   successful results in that chunk, and `wallet_release` the rest. A chunk is
   short-lived, so it never collides with `reap_stale_reservations`.
4. If `wallet_reserve` returns `insufficient_credits`, the run moves to `paused`
   with reason `credits`, and the UI shows "Paused: top up to continue". Resume
   re-queues it.
5. Each row update is written to `lead_rows` (and each attempt to
   `lead_attempts`). The browser subscribes with Supabase Realtime to `lead_rows`
   filtered by `run_id` (RLS select-own), with 3s polling of `get_run` as
   fallback.
6. Closing the tab does not stop a run. Pause, resume and cancel are actions on
   the same function.

### Stage 1: companies

- `tomba.companies.search.reveal` with mapped filters. One call returns up to 50
  companies.
- Fewer than the target: top up with `icypeas.companies.search`, then
  `treg.companies.search` as a last resort.
- De-duplicate by domain; drop anything matching exclusions or the user's opt-out
  list. Each company becomes a row immediately.

### Stage 2: the decision maker

- `icypeas.people.search` filtered to the company and target titles in priority
  order (CEO, Managing Partner, Founder, Owner). Take the most senior match.
- No match: `findymail.search.employees`, then `leadmagic.people.search`.
- Still none: mark the row "No match for these titles" and charge nothing.

### Stage 3: the email waterfall

```ts
// supabase/functions/leads/waterfall.ts (simplified)
for (const provider of orderedProviders(userId, 'email')) {   // cheapest first, or smart order
  if (!provider.canRunWith(row)) continue;                    // e.g. AI Ark needs a profile URL
  if (rowSpendUsd + provider.maxPrice > row.capUsd) break;    // per-row cost cap
  await updateRow(row, { step: 'email', provider: provider.id, state: 'trying' });
  const r = await treg(provider.endpoint, provider.toParams(row), {
    maxCostUsd: provider.maxPrice, idempotencyKey: key(run, row, 'email', provider.id),
  });
  rowSpendUsd += r.costUsd;
  await logAttempt(row, provider, r);                          // lead_attempts + api_usage
  const email = provider.readEmail(r.body);
  if (email) { row.email = email; row.emailProvider = provider.id; break; }
  await updateRow(row, { step: 'email', provider: provider.id, state: 'miss' });
}
```

Default order: QuickEnrich, Kitt, AI Ark, Tomba, LeadsForge.

### Stage 4: verification

- `contactout.people.email.verify` (free). "valid" means verified.
- Catch-all or unknown: `trykitt.people.email.verify`, then
  `millionverifier.people.email.verify`.
- Final states: Verified, Catch-all (risky), Invalid (run the email waterfall once
  more from the next provider), or Unknown.

### Stage 5 (opt-in): phone and company data

Phone only with the toggle on and within the per-row cap: AI Ark, Dropleads,
LeadMagic, then `hlrlookup.people.phone.network` to confirm it is live. Company
data column via `prospeo.companies.enrich`, on demand.

### Smart order

```
expected_cost_per_hit = price_per_hit + (miss_cost × (1 - hit_rate)) / hit_rate
hit_rate = (hits + 1) / (attempts + 2)     -- smoothed
```

Computed per user from `lead_attempts`. Turns on after 50 attempts per provider;
before that the default order applies. Users can override by dragging in Settings
or the Provider lab; stored in `lead_waterfall_orders`.

### Caps and safety

- Per-row cap: default $0.05 email only, $0.25 with phone (Settings), sent as
  `X-Treg-Route-Max-Cost` and enforced in the loop.
- Idempotency: Treg key `leads:run:row:step:provider`; wallet key
  `leads:run:chunk:n`; `api_usage.idempotency_key` unique. A crash or retry never
  double-charges.
- Opt-out list: `lead_suppressions` (emails and domains) is checked before every
  paid call; matching rows are never processed or returned.
- Credits are charged only on success, per the price list. A miss costs the user
  nothing.

## The leads table

Sub-view `#dashboard/leads/run/<id>`. This is the screen people screenshot.

Columns: select · Company (logo when known, domain beneath) · Person (name and
title) · Email · Status · Found by · Phone (optional) · Credits · actions.
Company data columns appear when added.

| State | Look |
| --- | --- |
| Queued | A faint `#eeeeea` shimmer bar |
| Trying | A small droplet moving down a tiny 5-step ladder, with the current provider's chip in its colour |
| Miss, moving on | The chip fades and slides down to the next provider in 200ms |
| Found | The email types in, with the provider dot beside it |
| Verified | Tick and "Verified" on `#e3f2e9` |
| Catch-all | Amber "Catch-all" on `#f8eedb`, tooltip explains the risk |
| Not found | Grey "Not found, no charge" |
| Credits | Tabular figures ("1 credit"), hover receipt lists every attempt for the row |

- Above the table: run title and ICP name, a live status pill ("running · 32 of
  50"), four counters (Found, Verified, Catch-all, Spent in credits), and a
  stacked bar of emails found per provider.
- Interactions: sort, filter by status or provider, search, expand a row (attempt
  history, company details, opening angle), multi-select bulk actions
  (re-verify, find phone, delete, export selected), keyboard up and down.
  TanStack Virtual keeps 10,000 rows smooth.
- Run complete: counters settle, a receipt card slides up from the bottom right:
  results by type, credits charged, credits released from holds.
- A credits meter in the Leads header ticks down live during a run.

## Import, clean and export

### Import (Clean a list)

1. Drag in a CSV (up to 10,000 rows). Parse in the browser with Papa Parse and
   show the first 5 rows.
2. Auto-map columns from headers (first name, last name, full name, company,
   domain, website, email, LinkedIn URL, title). Unmapped columns are kept in
   `extra` and passed through to the export.
3. De-duplicate by email or name plus domain; show how many were removed.
4. Send the mapped rows to `leads` action `import` in batches of 1,000; the
   function checks suppressions and returns how many were skipped.

### Clean modes

| Mode | What it does | Price |
| --- | --- | --- |
| Verify only | Verification waterfall on existing emails | 0.1 credits per email |
| Verify and refind | Verify, then email waterfall for invalid or missing | 0.1 per verify + 1 per new verified email |
| Full enrich | Domain if missing, email, verification, optional phone and company data | Shown per column |

Before the run: "1,240 rows · est. 462 credits ($23.10) · max 620 credits", using
the user's own hit rates where they exist.

### Export

CSV and Excel (`.xlsx`), all columns or only selected. Options: verified only,
include catch-all, include attempt history. Every export includes the provider
that found each email and its verification status. Export runs in the browser from
the loaded rows; large runs page through `get_run`.

## Pricing in Echo credits

Echo's wallet values 1 credit at $0.05 (packages: 200 credits for $10, 500 for
$25, 1,000 for $50). The Cascade price list was written for $0.01 credits, so
every number is divided by 5. Customer dollar prices are unchanged.
`numeric(20,6)` already supports fractional credits.

| Result | `pricing_config` operation | Credits | Customer price | Typical Treg cost |
| --- | --- | --- | --- | --- |
| ICP from your website | `leads.icp.generate` | 0 | Free | ~$0.03 plus the AI call |
| Company found | `leads.company.found` | 0.02 | $0.001 | under $0.0004 |
| Decision maker found | `leads.person.found` | 0.2 | $0.01 | $0.00038, up to $0.025 |
| Verified email | `leads.email.verified` | 1 | $0.05 | $0.0048 to $0.0245, + up to $0.0033 verify |
| Catch-all email | `leads.email.catch_all` | 0.4 | $0.02 | Same as above |
| Verify only | `leads.verify.only` | 0.1 | $0.005 | Free to $0.0033 |
| Phone found and live | `leads.phone.found` | 8 | $0.40 | $0.026 to $0.125, + $0.0033 |
| Company data column | `leads.company.enrich` | 1 | $0.05 | ~$0.0245 |

- Seed these rows in a migration with `provider_endpoint` = the primary endpoint
  for that step, `cost_source` = `catalog`, `cost_verified` = false until
  observed. Prices stay server-side; the browser reads `pricing_config` (select is
  already allowed for authenticated users) only to show estimates, and the
  function recomputes everything.
- Worked example: a 50-lead run at a 70% email hit rate = 50 × 0.02 + 50 × 0.2 +
  35 × 1 = 46 credits ($2.30), against roughly $0.30 to $0.80 of Treg cost.
- Billing tab: `ledgerLabel` in `src/lib/billing.ts` maps usage to "Search" today.
  Read the operation from ledger metadata and show "Leads run" for `leads.*`
  entries, with the run name.
- Margin: existing views (`v_margin_by_operation`, `v_margin_by_user`,
  `v_treg_reconciliation`) cover Leads with no change, because they read
  `api_usage`.

## Provider lab

Sub-view Provider lab. This is where Leads proves the waterfall with the user's
own data.

1. Pick 100 rows from an existing run or import.
2. Pick providers to test. The estimate is clearly labelled: running every
   provider on every row costs more than a waterfall.
3. Run the bake-off (a run with `kind` `lab`): every selected provider tries every
   row. The waterfall result is worked out from the same attempts at no extra
   cost.
4. Results: a Recharts bar chart in provider colours (each provider alone, then
   the waterfall); a table of hit rate, cost per hit, unique finds and agreement;
   and the headline "The best single provider found 52. The waterfall found 81 for
   81 credits." Always real numbers.
5. **Apply as my order** saves the ranking to `lead_waterfall_orders`. Dragging
   recalculates the waterfall instantly from the logged attempts.

## Feed tie-in (later phase)

Each Feed card gets an **Add to Leads** action that copies the author name, handle
and profile URL into a "From Feed" list. Most social authors have no company or
domain, so the default mode for these rows is LinkedIn-URL providers only
(QuickEnrich, AI Ark) with a clear "may not find" note and the usual price pill.
Ships after the core service works.

## Data model

New migration(s) `supabase/migrations/YYYYMMDD_leads.sql`, appended to
deploy-all.sql with `scripts/append-migration.cjs` and checked with
`scripts/check-deploy-all.cjs`. Every table: `id uuid default gen_random_uuid()`,
`user_id uuid references auth.users on delete cascade`, `created_at`. RLS on, one
select-own policy (`select auth.uid() = user_id`), no insert/update/delete
policies: all writes go through the leads function with the service role. Do not
reuse the dropped `lead_unlocks` name.

| Table | Key columns |
| --- | --- |
| `lead_icps` | website, offer, inputs (jsonb: price point, regions, sizes), pages (jsonb: url, title, treg_call_id), brand (jsonb), json (the ICP), version, note, approved_at |
| `lead_runs` | kind (find, clean, lab), icp_id, name, target, mode, options (jsonb: phone, company data, cap), status (queued, running, paused, done, failed, cancelled), pause_reason, est_credits, max_credits, charged_credits, treg_cost_usd, counters (jsonb), started_at, finished_at |
| `lead_rows` | run_id, company_name, domain, logo_url, person_name, title, linkedin_url, email, email_status (verified, catch_all, invalid, unknown, not_found), email_provider, phone, phone_provider, company_data (jsonb), extra (jsonb passthrough), credits, state, step, current_provider, locked_at |
| `lead_attempts` | row_id, run_id, step (company, person, email, verify, phone), endpoint_id, hit (bool), cost_usd, ms, treg_call_id, api_usage_id |
| `lead_waterfall_orders` | step, endpoint_ids (jsonb), mode (default, smart, custom); unique (user_id, step) |
| `lead_suppressions` | value (email or domain), kind, reason; unique (user_id, value) |
| `lead_filter_cache` | provider, filter_type, values (jsonb), fetched_at. Shared, no user_id, service-role only |
| `profiles` (existing) | Add `leads_terms_accepted_at` (server-guarded column) and `leads_row_cap_usd` |

Reused as-is: `wallet`, `reservations`, `credit_ledger`, `api_usage`,
`pricing_config`, `topup_packages`, `payment_orders`. Enable Realtime publication
on `lead_rows` and `lead_runs` only.

## The leads function

`supabase/functions/leads/index.ts`, deployed with `--no-verify-jwt` (like
`daily-sweep`) so work can be called by cron; every user action still calls
`requireUserId()`. Per-user rate limit for user actions; `work` requires
`x-leads-worker-secret`.

| Action | Who | Does |
| --- | --- | --- |
| `read_site` | user | Scrape pages and brand through Treg, store on `lead_icps` |
| `count` | user | Free counts for an ICP |
| `save_icp` | user | Save edits, approve |
| `estimate` | user | Min, expected and max credits for any run or action |
| `start` | user | Create a find, clean or lab run, kick the worker |
| `get_run`, `list_runs` | user | Run with rows (paged), run list |
| `pause`, `resume`, `cancel` | user | Run control |
| `import` | user | Insert mapped CSV rows (batches of 1,000), apply suppressions |
| `bulk` | user | Re-verify, find phone, delete for selected rows |
| `waterfall_get`, `waterfall_put` | user | The user's order per step |
| `suppressions_list`, `_add`, `_remove` | user | Opt-out list |
| `lab_results` | user | Bake-off results |
| `work` | cron / self | Process queued and running runs in chunks |

`ai` function: new action `icp` (writes the ICP JSON). pg_cron: one new job
calling `leads` `work` every minute via pg_net, same style as the daily-sweep job.

## Files

```
src/
  types/index.ts                 + 'leads' in DashboardTab, Lead* types
  lib/leads.ts                   invokeFunction wrappers, estimate helpers, realtime subscribe
  lib/billing.ts                 ledgerLabel: "Leads run" for leads.* usage
  pages/DashboardPage.tsx        title + {activeTab === 'leads' && <LeadsTab />}
  App.tsx                        hash parsing for #dashboard/leads/...
  components/dashboard/
    Sidebar.tsx                  + Leads nav item (Users icon, active run count)
    LeadsTab.tsx                 sub-nav + sub-views
    SettingsTab.tsx              + Leads block (row cap, phone default, order reset)
  components/leads/
    RunsList.tsx  NewSearch.tsx  IcpCard.tsx  ChipRow.tsx  CountLine.tsx  RunButton.tsx
    LeadsTable.tsx  CellLadder.tsx  StatusBadge.tsx  ProviderChip.tsx  RowReceipt.tsx
    RunReceipt.tsx  CreditsMeter.tsx  CleanList.tsx  ColumnMapper.tsx  ExportMenu.tsx
    ProviderLab.tsx  WaterfallOrder.tsx  Suppressions.tsx  EmptyState.tsx
  components/landing/            + LeadsSection on LandingPage, one line in LandingPricing
supabase/
  functions/leads/index.ts  registry.ts  treg.ts  waterfall.ts  filters.ts  billing.ts
  functions/ai/index.ts          + action 'icp'
  migrations/YYYYMMDD_leads.sql  YYYYMMDD_leads_pricing_seed.sql  YYYYMMDD_leads_cron.sql
  tests/leads_billing_acceptance.sql
```

## Compliance

- Before a user's first run: a one-time checkbox "I'll use Echo Leads for B2B
  outreach and respect opt-outs", stored as `profiles.leads_terms_accepted_at`
  (set by the function, not the client).
- Opt-outs: users manage their own list on the Opt-outs view. A public "Data and
  opt-out" link in the landing footer explains how anyone can ask to be removed;
  removed contacts go into a global suppression list checked by every run.
- Each result shows which provider found it. No guarantee of results: a free count
  and a price come before every run.

## Build phases

Build one phase at a time. After each, run it locally (`npm run dev`, Supabase
function served or deployed to the linked project), show what changed, and wait for
"next".

| Phase | Builds | Test it by |
| --- | --- | --- |
| 0. Docs | Fix stale `README.md`, `supabase/README.md` and `PRD.md` (they still say billing was removed and mention Stripe). Save this file as `docs/LEADS_PRD.md` | Reading them |
| 1. Sidebar shell | `leads` DashboardTab, sidebar item, LeadsTab with sub-nav and empty states, hash routes, migration with all `lead_*` tables and RLS | Clicking Leads collapsed and expanded, refreshing on a sub-view, RLS check as another user |
| 2. Treg + ICP | leads function skeleton, `treg.ts`, `registry.ts` from `catalog_get`, `read_site`, `ai` action `icp`, ICP card, free counts, filter mapping | An approved ICP with a free count, zero credits spent, `api_usage` rows for the scrape |
| 3. Runs + billing | Pricing seed, estimate, start, `work` worker, chunked reserve/settle/release, stages 1 to 4, pg_cron job, pause/resume/cancel | A 10-lead run; ledger and `api_usage` match; kill mid-run and it resumes; low balance pauses it |
| 4. Table | LeadsTable with cell states, realtime, counters, receipts, export CSV/xlsx | Watching a 50-lead run fill live; exporting it |
| 5. Clean a list | Import, column mapping, de-dupe, suppressions, clean modes, bulk actions | Importing a 200-row CSV and running verify and refind |
| 6. Provider lab + smart order | Lab runs, chart, apply order, drag to reorder, smart order | A 100-row bake-off with real numbers |
| 7. Polish + tie-ins | Phone and company data, Settings block, Billing labels, landing section, Feed "Add to Leads", acceptance SQL test | Full demo story end to end |

## Kickoff prompt

Read `docs/LEADS_PRD.md` in full before writing any code. Build the Leads service
inside this Echo repo exactly as specified, one phase at a time (see "Build
phases"). After each phase, run it, show me what changed, and wait for me to say
"next".

**Hard rules:**

- Use the existing stack: Vite + React, Supabase Postgres, Auth and Edge
  Functions. No SQLite, no Next.js, no new auth, no new payment provider.
- Every outside data call goes through Treg from an edge function with
  `TREG_TOKEN`. Never call Treg from the browser and never add individual provider
  keys.
- Before coding any Treg endpoint, read its parameters, price and response shape
  with the Treg MCP (`catalog_get`) and record them in
  `supabase/functions/leads/registry.ts`. If an endpoint in the PRD doesn't exist
  or has changed, stop and tell me.
- Every Treg call sends `X-Treg-Route-Max-Cost` and an `Idempotency-Key`, and
  records the real cost from `x-treg-cost-micro` in `api_usage`.
- Money only moves through `wallet_reserve` / `wallet_settle` /
  `wallet_release`, called with the service role. Never grant or charge credits
  from the client. New RPCs are revoked from `anon` and `authenticated`.
- Show a price before every action that spends credits.
- Follow the Echo design system in `src/index.css`. Match the existing code
  style, including header comments. Append every migration to `deploy-all.sql`
  with `scripts/append-migration.cjs`.
- Secrets live in Supabase secrets or `service_secrets`. Never print or log them.

## Open decisions

| Decision | Default in this PRD | Alternative |
| --- | --- | --- |
| AI model for the ICP | Existing OpenAI model used by the `ai` function, via `ICP_MODEL` | Claude Opus 5.5 (as in the Cascade PRD): add an Anthropic key and a provider switch in `ai` |
| Sidebar shape | One "Leads" item in MAIN with sub-views inside the tab | A separate LEADS group with Find leads, Clean a list, Provider lab as sidebar items |
| Prices | Cascade dollar prices converted to $0.05 credits | Re-price after the first 1,000 real attempts |
| Admin margin UI | SQL views only | An admin-only page gated by an allow-list of user ids |
| Phone numbers | Opt-in per run, off by default | Hide entirely in v1 |

## Out of scope

- Teams, seats and roles (still on the Echo roadmap).
- A separate Leads signup, landing site or onboarding flow.
- Sending emails or sequences; Leads stops at a verified list.
- Treg per-customer budgets (`PUT /orgs/<org_id>/budgets/...`); revisit after
  launch.

---

## Verification notes (added during the build, 17 Oct 2026)

Checked against this repository before Phase 1. Three things in the PRD above do
not match reality and need a decision.

**1. `profiles.leads_terms_accepted_at` cannot be server-guarded as written.**
The PRD calls it a server-guarded column, but `profiles` has a blanket UPDATE
policy:

```
UPDATE  qual = (( SELECT auth.uid() AS uid) = id)
       with_check = (( SELECT auth.uid() AS uid) = id)
```

`with_check` only restricts *which row* may be written, never *which columns*. A
signed-in client can therefore set `leads_terms_accepted_at` itself and skip the
compliance step entirely, and can set `leads_row_cap_usd` to anything. Either the
column moves to a table with no client write path (a `lead_terms` table with RLS
select-only), or the policies on `profiles` are narrowed to a column list via
`REVOKE UPDATE (column)` on `profiles` — which also affects the existing profile
fields, so it needs care.

**2. The catalog prices are a week old and unverifiable from this session.**
Prices are quoted from the 10 Oct 2026 catalog. The Treg MCP (`catalog_get`) is
not connected to this session, so Phase 2 cannot be started as specified: the hard
rule requires reading each endpoint's parameters, price and response shape from
the catalog before coding it, and `registry.ts` is not meant to be written from
the table above alone. Either connect the Treg MCP, or accept the table above as
authoritative for a first pass with `cost_verified = false` on every row.

**3. `daily-sweep` is deployed with `verify_jwt = false`, and that is deliberate.**
The PRD says to deploy `leads` with `--no-verify-jwt` "like daily-sweep", which is
correct, but the reason matters: the Supabase gateway cannot authenticate pg_net,
so a cron-driven function has to verify its own caller. `daily-sweep` gates every
request on `x-sweep-secret` and is fail-closed (503 when unset, 401 on mismatch).
`leads` should do the same for `work`, and its user-facing actions must use the
server-side `requireUserId()` from `billing/index.ts`, which validates the JWT
against the auth server rather than decoding it. Getting this flag wrong silently
kills the scheduler while `cron.job_run_details` still reports success — see
`scripts/verify-sweep-cron.cjs`.
