# Echo — Supabase Backend

Everything under `supabase/` is deployed to the project `fteoyqhogzuapfdledeg`.

---

## 📁 Layout

```
supabase/
├── deploy-all.sql              <- paste this once into the SQL Editor
├── migrations/                 <- numbered, run in order
├── tests/                      <- SQL acceptance suites, run against the live database
└── functions/
    ├── ai/                     OpenAI proxy  (keyword suggestions, outreach drafts, ICP)
    ├── social-search/          Treg gateway (interactive live sweep)
    ├── billing/                Dodo checkout, quotes, history
    ├── billing-webhook/        Dodo payment + refund events
    └── daily-sweep/            scheduled fan-out sweep
```

> Each function is **self-contained on purpose**. Supabase's bundler skips
> underscore-prefixed directories, so a shared `_shared/` module fails to
> resolve on deploy. If you add a helper, inline it or use a normal directory.

> `deploy-all.sql` is **curated, not a concatenation of every migration**. It
> deliberately omits the `20261024`–`20261101` block, which is the abandoned
> subscription and admin-pricing design that `20261101_remove_billing` took back
> out. Including it would restore plan tables, `admin_set_*` functions and an
> `is_admin` column. Run `node scripts/check-deploy-all.cjs` after adding a
> migration; it reports drift and exits non-zero. To append one:
> `node scripts/append-migration.cjs <file>.sql`.

---

## 1. Apply the schema

Dashboard → SQL Editor → paste [`deploy-all.sql`](deploy-all.sql) → Run.

Idempotent: safe to run more than once.

<details>
<summary>Or run the numbered migrations individually</summary>

| Order | File | Purpose |
|---|---|---|
| 1 | `20250101000000_echo_schema.sql` | `profiles`, `keywords`, `monitored_posts`, `sweep_runs` + RLS + triggers |
| 2 | `20250102000000_add_enabled_channels.sql` | `profiles.enabled_channels` |
| 3 | `20261016_lead_selling_credits.sql` | ⚠️ Legacy upgrade path only. Skip on a fresh install. |
| 4 | `20261017_security_hardening.sql` | Flat keyword limit, `min_intent_threshold`, server-column guard |
| 5 | `20261018_remove_credits_system.sql` | Drops the retired credit system |
| 6 | `20261019_security_lint_cleanup.sql` | Advisor-driven fixes: RPC revokes, `(select auth.uid())` policies, FK index |
| 7 | `20261020_backfill_and_constraints.sql` | Re-scores existing posts; adds `CHECK` constraints |
| 8 | `20261021_feed_retention.sql` | `profiles.feed_retention_days` |
| 9 | `20261022_socialfetch_integration.sql` | SocialFetch provider wiring |
| 10 | `20261023_scheduled_sweeps.sql` | `pg_cron` job for the daily sweep |
| — | `20261024`–`20261101` | **Excluded.** Abandoned subscription and admin-pricing design. |
| 11 | `20261102_credit_wallet.sql` | `wallet`, `credit_grants`, `credit_ledger`, `payment_orders`, `api_usage`, `pricing_config`, `reservations`, `webhook_events` |
| 12 | `20261103_wallet_rpcs.sql` | The six wallet RPCs |
| 13 | `20261104_pricing_seed.sql` | Credit prices per operation |
| 14 | `20261105_billing_reports.sql` | `v_margin_by_operation`, `v_platform_totals`, `v_margin_by_user`, `v_treg_reconciliation`, `v_stale_reservations` |
| 15 | `20261106_welcome_credits.sql` | 20 welcome credits on signup |
| 16 | `20261107_audit_fixes.sql` | Fee-safe top-up, stale-hold reaper, request-level feed guards, `sweep_shape()` |

</details>

---

## 2. Set secrets

None of the API keys belong in `.env` or the frontend bundle. Set them here:

```bash
supabase secrets set TREG_TOKEN=<treg token>
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set DODO_PAYMENTS_API_KEY=...
supabase secrets set APP_ORIGIN=https://your-app.example
supabase secrets set SWEEP_CRON_SECRET="$(openssl rand -hex 32)"
```

