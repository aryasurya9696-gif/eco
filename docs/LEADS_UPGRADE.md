# Echo Leads — upgrade notes (18 Oct 2026)

What was wrong with Leads, what changed, what was verified and how, and what
still needs a real environment. Written against the code in this repository;
every claim below names the file it is about.

## 1. Problems found in the existing implementation

Leads could not complete a paid run as written. Four independent defects each
stopped it on their own:

| # | Defect | Effect | Where |
|---|---|---|---|
| 1 | `estimate_lead_run` read the user from `auth.uid()`, but is only callable by the service role, where `auth.uid()` is null | Every estimate returned `unauthenticated`; `start` refuses a run without a price, so no run could start | `20261115_estimate_matches_plan.sql` |
| 2 | Wallet RPCs called with argument names that do not exist: `wallet_reserve(p_metadata)` (is `p_context`), `wallet_settle(p_provider_cost_usd)` (is `p_provider_cost`), `wallet_release(p_note)` (is `p_reason`) | PostgREST resolves by argument name, so every hold failed with "function not found" | `functions/leads/billing.ts` |
| 3 | The worker selected runs with `.in('status', …).eq('status', 'queued')`, and the first chunk sets a run to `running` | Every run worked one chunk of five rows and was never picked up again | `functions/leads/index.ts` `workRun` |
| 4 | Almost every provider was sent a guessed request body | See the Treg section: filters silently ignored or requests refused | `discover.ts`, `index.ts` step functions |

Other defects, in order of impact:

- **Billing.** Two overlapping workers (self re-invoke plus the every-minute cron) reserved under the same key, so the second worker's hold was an idempotent replay and its rows were never charged. A find run billed every found address at the full *verified* price while the row said `unknown`: nothing ever verified it. The worker claimed 25 rows to work 5 and sized the hold for 25, pausing runs for "insufficient credits" that could afford the work. `row_cap_usd` came from the request body unbounded.
- **Run state.** `finishRun` read `data` from a `head: true` count (always null), so runs were marked done with rows still in flight. The end-of-chunk write set status back to `running`, undoing a user's Pause or Cancel. A clean run was started *before* its rows were uploaded, so the worker could finish it empty. Rows left `trying` by a dead worker were never reclaimed.
- **Bulk actions.** Re-verify and Find phone flagged rows `queued` on a finished run that the worker never visits. Had it worked, the run's plan would have re-charged company and email without verifying anything.
- **Verification.** Answers with outcome `free` were discarded. That covers the free ContactOut verifier (first in the chain) and every idempotent replay, so each check paid for the second verifier. ContactOut's documented `accept_all` was not recognised as catch-all.
- **Security.** `start` read the ICP by id with the service role and no `user_id` filter, so another workspace's profile could be searched with the caller's credits.
- **Data quality.** `get_run` paged on `created_at` alone, and seeded rows share one timestamp, so pages could repeat or skip rows. `unknown` meant both "never checked" and "verifier could not tell".
- **Product gaps.** There was no lead database across runs: no lists, tags, notes, status, dedupe, scoring, saved searches, company view or usage view. The rate limit (60 requests/hour for everything) was exhausted by a few minutes of filtering.

## 2. What is new

**Search** (`SearchView.tsx`, `workspace.ts searchPeople/countPeople`)
- People search on the free `leadsforge.people.search`. Filters: job titles (include and exclude), seniority, department, person location, industry, employee range, company location, domains, names, technologies, funding round, revenue range, company keywords, and at most N per company.
- Free live count (`leadsforge.people.search.count`) as filters change.
- Seniority, department, industry, funding and revenue values come from the provider's own free vocabulary endpoints, cached for 7 days in `lead_filter_cache`.
- Removable filter chips, Reset all, saved searches, and history of recent searches.
- The opt-out list is passed to the provider as `excludeEmails` / `excludeDomains`, so suppressed people are never returned.
- Results can be saved to the database or a list for free. Finding their emails is a separate, priced step.

