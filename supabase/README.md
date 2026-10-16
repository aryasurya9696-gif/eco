# Echo — Supabase Backend

Everything under `supabase/` is deployed to the project `fteoyqhogzuapfdledeg`.

---

## 📁 Layout

```
supabase/
├── deploy-all.sql              <- paste this once into the SQL Editor
├── migrations/                 <- numbered, run in order
├── backup/                     <- data snapshots taken before destructive changes
└── functions/
    ├── ai/                     OpenAI proxy  (keyword suggestions, outreach drafts)
    ├── social-search/          SocialFetch proxy (live sweep)
    ├── billing/                Stripe Checkout for plan changes
    └── daily-sweep/            scheduled fan-out sweep
```

> Each function is **self-contained on purpose**. Supabase's bundler skips
> underscore-prefixed directories, so a shared `_shared/` module fails to
> resolve on deploy. If you add a helper, inline it or use a normal directory.

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
| 3 | `20261017_security_hardening.sql` | Plan-aware keyword limit, `min_intent_threshold`, server-column guard, `apply_subscription_plan` |
| 4 | `20261018_remove_credits_system.sql` | Drops the retired credit system |
| 5 | `20261019_security_lint_cleanup.sql` | Advisor-driven fixes: RPC revokes, `(select auth.uid())` policies, FK index |
| 6 | `20261020_backfill_and_constraints.sql` | Re-scores existing posts; adds `CHECK` constraints |
| — | `20261016_lead_selling_credits.sql` | ⚠️ Legacy upgrade path only. Skip on a fresh install. |

</details>

> **Backup before migration 4** — it permanently drops `lead_unlocks` and
> `credit_transactions`.

---

## 2. Set secrets

None of the API keys belong in `.env` or the frontend bundle. Set them here:

```bash
supabase secrets set SOCIALFETCH_API_KEY=sfk_...
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set APP_ORIGIN=https://your-app.example
supabase secrets set SWEEP_CRON_SECRET="$(openssl rand -hex 32)"
```

| Secret | Used by | Without it |
|---|---|---|
| `SOCIALFETCH_API_KEY` | `social-search`, `daily-sweep` | both return 503 |
| `OPENAI_API_KEY` | `ai` | returns 503, client falls back to templates |
| `STRIPE_SECRET_KEY` | `billing` | plan changes disabled (503) |
| `APP_ORIGIN` | `billing` | redirect URLs broken |
| `SWEEP_CRON_SECRET` | `daily-sweep` | sweep refuses to run at all |

Optional: `ALLOWED_ORIGIN` (CORS origin, defaults `*`), `OPENAI_MODEL`
(defaults `gpt-4o-mini`).

Also enable **Dashboard → Authentication → Providers → Email → Leaked password
protection**. It is the one remaining security advisory SQL cannot fix.

---

## 3. Deploy the functions

```bash
supabase functions deploy social-search
supabase functions deploy ai
supabase functions deploy billing
supabase functions deploy daily-sweep --no-verify-jwt
```

| Function | JWT | Auth model |
|---|---|---|
| `ai` | required | User JWT, verified in code via `requireUserId()` |
| `social-search` | required | Same |
| `billing` | required | Same |
| `daily-sweep` | disabled | `x-sweep-secret` header, compared to `SWEEP_CRON_SECRET` |

`daily-sweep` runs with the service role key and spends real API credit, so it
is deliberately not publicly invokable.

---

## 4. Schedule the sweep

```sql
select cron.schedule(
  'echo-daily-sweep',
  '0 6 * * *',
  $$ select net.http_post(
       url     := 'https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep',
       headers := '{"Content-Type":"application","x-sweep-secret":"<SWEEP_CRON_SECRET>"}'::jsonb
     ); $$
);
```

Manual trigger for testing:

```bash
curl -X POST \
  https://fteoyqhogzuapfdledeg.supabase.co/functions/v1/daily-sweep \
  -H "x-sweep-secret: $SWEEP_CRON_SECRET"
```

The function reads each user's `enabled_channels`, `lookback_hours` and
`min_intent_threshold`, so per-workspace settings are respected. Results land in
`monitored_posts`; the run is logged in `sweep_runs`.

---

## 🔐 Security model

| Concern | Protection |
|---|---|
| Vendor API keys | Edge Function secrets only — never `.env`, never the bundle |
| Plan changes | `apply_subscription_plan` is `SECURITY DEFINER`, service-role only; clients cannot change their own plan |
| Keyword limits | `enforce_keyword_limit` trigger derives the cap from `subscription_plan` |
| `subscription_*` / `is_admin` | Blocked from client writes by a column `REVOKE` **and** a `BEFORE UPDATE` trigger |
| Trigger functions | `EXECUTE` revoked from `anon`/`authenticated` so they are not RPCs |
| RLS policies | All use `(select auth.uid())` for per-query initialisation |
| `sweep_runs` | Explicit deny-by-default policy; service role only |
| Webhook URLs | Allow-listed to Slack/Discord hosts by trigger + client validation |
| Channels | `CHECK` restricts `enabled_channels` to twitter/reddit/google |
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
backfill query).

---

## 🗄 Schema

| Table | Notes |
|---|---|
| `profiles` | One row per user; plan, sweep settings, intent threshold |
| `keywords` | 5/10/25 active depending on plan, enforced by trigger |
| `monitored_posts` | Unique on `(user_id, post_url)`; written by edge functions |
| `sweep_runs` | Cron audit log, service-role only |

Client write access to `profiles` is limited to these columns:
`full_name`, `website`, `core_offer`, `onboarding_completed`, `onboarding_step`,
`email_digest`, `slack_webhook`, `lookback_hours`, `sweep_time_utc`,
`sweep_frequency`, `enabled_channels`, `min_intent_threshold`.

---

## 🔁 Client ↔ server constants

Keep these pairs in sync when changing a value:

| Client | Server |
|---|---|
| `src/lib/billing.ts` → `keywordLimit` | `plan_keyword_limit()` |
| `src/lib/constants.ts` → `WEBHOOK_PATTERN` | `guard_profile_webhook()` |
| `src/lib/constants.ts` → `SUPPORTED_PLATFORMS` | `profiles_enabled_channels_supported` |
| `src/lib/constants.ts` → `INTENT_THRESHOLD_OPTIONS` | `profiles_min_intent_threshold_range` |