| Secret | Used by | Without it |
|---|---|---|
| `TREG_TOKEN` | `social-search`, `daily-sweep` | both return 503 |
| `OPENAI_API_KEY` | `ai` | returns 503, client falls back to templates |
| `DODO_PAYMENTS_API_KEY` | `billing` | checkout returns 503 (`payments_not_configured`) |
| `DODO_PAYMENTS_WEBHOOK_KEY` | `billing-webhook` | every payment event is refused as unsigned |
| `APP_ORIGIN` | `billing` | return URLs broken |
| `SWEEP_CRON_SECRET` | `daily-sweep` | sweep refuses to run at all |

Optional: `ALLOWED_ORIGIN` (CORS origin, defaults `*`), `OPENAI_MODEL`
(defaults `gpt-4o-mini`).

Secrets that must survive a redeploy of the whole project also live in the
`service_secrets` table, which only the service role can read. `daily-sweep`
falls back to it for `sweep_cron_secret` and `treg_token`, so a function
deployed with no edge secrets configured still authenticates its own caller.

> **There is no Stripe key.** Stripe was replaced by Dodo Payments one-time
> top-ups. There is also no subscription: Echo sells prepaid credits only, and
> there is no plan column, no plan table and no admin surface anywhere in the
> schema. Verified live: zero `admin%` functions, zero `is_admin` columns.

Also enable **Dashboard → Authentication → Providers → Email → Leaked password
protection**. It is the one remaining security advisory SQL cannot fix.

---

## 3. Deploy the functions

```bash
node scripts/deploy-functions.cjs          # all of them, with the right auth flag
node scripts/deploy-functions.cjs billing  # or just one
```

Do not hand-roll `supabase functions deploy` for these. The `verify_jwt` flag is
not part of the function's source, so nothing in review sees it and nothing fails
at build time — and getting it wrong silently kills the scheduler.

| Function | `verify_jwt` | Auth model |
|---|---|---|
| `ai` | on | User JWT, verified in code via `requireUserId()` |
| `social-search` | on | Same |
| `billing` | on | Same |
| `billing-webhook` | **off** | Provider HMAC over the raw body; the gateway cannot check that |
| `daily-sweep` | **off** | `x-sweep-secret` compared to `SWEEP_CRON_SECRET` |

**Why the two "off" rows are off, and why the rest are on.** Supabase's gateway
enforces `verify_jwt` *before* the function body runs, and it cannot authenticate
`pg_net` — a cron-fired request carries no JWT. So a cron-driven function has to
have the flag off and gate itself, which `daily-sweep` does on every request
(503 when the secret is unset, 401 on mismatch). `billing-webhook` authenticates
with Dodo's own signature over the raw body, which a JWT check would only get in
the way of. Everything user-facing stays on, so the gateway does the work and the
function re-validates server-side anyway.

Getting this wrong is invisible from `cron.job_run_details`: it records that the
SQL ran, and `net.http_post` returns a request id without waiting for the
response, so a function the gateway rejects with 401 still leaves every run
looking green. `node scripts/verify-sweep-cron.cjs` reads the real HTTP status
back for both the authenticated and the anonymous case.

---

## 4. Schedule the sweep

```sql
select cron.schedule(
  'echo-daily-sweep',
  '0 * * * *',
  $$ select net.http_post(
       url     := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-sweep-secret', (select value from public.service_secrets
                            where name = 'sweep_cron_secret')),
       body    := '{}'::jsonb
     ); $$
);
```

Manual trigger for testing — the secret is read inside the query and never
returned:

```sql
select net.http_post(
  url := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-sweep-secret', (select value from public.service_secrets
                       where name = 'sweep_cron_secret')),
  body := '{}'::jsonb
);
```

Then read the actual result:

```sql
select status_code, content from net._http_response order by id desc limit 1;
```

The function reads each user's `enabled_channels`, `lookback_hours` and
`min_intent_threshold`, so per-workspace settings are respected. Results land in
`monitored_posts`; the run is logged in `sweep_runs`.

---

## 💳 Billing model

Prepaid credits. One credit is **$0.05**; packages are 200/$10, 500/$25,
1,000/$50. There are no subscriptions and no recurring charges.