**People** (`PeopleView.tsx`, `ContactPanel.tsx`)
- One record per person (`lead_contacts`), merged from every run, search and import. Dedupe is by email, then LinkedIn URL, then name + domain.
- Server-side search, filters, sorting and paging, with an id tiebreak so pages never repeat or skip rows.
- Filters: email status, has email/phone, lead status, tags, list, minimum fit score, source, "not checked in N days".
- Configurable columns (stored per browser). Saved views are stored in the database.
- Select a page, or "all N matching", which sends the filters instead of ids.
- Bulk actions: find emails, verify, find phones, company details (all priced), add to list (or a new list), set status, tag, CSV/Excel export, delete.
- Detail panel: every value with its source ("via Kitt", "checked 12/10 by ContactOut"); unknown values say "Not available". It also shows fit-score reasons, status, tags, notes and lists.
- Duplicates review and merge. The merge keeps the record you choose, fills its gaps, combines tags and notes, and moves list memberships.
- Scoring rules editor (`ScoringDialog.tsx`).

**Companies** (`CompaniesView.tsx`)
- One record per workspace and domain (`lead_companies`), with people, verified emails and missing emails counted.
- Filters: missing emails, not enriched, target list.
- Company profile shows provider firmographics with source and date, and the people held there. It flags when none of them has a decision-maker title.
- Company enrichment (`prospeo.companies.enrich`), priced. Companies enriched in the last 90 days are skipped unless refreshed.

**Lists** — people lists and target-account lists, persisted with workspace ownership (`lead_lists`, `lead_list_members`).

**Usage** — credits charged by run and by kind of work. Provider cost is internal and not shown.

**Fit scoring** (`functions/leads/scoring.ts`)
- Seven configurable factors: title, seniority, industry, company size, location, email quality, phone.
- Factors a lead has no data for are left out of both sides of the fraction, so missing data is never a negative.
- Below a third of the configured weight checkable, the label is "Not enough data" and no number is given.
- Labels are Strong / Possible / Weak fit, never a probability. Every point carries a reason.
- Rules are seeded from the approved ICP until saved. Saving rescores every lead.

**One confirmation for every paid bulk action** (`CostDialog.tsx`)
- Shows how many of the selection will be worked and why the rest are skipped (fresh, already have it, nothing to look it up with).
- Shows expected, maximum and available credits, plus the breakdown.
- If the balance doesn't cover the maximum, Start is disabled and a Top up link is shown.
- One request id per dialog, so a double click or a retry returns the same run. A unique index enforces this even for concurrent requests.

## 3. Treg endpoints and providers integrated

Source of truth: the public catalog API (`GET https://treg.to/catalog/endpoints/{id}`), read 18 Oct 2026.
- The examples used by the tests are saved in `supabase/tests/fixtures/treg/catalog-2026-10-18.json`.
- Request builders and response readers live in `supabase/functions/leads/endpoints.ts`.
- Prices and cost types are in `registry.ts`.

| Step | Endpoint (order) | Price (catalog) | Miss |
|---|---|---|---|
| People search + count | `leadsforge.people.search`, `.count` | free | — |
| Filter vocabularies | `leadsforge.people.search.filters.{seniorities,departments,funding_types,revenue_ranges,industries}` | free | — |
| Companies (find by profile) | `tomba.companies.search.reveal` → `icypeas.companies.search` | $0.000178/call (≤50 rows); $0.00038/row | billed |
| Decision maker | `icypeas.people.search` (10 rows) → `findymail.search.employees` (1) → `leadmagic.people.search` (3) | per person returned | free |
| Email | `quickenrich` → `trykitt` → `aiark` → `tomba` → `leadsforge` `.people.email.find` | $0.0048–$0.0245 per hit | free |
| Verify | `contactout` → `trykitt` → `millionverifier` `.people.email.verify` | free; $0.0015; $0.00178 | Kitt bills every completed check |
| Phone (opt-in) | `blitzapi` → `quickenrich` → `aiark` → `dropleads` → `leadmagic` `.people.phone.find` | $0.000495–$0.125 per hit | free |
| Company details | `prospeo.companies.enrich` | $0.0245 per match | free |

How the request shapes changed:
- Tomba's company search takes `filters: {industry: {include}}`; the old flat body was silently ignored.
- Icypeas takes a `query` object of include/exclude filters.
- Findymail takes `website` + `job_titles`.
- Kitt takes `fullName` and `realtime: true`.
- QuickEnrich, Tomba email, ContactOut and MillionVerifier are GET endpoints with query parameters; `treg.ts` now supports GET and query strings.

Other choices:
- Two cheaper documented phone providers were added (BlitzAPI, QuickEnrich).
- The HLR line check was removed from the phone *finder* chain.
- A finder's own verdict (Kitt `validity`, Tomba `verification.status` with `accept_all`, AI Ark `status`) is used when present; otherwise the verifier chain runs.
- Provider selection is explicit, cheapest per hit first. The workspace can override it in the provider lab, or switch to a hit-rate ranking after 50 attempts. Routed `treg.*` endpoints are not used: their misses can bill.

Unchanged: every call sends `X-Treg-Route-Max-Cost`, an `Idempotency-Key` and `X-Treg-Meta`, and records the `X-Treg-Cost-Micro` charge in `api_usage`.

## 4. Database changes

Apply in order. All four are also appended to `supabase/deploy-all.sql`.

| Migration | Adds |
|---|---|
| `20261116_leads_worker_lease.sql` | `lead_runs.lease_until`; `lead_claim_run` / `lead_release_run` (one worker per run); `lead_claim_rows` (`FOR UPDATE SKIP LOCKED`, reclaims stale `trying` rows); paging index |
| `20261117_estimate_for_user.sql` | `estimate_lead_run(…, p_user)`; drops the four-argument version; modes `phone_only`, `enrich_only` |
| `20261118_lead_database.sql` | `lead_rows` statuses `unchecked`, `disposable`, plus `email_checked_at`, `email_verifier`, `generation`; tables `lead_companies`, `lead_contacts`, `lead_lists`, `lead_list_members`, `lead_saved_searches`, `lead_search_log`, `lead_scoring` (RLS select-own, writes via the function only); `lead_contact_merge`, `lead_contact_upsert_from_row`, `lead_contacts_merge`, `lead_company_upsert`; `lead_companies_summary` view; unique paid-request index on `lead_runs`; `leads.search` pricing row at 0 credits; backfill of every finished row |
| `20261119_leads_economics.sql` | `v_leads_run_economics`, `v_leads_endpoint_economics` (service role only) |

The backfill also relabels imported addresses that never had a verify attempt
from `unknown` to `unchecked`.

## 5. Credits, pricing and provider cost