**Supabase owns the wallet, not the payment provider.** Treg settles its own
meter about a minute behind, so it cannot gate a call synchronously, and it
cannot see what a call cost us, so profit is not computable there. Credits enter
only through `billing-webhook`, after the backend has verified a payment.

**Two-phase balance.** `wallet_reserve` moves credits from `balance` into
`reserved` before the provider call; `wallet_settle` then draws them down FIFO
and recognises revenue at each grant's own `unit_price_usd`, or `wallet_release`
returns them when nothing billable happened. A crash between the two used to lock
credits out of a workspace permanently, so `reap_stale_reservations` closes holds
older than an hour — settling them for whatever `api_usage` recorded, releasing
the rest.

Out of credits is a **refusal**, not a loan: no negative balance, no overdraft,
no partial sweep. Both gates fire with distinct messages — the product caps
(`keyword_limit()` 8, `channel_limit()` 3) and the credit balance.

| Function | Purpose |
|---|---|
| `wallet_apply_grant(uuid, numeric, text, numeric, uuid, text, timestamptz, jsonb)` | Issue credits, record the price they were bought at |
| `wallet_reserve(uuid, numeric, text, jsonb)` | Hold credits for a job |
| `wallet_settle(uuid, numeric, numeric, text, text, jsonb)` | Charge what billed, release the rest, recognise revenue |
| `wallet_release(uuid, text)` | Return a hold in full |
| `wallet_topup_from_order(uuid, numeric, numeric, text, text)` | Grant a paid order, priced net of the fee |
| `wallet_revoke_grant(uuid, text)` | Take back the unspent part of a refunded purchase |

All six are `SECURITY DEFINER` with a pinned `search_path`, and all six are
revoked from `anon` and `authenticated` — the whole model depends on there being
no path from the API to them. `quote_sweep`, `reap_stale_reservations`,
`keyword_limit`, `channel_limit` and `sweep_shape` round out the RPC surface.

### Cost, not a rate card

There is no price list for what treg charges. Every call is measured from
`x-treg-cost-micro` on the response and written to `api_usage`. A missing header
means no charge. The provider's response body is never the source of truth for
cost.

`X-Treg-Route-Max-Cost` is sent on every call as a hard ceiling; exceeding it is
a `402` with nothing charged. `Idempotency-Key` is sent on every call, so a retry
after a lost answer is never billed twice — and `api_usage.idempotency_key` is
unique, so a replay cannot double-count either.

`409` and `410` are `uncertain`, never auto-refunded. Auto-refunding is how a
workspace gets served for free.

---

## 🔐 Security model

| Concern | Protection |
|---|---|
| Vendor API keys | Edge Function secrets or `service_secrets` — never `.env`, never the bundle |
| Credits | Only the six wallet RPCs move them, all service-role only; the browser can read a balance and nothing more |
| Price changes | `audit_pricing_change` trigger records who changed what and when, including from raw SQL |
| Keyword limits | `enforce_keyword_limit` trigger, server-side, from `keyword_limit()` |
| Server-owned profile columns | Per-column `GRANT`: `authenticated` gets `UPDATE` on 11 named columns only, so a column with no grant cannot be written from the client even though the RLS policy allows the row |
| Wallet RPCs | `EXECUTE` revoked from `anon` and `authenticated`; `SECURITY DEFINER` with `search_path` pinned |
| Trigger functions | `EXECUTE` revoked from `anon`/`authenticated` so they are not RPCs |
| RLS policies | All use `(select auth.uid())` for per-query initialisation |
| `sweep_runs`, `service_secrets` | Explicit deny-by-default policy; service role only |
| Feed deletion | `clear_feed` / `prune_feed` authorise on `auth.uid()` alone — never `session_user`, which describes the connection rather than the request |
| Webhook URLs | Allow-listed to Slack/Discord hosts by trigger + client validation |
| Channels | `CHECK` restricts `enabled_channels` to twitter/reddit/google/news |
| Intent threshold | `CHECK` restricts to 0–100 |
| API budgets | Per-function rate limits + 2-page pagination cap + 500-user run cap |