- **Prices** live in `pricing_config` (credits per operation) and are read by `estimate_lead_run` and the worker. Nothing is hard-coded in the UI.
- **Estimate.** Minimum, expected (from the workspace's own hit rates after 50 attempts, else 70%) and maximum. A run starts only if `balance − reserved ≥ maximum`.
- **Charging.** Per chunk of 5 rows: reserve the chunk's worst case, work it, settle what was earned, release the rest. A miss is never charged.
- **Email charge.** The verified price is charged only for a verified address. Catch-all, unknown or unchecked addresses are charged the catch-all price. Invalid or disposable addresses are charged nothing.
- **Verification on clean runs** is charged only for a definite verdict; "unknown" is free.
- **Idempotency.** Every provider call carries an idempotency key that includes the row's generation. Every chunk hold has a unique key. Every paid bulk request has a request id, enforced unique.
- **Provider cost** is measured, never assumed: it is the `X-Treg-Cost-Micro` header per call, in `api_usage`.
- **Revenue** is recognised on `credit_ledger` at settle, FIFO from the grants consumed (free credits are $0). The settle now carries `run_id`.
- `v_leads_run_economics` gives per-run revenue, provider cost, gross profit, margin, cost per verified lead and cost of misses. `v_leads_endpoint_economics` gives cost per hit and cost of misses per provider.
- Setting selling prices (FX, payment fees, infrastructure, target margin) stays a decision about `pricing_config`. Those views are the inputs it needs. `cost_verified` stays false until real `api_usage` rows exist.

## 6. Tests

Run with `node supabase/tests/<name>.cjs`. All pass.

| Suite | Assertions | Covers |
|---|---|---|
| `lead-endpoints-tests` (new) | 174 | Every request uses only documented params and sends every required one; every reader against the catalog's example response; status mapping |
| `lead-rpc-signature-tests` (new) | 55 | Every `.rpc()` call's argument names against the SQL signature (fails on the old `billing.ts`); no awaited query builders |
| `lead-scoring-tests` (new) | 32 | Missing data is neutral; "not enough data"; reasons add up; seniority and location matching |
| `lead-steps-tests` (updated) | 81 | Plans and charges per mode, including the corrected email price and the new modes |
| `lead-estimate-parity-tests` (updated) | 55 | Estimator matches the worker's plan; estimator takes `p_user` at every call site |
| existing suites | 232 | Unchanged and passing |

Total: 629 assertions across 12 suites, all passing.

Also checked:
- `node scripts/typecheck-leads-function.cjs` (13 modules) and `tsc -b`: clean.
- `vite build`: succeeds. `node scripts/check-deploy-all.cjs`: no drift.
- An independent read-through review of the backend found these, and this change fixes them:
  - Run totals were written from a stale snapshot. They are now an atomic `lead_run_add_totals`, and the run is re-read under the lease.
  - An import could exceed the run's approved target. Now refused server-side, sliced client-side, and the worker stops at `max_credits`.
  - The contact merge could clear a known verdict, or replace a verified address with a rejected one.
  - A CSV column named `contact_id` could break the merge and the backfill.
  - Verification was charged when only a finder had graded its own answer.
  - Worker status writes could overwrite a user's pause or cancel.
  - Claimed rows that a deadline left unprocessed stayed locked for 5 minutes.
  - Large selections hit PostgREST's 1000-row cap and URL length. Now paged and batched; list filters are a join.
  - Phone eligibility disagreed between the estimate and the worker.
  - An unvalidated `search` step could reach the waterfall table.
- `contactsFilter` was `async` and returned a PostgREST builder. Builders are thenables, so awaiting it ran the query, and every People query would have thrown. It is now synchronous, with a static test.
- The new screens were exercised in the browser against canned function responses: search, filter chips and count, save, People selection and "all matching", the cost dialog and its request payloads, the double-click request id, and the detail panels. Two bugs found that way were fixed: the enrich request overwrote its own route, and panels closed on the click that opened them.

## 7. Not implemented, and why

- **Natural-language search.** The documented options are Fiber AI NL search ($0.02 per result plus 2 credits a page) and Findymail IntelliMatch (async, price unpublished). Neither was wired, because the price could not be shown before running. The free structured search covers the same filters.
- **Scheduled discovery and automations** (saved-search refresh, auto-enrich imports, auto-tag rules, notifications). Not built. They need a job table with caps and a cost budget per schedule, and are the natural next step on top of saved searches and the run worker.
- **Team assignment.** Echo has no teams or roles; ownership is per user.
- **Sandbox.** Treg documents no test mode. `POST /demo/sandbox` exists without documentation and was not used.
- **LeadsForge paging cursor.** The cursor is a documented *request* parameter, but the response field that carries it is not in the catalog example. The reader accepts `cursor`, `nextCursor` and `next_cursor`. If none is present, "Load more" does not appear.
- **Tomba size buckets.** Only `10K-50K` appears in the documentation; the intermediate bucket labels follow the same pattern but are not confirmed. A bucket Tomba does not recognise would narrow the search to nothing, and the run would fall through to Icypeas, whose headcount range is documented.

- **Large target-account lists.** Filtering Companies by a target-account list uses its first 1000 members.
- **Mobile layout of the dashboard shell.** The existing sidebar takes most of a phone screen on every tab. The new Leads views wrap and scroll, but the shell itself was not changed.

## 8. Needs a real environment before it is relied on

1. Apply migrations `20261116` → `20261119` (or `deploy-all.sql`), then deploy the `leads` function with `node scripts/deploy-functions.cjs leads`. Deploy order matters: the new function needs the new SQL, and fails closed (`lease_unavailable`) without it.
2. `TREG_TOKEN` and `LEADS_WORKER_SECRET` (or `service_secrets.leads_worker_secret`) must be set; the cron job from `20261110` must be active.
3. Run one small find run and one 5-row verify on a real token. Then compare `v_leads_run_economics` with Treg's own call log (`GET /calls/{id}`) and set `pricing_config.cost_verified` where the costs agree.
4. The SQL acceptance suites (`credit_wallet_acceptance`, `credit_wallet_concurrency`) need psql against the project. Nothing in this change was executed against a database.