### Intent scoring

Both `social-search` and `daily-sweep` score identically:

```
score = 30
      + 9 per high-intent phrase  (looking for, recommend, pricing, budget, demo, …)
      + 3 per supporting phrase    (tool, software, automation, workflow, …)
      - 40 per disqualifying phrase (hiring, job opening, free template, …)
clamped to 0..97
```

Levels: `high >= 85`, `medium >= 60`, `low < 60`.

**Keep this in sync in three places:** the `social-search` function, the
`daily-sweep` function, and `20261020_backfill_and_constraints.sql` (the
backfill query). There used to be a fourth copy on the client
(`calculateIntentScore` in `src/lib/sweep.ts`); it was unreferenced and has been
removed, because two copies of a scoring algorithm drift and the one nobody
edits is the one nobody notices.

---

## 🗄 Schema

| Table | Notes |
|---|---|
| `profiles` | One row per user; sweep settings, intent threshold, retention |
| `keywords` | 8 active, enforced by trigger |
| `monitored_posts` | Unique on `(user_id, post_url)`; written by edge functions |
| `sweep_runs` | Cron audit log, service-role only |
| `wallet` | One row per user: `balance`, `reserved`, lifetime totals, recognised revenue, service cost |
| `credit_grants` | Each purchase as its own row with its own `unit_price_usd` |
| `credit_ledger` | Every movement; `idempotency_key` unique |
| `reservations` | Holds between reserve and settle |
| `payment_orders` | Dodo checkout attempts |
| `api_usage` | One row per Treg call: real `provider_cost_usd`, credits charged, revenue |
| `pricing_config` | Credit price per operation, change-audited |
| `topup_packages` | Public price list, readable before signup; no client write path |
| `webhook_events` | Every delivery, with `attempts` and `last_error` |
| `service_secrets` | Fallback secret store, service-role only |

Client write access to `profiles` is limited to these columns, by per-column
grant: `full_name`, `website`, `core_offer`, `onboarding_completed`,
`onboarding_step`, `lookback_hours`, `sweep_time_utc`, `sweep_frequency`,
`enabled_channels`, `min_intent_threshold`, `feed_retention_days`. Anything not
on that list is server-only by omission — a new column is protected until someone
grants it on purpose.

---

## 🧪 Tests

```bash
# 39 checks against the live database; cleans up after itself, so --yes is required
node scripts/run-sql-test.cjs credit_wallet_acceptance --yes

# HTTP against the deployed webhook — needs the signing key
node supabase/tests/webhook-signature-tests.cjs <url> <DODO_PAYMENTS_WEBHOOK_KEY>

# cron path really reaches the function, in both directions
node scripts/verify-sweep-cron.cjs

# Leads: no database or network needed. Run after touching supabase/functions/leads.
for f in supabase/tests/lead*-tests.cjs supabase/tests/icp-*-tests.cjs; do node "$f"; done
node scripts/typecheck-leads-function.cjs
```

`lead-rpc-signature-tests` checks every `.rpc()` call in the leads function
against the SQL that defines it. PostgREST resolves a function by argument name,
so a mismatch there is a runtime "function not found", not a type error.

---

## 🎯 Leads

The Leads service — people search, the lead database, enrichment runs, scoring
and its economics views — is described in
[`docs/LEADS_UPGRADE.md`](../docs/LEADS_UPGRADE.md), including the migration and
deploy order (`20261116` → `20261119`, then the `leads` function).

---

## 🔁 Client ↔ server constants

Keep these pairs in sync when changing a value:

| Client | Server |
|---|---|
| `src/context/EchoContext.tsx` → `KEYWORD_LIMIT` | `keyword_limit()` |
| `src/lib/constants.ts` → `WEBHOOK_PATTERN` | `guard_profile_webhook()` |
| `src/lib/billing.ts` → `CHANNEL_LIMIT` | `channel_limit()` |
| `src/lib/constants.ts` → `INTENT_THRESHOLD_OPTIONS` | `profiles_min_intent_threshold_range` |
| `supabase/functions/billing` → sweep estimate | `sweep_shape()` |
